'use strict'

// Self-contained authorization-boundary integration test for the package.
//
// This is the package-isolated counterpart of agency's authz.integration.test.js:
// instead of mounting agency's real routers + DB (which we deliberately do NOT
// depend on), it builds a TINY Express app whose routes are guarded ONLY by the
// package's createAuth() factory, mints REAL agency + client JWTs with the same
// secret createAuth verifies against, and drives them over HTTP. The properties
// proven are the same hard boundary agency proves end to end:
//
//   (1) requireAuth     — no/invalid token → 401; a valid token populates req.user
//   (2) scopeClientParam— client→OWN allowed, client→OTHER 403, agency allowed
//   (3) requireAgency   — role='client' is denied (403); agency passes
//   (4) scopeClientId   — list endpoint returns ONLY the caller's row for a
//                         client; agency sees all (the filter/clamp seam)
//
// In-memory "DB": two tenants, one row each, no external store.

const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

const jwt = require('jsonwebtoken')
const express = require('express')
const { createAuth } = require('..')

const SECRET = 'dashboard-core-int-secret'
const auth = createAuth({ jwtSecret: SECRET })

// Two tenants; one "metrics" row each (the cross-tenant data a client must never
// see by changing an id in the URL or a list filter).
const A = 'tenant-A'
const B = 'tenant-B'
const ROWS = {
  [A]: { client_id: A, name: 'Acme', spend: 100 },
  [B]: { client_id: B, name: 'Beta', spend: 250 },
}

// ── Tiny app guarded ONLY by the package ──────────────────────────────────────
const app = express()
app.use(express.json())

// Per-client GET surface (scopeClientParam): the IDOR boundary.
app.get('/api/metrics/:clientId', auth.requireAuth, auth.scopeClientParam('clientId'), (req, res) => {
  const row = ROWS[req.params.clientId]
  if (!row) return res.status(404).json({ error: 'not found' })
  res.json(row)
})

// Agency-only mutation surface (requireAgency).
app.post('/api/clients', auth.requireAuth, auth.requireAgency, (_req, res) => {
  res.status(201).json({ ok: true })
})

// List surface (scopeClientId clamp): a client sees ONLY its own row; agency all.
app.get('/api/clients', auth.requireAuth, (req, res) => {
  const confine = auth.scopeClientId(req) // null = agency (unconfined)
  const all = Object.values(ROWS)
  const visible = confine == null ? all : all.filter((r) => auth.sameId(r.client_id, confine))
  res.json(visible)
})

// ── Real JWTs ─────────────────────────────────────────────────────────────────
const sign = (payload) => jwt.sign(payload, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-clientA', email: 'a@test', role: 'client', client_id: A })
const FORGED   = jwt.sign({ id: 'x', role: 'agency', client_id: null }, 'wrong-secret')

let server = null
let PORT = 0
let readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = new Promise((resolve) => {
      server = app.listen(0, () => { PORT = server.address().port; resolve() })
    })
  }
  return readyPromise
}
after(() => new Promise((r) => (server ? server.close(r) : r())))

function request(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const r = http.request(
      { hostname: '127.0.0.1', port: PORT, method, path: pathname, headers },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json = null
          try { json = data ? JSON.parse(data) : null } catch {}
          resolve({ status: res.statusCode, body: json })
        })
      }
    )
    r.on('error', reject)
    if (payload != null) r.write(payload)
    r.end()
  })
}

// ── (1) requireAuth ───────────────────────────────────────────────────────────
test('requireAuth: missing token → 401, invalid token → 401, forged secret → 401', async () => {
  await ready()
  assert.equal((await request('GET', `/api/metrics/${A}`)).status, 401)
  assert.equal((await request('GET', `/api/metrics/${A}`, { token: 'garbage' })).status, 401)
  assert.equal((await request('GET', `/api/metrics/${A}`, { token: FORGED })).status, 401)
})

// ── (2) scopeClientParam boundary ─────────────────────────────────────────────
test('scopeClientParam: client→OWN allowed, client→OTHER 403, agency→any allowed', async () => {
  await ready()

  const own = await request('GET', `/api/metrics/${A}`, { token: CLIENT_A })
  assert.equal(own.status, 200, 'client must reach its OWN tenant')
  assert.equal(own.body.client_id, A)

  const other = await request('GET', `/api/metrics/${B}`, { token: CLIENT_A })
  assert.equal(other.status, 403, 'client must be blocked from another tenant (IDOR)')
  assert.equal(other.body && other.body.spend, undefined, 'no cross-tenant data leaks in the 403 body')

  const agencyOther = await request('GET', `/api/metrics/${B}`, { token: AGENCY })
  assert.equal(agencyOther.status, 200, 'agency may read any tenant')
  assert.equal(agencyOther.body.client_id, B)
})

// ── (3) requireAgency boundary ────────────────────────────────────────────────
test('requireAgency: role=client denied (403), agency allowed', async () => {
  await ready()
  const denied = await request('POST', '/api/clients', { token: CLIENT_A, body: { name: 'x' } })
  assert.equal(denied.status, 403, 'a client must never reach an agency-only mutation')

  const allowed = await request('POST', '/api/clients', { token: AGENCY, body: { name: 'x' } })
  assert.equal(allowed.status, 201, 'agency passes the guard')
})

// ── (4) scopeClientId list clamp ──────────────────────────────────────────────
test('GET /api/clients is row-filtered: client sees only itself, agency sees all', async () => {
  await ready()

  const client = await request('GET', '/api/clients', { token: CLIENT_A })
  assert.equal(client.status, 200)
  assert.deepEqual(client.body.map((r) => r.client_id), [A], 'client sees ONLY its own row')
  assert.ok(!JSON.stringify(client.body).includes(B), 'the other tenant never appears')

  const agency = await request('GET', '/api/clients', { token: AGENCY })
  const ids = agency.body.map((r) => r.client_id)
  assert.ok(ids.includes(A) && ids.includes(B), 'agency sees both tenants')
})
