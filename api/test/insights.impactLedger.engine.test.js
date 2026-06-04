'use strict'

// ============================================================
// test/insights.impactLedger.engine.test.js — the ENGINE WIRING for the
// INFLUENCE LEDGER (intel-v12 B2). lib/impactLedger.js (the pure algebra) and
// lib/impactSources.js (the pure adapter) are unit-tested in isolation in
// impactLedger.test.js / impactSources.test.js; this file proves the ONE read
// that puts that pure core onto live data: insights.getImpactLedger({clientId,asOf}).
//
// WHAT ONLY AN END-TO-END READ CAN PROVE (and the unit tests cannot):
//   • CROSS-CLIENT ISOLATION — a client-scoped ledger is built from THAT client's
//     recovered findings ALONE: client A's ledger never carries client B's win,
//     id, or name. This is the load-bearing leak property of the seam, and it is
//     only real once getRecentRecoveries' WHERE client_id = $1 is in the loop.
//   • SCOPE TAGGING + POOLING — clientId scopes the data ('client'); null pools the
//     whole portfolio ('portfolio') WITH per-client attribution (the JOINed name).
//   • RETURN SHAPE — scope, as_of, the summarizeImpactLedger spread, ledger, narration.
//   • HONESTY — COUNT-unit recoveries carry the neutral 0.5 default confidence, so a
//     recoveries-only ledger is NOT "proven" (0.5 < provenMinConfidence 0.6) no matter
//     how many wins — proven is earned, never inflated by volume.
//
// REALLOCATION CONFINEMENT — NOT re-proven here, by design. The agency-only pooled
// reallocation source is loaded ONLY for a portfolio ledger and is mapped to a
// client_id:null COUNT that can never be attributed to a client. That confinement is
// already closed at TWO independent levels — the adapter test (impactSources.test.js:
// reallocationToImpact → exactly one agency COUNT with client_id:null) and the getter's
// one-line construction guard (`reallocation = clientId != null ? null : …`). Making a
// "client has no reallocation while portfolio does" assertion strictly non-vacuous would
// require seeding a vindicated reallocation backtest (the heavy seedChannelWeekly weekly-
// fact fixture); that cost buys nothing the two existing guards don't already give. So
// here we seed recoveries ONLY and simply confirm the cheap, forward-wired source flows
// and that a client ledger carries no 'reallocation' category.
//
// Runs end to end against an isolated temp SQLite DB (its own SQLITE_PATH, migrated once).
// ANTHROPIC_API_KEY is deleted so nothing reaches the network; ledger narration is pure
// template by construction anyway. recovered_at is stamped relative to real now so the
// rows always land inside the 30-day recovery window.
// ============================================================

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// No key → deterministic narration, no network.
delete process.env.ANTHROPIC_API_KEY

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `insights_impactledger_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { getImpactLedger } = require('../lib/insights')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── harness (mirrors insights.reallocation.test.js) ─────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

let seq = 0
async function freshClient(name) {
  const id = `impledger-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

// A recovered finding inside the 30-day window. Supplies the three NOT-NULL-no-default
// columns (kind, title, fingerprint) plus the four the recovery read filters/maps on
// (scope='client', status='recovered', recovered_at, metric). evidence defaults to '{}',
// so every recovery maps to a COUNT win of value 1 (no revenue baseline/latest present).
let fp = 0
const recentIso = (daysAgo = 1) => new Date(Date.now() - daysAgo * 86400000).toISOString()
async function seedRecovery(clientId, metric, { daysAgo = 1, reason = 'play_worked' } = {}) {
  await db.query(
    `INSERT INTO insights
       (client_id, scope, kind, metric, severity, direction, title, status, recovery_reason, recovered_at, fingerprint)
     VALUES ($1,'client','anomaly',$2,'warning','down',$3,'recovered',$4,$5,$6)`,
    [clientId, metric, `Recovered ${metric}`, reason, recentIso(daysAgo), `impledger-fp-${process.pid}-${++fp}`])
}

// ── client scope: tagged, isolated, honest ──────────────────────────────────────
test('client scope tags "client", counts only THIS client, and never carries another client', async () => {
  await ready()
  const A = await freshClient('Acme Co')
  const B = await freshClient('Vandelay Industries')
  await seedRecovery(A, 'leads')
  await seedRecovery(A, 'jobs')
  await seedRecovery(B, 'revenue')   // B's win must never surface in A's ledger

  const led = await getImpactLedger({ clientId: A })

  // scope + as_of + the exact top-level shape (summarize spread + scope/as_of/ledger/narration)
  assert.equal(led.scope, 'client')
  assert.equal(typeof led.as_of, 'string')
  assert.ok(led.as_of.length >= 10)
  assert.deepEqual(Object.keys(led).sort(),
    ['as_of', 'categories', 'client_count', 'confidence', 'count',
     'headline', 'ledger', 'narration', 'proven', 'scope', 'units'])

  // counts ONLY A's two recoveries — the client_id = $1 filter is in the loop
  assert.equal(led.count, 2)
  assert.equal(led.client_count, 1)
  assert.equal(led.ledger.by_client.length, 1)
  assert.equal(led.ledger.by_client[0].client_id, A)

  // CROSS-CLIENT ISOLATION: B's id and name appear NOWHERE in A's payload
  const json = JSON.stringify(led)
  assert.ok(!json.includes(B),          "another client's id must not ride A's ledger")
  assert.ok(!json.includes('Vandelay'), "another client's name must not ride A's ledger")

  // client scope NEVER loads the pooled, agency-only reallocation source
  assert.deepEqual(led.categories, ['recovery'])
  assert.ok(!('reallocation' in led.ledger.by_category))

  // HONEST: two COUNT wins headline at value 2 / weighted 1 / confidence 0.5 → not proven
  assert.equal(led.headline.unit, 'count')
  assert.equal(led.headline.value, 2)
  assert.equal(led.confidence, 0.5)
  assert.equal(led.proven, false)

  // agency-audience narration speaks (it is the agency read), and leaks no dollars
  assert.equal(typeof led.narration, 'string')
  assert.match(led.narration, /measurable wins?/)
  assert.ok(!led.narration.includes('$'))
})

// ── portfolio scope: pooled across clients, with attribution ────────────────────
test('portfolio scope tags "portfolio" and pools wins across ALL clients (named)', async () => {
  await ready()
  const C = await freshClient('Ceptor Co')
  const D = await freshClient('Dunder Mifflin')
  await seedRecovery(C, 'leads')
  await seedRecovery(C, 'jobs')
  await seedRecovery(D, 'revenue')

  const led = await getImpactLedger({})

  assert.equal(led.scope, 'portfolio')
  // pooled total includes every seeded client's wins (≥ these 3; other tests share the DB)
  assert.ok(led.count >= 3, 'portfolio pools the whole fleet')

  // both clients are present, each with its OWN exact win count …
  const byId = new Map(led.ledger.by_client.map(c => [c.client_id, c]))
  assert.ok(byId.has(C) && byId.has(D), 'portfolio rosters every contributing client')
  assert.equal(byId.get(C).count, 2)
  assert.equal(byId.get(D).count, 1)
  // … and the portfolio JOIN attaches the client NAME (attribution the per-client read omits)
  assert.equal(byId.get(C).client_name, 'Ceptor Co')

  // still recoveries-only here (no backtest seeded) → no agency reallocation category,
  // and still honest: COUNT wins never cross the proven bar on volume alone
  assert.ok(!('reallocation' in led.ledger.by_category))
  assert.equal(led.proven, false)
  assert.equal(typeof led.narration, 'string')
  assert.match(led.narration, /measurable wins?/)
})

// ── defensive: a portfolio read against the live (now-seeded) DB never throws and
//    always returns the stable agency shape, even though the reallocation source is
//    exercised for real (empty backtest ⇒ no reallocation event, never an error) ──
test('getImpactLedger({}) is empty-safe through the real reallocation read (no throw)', async () => {
  await ready()
  const led = await getImpactLedger({})
  assert.equal(led.scope, 'portfolio')
  assert.equal(typeof led.as_of, 'string')
  assert.ok(Array.isArray(led.categories))
  assert.ok(led.ledger && typeof led.ledger === 'object')
  // narration is string-or-null and, when present, agency-grade — never a client silence-or-line check
  assert.ok(led.narration === null || typeof led.narration === 'string')
})
