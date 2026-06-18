// Integration-health bridge — REST integration tests over the REAL router.
//
// Covers the cli_framework → dashboard "Integration Health" surface end to end:
//
//   INGEST (POST /api/integration-health — machine, shared-secret gated):
//     • 503 when INTEGRATION_HEALTH_SECRET is unset (fail CLOSED).
//     • 401 on a wrong/missing token (with the secret armed).
//     • 200 + correct upsert with the right Bearer secret; a re-POST UPDATES the
//       same client_id row (UNIQUE upsert), never duplicates.
//
//   READ (GET /api/integration-health — agency-only):
//     • role='client' JWT → 403 (requireAgency boundary); agency JWT → 200.
//     • empty table → { tenants:[], summary{...zeros} } (INERT until pushed).
//     • after ingest → rows worst-health-first, breakers_tripped parsed.
//
// ── Test seam ───────────────────────────────────────────────────────────────
// JWT_SECRET + the SQLite path are pinned BEFORE any app module is required
// (auth captures JWT_SECRET at module load; db.js selects SQLite on no DATABASE_URL
// and honors SQLITE_PATH). The ingest secret is toggled per-case at request time —
// ihAuth reads process.env.INTEGRATION_HEALTH_SECRET on every request.

'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require -------------------------------------------
process.env.JWT_SECRET = 'ih-int-test-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `ih_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH
// Start with the ingest secret UNSET so the fail-closed case is honest.
delete process.env.INTEGRATION_HEALTH_SECRET

// (2) Require the real app pieces (share the SQLite singleton) ------------------
const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')

const { requireAuth } = require('../middleware/auth')
const { router: integrationHealthRouter } = require('../routes/integrationHealth')

// (3) Build the app, mirroring server.js's mount. The router carries its own
//     per-method gates (ihAuth on POST, requireAuth+requireAgency on GET), so it is
//     mounted WITHOUT a blanket requireAuth — exactly as in server.js. express.json()
//     stands in for server.js's raw-body capture (equivalent for JSON bodies).
const app = express()
app.use(express.json())
app.use('/api/integration-health', integrationHealthRouter)

// (4) JWTs ---------------------------------------------------------------------
const SECRET   = process.env.JWT_SECRET
const sign     = (payload) => jwt.sign(payload, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-clientA', email: 'a@test', role: 'client', client_id: `ih-${process.pid}-A` })

const INGEST_SECRET = 'ingest-shared-secret-value'

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

// Minimal HTTP client. `headers` lets a case set the ingest secret header(s).
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

// Toggle the ingest secret env around a request (ihAuth reads it at request time).
function withIngestSecret(secret, fn) {
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

// A canonical producer-shaped payload (replicates cli_framework's contract).
function samplePayload() {
  return {
    generated_at: '2026-06-16T10:00:00.000Z',
    tenants: [
      {
        tenant_id: 'tenant-ok',
        audit: { critical: 0, high: 0, medium: 1, low: 2, as_of: '2026-06-15T00:00:00.000Z' },
        dead_letters_open: 0,
        breakers_tripped: [],
        last_activity: '2026-06-16T09:55:00.000Z',
        health: 'ok',
      },
      {
        tenant_id: 'tenant-crit',
        audit: { critical: 3, high: 2, medium: 0, low: 0, as_of: '2026-06-15T00:00:00.000Z' },
        dead_letters_open: 5,
        breakers_tripped: [{ vendor: 'acculynx', reason: 'auth_failed', since: '2026-06-16T08:00:00.000Z' }],
        last_activity: '2026-06-16T08:30:00.000Z',
        health: 'critical',
      },
      {
        tenant_id: 'tenant-watch',
        audit: null,
        dead_letters_open: 1,
        breakers_tripped: [],
        last_activity: null,
        health: 'watch',
      },
    ],
  }
}

// ── INGEST: fail CLOSED when the secret is unset ──────────────────────────────
test('POST ingest 503s when INTEGRATION_HEALTH_SECRET is unset (fail closed)', async () => {
  await ready()
  await withIngestSecret(undefined, async () => {
    const r = await request('POST', '/api/integration-health', {
      headers: { authorization: 'Bearer anything' },
      body: samplePayload(),
    })
    assert.equal(r.status, 503, `unset secret must 503 (got ${r.status} ${r.raw})`)
  })
})

// ── INGEST: 401 on wrong / missing token ──────────────────────────────────────
test('POST ingest 401s on a wrong token (secret armed)', async () => {
  await ready()
  await withIngestSecret(INGEST_SECRET, async () => {
    const rWrong = await request('POST', '/api/integration-health', {
      headers: { authorization: 'Bearer not-the-secret' },
      body: samplePayload(),
    })
    assert.equal(rWrong.status, 401, `wrong token must 401 (got ${rWrong.status})`)

    const rMissing = await request('POST', '/api/integration-health', { body: samplePayload() })
    assert.equal(rMissing.status, 401, `missing token must 401 (got ${rMissing.status})`)
  })
})

// ── INGEST: 200 + correct upsert, and re-POST UPDATES (no duplicate) ──────────
test('POST ingest 200 upserts one row per tenant; re-POST updates the same client_id row', async () => {
  await ready()
  await withIngestSecret(INGEST_SECRET, async () => {
    // First push.
    const r1 = await request('POST', '/api/integration-health', {
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: samplePayload(),
    })
    assert.equal(r1.status, 200, `armed + right secret must 200 (got ${r1.status} ${r1.raw})`)
    assert.equal(r1.body.ok, true)
    assert.equal(r1.body.upserted, 3, 'three tenants upserted')

    const after1 = await db.query(
      `SELECT health, dead_letters_open FROM integration_health WHERE client_id = $1`,
      ['tenant-crit']
    )
    assert.equal(after1.rows.length, 1, 'tenant-crit stored exactly once')
    assert.equal(after1.rows[0].dead_letters_open, 5)

    // Re-POST with a CHANGED snapshot for tenant-crit → updates, not duplicates.
    const updated = samplePayload()
    updated.generated_at = '2026-06-16T11:00:00.000Z'
    updated.tenants[1].dead_letters_open = 9
    updated.tenants[1].health = 'degraded'

    const r2 = await request('POST', '/api/integration-health', {
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: updated,
    })
    assert.equal(r2.status, 200)
    assert.equal(r2.body.upserted, 3)

    const after2 = await db.query(
      `SELECT health, dead_letters_open FROM integration_health WHERE client_id = $1`,
      ['tenant-crit']
    )
    assert.equal(after2.rows.length, 1, 're-POST must UPDATE the same row, not add a duplicate')
    assert.equal(after2.rows[0].dead_letters_open, 9, 'dead_letters_open updated')
    assert.equal(after2.rows[0].health, 'degraded', 'health updated')

    // Total distinct rows = 3 (no duplicates across both pushes).
    const all = await db.query(`SELECT COUNT(*) AS n FROM integration_health`)
    assert.equal(Number(all.rows[0].n), 3, 'exactly three rows total after two pushes')
  })

  // x-secret header alternative is also accepted.
  await withIngestSecret(INGEST_SECRET, async () => {
    const r = await request('POST', '/api/integration-health', {
      headers: { 'x-secret': INGEST_SECRET },
      body: samplePayload(),
    })
    assert.equal(r.status, 200, `x-secret header must be accepted (got ${r.status} ${r.raw})`)
  })
})

// ── INGEST: malformed payload → 400, never 500 ────────────────────────────────
test('POST ingest 400s on a malformed payload (tenants not an array)', async () => {
  await ready()
  await withIngestSecret(INGEST_SECRET, async () => {
    const r = await request('POST', '/api/integration-health', {
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: { generated_at: '2026-06-16T10:00:00.000Z', tenants: 'nope' },
    })
    assert.equal(r.status, 400, `bad tenants must 400, never 500 (got ${r.status})`)
  })
})

// ── READ: requireAgency boundary ──────────────────────────────────────────────
test('GET read is agency-only: client JWT → 403, agency JWT → 200', async () => {
  await ready()
  const rClient = await request('GET', '/api/integration-health', { token: CLIENT_A })
  assert.equal(rClient.status, 403, `client role must be 403 (got ${rClient.status})`)

  const rAgency = await request('GET', '/api/integration-health', { token: AGENCY })
  assert.equal(rAgency.status, 200, `agency role must be 200 (got ${rAgency.status} ${rAgency.raw})`)
})

// ── READ: empty-state returns zeros ───────────────────────────────────────────
// The feature is INERT until pushed: an empty table reads as all-zeros, never an
// error. Truncate the table first so prior ingests don't pollute the check.
test('GET read empty-state returns { tenants:[], summary zeros }', async () => {
  await ready()
  await db.query(`DELETE FROM integration_health`)

  const r = await request('GET', '/api/integration-health', { token: AGENCY })
  assert.equal(r.status, 200, `empty read must 200 (got ${r.status})`)
  assert.deepEqual(r.body.tenants, [], 'empty table → empty tenants')
  assert.deepEqual(r.body.summary.by_health, { ok: 0, watch: 0, degraded: 0, critical: 0 })
  assert.equal(r.body.summary.tenant_count, 0)
  assert.equal(r.body.summary.dead_letters_open, 0)
  assert.equal(r.body.summary.breakers_tripped, 0)
})

// ── READ: after ingest, rows are worst-health-first with parsed breakers ──────
test('GET read returns rows worst-health-first after ingest', async () => {
  await ready()
  await db.query(`DELETE FROM integration_health`)
  await withIngestSecret(INGEST_SECRET, async () => {
    const ing = await request('POST', '/api/integration-health', {
      headers: { authorization: `Bearer ${INGEST_SECRET}` },
      body: samplePayload(),
    })
    assert.equal(ing.status, 200)
  })

  const r = await request('GET', '/api/integration-health', { token: AGENCY })
  assert.equal(r.status, 200)
  const order = r.body.tenants.map((t) => t.health)
  // critical → watch → ok (no degraded in the sample). Worst first.
  assert.deepEqual(order, ['critical', 'watch', 'ok'], `worst-health-first (got ${JSON.stringify(order)})`)

  const crit = r.body.tenants.find((t) => t.tenant_id === 'tenant-crit')
  assert.ok(crit, 'tenant-crit present')
  assert.equal(crit.dead_letters_open, 5)
  assert.ok(Array.isArray(crit.breakers_tripped), 'breakers_tripped parsed to an array')
  assert.equal(crit.breakers_tripped.length, 1)
  assert.equal(crit.breakers_tripped[0].vendor, 'acculynx')
  assert.equal(crit.audit.critical, 3)

  // Summary reflects the roster.
  assert.equal(r.body.summary.tenant_count, 3)
  assert.deepEqual(r.body.summary.by_health, { ok: 1, watch: 1, degraded: 0, critical: 1 })
  assert.equal(r.body.summary.dead_letters_open, 6) // 0 + 5 + 1
  assert.equal(r.body.summary.breakers_tripped, 1)
})
