'use strict'

// Route-level isolation test for GET /api/make-remediation/correctness (Spec A).
// The store layer is leak-tested in writeVerificationStore.test.js; this proves
// the HTTP read path itself: the requireAgency 403 boundary and the ?tenant_id
// scope end-to-end (CLAUDE.md: a leak-proof test for any new tenant-scoped surface).

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.JWT_SECRET = 'correctness-route-test-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `corr_route_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')
const { requireAuth } = require('../middleware/auth')
const opsRouter = require('../routes/makeRemediation')
const { recordWriteVerification } = require('../lib/writeVerificationStore')

const app = express()
app.use(express.json())
app.use('/api/make-remediation', requireAuth, opsRouter)

const SECRET   = process.env.JWT_SECRET
const AGENCY   = jwt.sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null }, SECRET)
const CLIENT_A = jwt.sign({ id: 'u-clientA', email: 'a@test', role: 'client', client_id: 'A' }, SECRET)

let server = null, PORT = 0, ready = null
function start() {
  if (!ready) ready = (async () => {
    await db.migrate()
    // Tenant A: one VERIFIED_CORRECT; Tenant B: one FAILED — distinct scopes.
    await recordWriteVerification({ query: db.query, tenantId: 'tenant-A', endpoint: 'ghl:upsert',
      persisted: true, intended: { a: '1' }, readBack: { a: '1' } })
    await recordWriteVerification({ query: db.query, tenantId: 'tenant-B', endpoint: 'ghl:upsert',
      persisted: false, intended: { a: '1' } })
    await new Promise((r) => { server = app.listen(0, () => { PORT = server.address().port; r() }) })
  })()
  return ready
}

before(start)
after(async () => {
  if (server) await new Promise((r) => server.close(r))
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

function get(pathname, token) {
  return new Promise((resolve, reject) => {
    const h = token ? { authorization: `Bearer ${token}` } : {}
    http.request({ hostname: '127.0.0.1', port: PORT, method: 'GET', path: pathname, headers: h }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c })
      res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null } catch {} ; resolve({ status: res.statusCode, body: j }) })
    }).on('error', reject).end()
  })
}

test('GET /correctness is agency-only: client JWT → 403, agency JWT → 200', async () => {
  await start()
  const c = await get('/api/make-remediation/correctness', CLIENT_A)
  assert.equal(c.status, 403, `client must be 403 (got ${c.status})`)
  const a = await get('/api/make-remediation/correctness', AGENCY)
  assert.equal(a.status, 200, `agency must be 200 (got ${a.status})`)
})

test('GET /correctness?tenant_id scopes to that tenant only', async () => {
  await start()
  const a = await get('/api/make-remediation/correctness?tenant_id=tenant-A', AGENCY)
  assert.equal(a.status, 200)
  assert.equal(a.body.scope, 'tenant-A')
  assert.ok(a.body.endpoints.length >= 1)
  assert.ok(a.body.endpoints.every((e) => e.tenant_id === 'tenant-A'), 'only tenant-A rows')
  assert.equal(a.body.endpoints[0].verified_correct, 1)

  // Tenant B is not visible under tenant-A's scope.
  assert.ok(!a.body.endpoints.some((e) => e.tenant_id === 'tenant-B'), 'no tenant-B leak')

  const b = await get('/api/make-remediation/correctness?tenant_id=tenant-B', AGENCY)
  assert.equal(b.body.endpoints[0].failed, 1)
  assert.ok(b.body.endpoints.every((e) => e.tenant_id === 'tenant-B'))
})
