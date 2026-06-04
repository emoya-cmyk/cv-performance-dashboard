// ============================================================
// test/insights.connectionNote.egress.test.js — intel-v11 A4 the SERIALIZED-PAYLOAD leak test
//
// connectionHealth.test.js already pins clientConnectionNote in ISOLATION (the note string
// alone is leak-proof). This file pins the stronger, end-to-end claim that A4 actually owes:
// when the brain's worst-case verdict — a LIVE auth failure, the record that carries the most
// sensitive agency machinery (channel identity, redacted error excerpt, operator_required,
// backoff/attempt counters, status taxonomy) — flows through the EXACT production read path
// the route uses (loadConnectionStates → assessConnectionStates → clientConnectionNote) and is
// assembled onto a per-client wire payload and SERIALIZED, none of that machinery survives the
// JSON. The single deliberately-vague note string is the only thing that rides the wire.
//
// Why a separate file: the reallocation/efficacy confinement blocks seed NO connection_state
// rows, so their connection_note resolves to '' — they prove the key is PRESENT and benign, but
// they can't prove the egress is leak-proof when the note is NON-empty. Here we seed a rich,
// operator-gated portfolio on purpose, then prove (a) the wire is clean AND (b) the upstream
// agency verdict genuinely carries the machinery being dropped — so the test can never pass
// vacuously. We also prove the note is BLIND to channel identity: two portfolios that fail on
// entirely different channels must serialize byte-identically.
//
// Pure/deterministic: no DB, no clock, no network. The query is injected (fakeQuery), the clock
// is a fixed ASOF — mirroring how connectionWatchdog.test.js exercises this same read chain.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

// The EXACT production read chain the A4 getter (getClientConnectionNote) walks: the loader and
// portfolio assessor live in the watchdog (the HAND), the client egress in the brain.
const { loadConnectionStates, assessConnectionStates } = require('../lib/connectionWatchdog')
const { clientConnectionNote } = require('../lib/connectionHealth')

const ASOF = '2026-06-03T12:00:00.000Z'

// The two — and ONLY two — strings the client may ever see. Apostrophe-free (they are baked into
// a JS string literal in the brain, where an apostrophe would terminate the literal) and, by
// design, digit-free and taxonomy-free.
const NOTICE = 'Some of your data is refreshing more slowly than usual. Your team is already on it, so no action is needed on your end.'
const INFO   = 'Some of your data is still catching up and is refreshing on its own. Nothing is needed on your end.'

// A fake `query` that branches on the SQL exactly like the watchdog tests: client_connections
// rows vs sync_runs rows. loadConnectionStates shapes these into the brain's `conn` grain.
function fakeQuery(conns, runs) {
  return async (sql) => {
    if (/sync_runs/.test(sql))          return { rows: runs }
    if (/client_connections/.test(sql)) return { rows: conns }
    return { rows: [] }
  }
}

// Walk the real getter chain WITHOUT a DB: shape rows → assess portfolio → derive client note.
// Returns BOTH the rich agency assessment (never serialized to a client) and the client note,
// so a test can audit the gap between them.
async function readChain(conns, runs, clientId) {
  const states   = await loadConnectionStates(fakeQuery(conns, runs), { clientId })
  const assessed = assessConnectionStates(states, ASOF, {})
  const note     = clientConnectionNote(assessed.records)
  return { assessed, note }
}

// Tokens the SERIALIZED wire payload must NEVER contain — the brain's whole machinery vocabulary:
// channel/provider identity, the seeded error excerpts, the status taxonomy, the brain's own
// severity VALUES (warning/critical — note: the WORD "severity" is a shared, allowed key; only
// the brain's escalated values are a leak), the recovery/backoff/attempt counters and their key
// names, the credential vocabulary, and any imperative ask directed at the client. Deliberately
// excludes the client note's OWN three keys (degraded / severity / note) and its safe severity
// values (none / info / notice), which legitimately appear in the payload.
const FORBIDDEN_EGRESS_TOKENS = [
  // channel / provider identity — the note must never name WHICH feed is troubled
  'meta', 'google_ads', 'google ads', 'googleads', 'ghl', 'gohighlevel', 'facebook',
  'instagram', 'gbp', 'lsa', 'ga4', 'google analytics', 'local service',
  // seeded raw error excerpts
  'invalid_grant', 'invalid grant', '503', 'service unavailable',
  // status taxonomy
  'healthy', 'stale', 'erroring', 'auth_expired', 'never_synced', 'disabled',
  // the brain's escalated severity VALUES (the word "severity" itself is an allowed shared key)
  'warning', 'critical',
  // recovery / machinery key-names and counters
  'operator_required', 'needs_attention', 'error_class', 'error_excerpt', 'last_success',
  'last_attempt', 'age_hours', 'age_days', 'failures', 'recovery', 'next_attempt',
  'retryable', 'is_active', 'reason', 'exhausted', 'max_attempts', 'maxattempts',
  // recovery / credential vocabulary
  'reconnect', 'sign-in', 'sign in', 'log in', 'login', 'token', 'credential', 'oauth',
  'authorize', 'authoriz', 'expired', 'expire', 'revoked', 'backoff', 'retry', 'retries',
  'attempt', 'escalate', 'operator', 'sync', 'error', 'fail',
  // imperative asks — the client is never told to act; reconnecting is the team's job
  'please', 'click', 'you need', 'you must', 'visit', 'go to',
]

// Assert a serialized wire blob is free of every forbidden token, and that the note VALUE itself
// carries no integer count. (The digit check is scoped to the note string — the surrounding
// envelope legitimately carries digits, e.g. a client id.)
function assertWireLeakProof(serialized, noteValue, where) {
  const low = String(serialized).toLowerCase()
  for (const t of FORBIDDEN_EGRESS_TOKENS) {
    assert.ok(!low.includes(t), `[${where}] wire leaked forbidden token "${t}": ${serialized}`)
  }
  assert.ok(!/\d/.test(noteValue), `[${where}] client note leaked a numeric count: ${noteValue}`)
}

// ── Fixtures — shaped so the real brain produces the intended classifications ──────────────────

// HEALTHY ghl + ERRORING/transient google_ads + AUTH_EXPIRED meta → an OPERATOR-GATED portfolio.
function operatorGatedPortfolio(clientId = 'cli_1') {
  const conns = [
    { client_id: clientId, channel: 'ghl',        is_active: 1, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null },
    { client_id: clientId, channel: 'google_ads', is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: '503 Service Unavailable' },
    { client_id: clientId, channel: 'meta',       is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: 'invalid_grant' },
  ]
  const runs = [
    { client_id: clientId, channel: 'ghl',        status: 'success', started_at: '2026-06-03T11:55:00.000Z', finished_at: '2026-06-03T11:56:00.000Z', rows_written: 10, error: null },
    { client_id: clientId, channel: 'meta',       status: 'error',   started_at: '2026-06-03T11:30:00.000Z', finished_at: null, rows_written: 0, error: 'invalid_grant' },
    { client_id: clientId, channel: 'google_ads', status: 'error',   started_at: '2026-06-03T11:00:00.000Z', finished_at: null, rows_written: 0, error: '503 Service Unavailable' },
  ]
  return { conns, runs }
}

// The SAME failure shapes on entirely DIFFERENT channels (lsa auth, gbp transient) — used to
// prove the client note is blind to channel identity.
function operatorGatedPortfolioOtherChannels(clientId = 'cli_x') {
  const conns = [
    { client_id: clientId, channel: 'ga4', is_active: 1, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null },
    { client_id: clientId, channel: 'gbp', is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: '503 Service Unavailable' },
    { client_id: clientId, channel: 'lsa', is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: 'invalid_grant' },
  ]
  const runs = [
    { client_id: clientId, channel: 'ga4', status: 'success', started_at: '2026-06-03T11:55:00.000Z', finished_at: '2026-06-03T11:56:00.000Z', rows_written: 10, error: null },
    { client_id: clientId, channel: 'lsa', status: 'error',   started_at: '2026-06-03T11:30:00.000Z', finished_at: null, rows_written: 0, error: 'invalid_grant' },
    { client_id: clientId, channel: 'gbp', status: 'error',   started_at: '2026-06-03T11:00:00.000Z', finished_at: null, rows_written: 0, error: '503 Service Unavailable' },
  ]
  return { conns, runs }
}

// HEALTHY ghl + ERRORING/transient google_ads + STALE gbp (old success, no error) → SELF-HEALING
// ONLY: degraded but no operator gate, so the note rides the gentler "info" tone.
function selfHealingPortfolio(clientId = 'cli_2') {
  const conns = [
    { client_id: clientId, channel: 'ghl',        is_active: 1, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null },
    { client_id: clientId, channel: 'google_ads', is_active: 1, last_synced_at: '2026-06-01T00:00:00.000Z', last_error: '503 Service Unavailable' },
    { client_id: clientId, channel: 'gbp',        is_active: 1, last_synced_at: '2026-05-30T00:00:00.000Z', last_error: null },
  ]
  const runs = [
    { client_id: clientId, channel: 'ghl',        status: 'success', started_at: '2026-06-03T11:55:00.000Z', finished_at: '2026-06-03T11:56:00.000Z', rows_written: 10, error: null },
    { client_id: clientId, channel: 'google_ads', status: 'error',   started_at: '2026-06-03T11:00:00.000Z', finished_at: null, rows_written: 0, error: '503 Service Unavailable' },
    { client_id: clientId, channel: 'gbp',        status: 'success', started_at: '2026-05-30T00:00:00.000Z', finished_at: '2026-05-30T00:01:00.000Z', rows_written: 5, error: null },
  ]
  return { conns, runs }
}

// A single fully-healthy connection → not degraded, empty note, no wire surface.
function healthyPortfolio(clientId = 'cli_3') {
  const conns = [
    { client_id: clientId, channel: 'ghl', is_active: 1, last_synced_at: '2026-06-03T11:55:00.000Z', last_error: null },
  ]
  const runs = [
    { client_id: clientId, channel: 'ghl', status: 'success', started_at: '2026-06-03T11:55:00.000Z', finished_at: '2026-06-03T11:56:00.000Z', rows_written: 10, error: null },
  ]
  return { conns, runs }
}

// ── The egress tests ───────────────────────────────────────────────────────────────────────────

test('A4 egress: operator-gated portfolio → exact "notice" note, and the SERIALIZED wire leaks no machinery', async () => {
  const { conns, runs } = operatorGatedPortfolio('cli_1')
  const { note } = await readChain(conns, runs, 'cli_1')

  // the precise contract: a live auth failure shifts only the TONE to "team is on it"
  assert.deepEqual(note, { degraded: true, severity: 'notice', note: NOTICE })

  // assemble it onto a per-client wire payload exactly as routes/insights.js does (tenth key),
  // serialize, and prove the bytes carry none of the brain's machinery
  const wire = { client_id: 'cli_1', connection_note: note }
  assertWireLeakProof(JSON.stringify(wire), note.note, 'operator-gated')
})

test('A4 egress: NON-VACUOUS — the upstream agency verdict DOES carry the machinery the wire drops', async () => {
  const { conns, runs } = operatorGatedPortfolio('cli_1')
  const { assessed, note } = await readChain(conns, runs, 'cli_1')

  // (a) the agency assessment genuinely carries the sensitive machinery — so this fixture is
  //     rich, not empty: if these ever vanish, the leak test below would be passing vacuously
  const agencyLow = JSON.stringify(assessed).toLowerCase()
  for (const t of ['meta', 'auth_expired', 'operator_required', 'recovery', 'failures', 'error_excerpt']) {
    assert.ok(agencyLow.includes(t), `expected the agency verdict to carry "${t}" (else the egress test is vacuous)`)
  }

  // (b) the very same machinery is ABSENT from the client wire payload
  const wireLow = JSON.stringify({ client_id: 'cli_1', connection_note: note }).toLowerCase()
  for (const t of ['meta', 'auth_expired', 'operator_required', 'recovery', 'failures', 'error_excerpt']) {
    assert.ok(!wireLow.includes(t), `wire leaked agency token "${t}"`)
  }
})

test('A4 egress: self-healing-only portfolio → exact "info" note (no operator ask), still leak-proof', async () => {
  const { conns, runs } = selfHealingPortfolio('cli_2')
  const { assessed, note } = await readChain(conns, runs, 'cli_2')

  // sanity: this portfolio is degraded but carries NO operator gate
  assert.ok(assessed.records.some(r => r.needs_attention), 'fixture must be degraded')
  assert.ok(!assessed.records.some(r => r.operator_required), 'fixture must NOT be operator-gated')

  assert.deepEqual(note, { degraded: true, severity: 'info', note: INFO })
  const wire = { client_id: 'cli_2', connection_note: note }
  assertWireLeakProof(JSON.stringify(wire), note.note, 'self-healing')
})

test('A4 egress: fully-healthy portfolio → empty, non-degraded note; the wire carries nothing to act on', async () => {
  const { conns, runs } = healthyPortfolio('cli_3')
  const { note } = await readChain(conns, runs, 'cli_3')

  assert.deepEqual(note, { degraded: false, severity: 'none', note: '' })
  const wire = { client_id: 'cli_3', connection_note: note }
  assertWireLeakProof(JSON.stringify(wire), note.note, 'healthy')
})

test('A4 egress: the note is BLIND to channel identity — different troubled channels serialize identically', async () => {
  const a = operatorGatedPortfolio('cli_a')
  const b = operatorGatedPortfolioOtherChannels('cli_b')
  const { note: noteA } = await readChain(a.conns, a.runs, 'cli_a')
  const { note: noteB } = await readChain(b.conns, b.runs, 'cli_b')

  // identical failure CLASSES on entirely different channels (meta/google_ads vs lsa/gbp) must
  // yield a byte-identical client note — the channel name can never ride through
  assert.deepEqual(noteA, { degraded: true, severity: 'notice', note: NOTICE })
  assert.deepEqual(noteB, { degraded: true, severity: 'notice', note: NOTICE })
  assert.equal(
    JSON.stringify({ connection_note: noteA }),
    JSON.stringify({ connection_note: noteB }),
    'the client note must be blind to which channel failed',
  )
})
