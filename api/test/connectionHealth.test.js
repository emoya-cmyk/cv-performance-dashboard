// ============================================================
// test/connectionHealth.test.js — the self-healing pipeline's brain (lib/connectionHealth.js)
//
// connectionHealth.js watches the CONNECTION layer (sync_runs + client_connections),
// one step upstream of coverage.js (which watches the resulting facts). These tests
// pin the contract that makes it safe to put on autopilot:
//   • the six states classify correctly from the sync ledger;
//   • THE INVARIANT — auth failures are operator-gated (reconnect, retryable:false,
//     next_attempt_at:null), NEVER self-retried; transient failures self-heal with a
//     deterministic exponential backoff and only ESCALATE (still retrying) once
//     exhausted;
//   • error classification puts auth ahead of transient ("401 … timed out" = auth);
//   • secrets are redacted out of every excerpt before it can be stored/shown;
//   • the worst-first ordering + portfolio rollup the watchdog reads;
//   • client-audience narration is '' for EVERY state (leak-proof by construction);
//   • determinism (same input → byte-identical output) and the hard no-op on empty /
//     malformed input ("no connections" is never "everything broken").
// Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  assessConnectionHealth,
  assessConnection,
  summarizeConnectionHealth,
  narrateConnectionHealth,
  clientConnectionNote,
  classifyError,
  computeBackoff,
  redactError,
  hoursBetween,
  STATUS,
  ACTION,
  SEVERITY,
  DEFAULTS,
} = require('../lib/connectionHealth')

const ASOF = '2026-06-03T12:00:00.000Z'
const hoursBefore = h => new Date(Date.parse(ASOF) - h * 3600000).toISOString()
const daysBefore  = d => hoursBefore(d * 24)

// A connection row + sync_runs. `runs` newest-LAST is fine — the module sorts.
function conn(channel, extra = {}) {
  return { channel, is_active: true, last_synced_at: null, last_error: null, runs: [], ...extra }
}
const okRun  = (at, extra = {}) => ({ status: 'success', started_at: at, finished_at: at, rows_written: 100, ...extra })
const errRun = (at, error)      => ({ status: 'error',   started_at: at, finished_at: at, error })

// ── hoursBetween ─────────────────────────────────────────────────────────────
test('hoursBetween: signed fractional hours, null on bad input', () => {
  assert.equal(hoursBetween('2026-06-03T00:00:00Z', '2026-06-03T06:00:00Z'), 6)
  assert.equal(hoursBetween('2026-06-03T12:00:00Z', '2026-06-03T12:00:00Z'), 0)
  assert.equal(hoursBetween('2026-06-03T12:00:00Z', '2026-06-03T06:00:00Z'), -6)
  assert.equal(hoursBetween(null, ASOF), null)
  assert.equal(hoursBetween(ASOF, undefined), null)
  assert.equal(hoursBetween('nope', ASOF), null)
})

// ── classifyError ────────────────────────────────────────────────────────────
test('classifyError: auth fingerprints', () => {
  for (const t of ['invalid_grant', 'Token has been expired or revoked',
                   '401 Unauthorized', 'HTTP 403 Forbidden', 'insufficient scope',
                   'AADSTS700082 refresh token expired', 'please reconnect your account']) {
    assert.equal(classifyError(t), 'auth', t)
  }
})
test('classifyError: transient fingerprints', () => {
  for (const t of ['429 Too Many Requests', 'rate limit exceeded', 'ETIMEDOUT',
                   'socket hang up', '503 Service Unavailable', 'Internal Server Error',
                   'upstream timeout', 'temporarily unavailable']) {
    assert.equal(classifyError(t), 'transient', t)
  }
})
test('classifyError: auth WINS over a co-occurring transient token', () => {
  // A 401 that also mentions a timeout is an auth failure — retrying it is futile.
  assert.equal(classifyError('401 invalid_grant (request timed out upstream)'), 'auth')
})
test('classifyError: unrecognized → unknown; empty/null → null', () => {
  assert.equal(classifyError('weird provider hiccup #1234'), 'unknown')
  assert.equal(classifyError(''), null)
  assert.equal(classifyError('   '), null)
  assert.equal(classifyError(null), null)
  assert.equal(classifyError(undefined), null)
})

// ── computeBackoff ───────────────────────────────────────────────────────────
test('computeBackoff: doubles from base, clamps to [base, max], 0 below 1', () => {
  assert.equal(computeBackoff(0), 0)
  assert.equal(computeBackoff(-3), 0)
  assert.equal(computeBackoff(1), DEFAULTS.baseBackoffSeconds)          // 300
  assert.equal(computeBackoff(2), 600)
  assert.equal(computeBackoff(3), 1200)
  assert.equal(computeBackoff(4), 2400)
  // Large failure count saturates at the cap, never overflows.
  assert.equal(computeBackoff(99), DEFAULTS.maxBackoffSeconds)          // 21600
  assert.equal(computeBackoff(1e9), DEFAULTS.maxBackoffSeconds)
})
test('computeBackoff: honors custom base/max', () => {
  assert.equal(computeBackoff(1, { baseBackoffSeconds: 60, maxBackoffSeconds: 600 }), 60)
  assert.equal(computeBackoff(2, { baseBackoffSeconds: 60, maxBackoffSeconds: 600 }), 120)
  assert.equal(computeBackoff(20, { baseBackoffSeconds: 60, maxBackoffSeconds: 600 }), 600)
})

// ── redactError ──────────────────────────────────────────────────────────────
test('redactError: strips labelled secrets but keeps the human-readable code', () => {
  const out = redactError('401 invalid_grant: Bearer ya29.A0ARrdaM-VERYLONGSECRETTOKEN-abcdef123456 rejected')
  assert.match(out, /invalid_grant/)        // the useful code survives
  assert.doesNotMatch(out, /ya29\.A0ARrdaM/) // the token does not
  assert.match(out, /\[redacted\]/)
})
test('redactError: redacts any long unbroken token-ish run', () => {
  const out = redactError('signature mismatch: aGVsbG8gd29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBzZWNyZXQ')
  assert.match(out, /\[redacted\]/)
  assert.doesNotMatch(out, /aGVsbG8gd29ybGQ/)
})
test('redactError: single line, length-bounded; null passthrough', () => {
  const out = redactError('line one\n  line two   with   spaces'.padEnd(400, 'x'))
  assert.doesNotMatch(out, /\n/)
  assert.ok(out.length <= 160)
  assert.equal(redactError(null), null)
  assert.equal(redactError(''), null)
})

// ── HEALTHY ──────────────────────────────────────────────────────────────────
test('HEALTHY: a fresh, recently-succeeded connection', () => {
  const r = assessConnection(conn('google_ads', {
    last_synced_at: hoursBefore(3),
    runs: [okRun(hoursBefore(3))],
  }), ASOF)
  assert.equal(r.status, STATUS.HEALTHY)
  assert.equal(r.ok, true)
  assert.equal(r.needs_attention, false)
  assert.equal(r.severity, SEVERITY.NONE)
  assert.equal(r.recovery.action, ACTION.NONE)
  assert.equal(r.operator_required, false)
  assert.equal(r.recovery.next_attempt_at, null)
  assert.equal(r.failures, 0)
})

// ── STALE ────────────────────────────────────────────────────────────────────
test('STALE (info): succeeded but aging just past cadence → resync now', () => {
  // daily cadence: staleAt = 48h, veryStaleAt = 72h. 60h → STALE/info.
  const r = assessConnection(conn('meta', { last_synced_at: hoursBefore(60), runs: [okRun(hoursBefore(60))] }), ASOF)
  assert.equal(r.status, STATUS.STALE)
  assert.equal(r.severity, SEVERITY.INFO)
  assert.equal(r.needs_attention, false)        // info is surfaced, not alarmed
  assert.equal(r.recovery.action, ACTION.RESYNC)
  assert.equal(r.recovery.retryable, true)
  assert.equal(r.operator_required, false)
  assert.equal(r.recovery.next_attempt_at, ASOF) // "now"
})
test('STALE (warning): well past cadence (≥3×) escalates the tier', () => {
  const r = assessConnection(conn('ga4', { last_synced_at: hoursBefore(100), runs: [okRun(hoursBefore(100))] }), ASOF)
  assert.equal(r.status, STATUS.STALE)
  assert.equal(r.severity, SEVERITY.WARNING)
  assert.equal(r.needs_attention, true)
})
test('STALE respects a wider declared cadence (weekly feed silent 8d = healthy)', () => {
  const r = assessConnection(conn('gbp', {
    cadence_days: 7, last_synced_at: daysBefore(8), runs: [okRun(daysBefore(8))],
  }), ASOF, { cadenceDays: 7 })
  assert.equal(r.status, STATUS.HEALTHY)        // 8d < staleAt(14d) for a weekly feed
})

// ── ERRORING (transient self-heal) ───────────────────────────────────────────
test('ERRORING: transient failures after past success → retry w/ exponential backoff', () => {
  const r = assessConnection(conn('google_ads', {
    last_synced_at: daysBefore(2),
    runs: [errRun(hoursBefore(1), '503 Service Unavailable'),
           errRun(hoursBefore(7), 'ETIMEDOUT'),
           okRun(daysBefore(2))],
  }), ASOF)
  assert.equal(r.status, STATUS.ERRORING)
  assert.equal(r.failures, 2)
  assert.equal(r.error_class, 'transient')
  assert.equal(r.severity, SEVERITY.WARNING)
  assert.equal(r.needs_attention, true)
  assert.equal(r.recovery.action, ACTION.RETRY)
  assert.equal(r.recovery.retryable, true)
  assert.equal(r.operator_required, false)
  assert.equal(r.recovery.exhausted, false)
  assert.equal(r.recovery.backoff_seconds, 600)            // base·2^(2-1)
  // next attempt = last attempt (1h ago) + 600s
  assert.equal(r.recovery.next_attempt_at, new Date(Date.parse(hoursBefore(1)) + 600000).toISOString())
})
test('ERRORING exhausted: still retrying (plateaued) but ALSO escalates to a human', () => {
  // 8 consecutive failures: well past maxAttempts(6) → exhausted. Once exhausted the
  // backoff stops doubling and HOLDS at the maxAttempts plateau — a fixed slow-retry
  // cadence (computeBackoff(6) = 300·2^5 = 9600s), not the raw 21600 ceiling.
  const runs = []
  for (let i = 0; i < 8; i++) runs.push(errRun(hoursBefore(i + 1), '500 Internal Server Error'))
  const r = assessConnection(conn('meta', { last_synced_at: daysBefore(3), runs }), ASOF)
  assert.equal(r.status, STATUS.ERRORING)
  assert.equal(r.failures, 8)
  assert.equal(r.recovery.exhausted, true)
  assert.equal(r.recovery.action, ACTION.ESCALATE)
  assert.equal(r.recovery.retryable, true)                              // never fully gives up
  assert.equal(r.recovery.backoff_seconds, computeBackoff(DEFAULTS.maxAttempts)) // plateau, == 9600
  assert.equal(r.recovery.backoff_seconds, 9600)
  assert.ok(r.recovery.backoff_seconds < DEFAULTS.maxBackoffSeconds)    // ceiling not reached here
  assert.equal(r.severity, SEVERITY.CRITICAL)
  assert.equal(r.operator_required, false)                             // not an auth gate
})
test("ERRORING: 'running' (in-flight) runs don't reset or count the streak", () => {
  const r = assessConnection(conn('ghl', {
    last_synced_at: daysBefore(2),
    runs: [{ status: 'running', started_at: hoursBefore(0.2) },
           errRun(hoursBefore(2), 'timeout'),
           okRun(daysBefore(2))],
  }), ASOF)
  assert.equal(r.status, STATUS.ERRORING)
  assert.equal(r.failures, 1)                              // the running row is skipped
})

// ── AUTH_EXPIRED (the Class-C invariant) ─────────────────────────────────────
test('AUTH_EXPIRED: credential rejected after past success → RECONNECT, never self-retried', () => {
  const r = assessConnection(conn('google_ads', {
    last_synced_at: daysBefore(5),
    last_error: 'invalid_grant: Token has been expired or revoked.',
    runs: [errRun(hoursBefore(2), 'invalid_grant: Token has been expired or revoked.'),
           okRun(daysBefore(5))],
  }), ASOF)
  assert.equal(r.status, STATUS.AUTH_EXPIRED)
  assert.equal(r.error_class, 'auth')
  assert.equal(r.severity, SEVERITY.CRITICAL)
  assert.equal(r.needs_attention, true)
  // THE INVARIANT: operator gate, no self-heal, no auto-retry schedule.
  assert.equal(r.recovery.action, ACTION.RECONNECT)
  assert.equal(r.operator_required, true)
  assert.equal(r.recovery.operator_required, true)
  assert.equal(r.recovery.retryable, false)
  assert.equal(r.recovery.backoff_seconds, 0)
  assert.equal(r.recovery.next_attempt_at, null)
})
test('AUTH_EXPIRED takes precedence even with many consecutive failures', () => {
  const runs = []
  for (let i = 0; i < 9; i++) runs.push(errRun(hoursBefore(i + 1), '401 Unauthorized'))
  const r = assessConnection(conn('meta', { last_synced_at: daysBefore(10), runs }), ASOF)
  assert.equal(r.status, STATUS.AUTH_EXPIRED)   // not ERRORING/exhausted
  assert.equal(r.recovery.retryable, false)
  assert.equal(r.recovery.exhausted, false)
})

// ── NEVER_SYNCED ─────────────────────────────────────────────────────────────
test('NEVER_SYNCED (never_attempted): active, zero runs → await_schedule, info', () => {
  const r = assessConnection(conn('gbp'), ASOF)
  assert.equal(r.status, STATUS.NEVER_SYNCED)
  assert.equal(r.reason, 'never_attempted')
  assert.equal(r.severity, SEVERITY.INFO)
  assert.equal(r.recovery.action, ACTION.AWAIT_SCHEDULE)
  assert.equal(r.recovery.retryable, true)
  assert.equal(r.operator_required, false)
})
test('NEVER_SYNCED (auth): first sync failed on credentials → reconnect, critical', () => {
  const r = assessConnection(conn('google_ads', {
    runs: [errRun(hoursBefore(1), '403 Forbidden: insufficient scope')],
  }), ASOF)
  assert.equal(r.status, STATUS.NEVER_SYNCED)
  assert.equal(r.reason, 'never_synced_auth')
  assert.equal(r.severity, SEVERITY.CRITICAL)
  assert.equal(r.recovery.action, ACTION.RECONNECT)
  assert.equal(r.operator_required, true)
  assert.equal(r.recovery.retryable, false)
})
test('NEVER_SYNCED (transient): first sync hitting 5xx → retry/backoff', () => {
  const r = assessConnection(conn('meta', {
    runs: [errRun(hoursBefore(1), '502 Bad Gateway'), errRun(hoursBefore(3), 'ECONNRESET')],
  }), ASOF)
  assert.equal(r.status, STATUS.NEVER_SYNCED)
  assert.equal(r.reason, 'never_synced_retrying')
  assert.equal(r.recovery.action, ACTION.RETRY)
  assert.equal(r.recovery.retryable, true)
  assert.equal(r.recovery.backoff_seconds, 600)
  assert.equal(r.operator_required, false)
})

// ── DISABLED ─────────────────────────────────────────────────────────────────
test('DISABLED: operator paused it → no fault, no recovery', () => {
  const r = assessConnection(conn('ga4', {
    is_active: false, last_error: 'invalid_grant', runs: [errRun(hoursBefore(2), 'invalid_grant')],
  }), ASOF)
  assert.equal(r.status, STATUS.DISABLED)
  assert.equal(r.ok, true)                       // intentional, not unhealthy
  assert.equal(r.needs_attention, false)
  assert.equal(r.severity, SEVERITY.NONE)
  assert.equal(r.recovery.action, ACTION.NONE)
  assert.equal(r.operator_required, false)
})

// ── everSynced via last_synced_at alone (no runs loaded) ─────────────────────
test('last_synced_at alone proves prior success (HEALTHY without run history)', () => {
  const r = assessConnection(conn('ghl', { last_synced_at: hoursBefore(5), runs: [] }), ASOF)
  assert.equal(r.status, STATUS.HEALTHY)
})

// ── error_excerpt redaction at the record level ──────────────────────────────
test('record error_excerpt is redacted (no token leaks into the verdict)', () => {
  const r = assessConnection(conn('google_ads', {
    last_synced_at: daysBefore(2),
    runs: [errRun(hoursBefore(1), 'auth failed: refresh_token=1//09xSECRETxSECRETxSECRETxSECRETxSECRET denied'),
           okRun(daysBefore(2))],
  }), ASOF)
  assert.match(r.error_excerpt, /\[redacted\]/)
  assert.doesNotMatch(r.error_excerpt, /1\/\/09xSECRET/)
})

// ── assessConnectionHealth: no-op, skip, worst-first ─────────────────────────
test('assessConnectionHealth: empty / non-array / all-garbage → []', () => {
  assert.deepEqual(assessConnectionHealth([], ASOF), [])
  assert.deepEqual(assessConnectionHealth(null, ASOF), [])
  assert.deepEqual(assessConnectionHealth(undefined, ASOF), [])
  assert.deepEqual(assessConnectionHealth([null, {}, { channel: '' }], ASOF), [])
})
test('assessConnectionHealth: orders worst-first deterministically', () => {
  const recs = assessConnectionHealth([
    conn('healthy_ch',  { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }),
    conn('auth_ch',     { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }),
    conn('stale_ch',    { last_synced_at: hoursBefore(60), runs: [okRun(hoursBefore(60))] }),
    conn('erroring_ch', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] }),
  ], ASOF)
  assert.deepEqual(recs.map(r => r.channel), ['auth_ch', 'erroring_ch', 'stale_ch', 'healthy_ch'])
})
test('assessConnectionHealth: stable tie-break by channel; input order irrelevant', () => {
  const a = assessConnectionHealth([
    conn('zzz', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '500'), okRun(daysBefore(2))] }),
    conn('aaa', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '500'), okRun(daysBefore(2))] }),
  ], ASOF)
  const b = assessConnectionHealth([
    conn('aaa', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '500'), okRun(daysBefore(2))] }),
    conn('zzz', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '500'), okRun(daysBefore(2))] }),
  ], ASOF)
  assert.deepEqual(a.map(r => r.channel), ['aaa', 'zzz'])
  assert.deepEqual(b.map(r => r.channel), ['aaa', 'zzz'])  // order-independent
})

// ── summarizeConnectionHealth ────────────────────────────────────────────────
test('summarizeConnectionHealth: counts, gates, and earliest self-heal wake', () => {
  const recs = assessConnectionHealth([
    conn('h',  { last_synced_at: hoursBefore(2),  runs: [okRun(hoursBefore(2))] }),
    conn('a',  { last_synced_at: daysBefore(4),   runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }),
    conn('e',  { last_synced_at: daysBefore(2),   runs: [errRun(hoursBefore(3), '503'), okRun(daysBefore(2))] }),
    conn('s',  { last_synced_at: hoursBefore(60), runs: [okRun(hoursBefore(60))] }),
    conn('d',  { is_active: false }),
  ], ASOF)
  const sum = summarizeConnectionHealth(recs)
  assert.equal(sum.total, 5)
  assert.equal(sum.counts.HEALTHY, 1)
  assert.equal(sum.counts.AUTH_EXPIRED, 1)
  assert.equal(sum.counts.ERRORING, 1)
  assert.equal(sum.counts.STALE, 1)
  assert.equal(sum.counts.DISABLED, 1)
  assert.equal(sum.operator_required, 1)        // the auth one
  assert.equal(sum.self_healing, 2)             // erroring(retry) + stale(resync)
  assert.equal(sum.worst_severity, SEVERITY.CRITICAL)
  assert.equal(sum.worst_status, STATUS.AUTH_EXPIRED)
  assert.equal(sum.ok, false)
  // next_wake_at = the EARLIEST recovery.next_attempt_at across the book. The
  // erroring channel last tried 3h ago; +300s backoff puts its next attempt at
  // 09:05Z (already past-due), which beats the STALE resync's "now" (12:00Z).
  // The watchdog wakes at the earliest pending attempt — so 09:05Z wins.
  assert.equal(sum.next_wake_at, new Date(Date.parse(hoursBefore(3)) + 300000).toISOString())
})
test('summarizeConnectionHealth: an all-healthy/disabled portfolio is ok with no wake', () => {
  const recs = assessConnectionHealth([
    conn('h1', { last_synced_at: hoursBefore(1), runs: [okRun(hoursBefore(1))] }),
    conn('d1', { is_active: false }),
  ], ASOF)
  const sum = summarizeConnectionHealth(recs)
  assert.equal(sum.ok, true)
  assert.equal(sum.needs_attention, 0)
  assert.equal(sum.operator_required, 0)
  assert.equal(sum.next_wake_at, null)
})
test('summarizeConnectionHealth: empty / garbage → zeroed, ok', () => {
  const sum = summarizeConnectionHealth([])
  assert.equal(sum.total, 0)
  assert.equal(sum.ok, true)
  assert.equal(sum.next_wake_at, null)
  assert.deepEqual(summarizeConnectionHealth(null).counts,
    { HEALTHY: 0, STALE: 0, ERRORING: 0, AUTH_EXPIRED: 0, NEVER_SYNCED: 0, DISABLED: 0 })
})

// ── narrateConnectionHealth ──────────────────────────────────────────────────
test('narrateConnectionHealth (agency): one actionable line per degraded state', () => {
  const auth = assessConnection(conn('Google Ads'.toLowerCase ? 'google_ads' : 'google_ads', {
    label: 'Google Ads', last_synced_at: daysBefore(4),
    runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))],
  }), ASOF)
  assert.match(narrateConnectionHealth(auth), /Reconnect Google Ads/)
  const err = assessConnection(conn('meta', { label: 'Meta', last_synced_at: daysBefore(2),
    runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] }), ASOF)
  assert.match(narrateConnectionHealth(err), /Meta sync is failing/)
  const stale = assessConnection(conn('ga4', { label: 'GA4', last_synced_at: hoursBefore(60),
    runs: [okRun(hoursBefore(60))] }), ASOF)
  assert.match(narrateConnectionHealth(stale), /resync/)
})
test('narrateConnectionHealth (agency): HEALTHY / DISABLED / first-sync-pending → ""', () => {
  const h = assessConnection(conn('x', { last_synced_at: hoursBefore(1), runs: [okRun(hoursBefore(1))] }), ASOF)
  const d = assessConnection(conn('y', { is_active: false }), ASOF)
  const n = assessConnection(conn('z'), ASOF)  // never_attempted
  assert.equal(narrateConnectionHealth(h), '')
  assert.equal(narrateConnectionHealth(d), '')
  assert.equal(narrateConnectionHealth(n), '')
})
test('narration never embeds the raw provider error (only the abstracted state)', () => {
  const r = assessConnection(conn('google_ads', { label: 'Google Ads', last_synced_at: daysBefore(2),
    runs: [errRun(hoursBefore(1), 'boom SUPERSECRETTOKEN0123456789abcdef leaked'), okRun(daysBefore(2))] }), ASOF)
  const line = narrateConnectionHealth(r)
  assert.doesNotMatch(line, /SUPERSECRETTOKEN/)
})
test('narrateConnectionHealth (client audience): "" for EVERY state — leak-proof by construction', () => {
  const samples = [
    conn('a', { last_synced_at: hoursBefore(1), runs: [okRun(hoursBefore(1))] }),                                  // HEALTHY
    conn('b', { last_synced_at: hoursBefore(60), runs: [okRun(hoursBefore(60))] }),                                // STALE
    conn('c', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] }),     // ERRORING
    conn('d', { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }), // AUTH
    conn('e', { runs: [errRun(hoursBefore(1), '401')] }),                                                          // NEVER_SYNCED auth
    conn('f'),                                                                                                     // NEVER_SYNCED pending
    conn('g', { is_active: false }),                                                                               // DISABLED
  ]
  for (const c of samples) {
    const r = assessConnection(c, ASOF)
    assert.equal(narrateConnectionHealth(r, { audience: 'client' }), '', r.status)
  }
  assert.equal(narrateConnectionHealth(null, { audience: 'client' }), '')
})

// ── determinism + robustness ─────────────────────────────────────────────────
test('determinism: identical input → byte-identical output', () => {
  const build = () => assessConnectionHealth([
    conn('a', { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }),
    conn('e', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), errRun(hoursBefore(5), 'timeout'), okRun(daysBefore(2))] }),
    conn('h', { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }),
  ], ASOF)
  assert.equal(JSON.stringify(build()), JSON.stringify(build()))
})
test('robustness: malformed rows never throw', () => {
  assert.doesNotThrow(() => assessConnectionHealth([
    { channel: 'a', runs: 'not-an-array' },
    { channel: 'b', runs: [null, { status: 'weird' }, { status: 'error' }] },
    { channel: 'c', last_synced_at: 'not-a-date', runs: [{ status: 'success', started_at: 'nope' }] },
    { channel: 'd', is_active: false },
  ], ASOF))
})
test('assessConnection: missing channel → null (skipped, not thrown)', () => {
  assert.equal(assessConnection({ runs: [] }, ASOF), null)
  assert.equal(assessConnection(null, ASOF), null)
})
test('missing asOf: error/auth states still classify; undated-success reads HEALTHY', () => {
  const auth = assessConnection(conn('a', { last_synced_at: daysBefore(4),
    runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }), null)
  assert.equal(auth.status, STATUS.AUTH_EXPIRED)          // doesn't need asOf
  const h = assessConnection(conn('b', { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }), null)
  assert.equal(h.status, STATUS.HEALTHY)                  // can't prove stale w/o asOf
})

// ── clientConnectionNote (A4): the ONE leak-proof client-facing egress ─────────
// Tokens the deliberately-vague note must NEVER contain — agency taxonomy, counts,
// recovery machinery, the credential vocabulary, and any ask directed at the client.
const FORBIDDEN_NOTE_TOKENS = [
  // status taxonomy
  'healthy', 'stale', 'erroring', 'auth_expired', 'never_synced', 'disabled',
  // recovery / machinery vocabulary
  'reconnect', 'sign-in', 'sign in', 'log in', 'login', 'token', 'credential',
  'oauth', 'authorize', 'authoriz', 'expired', 'expire', 'revoked', 'backoff',
  'retry', 'retries', 'attempt', 'escalate', 'operator', 'sync', 'error', 'fail',
  // imperative asks (the client must never be told to act — reconnecting is ours)
  'please', 'click', 'you need', 'you must', 'visit', 'go to',
]
// Assert a note string is free of every forbidden token AND carries no integer count.
function assertNoteLeakProof(note) {
  const low = String(note).toLowerCase()
  for (const t of FORBIDDEN_NOTE_TOKENS) {
    assert.ok(!low.includes(t), `note leaked forbidden token "${t}": ${note}`)
  }
  assert.ok(!/\d/.test(note), `note leaked a numeric count: ${note}`)
}

test('clientConnectionNote: all-healthy/disabled → not degraded, empty note', () => {
  const recs = assessConnectionHealth([
    conn('a', { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }),  // HEALTHY
    conn('b', { is_active: false }),                                               // DISABLED
  ], ASOF)
  assert.deepEqual(clientConnectionNote(recs), { degraded: false, severity: 'none', note: '' })
})

test('clientConnectionNote: empty / non-array / all-garbage → not degraded', () => {
  for (const input of [[], null, undefined, 'nope', [null, undefined]]) {
    assert.deepEqual(clientConnectionNote(input), { degraded: false, severity: 'none', note: '' })
  }
})

test('clientConnectionNote: self-healing only (no operator gate) → info tone, no action ask', () => {
  const recs = assessConnectionHealth([
    conn('a', { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }),                         // HEALTHY
    conn('b', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] }), // ERRORING (transient)
    conn('c', { last_synced_at: hoursBefore(60), runs: [okRun(hoursBefore(60))] }),                       // STALE
  ], ASOF)
  // sanity: this fixture must NOT contain an operator-gated feed
  assert.ok(!recs.some(r => r.operator_required))
  const out = clientConnectionNote(recs)
  assert.equal(out.degraded, true)
  assert.equal(out.severity, 'info')
  assert.ok(out.note.length > 0)
  assertNoteLeakProof(out.note)
})

test('clientConnectionNote: any operator-gated feed → notice tone ("team is on it"), still leak-proof', () => {
  const recs = assessConnectionHealth([
    conn('a', { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }),                         // HEALTHY
    conn('b', { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }), // AUTH_EXPIRED (operator)
    conn('c', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] }), // ERRORING (transient)
  ], ASOF)
  assert.ok(recs.some(r => r.operator_required))   // sanity: an auth gate is present
  const out = clientConnectionNote(recs)
  assert.equal(out.degraded, true)
  assert.equal(out.severity, 'notice')
  assert.ok(out.note.length > 0)
  assertNoteLeakProof(out.note)
})

test('clientConnectionNote: a brand-new first-sync-pending feed rides the gentle info tone', () => {
  const recs = assessConnectionHealth([
    conn('a', { last_synced_at: hoursBefore(2), runs: [okRun(hoursBefore(2))] }),  // HEALTHY
    conn('z'),                                                                     // NEVER_SYNCED (never attempted)
  ], ASOF)
  const out = clientConnectionNote(recs)
  assert.equal(out.degraded, true)
  assert.equal(out.severity, 'info')
  assertNoteLeakProof(out.note)
})

test('clientConnectionNote: EVERY degraded note across all degraded states is leak-proof', () => {
  // Drive each non-healthy/non-disabled status through the note and audit the wording.
  const states = [
    [conn('s', { last_synced_at: hoursBefore(60), runs: [okRun(hoursBefore(60))] })],                          // STALE
    [conn('e', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] })], // ERRORING
    [conn('x', { last_synced_at: daysBefore(2), runs: Array.from({ length: 8 }, (_, i) => errRun(hoursBefore(i + 1), '500')).concat(okRun(daysBefore(2))) })], // ERRORING exhausted
    [conn('a', { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] })], // AUTH_EXPIRED
    [conn('n', { runs: [errRun(hoursBefore(1), '401')] })],                                                     // NEVER_SYNCED auth
    [conn('m', { runs: [errRun(hoursBefore(1), '503')] })],                                                     // NEVER_SYNCED transient
    [conn('p')],                                                                                                // NEVER_SYNCED pending
  ]
  for (const s of states) {
    const recs = assessConnectionHealth(s, ASOF)
    const out  = clientConnectionNote(recs)
    assert.equal(out.degraded, true, recs[0] && recs[0].status)
    assert.ok(['info', 'notice'].includes(out.severity))
    assertNoteLeakProof(out.note)
  }
})

test('clientConnectionNote: deterministic — identical input → identical output', () => {
  const recs = assessConnectionHealth([
    conn('a', { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }),
    conn('b', { last_synced_at: daysBefore(2), runs: [errRun(hoursBefore(1), '503'), okRun(daysBefore(2))] }),
  ], ASOF)
  assert.equal(JSON.stringify(clientConnectionNote(recs)), JSON.stringify(clientConnectionNote(recs)))
})

test('clientConnectionNote: shape is exactly {degraded,severity,note} — no machinery rides along', () => {
  const recs = assessConnectionHealth([
    conn('a', { last_synced_at: daysBefore(4), runs: [errRun(hoursBefore(1), 'invalid_grant'), okRun(daysBefore(4))] }),
  ], ASOF)
  const out = clientConnectionNote(recs)
  assert.deepEqual(Object.keys(out).sort(), ['degraded', 'note', 'severity'])
})
