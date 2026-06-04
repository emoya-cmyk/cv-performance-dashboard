// ============================================================
// test/connectionWatchdog.test.js — the self-healing pipeline's HAND (lib/connectionWatchdog.js)
//
// connectionHealth.js is the BRAIN (records-in / verdicts-out, pure). This module is
// the HAND that acts on those verdicts against the live DB. These tests pin the contract
// that makes it safe to put the actuator on a 15-minute cron:
//   • selectDueConnections (PURE GATE) — auto-retry iff retryable && NOT operator_required
//     (checked on BOTH the record AND its recovery) && next_attempt_at has ARRIVED;
//     THE CLASS-C INVARIANT — an AUTH/operator-gated connection is NEVER selected;
//     an EXHAUSTED-but-retryable connection (action 'escalate') IS still selected
//     (escalate means "also tell a human," never "stop retrying"); a future / null /
//     garbage next_attempt_at is never due; an unparseable asOf fires nothing.
//   • loadConnectionStates — shapes rows into the brain's exact `conn` grain via an
//     injected query; the is_active coercion fix (SQLite 0 → real false, so a disabled
//     connection classifies DISABLED instead of slipping through ACTIVE); runs bucketed
//     newest-first per (client,channel) and capped; cross-(client,channel) isolation;
//     empty connections → [] WITHOUT touching sync_runs; clientId → $1 on both queries.
//   • assessConnectionStates — threads client_id back onto each record, worst-first
//     across clients, rolls up the summary.
//   • runConnectionWatchdog — the orchestrator with injected query + spy runSync: a due
//     transient IS re-synced (runSync(clientId, channel)), an AUTH connection is NEVER
//     re-synced, a throwing runSync is isolated (sweep still completes), deterministic
//     under a fixed asOf, and a missing query/runSync dep throws.
// Pure/deterministic: no DB, no clock, no network — every side effect is injected.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  loadConnectionStates,
  assessConnectionStates,
  selectDueConnections,
  runConnectionWatchdog,
  toBool,
} = require('../lib/connectionWatchdog')

const ASOF   = '2026-06-03T12:00:00.000Z'
const PAST   = '2026-06-03T11:00:00.000Z'   // before ASOF
const FUTURE = '2026-06-03T13:00:00.000Z'   // after ASOF

// A fake `query` that branches on the SQL: client_connections vs sync_runs. Records every
// call (sql + args) so tests can assert WHICH queries ran and with what params.
function fakeQuery(conns, runs) {
  const calls = []
  const q = async (sql, args) => {
    calls.push({ sql, args })
    if (/sync_runs/.test(sql))         return { rows: runs }
    if (/client_connections/.test(sql)) return { rows: conns }
    return { rows: [] }
  }
  q.calls = calls
  return q
}

// The canonical 3-connection portfolio used by the orchestrator tests, shaped so the real
// brain produces exactly: ghl=HEALTHY (not due), google_ads=ERRORING/transient DUE,
// meta=AUTH_EXPIRED (operator-gated, never due).
function portfolio() {
  const conns = [
    { client_id: 'cli_1', channel: 'ghl',        is_active: 1, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null },
    { client_id: 'cli_1', channel: 'google_ads', is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: '503 Service Unavailable' },
    { client_id: 'cli_1', channel: 'meta',       is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: 'invalid_grant' },
  ]
  const runs = [
    { client_id: 'cli_1', channel: 'ghl',        status: 'success', started_at: '2026-06-03T11:55:00.000Z', finished_at: '2026-06-03T11:56:00.000Z', rows_written: 10, error: null },
    { client_id: 'cli_1', channel: 'meta',       status: 'error',   started_at: '2026-06-03T11:30:00.000Z', finished_at: null, rows_written: 0, error: 'invalid_grant' },
    { client_id: 'cli_1', channel: 'google_ads', status: 'error',   started_at: '2026-06-03T11:00:00.000Z', finished_at: null, rows_written: 0, error: '503 Service Unavailable' },
  ]
  return { conns, runs }
}

// ── toBool — the is_active coercion fix at the loader boundary ────────────────────────
test('toBool — DB falsy (0/"0"/false/null/undefined) → false; everything else → true', () => {
  assert.equal(toBool(0), false)
  assert.equal(toBool('0'), false)
  assert.equal(toBool(false), false)
  assert.equal(toBool(null), false)
  assert.equal(toBool(undefined), false)
  assert.equal(toBool(1), true)
  assert.equal(toBool('1'), true)
  assert.equal(toBool(true), true)
  assert.equal(toBool('t'), true)
})

// ── selectDueConnections — THE auto-heal gate (PURE) ──────────────────────────────────
// Minimal hand-built records so each gate condition is isolated from the brain.
function rec({ op = false, retryable = true, recOp = false, next = PAST, action = 'retry' } = {}) {
  return { channel: 'c', client_id: 'A', operator_required: op, status: 'ERRORING',
    recovery: { retryable, operator_required: recOp, next_attempt_at: next, action } }
}

test('selectDueConnections — a due transient connection is selected', () => {
  assert.equal(selectDueConnections([rec({})], ASOF).length, 1)
})

test('selectDueConnections — THE INVARIANT: an AUTH/operator-gated connection is NEVER selected', () => {
  const auth = { channel: 'meta', client_id: 'A', operator_required: true,
    recovery: { retryable: false, operator_required: true, next_attempt_at: null, action: 'reconnect' } }
  assert.equal(selectDueConnections([auth], ASOF).length, 0)
})

test('selectDueConnections — an EXHAUSTED-but-retryable (escalate) connection IS still selected', () => {
  // escalate means "also tell a human," never "stop retrying" — backoff plateaus, retries continue.
  const exhausted = { channel: 'c', client_id: 'A', operator_required: false,
    recovery: { retryable: true, operator_required: false, next_attempt_at: PAST, action: 'escalate', exhausted: true } }
  assert.equal(selectDueConnections([exhausted], ASOF).length, 1)
})

test('selectDueConnections — future / null / garbage next_attempt_at is never due', () => {
  assert.equal(selectDueConnections([rec({ next: FUTURE })], ASOF).length, 0)
  assert.equal(selectDueConnections([rec({ next: null })], ASOF).length, 0)
  assert.equal(selectDueConnections([rec({ next: 'garbage' })], ASOF).length, 0)
})

test('selectDueConnections — boundary: next_attempt_at == asOf is due (<=)', () => {
  assert.equal(selectDueConnections([rec({ next: ASOF })], ASOF).length, 1)
})

test('selectDueConnections — belt-and-suspenders: operator_required on the RECOVERY blocks selection', () => {
  assert.equal(selectDueConnections([rec({ op: false, recOp: true })], ASOF).length, 0)
})

test('selectDueConnections — operator_required on the RECORD blocks even a clean recovery', () => {
  const r = { channel: 'c', client_id: 'A', operator_required: true,
    recovery: { retryable: true, operator_required: false, next_attempt_at: PAST } }
  assert.equal(selectDueConnections([r], ASOF).length, 0)
})

test('selectDueConnections — retryable:false (non-auth) is not selected', () => {
  assert.equal(selectDueConnections([rec({ retryable: false })], ASOF).length, 0)
})

test('selectDueConnections — a missing recovery is skipped, never thrown on', () => {
  assert.equal(selectDueConnections([{ channel: 'c', operator_required: false }], ASOF).length, 0)
})

test('selectDueConnections — an unparseable asOf fires nothing (never retry blindly)', () => {
  assert.deepEqual(selectDueConnections([rec({})], 'not-a-date'), [])
})

test('selectDueConnections — non-array input → [] (hard no-op)', () => {
  assert.deepEqual(selectDueConnections(null, ASOF), [])
  assert.deepEqual(selectDueConnections(undefined, ASOF), [])
})

test('selectDueConnections — mixed list returns exactly the due records', () => {
  const due1 = rec({ next: PAST })
  const due2 = rec({ next: ASOF, action: 'escalate' })
  const notDueFuture = rec({ next: FUTURE })
  const auth = { channel: 'meta', operator_required: true,
    recovery: { retryable: false, operator_required: true, next_attempt_at: null } }
  const out = selectDueConnections([due1, auth, notDueFuture, due2], ASOF)
  assert.equal(out.length, 2)
  assert.ok(out.includes(due1) && out.includes(due2))
})

// ── loadConnectionStates — shaping rows into the brain's input grain ───────────────────
test('loadConnectionStates — is_active coercion: 0/false → conn.is_active === false (DISABLED fix)', async () => {
  const conns = [
    { client_id: 'A', channel: 'disabled_int',  is_active: 0,     last_synced_at: null, last_error: null },
    { client_id: 'A', channel: 'active_int',     is_active: 1,     last_synced_at: '2026-06-03T11:00:00.000Z', last_error: null },
    { client_id: 'A', channel: 'disabled_bool',  is_active: false, last_synced_at: null, last_error: null },
    { client_id: 'A', channel: 'active_bool',    is_active: true,  last_synced_at: null, last_error: null },
  ]
  const states = await loadConnectionStates(fakeQuery(conns, []))
  const byCh = Object.fromEntries(states.map((s) => [s.channel, s.conn.is_active]))
  assert.equal(byCh.disabled_int, false)   // the coercion fix — raw SQLite 0 would be !== false
  assert.equal(byCh.active_int, true)
  assert.equal(byCh.disabled_bool, false)
  assert.equal(byCh.active_bool, true)

  // …and it carries through the brain: the disabled one classifies DISABLED, not ACTIVE.
  const { records } = assessConnectionStates(states, ASOF)
  const disabled = records.find((r) => r.channel === 'disabled_int')
  assert.equal(disabled.status, 'DISABLED')
})

test('loadConnectionStates — runs bucketed newest-first per channel and capped at runsPerChannel', async () => {
  const conns = [{ client_id: 'A', channel: 'google_ads', is_active: 1, last_synced_at: null, last_error: null }]
  const runs = [ // already DESC by started_at, as the real SQL returns
    { client_id: 'A', channel: 'google_ads', status: 'error', started_at: '2026-06-03T11:00:00.000Z', error: 'e1' },
    { client_id: 'A', channel: 'google_ads', status: 'error', started_at: '2026-06-03T10:00:00.000Z', error: 'e2' },
    { client_id: 'A', channel: 'google_ads', status: 'error', started_at: '2026-06-03T09:00:00.000Z', error: 'e3' },
  ]
  const states = await loadConnectionStates(fakeQuery(conns, runs), { runsPerChannel: 2 })
  assert.equal(states[0].conn.runs.length, 2)        // capped
  assert.equal(states[0].conn.runs[0].error, 'e1')   // newest first preserved
  assert.equal(states[0].conn.runs[1].error, 'e2')
})

test('loadConnectionStates — runs never leak across (client, channel)', async () => {
  const conns = [
    { client_id: 'A', channel: 'google_ads', is_active: 1, last_synced_at: null, last_error: null },
    { client_id: 'B', channel: 'google_ads', is_active: 1, last_synced_at: null, last_error: null },
  ]
  const runs = [
    { client_id: 'A', channel: 'google_ads', status: 'success', started_at: '2026-06-03T11:00:00.000Z', error: null, rows_written: 5 },
    { client_id: 'B', channel: 'google_ads', status: 'error',   started_at: '2026-06-03T10:00:00.000Z', error: 'oops', rows_written: 0 },
  ]
  const states = await loadConnectionStates(fakeQuery(conns, runs))
  const A = states.find((s) => s.client_id === 'A')
  const B = states.find((s) => s.client_id === 'B')
  assert.equal(A.conn.runs.length, 1)
  assert.equal(A.conn.runs[0].status, 'success')
  assert.equal(B.conn.runs.length, 1)
  assert.equal(B.conn.runs[0].status, 'error')
})

test('loadConnectionStates — empty connections → [] WITHOUT querying sync_runs', async () => {
  const q = fakeQuery([], [{ client_id: 'A', channel: 'x', status: 'error' }])
  const states = await loadConnectionStates(q)
  assert.deepEqual(states, [])
  assert.equal(q.calls.length, 1)                       // only the connections query ran
  assert.match(q.calls[0].sql, /client_connections/)
})

test('loadConnectionStates — clientId scopes BOTH queries with $1', async () => {
  const conns = [{ client_id: 'A', channel: 'ghl', is_active: 1, last_synced_at: null, last_error: null }]
  const q = fakeQuery(conns, [])
  await loadConnectionStates(q, { clientId: 'A' })
  assert.equal(q.calls.length, 2)
  assert.match(q.calls[0].sql, /client_connections/)
  assert.match(q.calls[0].sql, /WHERE client_id = \$1/)
  assert.deepEqual(q.calls[0].args, ['A'])
  assert.match(q.calls[1].sql, /sync_runs/)
  assert.match(q.calls[1].sql, /WHERE client_id = \$1/)
  assert.deepEqual(q.calls[1].args, ['A'])
})

test('loadConnectionStates — shapes the brain grain: label defaults to channel, nulls coalesced', async () => {
  const conns = [{ client_id: 'A', channel: 'ghl', is_active: 1, last_synced_at: undefined, last_error: undefined }]
  const states = await loadConnectionStates(fakeQuery(conns, []))
  assert.equal(states[0].conn.channel, 'ghl')
  assert.equal(states[0].conn.label, 'ghl')
  assert.equal(states[0].conn.last_synced_at, null)
  assert.equal(states[0].conn.last_error, null)
  assert.deepEqual(states[0].conn.runs, [])
})

// ── assessConnectionStates — run the brain, thread client_id, sort, summarize ──────────
test('assessConnectionStates — threads client_id onto records and sorts worst-first across clients', () => {
  const states = [
    { client_id: 'A', conn: { channel: 'ghl', is_active: true, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null,
      runs: [{ status: 'success', started_at: '2026-06-03T11:55:00.000Z' }] } },
    { client_id: 'B', conn: { channel: 'meta', is_active: true, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: 'invalid_grant',
      runs: [{ status: 'error', started_at: '2026-06-03T11:30:00.000Z', error: 'invalid_grant' }] } },
  ]
  const { records, summary } = assessConnectionStates(states, ASOF)
  assert.equal(records.length, 2)
  assert.equal(records[0].client_id, 'B')          // AUTH critical sorts first
  assert.equal(records[0].channel, 'meta')
  assert.equal(records[0].status, 'AUTH_EXPIRED')
  assert.equal(records[1].client_id, 'A')
  assert.equal(records[1].status, 'HEALTHY')
  assert.equal(summary.total, 2)
  assert.equal(summary.operator_required, 1)
})

test('assessConnectionStates — client_id falls back to conn.client_id, then null', () => {
  const states = [
    { client_id: null, conn: { client_id: 'Z', channel: 'ghl', is_active: true, last_synced_at: '2026-06-03T11:55:00.000Z',
      runs: [{ status: 'success', started_at: '2026-06-03T11:55:00.000Z' }] } },
  ]
  const { records } = assessConnectionStates(states, ASOF)
  assert.equal(records[0].client_id, 'Z')
})

test('assessConnectionStates — skips states with no conn and rows with no channel', () => {
  const states = [
    null,
    { client_id: 'A' },                                   // no conn
    { client_id: 'A', conn: { channel: '', runs: [] } },  // brain returns null (no channel)
  ]
  const { records, summary } = assessConnectionStates(states, ASOF)
  assert.deepEqual(records, [])
  assert.equal(summary.total, 0)
})

test('assessConnectionStates — non-array input → empty records + zeroed summary', () => {
  const { records, summary } = assessConnectionStates(null, ASOF)
  assert.deepEqual(records, [])
  assert.equal(summary.total, 0)
  assert.equal(summary.operator_required, 0)
})

// ── runConnectionWatchdog — the orchestrator (every side effect injected) ──────────────
test('runConnectionWatchdog — re-syncs the due transient and NEVER the AUTH connection', async () => {
  const { conns, runs } = portfolio()
  const calls = []
  const runSync = async (cid, ch) => { calls.push([cid, ch]); return { ok: true, rows: 7 } }
  const out = await runConnectionWatchdog({ query: fakeQuery(conns, runs), runSync, asOf: ASOF })

  assert.equal(out.scanned, 3)
  assert.equal(out.due, 1)
  assert.equal(out.healed, 1)
  assert.equal(out.failed, 0)
  assert.equal(out.operator_required, 1)               // meta (AUTH) surfaced for a human
  assert.deepEqual(calls, [['cli_1', 'google_ads']])   // ONLY the due transient; AUTH never re-synced
  assert.equal(out.as_of, ASOF)
  assert.equal(out.healed_detail[0].channel, 'google_ads')
  assert.equal(out.healed_detail[0].from_status, 'ERRORING')
  assert.equal(out.healed_detail[0].action, 'retry')
  assert.equal(out.healed_detail[0].rows, 7)
})

test('runConnectionWatchdog — a throwing runSync is isolated; the sweep still completes', async () => {
  const { conns, runs } = portfolio()
  const runSync = async () => { throw new Error('network blip ECONNRESET') }
  const out = await runConnectionWatchdog({ query: fakeQuery(conns, runs), runSync, asOf: ASOF })

  assert.equal(out.healed, 0)
  assert.equal(out.failed, 1)
  assert.equal(out.failed_detail[0].channel, 'google_ads')
  assert.equal(typeof out.failed_detail[0].error, 'string')
  assert.ok(out.failed_detail[0].error.length > 0)
  assert.equal(out.operator_required, 1)               // AUTH still surfaced even though the heal failed
})

test('runConnectionWatchdog — deterministic under a fixed asOf (byte-identical output)', async () => {
  const { conns, runs } = portfolio()
  const okSync = async () => ({ ok: true, rows: 7 })
  const a = await runConnectionWatchdog({ query: fakeQuery(conns, runs), runSync: okSync, asOf: ASOF })
  const b = await runConnectionWatchdog({ query: fakeQuery(conns, runs), runSync: okSync, asOf: ASOF })
  assert.deepEqual(a, b)
})

test('runConnectionWatchdog — logs each re-sync through the injected logger', async () => {
  const { conns, runs } = portfolio()
  const logged = []
  const logger = { log: (m) => logged.push(m) }
  await runConnectionWatchdog({ query: fakeQuery(conns, runs), runSync: async () => ({ rows: 7 }), asOf: ASOF, logger })
  assert.ok(logged.some((m) => /re-synced/.test(m)))
})

test('runConnectionWatchdog — a missing query or runSync dep throws (fail-fast wiring guard)', async () => {
  await assert.rejects(() => runConnectionWatchdog({ runSync: async () => {} }), /query/)
  await assert.rejects(() => runConnectionWatchdog({ query: async () => ({ rows: [] }) }), /runSync/)
})

test('runConnectionWatchdog — an all-healthy portfolio heals nothing and calls runSync zero times', async () => {
  const conns = [{ client_id: 'A', channel: 'ghl', is_active: 1, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null }]
  const runs = [{ client_id: 'A', channel: 'ghl', status: 'success', started_at: '2026-06-03T11:55:00.000Z', finished_at: '2026-06-03T11:56:00.000Z', rows_written: 9, error: null }]
  const calls = []
  const out = await runConnectionWatchdog({ query: fakeQuery(conns, runs), runSync: async (c, ch) => { calls.push([c, ch]); return { rows: 0 } }, asOf: ASOF })
  assert.equal(out.scanned, 1)
  assert.equal(out.due, 0)
  assert.equal(out.healed, 0)
  assert.equal(calls.length, 0)
})
