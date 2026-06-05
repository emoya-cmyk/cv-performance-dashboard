'use strict'

// Self-healing CLOSURE of the autonomy layer (ops-v2).
//
// WHAT THIS COMPLETES
//   lib/opsHealth.js gave the engine an EYE: it can read the job_heartbeats ledger
//   and SEE when a scheduled job-class has slipped overdue or gone stale. But seeing
//   is not healing — until now an overdue nightly sweep just sat there, graded amber,
//   waiting for a human. This module is the HAND: given that same assessment, it
//   decides — purely, deterministically, conservatively — which overdue/stale jobs
//   are safe to re-run THIS cycle. The scheduler's watchdog tick (the organ that
//   already runs every 15 min) executes the plan and folds the count back into its
//   own `detail.healed`, so the existing "N self-heals" headline surfaces a recovered
//   job automatically — no new read path, no new surface.
//   sense (opsHealth) → decide (this module) → act+verify (scheduler) → show (the strip).
//
// PURE BY CONSTRUCTION
//   No I/O, no DB, no clock of its own: `now` is passed in and normalized via toMs
//   (imported from opsHealth — opsHealth never imports this, so there is no cycle).
//   It never mutates its inputs — the cooldown ledger is READ only; the executor owns
//   writing it. That makes the entire heal DECISION deterministic and unit-testable
//   with zero mocking, exactly like the grader it sits beside.
//
// CLASS-C INVARIANT (absolute)
//   Re-running an idempotent, pure-internal JOB function is in-bounds. Touching auth,
//   credentials, secrets, OAuth, account connections, or host/cron provisioning is
//   NOT — those are never self-healed in code, only ever surfaced for a human. Two
//   job-classes are therefore HARD-DENIED here and can never be recovered no matter
//   what allow-list a caller passes:
//     • digest   — sends external client emails; a re-run is duplicate outbound comms.
//     • watchdog — the recovery executes INSIDE the watchdog tick; recovering it is
//                  circular (it is, by definition, running right now).
//   `sync` is intentionally NOT in any caller's allow-list either: it already owns a
//   per-connection recovery organ (runConnectionWatchdog), so re-running the whole
//   sweep from here would be redundant and fight that backoff. The executor passes
//   recoverable: ['insights'] — the one heavy, pure-internal, idempotent sweep that
//   has no recovery organ of its own.
//
// SAFE BY CONSTRUCTION — four independent guards, each fail-closed:
//   1. ALLOW-LIST   — a job is a candidate only if the executor explicitly lists it
//                     AND it is not on the hard deny-list. Default allow-list is empty,
//                     so a forgetful caller recovers NOTHING rather than something wrong.
//   2. STATUS GATE  — only 'overdue'/'stale' jobs are eligible; 'live'/'never' are left
//                     alone (a cold-start 'never' is honest, not a fault to heal).
//   3. COOLDOWN     — a per-job thrash-guard: a job re-tried within cooldownMs is left
//                     to settle, so a genuinely-broken sweep backs off (2h) instead of
//                     being hammered every 15 min.
//   4. PER-CYCLE CAP — at most maxPerCycle recoveries fire per tick, most-overdue first,
//                     so one bad night can never trigger a stampede of re-runs.
//   Plus a clock fail-safe: if `now` is unparseable we recover NOTHING (a missed heal
//   self-corrects next tick; an un-cooled-down thrash does not).

const { toMs } = require('./opsHealth')

// 2 hours: long enough that a genuinely-failing sweep backs off hard, short enough
// that a transient blip recovers well within the same day.
const DEFAULT_COOLDOWN_MS = 2 * 60 * 60 * 1000

// At most two job-class recoveries per 15-min tick. With a single-element allow-list
// today this is headroom; it bounds the blast radius if the allow-list ever grows.
const DEFAULT_MAX_PER_CYCLE = 2

// Only these grades are worth re-running. 'live' is fine; 'never' is cold-start-honest.
const DEFAULT_RECOVER_STATUSES = ['overdue', 'stale']

// HARD, NON-OVERRIDABLE deny-list. No caller-supplied allow-list can ever bring these
// into scope. See the CLASS-C INVARIANT note above for why each is here.
const NEVER_RECOVERABLE = ['watchdog', 'digest']

// The core safety predicate: a job may be recovered iff it is on the caller's
// allow-list AND not on the hard deny-list. Exported so it can be unit-tested and
// reused in isolation. Defensive: a missing job or non-array allow-list → false.
function isRecoverable(job, recoverable) {
  if (!job) return false
  if (NEVER_RECOVERABLE.includes(job)) return false
  return Array.isArray(recoverable) && recoverable.includes(job)
}

// Decide which jobs to re-run this cycle. PURE — returns a plan, performs nothing.
//
//   assessment      — an assessOps() result; only assessment.jobs[].{job,status,
//                     overdueByMs,ageMs} are read.
//   recoverable     — executor-owned allow-list (e.g. ['insights']). Default [] so an
//                     absent allow-list heals nothing (fail-closed).
//   cooldownLedger  — { [job]: lastAttemptTs } map (ms | Date | ISO). READ only; the
//                     executor stamps it on every attempt (success OR failure) so a
//                     failing sweep is what the cooldown backs off.
//   now             — current time (ms | Date | ISO). Normalized via toMs.
//   cooldownMs      — per-job back-off window (default 2h).
//   maxPerCycle     — cap on recoveries fired this cycle (default 2).
//   recoverStatuses — eligible grades (default ['overdue','stale']).
//
// Returns { recover: [{job,status,reason,overdueByMs,ageMs}], skipped: [{job,status,reason}] }.
// `reason` on skipped ∈ {'cooldown','cap','no-clock'}; on recover it is 'due'.
function planJobRecovery({
  assessment,
  recoverable = [],
  cooldownLedger = {},
  now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxPerCycle = DEFAULT_MAX_PER_CYCLE,
  recoverStatuses = DEFAULT_RECOVER_STATUSES,
} = {}) {
  const recover = []
  const skipped = []

  const jobs     = assessment && Array.isArray(assessment.jobs) ? assessment.jobs : []
  const statuses = Array.isArray(recoverStatuses) ? recoverStatuses : DEFAULT_RECOVER_STATUSES
  const cap      = Number.isFinite(maxPerCycle) && maxPerCycle > 0 ? Math.floor(maxPerCycle) : 0
  const cool     = Number.isFinite(cooldownMs) && cooldownMs >= 0 ? cooldownMs : DEFAULT_COOLDOWN_MS
  const ledger   = cooldownLedger && typeof cooldownLedger === 'object' ? cooldownLedger : {}
  const nowMs    = toMs(now)

  // Candidate set: on the allow-list (and never the hard deny-list) AND in a
  // recoverable status. Everything else is silently out of scope (not even skipped —
  // it was never a candidate). Guards 1 & 2.
  const candidates = jobs.filter(
    (j) => j && isRecoverable(j.job, recoverable) && statuses.includes(j.status),
  )

  // Clock fail-safe: without a trustworthy `now` we cannot evaluate cooldowns, so we
  // recover NOTHING and surface every candidate as skipped 'no-clock' for observability.
  if (nowMs == null) {
    for (const c of candidates) skipped.push({ job: c.job, status: c.status, reason: 'no-clock' })
    return { recover, skipped }
  }

  // Deterministic priority: most-overdue first; tie-break on raw age, then job name —
  // so the plan is stable run-to-run and the cap always cuts the same, lowest-priority
  // candidates.
  const sorted = candidates.slice().sort((a, b) => {
    const ao = Number.isFinite(a.overdueByMs) ? a.overdueByMs : 0
    const bo = Number.isFinite(b.overdueByMs) ? b.overdueByMs : 0
    if (bo !== ao) return bo - ao
    const aa = Number.isFinite(a.ageMs) ? a.ageMs : 0
    const ba = Number.isFinite(b.ageMs) ? b.ageMs : 0
    if (ba !== aa) return ba - aa
    return String(a.job).localeCompare(String(b.job))
  })

  for (const c of sorted) {
    // Guard 3 — cooldown thrash-guard. If this job was attempted within cooldownMs,
    // leave it to settle (reason 'cooldown'), regardless of remaining cap. A missing
    // or unparseable ledger stamp means "never attempted" → not in cooldown.
    const lastMs = toMs(ledger[c.job])
    if (lastMs != null && nowMs - lastMs < cool) {
      skipped.push({ job: c.job, status: c.status, reason: 'cooldown' })
      continue
    }
    // Guard 4 — per-cycle cap. Only a successful add consumes budget, so a
    // cooldown-skipped job never starves a healthy candidate out of its slot.
    if (recover.length >= cap) {
      skipped.push({ job: c.job, status: c.status, reason: 'cap' })
      continue
    }
    recover.push({
      job: c.job,
      status: c.status,
      reason: 'due',
      overdueByMs: Number.isFinite(c.overdueByMs) ? c.overdueByMs : 0,
      ageMs: Number.isFinite(c.ageMs) ? c.ageMs : null,
    })
  }

  return { recover, skipped }
}

module.exports = {
  planJobRecovery,
  isRecoverable,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_PER_CYCLE,
  DEFAULT_RECOVER_STATUSES,
  NEVER_RECOVERABLE,
}
