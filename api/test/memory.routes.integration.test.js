// ============================================================
// test/memory.routes.integration.test.js — Memory OS Phase 3 REST surface
// (routes/memory.js), leak-proof. Mounts the REAL router behind the REAL
// requireAuth, mints REAL JWTs, and drives it over HTTP — the same harness the
// authz integration suite uses.
//
// Proven:
//   • agency can write / fleet-read / per-client-read / delete
//   • a client can read ONLY its own tenant (200), a peer's id → 403
//   • a client is denied every agency-only surface (POST, fleet GET, DELETE)
//   • a client never sees another tenant's memory through its own endpoint
//
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.JWT_SECRET = 'memory-int-test-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `memory_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')
const { requireAuth } = require('../middleware/auth')
const memoryRouter    = require('../routes/memory')

const app = express()
app.use(express.json())
app.use('/api/memory', requireAuth, memoryRouter)

const A = `mem-${process.pid}-A`
const B = `mem-${process.pid}-B`
const SECRET   = process.env.JWT_SECRET
const sign     = (p) => jwt.sign(p, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-a', email: 'a@test', role: 'client', client_id: A })

let server = null, PORT = 0, readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
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

test('agency can write, fleet-read, per-client-read, and delete', async () => {
  await ready()
  const w = await request('POST', '/api/memory', { token: AGENCY, body: { client_id: A, kind: 'note', content: 'A remembers X', source: 'user' } })
  assert.equal(w.status, 201)
  assert.ok(w.body.id)

  const fleet = await request('GET', '/api/memory', { token: AGENCY })
  assert.equal(fleet.status, 200)
  assert.ok(fleet.body.memories.some(m => m.content === 'A remembers X'))

  const perClient = await request('GET', `/api/memory/${A}`, { token: AGENCY })
  assert.equal(perClient.status, 200)
  assert.ok(perClient.body.memories.some(m => m.content === 'A remembers X'))

  const del = await request('DELETE', `/api/memory/${w.body.id}`, { token: AGENCY })
  assert.equal(del.status, 200)
  assert.equal(del.body.forgotten, 1)
})

test('a client reads only its own tenant; a peer id is 403; no cross-tenant leak', async () => {
  await ready()
  await request('POST', '/api/memory', { token: AGENCY, body: { client_id: A, kind: 'note', content: 'A-only secret', source: 'user' } })
  await request('POST', '/api/memory', { token: AGENCY, body: { client_id: B, kind: 'note', content: 'B-only secret', source: 'user' } })

  const own = await request('GET', `/api/memory/${A}`, { token: CLIENT_A })
  assert.equal(own.status, 200)
  assert.ok(own.body.memories.some(m => m.content === 'A-only secret'))
  assert.ok(!own.body.memories.some(m => m.content === 'B-only secret')) // no leak

  const peer = await request('GET', `/api/memory/${B}`, { token: CLIENT_A })
  assert.equal(peer.status, 403) // scopeClientParam denies a peer's id outright
})

test('a client is denied every agency-only surface', async () => {
  await ready()
  const post  = await request('POST', '/api/memory', { token: CLIENT_A, body: { client_id: A, kind: 'k', content: 'x', source: 'user' } })
  const fleet = await request('GET', '/api/memory', { token: CLIENT_A })
  const del   = await request('DELETE', '/api/memory/1', { token: CLIENT_A })
  assert.equal(post.status, 403)
  assert.equal(fleet.status, 403)
  assert.equal(del.status, 403)
})

test('unauthenticated requests are rejected', async () => {
  await ready()
  const r = await request('GET', `/api/memory/${A}`)
  assert.equal(r.status, 401)
})

test('a malformed write is a 400, not a 500', async () => {
  await ready()
  const r = await request('POST', '/api/memory', { token: AGENCY, body: { kind: 'k', content: 'x', source: 'not-a-source' } })
  assert.equal(r.status, 400)
})

test('GET /api/memory/health is agency-only and returns a governance verdict', async () => {
  await ready()
  const ok = await request('GET', '/api/memory/health', { token: AGENCY })
  assert.equal(ok.status, 200)
  assert.ok(['healthy', 'degraded', 'critical'].includes(ok.body.status))
  assert.ok(['none', 'compact', 'escalate'].includes(ok.body.recommended_action))

  const denied = await request('GET', '/api/memory/health', { token: CLIENT_A })
  assert.equal(denied.status, 403) // not the /:clientId route — health is agency-only
})
