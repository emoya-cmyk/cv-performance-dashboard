// ============================================================
// test/dashboards.routes.integration.test.js — Phase 3 saved-dashboards REST
// surface (routes/dashboards.js), leak-proof. Mounts the REAL router behind the
// REAL requireAuth, mints REAL JWTs, drives it over HTTP — the same harness the
// memory/authz integration suites use.
//
// Proven:
//   • agency CRUD (create / list / get / update / delete) on agency-owned
//     dashboards, and on client-scoped ones it sees them all
//   • a client sees/CRUDs ONLY its own client-scoped dashboards
//   • a client cannot read/update/delete an agency dashboard or a peer's → 403
//   • CRITICAL: a widget spec carrying a forged cross-tenant `clients` /
//     `dim:'client'` filter is still CLAMPED to the caller on /run — no leak.
//     This mirrors query.golden.test.js's isolation guarantee for the saved path.
// ============================================================
'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.JWT_SECRET = 'dashboards-int-test-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `dashboards_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')
const facts   = require('../lib/facts')
const { requireAuth }  = require('../middleware/auth')
const dashboardsRouter = require('../routes/dashboards')

const app = express()
app.use(express.json())
app.use('/api/dashboards', requireAuth, dashboardsRouter)

const A = `dash-${process.pid}-A`
const B = `dash-${process.pid}-B`
const SECRET   = process.env.JWT_SECRET
const sign     = (p) => jwt.sign(p, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-a', email: 'a@test', role: 'client', client_id: A })
const CLIENT_B = sign({ id: 'u-b', email: 'b@test', role: 'client', client_id: B })

const FACT_UPSERT = `
  INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
  VALUES ($1,$2,$3,$4,$5,$6)
  ON CONFLICT (client_id, date, channel_id, COALESCE(entity_id,0), metric_key)
  DO UPDATE SET metric_value = EXCLUDED.metric_value`

let server = null, PORT = 0, readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
      // Two tenants, each with one distinguishable spend fact so a cross-tenant
      // leak would change the returned number.
      await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [A, 'Tenant A'])
      await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [B, 'Tenant B'])
      const gads = facts.channelId('google_ads')
      await db.query(FACT_UPSERT, [A, '2024-01-01', gads, null, 'spend', 100])
      await db.query(FACT_UPSERT, [B, '2024-01-01', gads, null, 'spend', 999])
      await new Promise((resolve) => { server = app.listen(0, () => { PORT = server.address().port; resolve() }) })
    })()
  }
  return readyPromise
}
after(async () => {
  if (server) await new Promise((r) => server.close(r))
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

function request(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    if (payload != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
    const r = http.request({ hostname: '127.0.0.1', port: PORT, method, path: pathname, headers }, (res) => {
      let data = ''; res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null } catch {} resolve({ status: res.statusCode, body: json }) })
    })
    r.on('error', reject)
    if (payload != null) r.write(payload)
    r.end()
  })
}

const SPEND_WIDGET = {
  title: 'Spend by channel',
  viz: 'bar',
  spec: { metrics: ['spend'], dateRange: { start: '2024-01-01', end: '2024-01-01' }, groupBy: ['channel'] },
}

test('agency can create, list, get, update, and delete an agency-owned dashboard', async () => {
  await ready()
  const c = await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'Agency Board', widgets: [SPEND_WIDGET] } })
  assert.equal(c.status, 201)
  assert.ok(c.body.dashboard.id)
  assert.equal(c.body.dashboard.client_id, null)
  assert.equal(c.body.dashboard.widgets.length, 1)
  const id = c.body.dashboard.id

  const list = await request('GET', '/api/dashboards', { token: AGENCY })
  assert.equal(list.status, 200)
  assert.ok(list.body.dashboards.some(d => d.id === id))

  const got = await request('GET', `/api/dashboards/${id}`, { token: AGENCY })
  assert.equal(got.status, 200)
  assert.equal(got.body.dashboard.name, 'Agency Board')

  const upd = await request('PUT', `/api/dashboards/${id}`, { token: AGENCY, body: { name: 'Renamed' } })
  assert.equal(upd.status, 200)
  assert.equal(upd.body.dashboard.name, 'Renamed')
  assert.equal(upd.body.dashboard.widgets.length, 1) // widgets preserved when omitted

  const del = await request('DELETE', `/api/dashboards/${id}`, { token: AGENCY })
  assert.equal(del.status, 200)
  assert.equal(del.body.deleted, true)

  const gone = await request('GET', `/api/dashboards/${id}`, { token: AGENCY })
  assert.equal(gone.status, 404)
})

test('a client only sees/CRUDs its OWN client-scoped dashboards', async () => {
  await ready()
  // Agency seeds an agency board + a board for each of A and B.
  await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'Agency only' } })
  const forA = await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'A board', client_id: A, widgets: [SPEND_WIDGET] } })
  const forB = await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'B board', client_id: B } })

  // Client A's list contains ONLY its own board — never the agency or B's.
  const list = await request('GET', '/api/dashboards', { token: CLIENT_A })
  assert.equal(list.status, 200)
  assert.ok(list.body.dashboards.every(d => d.client_id === A))
  assert.ok(list.body.dashboards.some(d => d.id === forA.body.dashboard.id))
  assert.ok(!list.body.dashboards.some(d => d.id === forB.body.dashboard.id))

  // Client A may read/update/delete its own board.
  const ownGet = await request('GET', `/api/dashboards/${forA.body.dashboard.id}`, { token: CLIENT_A })
  assert.equal(ownGet.status, 200)

  // Client A cannot read/update/delete B's board → 403.
  const peerGet = await request('GET', `/api/dashboards/${forB.body.dashboard.id}`, { token: CLIENT_A })
  assert.equal(peerGet.status, 403)
  const peerPut = await request('PUT', `/api/dashboards/${forB.body.dashboard.id}`, { token: CLIENT_A, body: { name: 'hijack' } })
  assert.equal(peerPut.status, 403)
  const peerDel = await request('DELETE', `/api/dashboards/${forB.body.dashboard.id}`, { token: CLIENT_A })
  assert.equal(peerDel.status, 403)
})

test('a client cannot read an agency-owned dashboard', async () => {
  await ready()
  const ag = await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'Agency secret' } })
  const r = await request('GET', `/api/dashboards/${ag.body.dashboard.id}`, { token: CLIENT_A })
  assert.equal(r.status, 403)
})

test("a client's create is hard-pinned to its own id (body client_id ignored)", async () => {
  await ready()
  // Client A tries to plant a dashboard on tenant B — the body's client_id is ignored.
  const c = await request('POST', '/api/dashboards', { token: CLIENT_A, body: { name: 'sneaky', client_id: B } })
  assert.equal(c.status, 201)
  assert.equal(c.body.dashboard.client_id, A) // pinned to A, never B
})

test('CRITICAL: a forged cross-tenant widget spec is clamped to the caller on /run (no leak)', async () => {
  await ready()
  // Client A saves a widget whose spec FORGES access to tenant B both ways:
  // an explicit clients:[B] AND a dim:'client' filter for B.
  const forged = {
    title: 'forged',
    viz: 'table',
    spec: {
      metrics: ['spend'],
      dateRange: { start: '2024-01-01', end: '2024-01-01' },
      groupBy: ['client'],
      clients: [B],
      filters: [{ dim: 'client', op: 'in', values: [B] }],
    },
  }
  const c = await request('POST', '/api/dashboards', { token: CLIENT_A, body: { name: 'A forged', widgets: [forged] } })
  assert.equal(c.status, 201)
  const id = c.body.dashboard.id

  const run = await request('POST', `/api/dashboards/${id}/run`, { token: CLIENT_A })
  assert.equal(run.status, 200)
  const widget = run.body.widgets[0]
  assert.ok(widget.result, 'widget ran')
  // Every returned row is tenant A's — B's 999 spend NEVER appears.
  for (const row of widget.result.rows) {
    assert.equal(row.client, A, 'row clamped to caller tenant A')
  }
  const total = widget.result.rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
  assert.equal(total, 100) // A's spend only; if B leaked it would be 999 or 1099
})

test('agency /run honours the saved spec across tenants (no clamp for agency)', async () => {
  await ready()
  const board = {
    title: 'both tenants',
    viz: 'table',
    spec: { metrics: ['spend'], dateRange: { start: '2024-01-01', end: '2024-01-01' }, groupBy: ['client'] },
  }
  const c = await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'Agency run', widgets: [board] } })
  const run = await request('POST', `/api/dashboards/${c.body.dashboard.id}/run`, { token: AGENCY })
  assert.equal(run.status, 200)
  const tenants = run.body.widgets[0].result.rows.map(r => r.client).sort()
  assert.deepEqual(tenants, [A, B].sort()) // agency sees both tenants
})

test('unauthenticated requests are rejected; malformed widgets are 400', async () => {
  await ready()
  const noauth = await request('GET', '/api/dashboards')
  assert.equal(noauth.status, 401)

  const badName = await request('POST', '/api/dashboards', { token: AGENCY, body: { widgets: [] } })
  assert.equal(badName.status, 400)

  const badWidget = await request('POST', '/api/dashboards', { token: AGENCY, body: { name: 'bad', widgets: [{ title: 'x', spec: { metrics: [] } }] } })
  assert.equal(badWidget.status, 400)
})
