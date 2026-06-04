'use strict'

// ============================================================
// lib/connectionHealth.js — the self-healing pipeline's brain (PURE).
//
// coverage.js watches the DATA: it notices when a channel's FACTS go dark beyond
// their own cadence. But by the time facts stop arriving, the failure already
// happened upstream — at the CONNECTION. A revoked OAuth grant, an expired token, a
// run of 503s from a provider: the sync layer is where the product's one operator
// job ("connect the accounts") actually breaks. coverage.js sees the symptom days
// later; this module watches the cause, in real time, from the sync ledger itself.
//
// Given each connection's own record (is_active, last_synced_at, last_error) plus
// its recent sync attempts (sync_runs: status / error / timestamps), it classifies
// the connection into one state and prescribes exactly one recovery:
//
//   HEALTHY       fresh, last attempt succeeded            → none
//   STALE         succeeded once, now aging past cadence   → resync (self-heal)
//   ERRORING      transient failures (5xx/timeout/rate)    → retry w/ backoff, then escalate
//   AUTH_EXPIRED  credential/token rejected (invalid_grant)→ RECONNECT  (operator gate)
//   NEVER_SYNCED  never delivered a first sync             → await_schedule | retry | reconnect
//   DISABLED      operator turned it off                   → none (intentional, not a fault)
//
// THE ONE INVARIANT THAT MAKES THIS SAFE TO AUTOMATE. Auth failures are the single
// thing the system must NEVER try to fix itself — re-running a sync with a revoked
// token just burns quota and never recovers; only a human re-authorizing in the
// provider's OAuth screen can. So AUTH_EXPIRED (and an auth failure on a never-synced
// connection) is marked operator_required, retryable:false, next_attempt_at:null —
// the machine automates everything UP TO the reconnect click and then hands off.
// Everything else (transient errors, staleness) is genuinely self-healing: a
// deterministic exponential backoff schedule the executor can act on, and — when
// transient retries are exhausted — an escalation that still keeps retrying slowly
// while flagging a human. The connection never silently dies and never self-harms.
//
// PURE: records in, verdicts out. No DB, no clock, no network — the caller reads the
// rows and passes `asOf` (the sweep instant). Deterministic: identical input →
// byte-identical output (no Date.now / Math.random). Defensive: empty / malformed
// input → [] (a hard no-op) — "no connections" is NEVER "everything is broken," and
// a garbage row is skipped, never thrown on.
//
// AGENCY MACHINERY. States, error classes, backoff seconds and reconnect prompts are
// operator-facing. narrateConnectionHealth() returns '' for audience:'client' by
// construction here; the deliberately-vague client-facing degraded note and its
// leak-proof guard are built separately (A4). Error text is redacted before it ever
// enters a record (redactError) so a provider message can never leak a token.
// ============================================================

const STATUS = {
  HEALTHY:      'HEALTHY',
  STALE:        'STALE',
  ERRORING:     'ERRORING',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  NEVER_SYNCED: 'NEVER_SYNCED',
  DISABLED:     'DISABLED',
}

const ACTION = {
  NONE:           'none',
  AWAIT_SCHEDULE: 'await_schedule',
  RETRY:          'retry',
  RESYNC:         'resync',
  ESCALATE:       'escalate',
  RECONNECT:      'reconnect',
}

const SEVERITY = { NONE: 'none', INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' }
const SEV_RANK = { none: 0, info: 1, warning: 2, critical: 3 }

const DEFAULTS = {
  cadenceDays:        1,      // assumed natural sync rhythm when the row doesn't say
  staleGraceHours:    12,     // slack added to cadence before "stale" (min, vs 1× cadence)
  criticalStaleFactor: 3,     // age ≥ factor × cadence → the louder STALE tier
  baseBackoffSeconds: 300,    // first transient retry waits 5 min …
  maxBackoffSeconds:  21600,  // … doubling, capped at 6 h
  maxAttempts:        6,      // consecutive transient failures before we ALSO escalate
}

// Error fingerprints. Order matters at the call site: AUTH is tested FIRST, because a
// message like "401 invalid_grant (request timed out upstream)" is an auth failure,
// not a transient one — retrying it is futile. These are matched case-insensitively
// against the provider's error string.
const AUTH_PATTERNS = [
  'invalid_grant', 'invalid_client', 'invalid_token', 'invalid credentials',
  'unauthorized', 'unauthenticated', 'forbidden', 'access_denied', 'access denied',
  'permission denied', 'insufficient scope', 'insufficient permission',
  'token expired', 'token has expired', 'token has been expired', 'expired token',
  'token revoked', 'has been revoked', 'revoked', 'reauth', 're-auth', 'reconnect',
  'refresh token', 'credential', 'login required', 'aadsts', '401', '403',
]
const TRANSIENT_PATTERNS = [
  'rate limit', 'ratelimit', 'rate_limit', 'too many requests', 'quota', 'throttl',
  'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused', 'eai_again',
  'enotfound', 'socket hang up', 'network', 'temporarily', 'temporary',
  'service unavailable', 'unavailable', 'gateway', 'bad gateway',
  'internal server error', 'server error', '429', '500', '502', '503', '504',
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const num   = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }
const round = (n, d = 2) => {
  const x = Number(n)
  if (!Number.isFinite(x)) return null
  const p = 10 ** d
  return Math.round((x + Number.EPSILON) * p) / p
}

// Fractional hours from ISO instant `aIso` → `bIso` (b − a). Full-timestamp aware
// (these are TIMESTAMPTZ, not dates). null on unparseable input.
function hoursBetween(aIso, bIso) {
  if (!aIso || !bIso) return null
  const a = Date.parse(aIso)
  const b = Date.parse(bIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return (b - a) / 3600000
}

// Add `secs` to an ISO instant, re-emit as ISO. null if the anchor won't parse — a
// missing/garbage timestamp must never fabricate a fake schedule.
function addSeconds(iso, secs) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t + secs * 1000).toISOString()
}

// Classify a provider error string. 'auth' (human gate) | 'transient' (self-heal) |
// 'unknown' (treated as transient — retry-but-cap, never nag a human for a code we
// don't recognize) | null (no error text at all). Auth is checked first on purpose.
function classifyError(text) {
  if (text == null) return null
  const s = String(text).toLowerCase().trim()
  if (!s) return null
  for (const p of AUTH_PATTERNS)      if (s.includes(p)) return 'auth'
  for (const p of TRANSIENT_PATTERNS) if (s.includes(p)) return 'transient'
  return 'unknown'
}

// Deterministic exponential backoff: base · 2^(failures−1), clamped to [base, max].
// failures ≤ 0 → 0. No jitter (purity); the cap is enforced by clamp so a pathological
// failure count can't overflow the schedule.
function computeBackoff(failures, opts = {}) {
  const f = Math.floor(num(failures, 0))
  if (f <= 0) return 0
  const base = num(opts.baseBackoffSeconds, DEFAULTS.baseBackoffSeconds)
  const max  = num(opts.maxBackoffSeconds,  DEFAULTS.maxBackoffSeconds)
  const raw  = base * Math.pow(2, f - 1)
  return Math.round(clamp(Number.isFinite(raw) ? raw : max, base, max))
}

// Redact a provider error into a short, secret-free excerpt safe to store/show an
// operator. Strips labelled secrets (bearer/token/key/password/secret/authorization),
// then any unbroken 24+ char token-ish run (refresh tokens, hashes, signed URLs),
// collapses to a single line, and bounds the length. Recognizable CODES survive
// ("invalid_grant", "503") because they're short and meaningful; raw secrets don't.
function redactError(text, maxLen = 160) {
  if (text == null) return null
  let s = String(text).replace(/\s+/g, ' ').trim()
  if (!s) return null
  s = s.replace(/\b(bearer|token|key|password|secret|authorization)\b\s*[:=]?\s*['"]?[A-Za-z0-9._\-/+]{6,}['"]?/gi,
                '$1 [redacted]')
  s = s.replace(/[A-Za-z0-9._\-/+]{24,}/g, '[redacted]')
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…'
  return s
}

// Newest-first by started_at (fallback finished_at). Unparseable timestamps sink to
// the end; ties keep input order — fully deterministic regardless of caller ordering.
function sortRunsNewestFirst(runs) {
  const arr = (Array.isArray(runs) ? runs : []).filter(Boolean)
  return arr
    .map((r, i) => {
      const t = Date.parse(r.started_at || r.finished_at || '')
      return { r, i, t: Number.isFinite(t) ? t : -Infinity }
    })
    .sort((x, y) => (y.t - x.t) || (x.i - y.i))
    .map(o => o.r)
}

const statusOf = r => String((r && r.status) || '').toLowerCase()

// Assemble one connection's verdict. Returns null only when there's no channel key
// (an unidentifiable row — skipped upstream). Never throws on a malformed record.
function assessConnection(conn, asOf, opts = {}) {
  if (!conn || conn.channel == null || conn.channel === '') return null
  const channel = String(conn.channel)
  const label   = conn.label ? String(conn.label) : channel

  const cfg = {
    cadenceDays:         num(opts.cadenceDays,         DEFAULTS.cadenceDays),
    staleGraceHours:     num(opts.staleGraceHours,     DEFAULTS.staleGraceHours),
    criticalStaleFactor: num(opts.criticalStaleFactor, DEFAULTS.criticalStaleFactor),
    baseBackoffSeconds:  num(opts.baseBackoffSeconds,  DEFAULTS.baseBackoffSeconds),
    maxBackoffSeconds:   num(opts.maxBackoffSeconds,   DEFAULTS.maxBackoffSeconds),
    maxAttempts:         num(opts.maxAttempts,         DEFAULTS.maxAttempts),
  }

  const runs   = sortRunsNewestFirst(conn.runs)
  const hasRun = runs.some(r => statusOf(r) === 'success' || statusOf(r) === 'error')

  // Consecutive failure streak from the newest end: count leading errors, ignore
  // in-flight 'running', stop at the first success.
  let failures = 0
  for (const r of runs) {
    const s = statusOf(r)
    if (s === 'running') continue
    if (s === 'error') { failures++; continue }
    break
  }

  const newestOk    = runs.find(r => statusOf(r) === 'success')
  const newestErr   = runs.find(r => statusOf(r) === 'error')
  const newestTerm  = runs.find(r => statusOf(r) === 'success' || statusOf(r) === 'error')
  const lastSuccess = conn.last_synced_at || (newestOk && (newestOk.finished_at || newestOk.started_at)) || null
  const everSynced  = !!lastSuccess
  const lastAttempt = (newestTerm && (newestTerm.finished_at || newestTerm.started_at)) || lastSuccess || asOf || null
  const errText     = (newestErr && newestErr.error) || conn.last_error || null
  const errorClass  = classifyError(errText)

  const ageHours = everSynced ? hoursBetween(lastSuccess, asOf) : null

  // Recovery template — every branch fills this in, so the shape is uniform.
  const rec = {
    action:            ACTION.NONE,
    retryable:         false,
    operator_required: false,
    attempts:          failures,
    exhausted:         false,
    backoff_seconds:   0,
    next_attempt_at:   null,
  }

  let status, severity, reason

  if (conn.is_active === false) {
    // Deliberately paused — not a fault. Nothing to heal, nothing to schedule.
    status = STATUS.DISABLED; severity = SEVERITY.NONE; reason = 'operator_disabled'
    rec.attempts = 0
  } else if (!everSynced) {
    // Never delivered a first sync. Why?
    if (!hasRun) {
      // Active but never even attempted — the scheduler simply hasn't run it yet.
      status = STATUS.NEVER_SYNCED; severity = SEVERITY.INFO; reason = 'never_attempted'
      rec.action = ACTION.AWAIT_SCHEDULE; rec.retryable = true; rec.attempts = 0
    } else if (errorClass === 'auth') {
      // First-sync authorization failed → finish connecting (operator gate).
      status = STATUS.NEVER_SYNCED; severity = SEVERITY.CRITICAL; reason = 'never_synced_auth'
      rec.action = ACTION.RECONNECT; rec.operator_required = true; rec.retryable = false
    } else {
      // Transient/unknown failures before any success → self-heal with backoff.
      const exhausted = failures >= cfg.maxAttempts
      const backoff   = computeBackoff(exhausted ? cfg.maxAttempts : failures, cfg)
      status = STATUS.NEVER_SYNCED
      severity = exhausted ? SEVERITY.CRITICAL : SEVERITY.WARNING
      reason = exhausted ? 'never_synced_exhausted' : 'never_synced_retrying'
      rec.action = exhausted ? ACTION.ESCALATE : ACTION.RETRY
      rec.retryable = true; rec.exhausted = exhausted
      rec.backoff_seconds = backoff
      rec.next_attempt_at = addSeconds(lastAttempt, backoff)
    }
  } else if (failures > 0) {
    if (errorClass === 'auth') {
      // Credential/token rejected after past success → RECONNECT. The one thing the
      // system must not retry itself: no backoff, no auto-attempt, hand to a human.
      status = STATUS.AUTH_EXPIRED; severity = SEVERITY.CRITICAL; reason = 'auth_expired'
      rec.action = ACTION.RECONNECT; rec.operator_required = true; rec.retryable = false
    } else {
      const exhausted = failures >= cfg.maxAttempts
      const backoff   = computeBackoff(exhausted ? cfg.maxAttempts : failures, cfg)
      status = STATUS.ERRORING
      severity = exhausted ? SEVERITY.CRITICAL : SEVERITY.WARNING
      reason = exhausted ? 'errors_exhausted' : 'transient_error'
      // Exhausted → ALSO escalate to a human, but keep retrying slowly (cap): never
      // fully give up on a connection that might recover on its own.
      rec.action = exhausted ? ACTION.ESCALATE : ACTION.RETRY
      rec.retryable = true; rec.exhausted = exhausted
      rec.backoff_seconds = backoff
      rec.next_attempt_at = addSeconds(lastAttempt, backoff)
    }
  } else {
    // Last attempt succeeded (or no recent error). Healthy unless aging past cadence.
    const cadenceHours = Math.max(1, cfg.cadenceDays * 24)
    const staleAt      = cadenceHours + Math.max(cfg.staleGraceHours, cadenceHours)
    const veryStaleAt  = cadenceHours * cfg.criticalStaleFactor
    if (ageHours == null || ageHours <= staleAt) {
      status = STATUS.HEALTHY; severity = SEVERITY.NONE; reason = 'fresh'
      rec.attempts = 0
    } else {
      status = STATUS.STALE; reason = 'stale_no_recent_sync'
      severity = ageHours >= veryStaleAt ? SEVERITY.WARNING : SEVERITY.INFO
      rec.action = ACTION.RESYNC; rec.retryable = true; rec.attempts = 0
      rec.next_attempt_at = addSeconds(asOf, 0)   // resync now
    }
  }

  const needs_attention = SEV_RANK[severity] >= SEV_RANK[SEVERITY.WARNING]
  const ok = status === STATUS.HEALTHY || status === STATUS.DISABLED

  return {
    channel,
    label,
    status,
    ok,
    needs_attention,
    severity,
    reason,
    is_active:         conn.is_active !== false,
    last_success_at:   lastSuccess,
    last_attempt_at:   lastAttempt || null,
    age_hours:         ageHours == null ? null : round(ageHours, 2),
    age_days:          ageHours == null ? null : round(ageHours / 24, 2),
    failures,
    error_class:       errorClass,
    error_excerpt:     redactError(errText),
    operator_required: rec.operator_required,
    recovery:          rec,
  }
}

// Assess a whole portfolio (or one client's) connections, worst-first. Empty /
// non-array input → [] (hard no-op). asOf is optional: when absent, staleness can't be
// computed and a succeeded-but-undated connection reads HEALTHY (error/auth/never
// states still classify). Sort: severity desc → operator-required first → most
// failures → channel asc (stable, input-order-independent).
function assessConnectionHealth(connections, asOf, opts = {}) {
  if (!Array.isArray(connections) || connections.length === 0) return []
  const out = []
  for (const c of connections) {
    const rec = assessConnection(c, asOf, opts)
    if (rec) out.push(rec)
  }
  out.sort((a, b) =>
    (SEV_RANK[b.severity] - SEV_RANK[a.severity]) ||
    ((b.operator_required ? 1 : 0) - (a.operator_required ? 1 : 0)) ||
    (b.failures - a.failures) ||
    String(a.channel).localeCompare(String(b.channel))
  )
  return out
}

// Portfolio rollup over assessed records — what the watchdog/heartbeat (A2) and the
// agency endpoint read in one shot. next_wake_at is the earliest scheduled self-heal
// attempt across all connections (when the executor should next run); null if nothing
// is auto-scheduled (everything healthy, disabled, or human-gated).
function summarizeConnectionHealth(records) {
  const recs = Array.isArray(records) ? records.filter(Boolean) : []
  const counts = {
    HEALTHY: 0, STALE: 0, ERRORING: 0, AUTH_EXPIRED: 0, NEVER_SYNCED: 0, DISABLED: 0,
  }
  let needs_attention = 0, operator_required = 0, self_healing = 0, exhausted = 0
  let worstRank = 0, worstStatus = null, worstSeverity = SEVERITY.NONE
  let nextWake = null

  for (const r of recs) {
    if (counts[r.status] != null) counts[r.status] += 1
    if (r.needs_attention) needs_attention += 1
    if (r.operator_required) operator_required += 1
    if (r.recovery && r.recovery.exhausted) exhausted += 1
    if (r.recovery && r.recovery.retryable &&
        (r.recovery.action === ACTION.RETRY || r.recovery.action === ACTION.RESYNC)) {
      self_healing += 1
    }
    const rank = SEV_RANK[r.severity] || 0
    if (rank > worstRank) { worstRank = rank; worstStatus = r.status; worstSeverity = r.severity }
    const w = r.recovery && r.recovery.next_attempt_at
    if (w) {
      const t = Date.parse(w)
      if (Number.isFinite(t) && (nextWake == null || t < Date.parse(nextWake))) nextWake = w
    }
  }

  return {
    total: recs.length,
    counts,
    needs_attention,
    operator_required,
    self_healing,
    exhausted,
    worst_status:   worstStatus,
    worst_severity: worstSeverity,
    next_wake_at:   nextWake,
    ok:             needs_attention === 0 && operator_required === 0,
  }
}

// One-line operator instruction for a record. '' when there's nothing actionable
// (HEALTHY / DISABLED / first-sync-pending). audience:'client' → '' ALWAYS (leak-proof
// by construction; the real client note is A4's job). Never embeds the raw error —
// only the abstracted state — so a provider message can't leak through narration.
function narrateConnectionHealth(record, opts = {}) {
  if (!record) return ''
  if ((opts.audience || 'agency') === 'client') return ''
  const label = record.label || record.channel || 'a connection'
  switch (record.status) {
    case STATUS.AUTH_EXPIRED:
      return `Reconnect ${label}: its sign-in expired — re-authorize to resume syncing.`
    case STATUS.ERRORING:
      return record.recovery && record.recovery.exhausted
        ? `${label} sync still failing after ${record.failures} retries — needs a look.`
        : `${label} sync is failing (${record.failures}×) — auto-retry scheduled.`
    case STATUS.STALE:
      return `${label} data is ${record.age_days != null ? record.age_days + 'd' : 'a while'} old — triggering a resync.`
    case STATUS.NEVER_SYNCED:
      if (record.reason === 'never_synced_auth')
        return `Finish connecting ${label}: authorization failed on its first sync.`
      if (record.reason === 'never_synced_retrying' || record.reason === 'never_synced_exhausted')
        return `${label} hasn't completed a first sync — ${record.recovery && record.recovery.exhausted ? 'needs a look' : 'retrying'}.`
      return ''   // never_attempted — scheduler owns it, nothing to do
    default:
      return ''
  }
}

module.exports = {
  assessConnectionHealth,
  assessConnection,
  summarizeConnectionHealth,
  narrateConnectionHealth,
  classifyError,
  computeBackoff,
  redactError,
  hoursBetween,
  clamp,
  num,
  STATUS,
  ACTION,
  SEVERITY,
  DEFAULTS,
  AUTH_PATTERNS,
  TRANSIENT_PATTERNS,
}
