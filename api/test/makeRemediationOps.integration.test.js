'use strict'

// HTTP integration tests for the Make.com remediation OPERATOR surface
// (/api/make-remediation/*). Mounts the real router behind the real requireAuth,
// mints real JWTs, and drives it over HTTP — proving the agency-only guard holds
// on every route and that the fix-queue / circuit-breaker actions behave.
//
// Mirrors test/authz.integration.test.js: pin JWT_SECRET + SQLITE_PATH BEFORE any
// app module is required (auth.js captures JWT_SECRET at load; db.js selects
// SQLite when DATABASE_URL is unset and honors SQLITE_PATH).

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const crypto = require('crypto')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.JWT_SECRET = 'make-ops-int-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `make_ops_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')
const { requireAuth }   = require('../middleware/auth')
const opsRouter         = require('../routes/makeRemediation')

const app = express()
app.use(express.json())
app.use('/api/make-remediation', requireAuth, opsRouter)

const SECRET = process.env.JWT_SECRET
const AGENCY = jwt.sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null }, SECRET)
const CLIENT = jwt.sign({ id: 'u-client', email: 'c@test', role: 'client', client_id: 't1' }, SECRET)

let server, PORT
function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (data) headers['content-length'] = Buffer.byteLength(data)
    const r = http.request({ port: PORT, path, method, headers }, (res) => {
      let d = ''; res.on('data', c => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }))
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

before(async () => {
  await db.migrate()
  // Seed one open dead-letter item and one tripped breaker.
  await db.query(
    `INSERT INTO make_dead_letter (id, execution_id, scenario_id, tenant_id, vendor, failure_tier, original_error, suggested_action, status)
     VALUES ($1,'ex-1','scn-1','t1','GHL',1,'missing email','remap_or_dead_letter','open')`,
    [crypto.randomUUID()]
  )
  await db.query(
    `INSERT INTO make_circuit_breaker (tenant_id, vendor, tripped, consecutive_failures, reason, tripped_at, updated_at)
     VALUES ('t1','GHL',1,2,'auth_expired_manual',$1,$1)`,
    [new Date().toISOString()]
  )
  await db.query(
    `INSERT INTO make_remediation_log (id, scenario_id, execution_id, tenant_id, vendor, failure_tier, remediation_outcome, auto_resolved)
     VALUES ($1,'scn-1','ex-log-1','t1','GHL',0,'success',1)`,
    [crypto.randomUUID()]
  )
  await new Promise(r => { server = app.listen(0, () => { PORT = server.address().port; r() }) })
})

after(() => {
  if (server) server.close()
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── requireAgency holds on every route (client → 403, no token → 401) ─────────

test('client role is forbidden on every operator route', async () => {
  const routes = [
    ['GET', '/api/make-remediation/dead-letter'],
    ['GET', '/api/make-remediation/circuit-breakers'],
    ['POST', '/api/make-remediation/circuit-breakers/clear'],
    ['GET', '/api/make-remediation/stats'],
    ['GET', '/api/make-remediation/recurring-unknowns'],
  ]
  for (const [m, p] of routes) {
    const r = await req(m, p, CLIENT, m === 'POST' ? { tenant_id: 't1', vendor: 'GHL' } : null)
    assert.equal(r.status, 403, `${m} ${p}`)
  }
})

test('no token is unauthorized', async () => {
  const r = await req('GET', '/api/make-remediation/dead-letter', null)
  assert.equal(r.status, 401)
})

// ── Agency happy paths ────────────────────────────────────────────────────────

test('agency lists the open fix queue, then resolves an item', async () => {
  const list = await req('GET', '/api/make-remediation/dead-letter?status=open', AGENCY)
  assert.equal(list.status, 200)
  assert.equal(list.body.count, 1)
  const id = list.body.items[0].id

  const resolve = await req('POST', `/api/make-remediation/dead-letter/${id}/resolve`, AGENCY)
  assert.equal(resolve.status, 200)
  assert.equal(resolve.body.ok, true)

  // Now resolving again 404s (no longer open).
  const again = await req('POST', `/api/make-remediation/dead-letter/${id}/resolve`, AGENCY)
  assert.equal(again.status, 404)

  // And the open queue is now empty.
  const empty = await req('GET', '/api/make-remediation/dead-letter?status=open', AGENCY)
  assert.equal(empty.body.count, 0)
})

test('agency clears a tripped circuit breaker (FR-5 manual override)', async () => {
  const before = await req('GET', '/api/make-remediation/circuit-breakers', AGENCY)
  assert.equal(before.body.breakers[0].tripped, true)

  const bad = await req('POST', '/api/make-remediation/circuit-breakers/clear', AGENCY, { tenant_id: 't1' })
  assert.equal(bad.status, 400) // vendor missing

  const clear = await req('POST', '/api/make-remediation/circuit-breakers/clear', AGENCY, { tenant_id: 't1', vendor: 'GHL' })
  assert.equal(clear.status, 200)
  assert.equal(clear.body.cleared, true)

  const after = await req('GET', '/api/make-remediation/circuit-breakers', AGENCY)
  assert.equal(after.body.breakers[0].tripped, false)
  assert.equal(after.body.breakers[0].consecutive_failures, 0)

  const missing = await req('POST', '/api/make-remediation/circuit-breakers/clear', AGENCY, { tenant_id: 'nope', vendor: 'X' })
  assert.equal(missing.status, 404)
})

test('agency reads the stats rollup', async () => {
  const r = await req('GET', '/api/make-remediation/stats?days=7', AGENCY)
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.total_events, 'number')
  assert.ok('auto_resolution_rate' in r.body)
  assert.ok('by_tier' in r.body)
})
