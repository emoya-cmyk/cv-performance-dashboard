'use strict'

// Autonomy-loop liveness — the brain that turns the job_heartbeats ledger (020)
// into a single provable answer: *is the self-healing engine alive and on-cadence,
// or has it silently stopped?*
//
// WHY THIS EXISTS
//   scheduler.js fires four job-classes — sync (6h), watchdog (15m), insights
//   (daily), digest (weekly) — and lib/heartbeat.js drives the first three from an
//   external cron when the host sleeps. All of it was invisible: each job only
//   console.log'd, so nothing could tell an agency or executive whether the engine
//   was actually running. health_score_history (017) is per-CLIENT; sync_runs (001)
//   is per-(client,channel); neither records "did the nightly sweep fire". The 020
//   ledger records one row per run; THIS module reads it.
//
// HOW IT GRADES
//   For each job it takes the latest run and compares its age to that job's expected
//   cadence (EXPECTED_MS, mirrored from the scheduler crons):
//     never    — no run on record (cold-start-honest; a fresh install, NOT a fault)
//     live     — ran within GRACE×cadence (on time, allowing for skew / a long sweep)
//     overdue  — late: GRACE×cadence < age ≤ STALE×cadence (the loop is slipping)
//     stale    — age > STALE×cadence (missed multiple cycles — engine likely down)
//   Overdue/stale detection is itself a self-healing signal: the loop can SEE that
//   its own heartbeat has stopped. `never` never reads as "down" — only overdue and
//   stale do — so a brand-new install renders calmly as "warming up".
//
// PURE & CLOCK-FREE
//   Every function takes `now` as an argument and never calls Date.now()/new Date()
//   argless, so grading is deterministic and unit-testable with zero mocking. The
//   one DB-touching helper (recordHeartbeat) takes an injected `query`, matching the
//   project's dependency-injection convention (see lib/heartbeat.js).

// ── Cadence model ───────────────────────────────────────────────────────────────
// Expected interval per job-class, in milliseconds. These MIRROR scheduler.js cron
// lines exactly — change a cron there, change the matching entry here.
const EXPECTED_MS = {
  sync:     6  * 60 * 60 * 1000,        //  6 hours   — SYNC_CRON     0 */6 * * *
  watchdog: 15 * 60 * 1000,             // 15 minutes — WATCHDOG_CRON */15 * * * *
  insights: 24 * 60 * 60 * 1000,        // 24 hours   — INSIGHTS_CRON 0 7 * * *
  digest:   7  * 24 * 60 * 60 * 1000,   //  7 days    — DIGEST_CRON   0 8 * * 1
}

// The canonical job roster + display order (heaviest-cadence concern first).
const JOBS = ['sync', 'watchdog', 'insights', 'digest']

// Valid status values a recorded run may carry.
const RUN_STATUSES = ['success', 'partial', 'error']

// How late before we call a job overdue, and how late before we call it stale.
// GRACE=1.5 → "late but plausibly alive" (clock skew, a slow sweep, a cron service
// firing a few minutes off). STALE=3 → "missed multiple cycles, treat as down".
const GRACE_FACTOR = 1.5
const STALE_FACTOR = 3

// Trailing window over which we total the watchdog's self-heals for the headline
// "N self-heals this week".
const HEAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// ── helpers ─────────────────────────────────────────────────────────────────────

// Normalize a timestamp (number ms | Date | ISO string | SQLite datetime) to ms.
// Returns null for anything unparseable. SQLite's CURRENT_TIMESTAMP yields a
// space-separated UTC string ('YYYY-MM-DD HH:MM:SS') with no zone — which V8 would
// parse as LOCAL time — so we normalize that exact form to ISO-UTC first.
function toMs(v) {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null }
  let s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z'
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

// detail may arrive as a JSON string (from the TEXT column) or an already-parsed
// object (a fresh in-process record). Parse defensively; never throw.
function parseDetail(d) {
  if (d == null) return null
  if (typeof d === 'object') return d
  try { return JSON.parse(d) } catch { return null }
}

function safeStringify(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return null }
}

// ── per-job assessment ────────────────────────────────────────────────────────────

// Grade ONE job from its latest run record (or null) against `nowMs`. A missing run
// OR a missing clock both resolve to the safe, non-alarming 'never' (we never invent
// an alarm we can't substantiate). `degraded` flags a job that ran on cadence but
// whose last run reported status 'error'.
function assessJob(job, run, nowMs, { grace = GRACE_FACTOR, stale = STALE_FACTOR } = {}) {
  const expectedMs = Object.prototype.hasOwnProperty.call(EXPECTED_MS, job) ? EXPECTED_MS[job] : null
  const lastRunMs  = run ? (run._t != null ? run._t : toMs(run.ran_at != null ? run.ran_at : run.lastRunAt)) : null

  if (lastRunMs == null || nowMs == null) {
    return {
      job,
      status: 'never',
      lastRunAt:  lastRunMs == null ? null : new Date(lastRunMs).toISOString(),
      lastStatus: run ? (run.status != null ? run.status : null) : null,
      ageMs: null,
      expectedMs,
      overdueByMs: 0,
      degraded: false,
      durationMs: run ? (run.duration_ms != null ? run.duration_ms : null) : null,
    }
  }

  const ageMs = Math.max(0, nowMs - lastRunMs)
  let status = 'live'
  if (expectedMs != null) {
    if (ageMs > expectedMs * stale)       status = 'stale'
    else if (ageMs > expectedMs * grace)  status = 'overdue'
  }
  const lastStatus = run.status != null ? run.status : null
  return {
    job,
    status,
    lastRunAt: new Date(lastRunMs).toISOString(),
    lastStatus,
    ageMs,
    expectedMs,
    overdueByMs: expectedMs != null ? Math.max(0, ageMs - expectedMs * grace) : 0,
    degraded: lastStatus === 'error',
    durationMs: run.duration_ms != null ? run.duration_ms : null,
  }
}

// Sum the watchdog's self-heals over the trailing window — the "self-healing,
// visibly" number. Reads detail.healed off each in-window watchdog run.
function countHeals(runs, nowMs, windowMs = HEAL_WINDOW_MS) {
  if (!Array.isArray(runs) || nowMs == null) return 0
  let total = 0
  for (const r of runs) {
    if (!r || r.job !== 'watchdog') continue
    const t = toMs(r.ran_at != null ? r.ran_at : r.lastRunAt)
    if (t == null || t > nowMs || t < nowMs - windowMs) continue
    const d = parseDetail(r.detail)
    if (d && typeof d.healed === 'number' && Number.isFinite(d.healed)) total += d.healed
  }
  return total
}

function headlineFor(status, { jobs, liveCount, overdueCount, staleCount, degradedCount }) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (status === 'warming') return 'Autonomy engine warming up — no scheduled jobs have run yet'
  if (status === 'stale')   return `Autonomy engine degraded — ${plural(staleCount, 'job')} stalled (engine may be down)`
  if (status === 'overdue') return `Autonomy engine running late — ${plural(overdueCount, 'job')} overdue`
  const base = liveCount === jobs
    ? `Autonomy engine live — all ${jobs} jobs on cadence`
    : `Autonomy engine live — ${liveCount}/${jobs} jobs on cadence`
  return degradedCount ? `${base} (${plural(degradedCount, 'job')} ran with errors)` : base
}

// ── portfolio rollup ──────────────────────────────────────────────────────────────

// Roll a flat list of recent run records (newest-anywhere, possibly several per job)
// into a whole-engine assessment. Reduces to the latest run per job internally, so
// the SQL stays a trivial `ORDER BY ran_at DESC LIMIT N`. Returns an agency-only
// shape — never any client identifier — so it is safe to surface on agency surfaces.
function assessOps({
  runs = [],
  now,
  jobs = JOBS,
  grace = GRACE_FACTOR,
  stale = STALE_FACTOR,
  healWindowMs = HEAL_WINDOW_MS,
} = {}) {
  const nowMs = toMs(now)
  const list  = Array.isArray(runs) ? runs : []

  // latest run per job, by ran_at
  const latest = {}
  for (const r of list) {
    if (!r || !r.job) continue
    const t = toMs(r.ran_at != null ? r.ran_at : r.lastRunAt)
    if (t == null) continue
    const cur = latest[r.job]
    if (!cur || t > cur._t) latest[r.job] = Object.assign({}, r, { _t: t })
  }

  const jobAssessments = jobs.map((job) => assessJob(job, latest[job] || null, nowMs, { grace, stale }))

  const countStatus   = (s) => jobAssessments.filter((j) => j.status === s).length
  const liveCount     = countStatus('live')
  const overdueCount  = countStatus('overdue')
  const staleCount    = countStatus('stale')
  const neverCount    = countStatus('never')
  const degradedCount = jobAssessments.filter((j) => j.degraded).length

  // Overall ALARM precedence. `never` is cold-start-honest and never downgrades the
  // engine to "down"; only overdue/stale do. All-never ⇒ 'warming' (a fresh install).
  let status
  if (staleCount)        status = 'stale'
  else if (overdueCount) status = 'overdue'
  else if (liveCount)    status = 'live'
  else                   status = 'warming'

  return {
    status,
    headline: headlineFor(status, { jobs: jobs.length, liveCount, overdueCount, staleCount, degradedCount }),
    total: jobs.length,
    liveCount,
    overdueCount,
    staleCount,
    neverCount,
    degradedCount,
    healsRecent: countHeals(list, nowMs, healWindowMs),
    healWindowMs,
    jobs: jobAssessments,
    now: nowMs == null ? null : new Date(nowMs).toISOString(),
  }
}

// ── ledger writer (DB-injected) ───────────────────────────────────────────────────

// Append one heartbeat row. Dependency-injected `query` so it unit-tests with a fake.
// Best-effort by contract: CALLERS MUST wrap this in try/catch — recording a
// heartbeat must NEVER disturb the real job it is recording. When `now` is supplied
// we write an explicit ISO ran_at (deterministic, unambiguous); when omitted we let
// the column DEFAULT CURRENT_TIMESTAMP stamp it (toMs normalizes that UTC form).
async function recordHeartbeat({ query, job, status = 'success', durationMs = null, detail = null, now } = {}) {
  if (typeof query !== 'function') throw new Error('recordHeartbeat: query function is required')
  if (!JOBS.includes(job))         throw new Error(`recordHeartbeat: unknown job "${job}"`)
  if (!RUN_STATUSES.includes(status)) throw new Error(`recordHeartbeat: invalid status "${status}"`)

  const detailStr = safeStringify(detail)
  const ranAtMs   = now == null ? null : toMs(now)
  const ranAtIso  = ranAtMs == null ? null : new Date(ranAtMs).toISOString()

  if (ranAtIso) {
    await query(
      `INSERT INTO job_heartbeats (job, status, ran_at, duration_ms, detail) VALUES ($1, $2, $3, $4, $5)`,
      [job, status, ranAtIso, durationMs, detailStr],
    )
  } else {
    await query(
      `INSERT INTO job_heartbeats (job, status, duration_ms, detail) VALUES ($1, $2, $3, $4)`,
      [job, status, durationMs, detailStr],
    )
  }
  return { job, status, ranAt: ranAtIso }
}

module.exports = {
  assessOps,
  assessJob,
  countHeals,
  recordHeartbeat,
  toMs,
  EXPECTED_MS,
  JOBS,
  RUN_STATUSES,
  GRACE_FACTOR,
  STALE_FACTOR,
  HEAL_WINDOW_MS,
}
