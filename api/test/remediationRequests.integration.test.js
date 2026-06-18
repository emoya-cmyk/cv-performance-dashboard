// Operator remediation-request queue — REST integration tests over the REAL router.
//
// The OUTBOUND half of the cli_framework ↔ dashboard bridge: an agency operator
// REQUESTS a safe cli operation from the Integration-Health tile, cli PULLS +
// executes + reports back. Covers, end to end:
//
//   CREATE (POST /requests — agency-only):
//     • client-role JWT → 403 (requireAgency boundary); agency JWT → 201.
//     • an action NOT in the fixed safe allow-list → 400 (cause/effect wall).
//     • a missing client_id → 400; status defaults to 'pending'.
//
//   LIST (GET /requests — agency-only):
//     • client JWT → 403; agency JWT → 200, newest-first, optional status/client filter.
//     • agency-scoping: the list is the operator surface, only reachable with agency auth.
//
//   PULL (GET /requests/pending — machine, ihAuth secret-gated):
//     • 503 when INTEGRATION_HEALTH_SECRET is unset (fail CLOSED); 401 on a wrong token.
//     • claims pending rows (pending → claimed) and a SECOND pull won't re-claim them
//       (no double-claim).
//
//   RESULT (POST /requests/:id/result — machine, ihAuth secret-gated):
//     • 401 without the secret; bad body → 400 (never 500); unknown id → 404.
//     • updates status to done|failed and stamps completed_at.
//
//   LIFECYCLE: pending → claimed (via pull) → done (via result).
//
// ── Test seam ───────────────────────────────────────────────────────────────
// JWT_SECRET + the SQLite path are pinned BEFORE any app module is required. The
// ingest/machine secret is toggled per-case at request time (ihAuth reads it live).

'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require -------------------------------------------
process.env.JWT_SECRET = 'rr-int-test-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `rr_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH
delete process.env.INTEGRATION_HEALTH_SECRET

// (2) Require the real app pieces (share the SQLite singleton) ------------------
const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')

const { router: remediationRequestsRouter } = require('../routes/remediationRequests')

// (3) Build the app, mirroring server.js's mount: the router carries its own
//     per-method gates (requireAuth+requireAgency on create/list, ihAuth on the
//     machine pull + result), so it is mounted WITHOUT a blanket requireAuth.
const app = express()
app.use(express.json())
app.use('/api/integration-health', remediationRequestsRouter)

// (4) JWTs ---------------------------------------------------------------------
const SECRET   = process.env.JWT_SECRET
const sign     = (payload) => jwt.sign(payload, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-clientA', email: 'a@test', role: 'client', client_id: `rr-${process.pid}-A` })

const MACHINE_SECRET = 'remediation-shared-secret-value'

// (5) Lazy, idempotent, parallel-safe setup ------------------------------------
let server = null
let PORT = 0
let readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
      await new Promise((resolve) => {
        server = app.listen(0, () => { PORT = server.address().port; resolve() })
      })
    })()
  }
  return readyPromise
}

after(async () => {
  if (server) await new Promise((r) => server.close(r))
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

function request(method, pathname, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null
    const h = { ...headers }
    if (token) h['authorization'] = `Bearer ${token}`
    if (payload != null) {
      h['content-type']   = 'application/json'
      h['content-length'] = Buffer.byteLength(payload)
    }
    const r = http.request(
      { hostname: '127.0.0.1', port: PORT, method, path: pathname, headers: h },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json = null
          try { json = data ? JSON.parse(data) : null } catch {}
          resolve({ status: res.statusCode, body: json, raw: data })
        })
      }
    )
    r.on('error', reject)
    if (payload != null) r.write(payload)
    r.end()
  })
}

function withMachineSecret(secret, fn) {
  const prev = process.env.INTEGRATION_HEALTH_SECRET
  if (secret === undefined) delete process.env.INTEGRATION_HEALTH_SECRET
  else process.env.INTEGRATION_HEALTH_SECRET = secret
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.INTEGRATION_HEALTH_SECRET
      else process.env.INTEGRATION_HEALTH_SECRET = prev
    })
}

// ── CREATE: agency-only boundary ──────────────────────────────────────────────
test('POST /requests create requires agency: client JWT → 403, agency JWT → 201', async () => {
  await ready()

  const rClient = await request('POST', '/api/integration-health/requests', {
    token: CLIENT_A,
    body: { client_id: 'tenant-x', action: 'reaudit' },
  })
  assert.equal(rClient.status, 403, `client role must be 403 (got ${rClient.status})`)

  const rAgency = await request('POST', '/api/integration-health/requests', {
    token: AGENCY,
    body: { client_id: 'tenant-x', action: 'reaudit' },
  })
  assert.equal(rAgency.status, 201, `agency role must be 201 (got ${rAgency.status} ${rAgency.raw})`)
  assert.equal(rAgency.body.ok, true)
  assert.equal(rAgency.body.request.action, 'reaudit')
  assert.equal(rAgency.body.request.client_id, 'tenant-x')
  assert.equal(rAgency.body.request.status, 'pending', 'a fresh request is pending')
  assert.equal(rAgency.body.request.requested_by, 'agency@test', 'requested_by captured from the JWT')
})

// ── CREATE: allow-list enforcement ────────────────────────────────────────────
test('POST /requests rejects an action not in the safe allow-list → 400', async () => {
  await ready()

  // A plausible-but-forbidden vendor-write action MUST be rejected (no such enum).
  const rBad = await request('POST', '/api/integration-health/requests', {
    token: AGENCY,
    body: { client_id: 'tenant-x', action: 'delete_contact' },
  })
  assert.equal(rBad.status, 400, `out-of-list action must 400 (got ${rBad.status})`)
  assert.equal(rBad.body.code, 'BAD_ACTION')

  // Every allow-list action is accepted.
  for (const action of ['reaudit', 'clear_breaker', 'rebuild_index', 'export_queue']) {
    const r = await request('POST', '/api/integration-health/requests', {
      token: AGENCY,
      body: { client_id: 'tenant-allow', action, ...(action === 'clear_breaker' ? { params: { vendor: 'acculynx' } } : {}) },
    })
    assert.equal(r.status, 201, `${action} must be accepted (got ${r.status} ${r.raw})`)
    assert.equal(r.body.request.action, action)
  }

  // A missing client_id is a 400 too.
  const rNoClient = await request('POST', '/api/integration-health/requests', {
    token: AGENCY,
    body: { action: 'reaudit' },
  })
  assert.equal(rNoClient.status, 400, `missing client_id must 400 (got ${rNoClient.status})`)
  assert.equal(rNoClient.body.code, 'BAD_CLIENT')
})

// ── LIST: agency-only, newest-first, filters ──────────────────────────────────
test('GET /requests is agency-only and newest-first with optional filters', async () => {
  await ready()
  await db.query(`DELETE FROM remediation_requests`)

  // Client token is refused.
  const rClient = await request('GET', '/api/integration-health/requests', { token: CLIENT_A })
  assert.equal(rClient.status, 403, `client role must be 403 (got ${rClient.status})`)

  // Empty table → { requests: [] } (INERT until an operator requests one).
  const rEmpty = await request('GET', '/api/integration-health/requests', { token: AGENCY })
  assert.equal(rEmpty.status, 200)
  assert.deepEqual(rEmpty.body.requests, [])

  // Seed three requests across two tenants.
  await request('POST', '/api/integration-health/requests', { token: AGENCY, body: { client_id: 'ten-1', action: 'reaudit' } })
  await request('POST', '/api/integration-health/requests', { token: AGENCY, body: { client_id: 'ten-2', action: 'rebuild_index' } })
  const last = await request('POST', '/api/integration-health/requests', { token: AGENCY, body: { client_id: 'ten-1', action: 'export_queue' } })

  const rAll = await request('GET', '/api/integration-health/requests', { token: AGENCY })
  assert.equal(rAll.status, 200)
  assert.equal(rAll.body.requests.length, 3)
  // Newest-first: the last-created request is first.
  assert.equal(rAll.body.requests[0].id, last.body.request.id, 'newest request first')

  // client_id filter narrows to one tenant.
  const rTen1 = await request('GET', '/api/integration-health/requests?client_id=ten-1', { token: AGENCY })
  assert.equal(rTen1.body.requests.length, 2, 'ten-1 has two requests')
  assert.ok(rTen1.body.requests.every((r) => r.client_id === 'ten-1'))

  // status filter (all are pending right now).
  const rPending = await request('GET', '/api/integration-health/requests?status=pending', { token: AGENCY })
  assert.equal(rPending.body.requests.length, 3)
})

// ── PULL: secret-gated + atomic claim, no double-claim ────────────────────────
test('GET /requests/pending is secret-gated, claims pending rows, never double-claims', async () => {
  await ready()
  await db.query(`DELETE FROM remediation_requests`)

  // Fail CLOSED: 503 when the secret is unset.
  await withMachineSecret(undefined, async () => {
    const r = await request('GET', '/api/integration-health/requests/pending', { headers: { authorization: 'Bearer anything' } })
    assert.equal(r.status, 503, `unset secret must 503 (got ${r.status})`)
  })

  // 401 on a wrong token (secret armed).
  await withMachineSecret(MACHINE_SECRET, async () => {
    const r = await request('GET', '/api/integration-health/requests/pending', { headers: { authorization: 'Bearer nope' } })
    assert.equal(r.status, 401, `wrong token must 401 (got ${r.status})`)
  })

  // Seed two pending requests.
  await request('POST', '/api/integration-health/requests', { token: AGENCY, body: { client_id: 'pull-1', action: 'reaudit' } })
  await request('POST', '/api/integration-health/requests', { token: AGENCY, body: { client_id: 'pull-2', action: 'rebuild_index' } })

  await withMachineSecret(MACHINE_SECRET, async () => {
    // First pull claims BOTH and marks them claimed.
    const r1 = await request('GET', '/api/integration-health/requests/pending', { headers: { authorization: `Bearer ${MACHINE_SECRET}` } })
    assert.equal(r1.status, 200, `armed pull must 200 (got ${r1.status} ${r1.raw})`)
    assert.equal(r1.body.requests.length, 2, 'first pull claims both pending rows')
    assert.ok(r1.body.requests.every((r) => r.status === 'claimed'), 'pulled rows are now claimed')

    // SECOND pull finds nothing pending — no double-claim.
    const r2 = await request('GET', '/api/integration-health/requests/pending', { headers: { authorization: `Bearer ${MACHINE_SECRET}` } })
    assert.equal(r2.status, 200)
    assert.equal(r2.body.requests.length, 0, 'second pull must not re-claim already-claimed rows')
  })

  // x-secret header alternative is accepted too.
  await request('POST', '/api/integration-health/requests', { token: AGENCY, body: { client_id: 'pull-3', action: 'export_queue' } })
  await withMachineSecret(MACHINE_SECRET, async () => {
    const r = await request('GET', '/api/integration-health/requests/pending', { headers: { 'x-secret': MACHINE_SECRET } })
    assert.equal(r.status, 200, `x-secret header must be accepted (got ${r.status})`)
    assert.equal(r.body.requests.length, 1)
  })
})

// ── RESULT: secret-gated, validates, updates status + completed_at ────────────
test('POST /requests/:id/result is secret-gated, validates, and updates status', async () => {
  await ready()
  await db.query(`DELETE FROM remediation_requests`)

  const created = await request('POST', '/api/integration-health/requests', {
    token: AGENCY, body: { client_id: 'res-1', action: 'reaudit' },
  })
  const id = created.body.request.id

  // No secret armed → 503 (fail closed).
  await withMachineSecret(undefined, async () => {
    const r = await request('POST', `/api/integration-health/requests/${id}/result`, {
      headers: { authorization: `Bearer ${MACHINE_SECRET}` }, body: { status: 'done' },
    })
    assert.equal(r.status, 503, `unset secret must 503 (got ${r.status})`)
  })

  await withMachineSecret(MACHINE_SECRET, async () => {
    // 401 without the secret.
    const rNoAuth = await request('POST', `/api/integration-health/requests/${id}/result`, { body: { status: 'done' } })
    assert.equal(rNoAuth.status, 401, `missing token must 401 (got ${rNoAuth.status})`)

    // Bad body → 400, never 500.
    const rBad = await request('POST', `/api/integration-health/requests/${id}/result`, {
      headers: { authorization: `Bearer ${MACHINE_SECRET}` }, body: { status: 'not-a-status' },
    })
    assert.equal(rBad.status, 400, `bad status must 400 (got ${rBad.status})`)
    assert.equal(rBad.body.code, 'BAD_STATUS')

    // Unknown id → 404.
    const rMissing = await request('POST', '/api/integration-health/requests/no-such-id/result', {
      headers: { authorization: `Bearer ${MACHINE_SECRET}` }, body: { status: 'done' },
    })
    assert.equal(rMissing.status, 404, `unknown id must 404 (got ${rMissing.status})`)

    // Happy path: done + a result payload.
    const rOk = await request('POST', `/api/integration-health/requests/${id}/result`, {
      headers: { authorization: `Bearer ${MACHINE_SECRET}` },
      body: { status: 'done', result: { audited: 42, ok: true } },
    })
    assert.equal(rOk.status, 200, `valid result must 200 (got ${rOk.status} ${rOk.raw})`)
    assert.equal(rOk.body.request.status, 'done')
    assert.deepEqual(rOk.body.request.result, { audited: 42, ok: true })
    assert.ok(rOk.body.request.completed_at, 'completed_at stamped')
  })
})

// ── LIFECYCLE: pending → claimed → done ───────────────────────────────────────
test('full lifecycle: pending → claimed (pull) → done (result)', async () => {
  await ready()
  await db.query(`DELETE FROM remediation_requests`)

  // pending
  const created = await request('POST', '/api/integration-health/requests', {
    token: AGENCY, body: { client_id: 'life-1', action: 'clear_breaker', params: { vendor: 'jobber' } },
  })
  assert.equal(created.body.request.status, 'pending')
  assert.deepEqual(created.body.request.params, { vendor: 'jobber' }, 'params round-trip')
  const id = created.body.request.id

  await withMachineSecret(MACHINE_SECRET, async () => {
    // claimed (via pull)
    const pulled = await request('GET', '/api/integration-health/requests/pending', { headers: { authorization: `Bearer ${MACHINE_SECRET}` } })
    const mine = pulled.body.requests.find((r) => r.id === id)
    assert.ok(mine, 'our request was pulled')
    assert.equal(mine.status, 'claimed')
    assert.deepEqual(mine.params, { vendor: 'jobber' }, 'params survive the claim')

    // done (via result)
    const done = await request('POST', `/api/integration-health/requests/${id}/result`, {
      headers: { authorization: `Bearer ${MACHINE_SECRET}` }, body: { status: 'done', result: { cleared: 'jobber' } },
    })
    assert.equal(done.body.request.status, 'done')
  })

  // The agency list reflects the terminal state.
  const listed = await request('GET', '/api/integration-health/requests?client_id=life-1', { token: AGENCY })
  const row = listed.body.requests.find((r) => r.id === id)
  assert.equal(row.status, 'done')
  assert.ok(row.completed_at, 'completed_at present in the agency list')
})
