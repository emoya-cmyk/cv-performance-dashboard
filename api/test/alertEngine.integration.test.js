// ============================================================
// test/alertEngine.integration.test.js — Phase 4 alert EVALUATION → FIRING.
//
// Drives lib/alertEngine.evaluateAlerts against a REAL ephemeral SQLite DB
// (migrated, incl. 033_fired_alerts_dedup) and the REAL routes/alerts.js read
// route over HTTP behind the REAL requireAuth — the same harness the authz /
// memory integration suites use.
//
// Proven:
//   • a crossed WoW drop FIRES a fired_alerts row (eval → fire works)
//   • IDEMPOTENT — a second evaluation in the same window does NOT duplicate it
//   • a fresh week is a fresh window — the same drop next week fires again
//   • NO-CONFIG → records the fired alert but attempts NO delivery (inert in CI)
//   • CONFIGURED → a newly-fired alert attempts delivery exactly once (deduped
//     fires never re-deliver)
//   • GET /api/alerts is agency-only and surfaces fired alerts; a client is 403
//
// Run with:  node --test   (from api/)
// ============================================================
'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.JWT_SECRET = 'alert-int-test-secret'
delete process.env.DATABASE_URL
// Belt-and-braces: ensure no channel is configured by default so the inert path
// is what the bulk of the suite exercises. Individual tests opt in via isConfigured.
delete process.env.SLACK_WEBHOOK_URL
delete process.env.RESEND_API_KEY
delete process.env.ALERT_EMAIL
const DB_PATH = path.join(os.tmpdir(), `alert_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')
const { query } = db
const { requireAuth } = require('../middleware/auth')
const alertsRouter    = require('../routes/alerts')
const { evaluateAlerts } = require('../lib/alertEngine')

const app = express()
app.use(express.json())
app.use('/api/alerts', requireAuth, alertsRouter)

const A = `alert-${process.pid}-A`
const B = `alert-${process.pid}-B`
const SECRET   = process.env.JWT_SECRET
const sign     = (p) => jwt.sign(p, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-a', email: 'a@test', role: 'client', client_id: A })

// Week anchors RELATIVE to "today" so the suite is deterministic on any date —
// the engine only looks back 21 days, so fixed dates would rot. WEEK1 (oldest) →
// WEEK3 (newest) all sit inside that window.
const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d) }
const WEEK1 = daysAgo(14)   // prior
const WEEK2 = daysAgo(7)    // current
const WEEK3 = daysAgo(1)    // a fresh later week (added mid-suite)

let server = null, PORT = 0, readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
      // Two clients with weekly_reports. A drops hard WoW; B is flat (no alert).
      await query(`INSERT INTO clients (id, name) VALUES ($1, $2)`, [A, 'Acme Co'])
      await query(`INSERT INTO clients (id, name) VALUES ($1, $2)`, [B, 'Bravo Co'])
      // Prior week (older), then current week (newer). Revenue 1000 → 400 = -60% (critical).
      await query(`INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue) VALUES ($1,$2,$3,$4)`, [A, WEEK1, 100, 1000])
      await query(`INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue) VALUES ($1,$2,$3,$4)`, [A, WEEK2, 95, 400])
      // B flat — no drop, never fires.
      await query(`INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue) VALUES ($1,$2,$3,$4)`, [B, WEEK1, 50, 500])
      await query(`INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue) VALUES ($1,$2,$3,$4)`, [B, WEEK2, 50, 500])
      await new Promise((resolve) => { server = app.listen(0, () => { PORT = server.address().port; resolve() }) })
    })()
  }
  return readyPromise
}
after(async () => {
  if (server) await new Promise((r) => server.close(r))
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

function request(method, pathname, { token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    const r = http.request({ hostname: '127.0.0.1', port: PORT, method, path: pathname, headers }, (res) => {
      let data = ''; res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null } catch {} resolve({ status: res.statusCode, body: json }) })
    })
    r.on('error', reject)
    r.end()
  })
}

async function firedRows(clientId) {
  const { rows } = await query(
    `SELECT id, severity, metric, value, dedup_key FROM fired_alerts WHERE client_id = $1 ORDER BY id`,
    [clientId]
  )
  return rows
}

// ── eval → fire ───────────────────────────────────────────────────────────────
test('a crossed WoW drop fires a fired_alerts row (no-config → records, no delivery)', async () => {
  await ready()
  const sent = []
  const r = await evaluateAlerts({
    query,
    deliver: async (a) => { sent.push(a) },     // would be called only if configured
    isConfigured: () => false,                   // simulate an unconfigured env
  })

  // Two clients have ≥2 weeks (A and B); only A crossed (revenue -60% AND leads flat-ish).
  assert.equal(r.evaluated, 2, 'both clients with 2 weeks were evaluated')
  assert.ok(r.fired >= 1, 'at least the revenue drop fired')
  assert.equal(r.delivered, 0, 'no delivery attempted when no channel is configured')
  assert.equal(sent.length, 0, 'the send fan-out was never called (inert)')

  const rows = await firedRows(A)
  assert.ok(rows.length >= 1, 'fired_alerts row was recorded')
  const rev = rows.find(x => x.metric === 'Revenue')
  assert.ok(rev, 'a Revenue alert was recorded')
  assert.equal(rev.severity, 'critical', '-60% ≥ 40% crit threshold → critical')
  assert.equal(rev.dedup_key, `${A}:Revenue:${WEEK2}`, 'natural dedup key = client:metric:week')

  // B never fired (flat).
  assert.equal((await firedRows(B)).length, 0, 'the flat client never fired')
})

// ── idempotency ─────────────────────────────────────────────────────────────────
test('a second evaluation in the same window does NOT duplicate the fired row', async () => {
  await ready()
  const before = (await firedRows(A)).length
  assert.ok(before >= 1, 'first eval already fired in the prior test')

  const r = await evaluateAlerts({ query, isConfigured: () => false })
  assert.equal(r.fired, 0, 'nothing new fired on the re-run')
  assert.ok(r.skipped >= 1, 'the crossed condition was skipped as already-fired')

  const after = (await firedRows(A)).length
  assert.equal(after, before, 'no duplicate fired_alerts row written')
})

// ── fresh window fires again ─────────────────────────────────────────────────────
test('a new week is a fresh window — the same drop fires a new row', async () => {
  await ready()
  const before = (await firedRows(A)).length
  // Add a newer week that again drops hard vs the prior (400 → 150 = -62%).
  await query(
    `INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue)
     VALUES ($1, $2, $3, $4)`,
    [A, WEEK3, 90, 150]
  )

  const r = await evaluateAlerts({ query, clientId: A, isConfigured: () => false })
  assert.ok(r.fired >= 1, 'the new week crossed and fired')

  const rows = await firedRows(A)
  assert.ok(rows.length > before, 'a new fired_alerts row was added for the fresh window')
  assert.ok(rows.some(x => x.dedup_key === `${A}:Revenue:${WEEK3}`), 'keyed to the new week')
})

// ── delivery gating when configured ──────────────────────────────────────────────
test('when a channel is configured, a newly-fired alert attempts delivery exactly once', async () => {
  await ready()
  // Use an isolated client so this test owns its dedup windows.
  const C = `alert-${process.pid}-C`
  await query(`INSERT INTO clients (id, name) VALUES ($1, $2)`, [C, 'Charlie Co'])
  await query(`INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue) VALUES ($1,$2,$3,$4)`, [C, WEEK1, 80, 800])
  await query(`INSERT INTO weekly_reports (client_id, week_start, raw_leads, projected_revenue) VALUES ($1,$2,$3,$4)`, [C, WEEK2, 30, 200])

  const sent = []
  const deliver = async (a) => { sent.push(a) }

  const r1 = await evaluateAlerts({ query, clientId: C, deliver, isConfigured: () => true })
  assert.ok(r1.fired >= 1, 'fired on first eval')
  assert.equal(r1.delivered, r1.fired, 'each newly-fired alert attempted delivery')
  assert.equal(sent.length, r1.fired, 'the send fan-out was called once per new fire')

  // Re-run: deduped, so NO further delivery.
  const r2 = await evaluateAlerts({ query, clientId: C, deliver, isConfigured: () => true })
  assert.equal(r2.fired, 0, 'nothing new fired')
  assert.equal(r2.delivered, 0, 'no delivery on a deduped re-run')
  assert.equal(sent.length, r1.fired, 'the fan-out was not called again')
})

// ── read route authz ────────────────────────────────────────────────────────────
test('GET /api/alerts is agency-only and lists fired alerts; a client is 403', async () => {
  await ready()
  const agency = await request('GET', '/api/alerts', { token: AGENCY })
  assert.equal(agency.status, 200)
  assert.ok(Array.isArray(agency.body.alerts), 'agency sees the fired-alert log')
  assert.ok(agency.body.alerts.some(a => a.client_id === A), 'the fired alert for A is visible')

  const client = await request('GET', '/api/alerts', { token: CLIENT_A })
  assert.equal(client.status, 403, 'a client cannot read the agency-wide alert log')
})
