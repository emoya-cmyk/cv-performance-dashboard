// Multi-tenant authorization — REST integration (leak-proof) tests.
//
// Threat model: a logged-in role='client' user is pinned to exactly one
// client_id. They must never read, mutate, enumerate, or infer another
// tenant's data through ANY clientId-bearing endpoint, and they must never
// reach an agency-only management surface. This suite mounts the REAL routers
// exactly as server.js does (behind the REAL requireAuth), mints REAL JWTs, and
// drives them over HTTP — so it exercises the actual middleware chain end to end,
// not a stub.
//
// Four properties are proven:
//   (1) scopeClientParam GET surfaces  → client→OWN allowed, client→OTHER 403, agency allowed
//   (2) requireAgency surfaces          → role='client' is denied (403) everywhere; agency passes
//   (3) GET /api/clients list-filter    → client sees ONLY its own row; agency sees all
//   (4) POST /api/query behavioral clamp→ clients:'all' / forged dim:'client' filter is clamped to
//                                          the caller's own client; agency is NOT clamped
//
// ── Test seam ───────────────────────────────────────────────────────────────
// JWT_SECRET + the SQLite path must be pinned BEFORE any app module is required:
//   - auth.js captures JWT_SECRET at module load (const at top), so we set it first
//     and sign tokens with the same value.
//   - db.js selects SQLite when DATABASE_URL is unset and honors SQLITE_PATH.
// Routers require('../db') at load and Node caches the singleton, so every router
// shares this one SQLite file.

'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require -------------------------------------------
process.env.JWT_SECRET = 'authz-int-test-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `authz_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// (2) Now require the real app pieces (all share the SQLite singleton) ---------
const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')
const facts   = require('../lib/facts')

const { requireAuth }                     = require('../middleware/auth')
const { requireAgency, scopeClientParam } = require('../middleware/authz')

const clientsRouter        = require('../routes/clients')
const goalsRouter          = require('../routes/goals')
const updatesRouter        = require('../routes/updates')
const metricsRouter        = require('../routes/metrics')
const queryRouter          = require('../routes/query')
const reportsRouter        = require('../routes/reports')
const connectionsRouter    = require('../routes/connections')
const { router: syncRouter }   = require('../routes/sync')
const { router: sharesRouter } = require('../routes/shares')
const campaignsRouter      = require('../routes/campaigns')
const insightsRouter       = require('../routes/insights')
const aiRouter             = require('../routes/ai')
const alertsRouter         = require('../routes/alerts')

// (3) Build the app, mirroring server.js mounts (real requireAuth + each
//     router's own guards). Uses express.json() in place of server.js's custom
//     raw-body capture middleware — equivalent for JSON request bodies.
const app = express()
app.use(express.json())
app.use('/api/clients',     requireAuth, clientsRouter)
app.use('/api/goals',       requireAuth, goalsRouter)
app.use('/api/updates',     requireAuth, updatesRouter)
app.use('/api/metrics',     requireAuth, metricsRouter)
app.use('/api/query',       requireAuth, queryRouter)
app.use('/api/reports',     requireAuth, reportsRouter)
app.use('/api/connections', requireAuth, connectionsRouter)
app.use('/api/sync',        requireAuth, syncRouter)
app.use('/api/shares',      requireAuth, sharesRouter)
app.use('/api/campaigns',   requireAuth, campaignsRouter)
app.use('/api/ai',          requireAuth, aiRouter)
app.use('/api/insights',    requireAuth, insightsRouter)
app.use('/api/alerts',      requireAuth, alertsRouter)

// The two inline email routes from server.js (GET = scoped, PUT = agency-only).
// `/:id/email` is two segments, so the clients router's `/:id` (one segment)
// never matches it — these win regardless of registration order.
app.get('/api/clients/:id/email', requireAuth, scopeClientParam('id'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT digest_email, digest_enabled FROM clients WHERE id = $1`, [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.put('/api/clients/:id/email', requireAuth, requireAgency, async (_req, res) => {
  // Guard is the unit under test; a minimal handler keeps the agency-allowed
  // path side-effect-free (we only ever drive the DENIED direction here anyway).
  res.json({ ok: true })
})

// (4) Tenants + JWTs -----------------------------------------------------------
const A = `idor-${process.pid}-A`   // tenant "Acme"  (the caller)
const B = `idor-${process.pid}-B`   // tenant "Beta"  (the victim)
const SECRET = process.env.JWT_SECRET
const sign   = (payload) => jwt.sign(payload, SECRET)
const AGENCY   = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT_A = sign({ id: 'u-clientA', email: 'a@test',     role: 'client',  client_id: A })

// (5) Lazy, idempotent, parallel-safe setup -----------------------------------
let server = null
let PORT = 0
let readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
      await seed()
      await new Promise((resolve) => {
        server = app.listen(0, () => { PORT = server.address().port; resolve() })
      })
    })()
  }
  return readyPromise
}

async function seed() {
  await db.query(`INSERT INTO clients (id, name, status) VALUES ($1, $2, 'active')`, [A, 'Acme'])
  await db.query(`INSERT INTO clients (id, name, status) VALUES ($1, $2, 'active')`, [B, 'Beta'])
  // One google_ads spend fact per tenant so the POST /api/query clamp has real
  // cross-tenant data it must (not) leak. entity_id null = account grain.
  const gid = facts.channelId('google_ads')
  const FACT = `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (client_id, date, channel_id, COALESCE(entity_id, 0), metric_key)
                DO UPDATE SET metric_value = EXCLUDED.metric_value`
  await db.query(FACT, [A, '2026-06-01', gid, null, 'spend', 100])
  await db.query(FACT, [B, '2026-06-01', gid, null, 'spend', 250])
}

after(async () => {
  if (server) await new Promise((r) => server.close(r))
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// Minimal HTTP client over the ephemeral server.
function request(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    if (payload != null) {
      headers['content-type']   = 'application/json'
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
          resolve({ status: res.statusCode, body: json, raw: data })
        })
      }
    )
    r.on('error', reject)
    if (payload != null) r.write(payload)
    r.end()
  })
}

// ── (1) scopeClientParam GET surfaces ─────────────────────────────────────────
// Each builder yields the path for a given clientId. DB-only handlers, so the
// allowed direction is asserted as "not 403" (tolerates 200/404) — the security
// property is the 403 boundary, not the handler's data shape.
const SCOPED_GET = [
  (id) => `/api/metrics/${id}`,
  (id) => `/api/metrics/${id}/weekly`,
  (id) => `/api/metrics/${id}/summary`,
  (id) => `/api/metrics/${id}/anomalies`,
  (id) => `/api/reports/${id}`,
  (id) => `/api/reports/${id}/latest`,
  (id) => `/api/goals/${id}`,
  (id) => `/api/updates/${id}`,
  (id) => `/api/campaigns/${id}`,
  (id) => `/api/insights/${id}`,
  (id) => `/api/clients/${id}`,
  (id) => `/api/clients/${id}/email`,
  (id) => `/api/alerts/client/${id}`,
]

test('scopeClientParam GET surfaces: client→OWN allowed, client→OTHER 403, agency allowed', async () => {
  await ready()
  for (const build of SCOPED_GET) {
    const own   = build(A)
    const other = build(B)

    const rOwn = await request('GET', own, { token: CLIENT_A })
    assert.notEqual(rOwn.status, 403, `client→OWN must be allowed: GET ${own} (got ${rOwn.status})`)

    const rOther = await request('GET', other, { token: CLIENT_A })
    assert.equal(rOther.status, 403, `client→OTHER must be blocked: GET ${other} (got ${rOther.status})`)

    const rAgency = await request('GET', other, { token: AGENCY })
    assert.notEqual(rAgency.status, 403, `agency must be allowed: GET ${other} (got ${rAgency.status})`)
  }
})

// AI recap/brief carry scopeClientParam('clientId') too. We assert ONLY the
// denied direction — the guard short-circuits to 403 BEFORE any Anthropic/model
// call, so this never touches the network. (The /ask scope path is separately
// covered by ai.askscope.test.js.)
test('ai recap/brief :clientId — cross-tenant client blocked (403) before any model call', async () => {
  await ready()
  for (const p of [`/api/ai/recap/${B}`, `/api/ai/brief/${B}`]) {
    const r = await request('GET', p, { token: CLIENT_A })
    assert.equal(r.status, 403, `GET ${p} must be 403 for a cross-tenant client (got ${r.status})`)
  }
})

// ── (2) requireAgency surfaces ────────────────────────────────────────────────
// role='client' must be denied (403) on every agency-only endpoint — reads AND
// mutations. requireAgency short-circuits before any handler logic, so driving
// the mutations with a client token performs NO writes.
const AGENCY_ONLY = [
  ['GET',    `/api/metrics/`],
  ['GET',    `/api/insights/`],
  ['GET',    `/api/insights/ops`],       // autonomy-liveness grader — agency-only
  ['GET',    `/api/connections/${A}`],   // blanket router.use(requireAgency)
  ['GET',    `/api/shares/${A}`],        // blanket router.use(requireAgency)
  ['POST',   `/api/sync/${A}/all`],      // blanket router.use(requireAgency)
  ['POST',   `/api/reports/${A}`],
  ['PUT',    `/api/updates/${A}`],
  ['POST',   `/api/campaigns/${A}`],
  ['POST',   `/api/clients/`],
  ['PUT',    `/api/clients/${B}`],
  ['DELETE', `/api/clients/${B}`],
  ['PUT',    `/api/clients/${A}/email`],
  ['GET',    `/api/alerts/`],
  ['GET',    `/api/alerts/rules`],
  ['GET',    `/api/alerts/rules/${A}`],
  ['PUT',    `/api/alerts/rules/${A}`],
]

test('requireAgency surfaces: role=client is denied (403) on every agency-only endpoint', async () => {
  await ready()
  for (const [m, p] of AGENCY_ONLY) {
    const r = await request(m, p, { token: CLIENT_A })
    assert.equal(r.status, 403, `${m} ${p} must be 403 for role=client (got ${r.status})`)
  }
})

// And the agency token passes the guard (not 403) on the safe agency reads.
// (POST /api/sync/:clientId/all is a no-op here: no seeded connections → {}.)
const AGENCY_ALLOWED_SAFE = [
  ['GET',  `/api/metrics/`],
  ['GET',  `/api/insights/`],
  ['GET',  `/api/insights/ops`],   // empty ledger → 'warming' 200, never 403 for agency
  ['GET',  `/api/connections/${A}`],
  ['GET',  `/api/shares/${A}`],
  ['POST', `/api/sync/${A}/all`],
  ['GET',  `/api/alerts/`],
  ['GET',  `/api/alerts/rules`],
]

test('requireAgency surfaces: role=agency passes the guard on safe agency reads', async () => {
  await ready()
  for (const [m, p] of AGENCY_ALLOWED_SAFE) {
    const r = await request(m, p, { token: AGENCY })
    assert.notEqual(r.status, 403, `${m} ${p} must pass requireAgency for agency (got ${r.status})`)
  }
})

// ── (2b) /ops autonomy-liveness: agency-shaped, never leaked to a client ──────
// The ops-health grader is an AGENCY surface. Two properties:
//   (i)  the agency GET /ops returns the assessOps shape (proves the route is
//        actually wired — not merely guarded — and is SQLite-safe on an empty
//        ledger, grading 'warming' rather than throwing).
//   (ii) NONE of the distinctive ops-only field names ever appear in the
//        client-reachable GET /:clientId card payload. These tokens identify
//        engine-liveness internals (job cadence gradings, self-heal counts); a
//        client must never see whether the autonomy loop is healthy or how often
//        it self-heals. Asserted against the raw serialized body so a leak nested
//        at any depth is caught.
const OPS_ONLY_TOKENS = [
  'liveCount', 'overdueCount', 'staleCount', 'neverCount',
  'degradedCount', 'healsRecent', 'healWindowMs',
]

test('GET /api/insights/ops returns the agency ops-health shape (wired + SQLite-safe)', async () => {
  await ready()
  const r = await request('GET', '/api/insights/ops', { token: AGENCY })
  assert.equal(r.status, 200, `agency /ops should 200 (got ${r.status} ${r.raw})`)
  assert.ok(r.body && typeof r.body === 'object', 'ops body must be an object')
  // Empty ledger in the test DB ⇒ no job has ever run ⇒ 'warming' (cold-start honest).
  assert.equal(r.body.status, 'warming', `empty ledger must grade 'warming' (got ${r.body.status})`)
  assert.ok(Array.isArray(r.body.jobs), 'ops payload must carry a per-job array')
  assert.equal(r.body.neverCount, r.body.total, 'every job is "never" on an empty ledger')
  assert.ok('healsRecent' in r.body, 'ops payload must carry the self-heal count')
})

test('client GET /:clientId card carries NO ops-liveness fields (leak-proof)', async () => {
  await ready()
  const r = await request('GET', `/api/insights/${A}`, { token: CLIENT_A })
  assert.notEqual(r.status, 403, `client must reach its OWN card (got ${r.status})`)
  const wire = JSON.stringify(r.body || {})
  for (const tok of OPS_ONLY_TOKENS) {
    assert.ok(!wire.includes(tok), `client card must NOT expose ops field "${tok}"`)
  }
})

// ── (3) GET /api/clients list-level row filter ────────────────────────────────
test('GET /api/clients is row-filtered: client sees only itself, agency sees all', async () => {
  await ready()

  const rClient = await request('GET', '/api/clients', { token: CLIENT_A })
  assert.equal(rClient.status, 200, `client list should 200 (got ${rClient.status})`)
  assert.ok(Array.isArray(rClient.body), 'client list must be an array')
  const clientIds = rClient.body.map((c) => c.id)
  assert.deepEqual(clientIds, [A], `client must see ONLY its own row (got ${JSON.stringify(clientIds)})`)
  assert.ok(!clientIds.includes(B), 'client must NOT see the other tenant in the list')

  const rAgency = await request('GET', '/api/clients', { token: AGENCY })
  assert.equal(rAgency.status, 200, `agency list should 200 (got ${rAgency.status})`)
  const agencyIds = rAgency.body.map((c) => c.id)
  assert.ok(
    agencyIds.includes(A) && agencyIds.includes(B),
    `agency must see both tenants (got ${JSON.stringify(agencyIds)})`
  )
})

// ── (4) POST /api/query behavioral clamp (the crown jewel) ────────────────────
const DR = { start: '2026-05-01', end: '2026-06-30' }

test('POST /api/query clamps clients:"all" to the caller for client, not for agency', async () => {
  await ready()

  // (a) client A asks for ALL clients → must be clamped to A only.
  const rAll = await request('POST', '/api/query', {
    token: CLIENT_A,
    body: { clients: 'all', metrics: ['spend'], dateRange: DR, groupBy: ['client'] },
  })
  assert.equal(rAll.status, 200, `client query should succeed (got ${rAll.status} ${rAll.raw})`)
  const rowsAll = (rAll.body && rAll.body.rows) || []
  assert.ok(rowsAll.length >= 1, 'client should see its own row')
  assert.ok(
    rowsAll.every((r) => r.client === A),
    `every row must be the caller's client (got ${JSON.stringify(rowsAll.map((r) => r.client))})`
  )
  assert.ok(!rowsAll.some((r) => r.client === B), 'client must NOT see the other tenant')

  // (b) client A forges a dim:'client' filter targeting B → still clamped to A
  //     (the route strips dim:'client' filters AND pins clients=[A]).
  const rForge = await request('POST', '/api/query', {
    token: CLIENT_A,
    body: {
      clients: 'all', metrics: ['spend'], dateRange: DR, groupBy: ['client'],
      filters: [{ dim: 'client', op: 'in', values: [B] }],
    },
  })
  assert.equal(rForge.status, 200, `forged-filter query should succeed (got ${rForge.status} ${rForge.raw})`)
  const rowsForge = (rForge.body && rForge.body.rows) || []
  assert.ok(!rowsForge.some((r) => r.client === B), 'forged dim:client filter must NOT leak the other tenant')
  assert.ok(rowsForge.every((r) => r.client === A), "forged-filter rows must remain the caller's client")

  // (c) agency asks for ALL → sees BOTH tenants (not clamped).
  const rAgency = await request('POST', '/api/query', {
    token: AGENCY,
    body: { clients: 'all', metrics: ['spend'], dateRange: DR, groupBy: ['client'] },
  })
  assert.equal(rAgency.status, 200, `agency query should succeed (got ${rAgency.status} ${rAgency.raw})`)
  const ids = ((rAgency.body && rAgency.body.rows) || []).map((r) => r.client)
  assert.ok(ids.includes(A) && ids.includes(B), `agency must see both tenants (got ${JSON.stringify(ids)})`)
})
