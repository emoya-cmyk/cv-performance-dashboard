// Cold-start / empty-state integration sweep (P2).
//
// A brand-new tenant — one `clients` row, ZERO `fact_metric`, ZERO
// `weekly_reports`, ZERO `connections` — is the FIRST thing every real client
// sees the moment an operator onboards them and before any connector has
// synced. This file proves the whole read surface survives that state with no
// sharp edges, driven over HTTP through the REAL routers exactly as server.js
// wires them (requireAuth in front of the REST routers; agencyRouter public).
//
// Three invariants are asserted on every cold read:
//   (1) NO 500 — status < 500 everywhere (the one documented exception is
//       POST /api/ai/ask, which is a hard 503 NO_AI without ANTHROPIC_API_KEY —
//       by design, allow-listed). The intelligence engine "never throws on the
//       detection path (degrades to deterministic templates)", so a 5xx here
//       would only ever mean a real DB/transport fault — exactly what we want
//       to catch before a client does.
//   (2) NO NaN / Infinity over the wire — JSON.stringify(NaN|Infinity) → "null",
//       so a raw numeric non-finite is invisible after parse; only a TEMPLATED
//       string ("$NaN", "NaN%", "Infinity") leaks visibly. We therefore scan the
//       RAW response TEXT for the substrings "NaN"/"Infinity" (the latter also
//       covers "-Infinity"). A clean cold read must contain neither.
//   (3) NO false ALARM — zero data must not manufacture a crisis. Every
//       'critical'-severity insight is emitted only behind a real ratio /
//       weeks-behind computation that needs prior data, so none can fire on an
//       empty book. We assert no `"severity":"critical"` appears in any payload.
//       (A connection-health BAND of "critical" for an unconfigured client is a
//       legitimate "connect your accounts" setup prompt, not a data alarm, and
//       is serialized as a `"critical":N` tally key — not a `severity` field —
//       so it is correctly out of scope of this check.)
//
// Plus direct pure-lib assertions on lib/metricsCore against degenerate inputs
// (undefined / {} / all-null row, and an empty anomaly past) — the unit-level
// floor under the same guarantee.
//
// ── Test seam ───────────────────────────────────────────────────────────────
// `node --test` runs each file in its own process, so the env pins below have
// zero blast radius on the rest of the suite. JWT_SECRET + SQLITE_PATH are set
// before any app module loads (db.js selects SQLite when DATABASE_URL is unset).
// NODE_ENV='test' (the ONLY NODE_ENV branch in routes/lib/middleware is the
// shared rate-limiter's defaultSkip) neutralizes BOTH the login limiter and the
// AI budget without weakening any assertion. ANTHROPIC_API_KEY is deleted so the
// AI layer degrades to deterministic templates offline — the true cold-start
// posture before a key is provisioned.

'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require ------------------------------------------
process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'coldstart-int-secret'
delete process.env.DATABASE_URL          // → db.js uses SQLite
delete process.env.ANTHROPIC_API_KEY     // → AI degrades to templates / 503, offline
delete process.env.FORCE_RATE_LIMIT      // → NODE_ENV='test' bypass stays active
const DB_PATH = path.join(os.tmpdir(), `coldstart_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// (2) Now require the real app pieces (share the SQLite singleton) ------------
const jwt     = require('jsonwebtoken')
const express = require('express')
const db      = require('../db')

const { requireAuth }   = require('../middleware/auth')
const metricsRouter     = require('../routes/metrics')
const queryRouter       = require('../routes/query')
const reportsRouter     = require('../routes/reports')
const connectionsRouter = require('../routes/connections')
const agencyRouter      = require('../routes/agency')
const aiRouter          = require('../routes/ai')
const insightsRouter    = require('../routes/insights')
const metricsCore       = require('../lib/metricsCore')

// (3) Build an app mirroring server.js's protected read surface ---------------
const app = express()
app.set('trust proxy', 1)
app.use(express.json())
app.use('/api/metrics',     requireAuth, metricsRouter)
app.use('/api/query',       requireAuth, queryRouter)
app.use('/api/reports',     requireAuth, reportsRouter)
app.use('/api/connections', requireAuth, connectionsRouter)
app.use('/api/agency',      agencyRouter)                  // GET public, PUT self-guards
app.use('/api/ai',          requireAuth, aiRouter)
app.use('/api/insights',    requireAuth, insightsRouter)

// (4) The single cold-start tenant + its tokens -------------------------------
const C = `cold-${process.pid}`
const SECRET = process.env.JWT_SECRET
const sign   = (p) => jwt.sign(p, SECRET)
const AGENCY = sign({ id: 'u-agency', email: 'agency@test', role: 'agency', client_id: null })
const CLIENT = sign({ id: 'u-client', email: 'c@test',      role: 'client', client_id: C })

let server = null
let PORT = 0
let readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
      // Seed EXACTLY one active client. NO fact_metric, NO weekly_reports, NO
      // connections — the genuine empty-book state on day one.
      await db.query(
        `INSERT INTO clients (id, name, status) VALUES ($1, $2, 'active')`,
        [C, 'Cold Start Co']
      )
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

// Minimal HTTP JSON client. Resolves { status, body, raw } — `.raw` is the text
// the NaN/Infinity substring scan needs (a parsed body has already lost it).
function request(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    if (payload) {
      headers['content-type']   = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const req = http.request(
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
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ── Shared assertions ────────────────────────────────────────────────────────
// (1)+(2): never a 500, never a non-finite leak in the serialized payload.
function assertClean(r, label) {
  assert.ok(r.status < 500, `${label}: must not 500 on cold start (got ${r.status}: ${r.raw})`)
  assert.ok(!/NaN/.test(r.raw),      `${label}: leaked "NaN" over the wire (raw: ${r.raw})`)
  assert.ok(!/Infinity/.test(r.raw), `${label}: leaked "Infinity" over the wire (raw: ${r.raw})`)
}
// (3): zero data must not fabricate a critical-severity insight. Shape-agnostic
// raw scan — matches a severity FIELD set to "critical", not a tally KEY.
function assertNoCriticalSeverity(r, label) {
  assert.ok(
    !/"severity"\s*:\s*"critical"/.test(r.raw),
    `${label}: raised a critical-severity item on ZERO data — false alarm (raw: ${r.raw})`
  )
}

// Every literal GET on the agency read surface. Each insights literal route is
// declared before /:clientId in the router, so Express resolves them correctly.
const AGENCY_READS = [
  '/api/insights',
  '/api/insights/health',
  '/api/insights/benchmarks',
  '/api/insights/recoveries',
  '/api/insights/systemic',
  '/api/insights/trajectory',
  '/api/insights/pacing',
  '/api/insights/reallocation',
  '/api/insights/reallocation-efficacy',
  '/api/insights/reallocation-efficacy-health',
  '/api/insights/connection-health',
  '/api/insights/impact',
  '/api/insights/pulse',
  '/api/insights/efficacy',
  `/api/insights/${C}`,
  `/api/metrics/${C}`,
  `/api/metrics/${C}/weekly`,
  `/api/metrics/${C}/summary`,
  `/api/metrics/${C}/anomalies`,
  '/api/metrics',
  `/api/reports/${C}`,
  `/api/reports/${C}/latest`,
  `/api/connections/${C}`,
  '/api/query/schema',
  '/api/agency/settings',
]

// ── (A) Whole agency read surface survives the empty book ────────────────────
test('cold start: every agency GET is clean — no 500, no NaN/Infinity, no false critical', async () => {
  await ready()
  for (const p of AGENCY_READS) {
    const r = await request('GET', p, { token: AGENCY })
    assertClean(r, `GET ${p}`)
    assertNoCriticalSeverity(r, `GET ${p}`)
  }
})

// ── (B) The highest-signal endpoints have the exact empty shapes ─────────────
test('cold start: empty-state shapes are correct (insights feed, connections, reports, settings)', async () => {
  await ready()

  // Agency intelligence feed: a real 200, and not one critical item on no data.
  const feed = await request('GET', '/api/insights', { token: AGENCY })
  assert.equal(feed.status, 200, 'agency insights feed is reachable')
  assertNoCriticalSeverity(feed, 'GET /api/insights')
  if (feed.body && feed.body.by_severity && 'critical' in feed.body.by_severity) {
    assert.equal(feed.body.by_severity.critical, 0, 'zero critical insights on an empty book')
  }

  // No connectors configured yet → empty list (agency can read any client).
  const conns = await request('GET', `/api/connections/${C}`, { token: AGENCY })
  assert.equal(conns.status, 200)
  assert.deepEqual(conns.body, [], 'a client with no connections returns []')

  // No weekly reports generated yet → empty list.
  const reports = await request('GET', `/api/reports/${C}`, { token: AGENCY })
  assert.equal(reports.status, 200)
  assert.ok(Array.isArray(reports.body), 'reports list is an array')
  assert.equal(reports.body.length, 0, 'no reports generated yet → []')

  // Public agency settings always resolve to an object (defaults if unset).
  const settings = await request('GET', '/api/agency/settings', { token: AGENCY })
  assert.equal(settings.status, 200)
  assert.equal(typeof settings.body, 'object')
  assert.ok(settings.body !== null, 'settings is a concrete object, never null')
})

// ── (C) Semantic query over an empty fact grain → 200 with zero rows ─────────
test('cold start: POST /api/query over empty fact_metric → 200, rows:[], clean', async () => {
  await ready()
  const body = {
    metrics:   ['spend', 'leads', 'roas'],
    dateRange: { start: '2026-01-01', end: '2026-06-04' },
    groupBy:   ['channel'],
  }

  const agency = await request('POST', '/api/query', { token: AGENCY, body })
  assertClean(agency, 'POST /api/query (agency)')
  assert.equal(agency.status, 200)
  assert.ok(Array.isArray(agency.body.rows), 'query returns a rows array')
  assert.equal(agency.body.rows.length, 0, 'no facts → no rows (ratios never divide by zero)')

  // A client token is clamped to its own (still empty) book — same clean zero.
  const client = await request('POST', '/api/query', { token: CLIENT, body })
  assertClean(client, 'POST /api/query (client-clamped)')
  assert.equal(client.status, 200)
  assert.equal(client.body.rows.length, 0)
})

// ── (D) AI layer degrades cleanly with no ANTHROPIC_API_KEY ──────────────────
test('cold start: AI recap/brief degrade to grounded templates (200); pure-DB AI reads are clean', async () => {
  await ready()

  // Narrative endpoints degrade to deterministic templates — 200, never a throw.
  for (const p of [`/api/ai/recap/${C}`, `/api/ai/brief/${C}`, '/api/ai/brief']) {
    const r = await request('GET', p, { token: AGENCY })
    assertClean(r, `GET ${p}`)
    assert.ok(r.status < 500, `${p} degrades rather than failing (got ${r.status})`)
  }

  // Pure-DB AI reads (no LLM key needed) — clean idle/insufficient state, no 500.
  const pureDbAi = [
    '/api/ai/brief-health',
    '/api/ai/brief-impact',
    '/api/ai/lead-policy',
    '/api/ai/lead-policy-health',
    '/api/ai/lead-policy-governance',
    '/api/ai/brief-engagement',
    '/api/ai/ask/suggestions',
  ]
  for (const p of pureDbAi) {
    const r = await request('GET', p, { token: AGENCY })
    assertClean(r, `GET ${p}`)
    assertNoCriticalSeverity(r, `GET ${p}`)
  }
})

test('cold start: POST /api/ai/ask without an API key is a clean, documented 503 (NO_AI)', async () => {
  await ready()
  const r = await request('POST', '/api/ai/ask', {
    token: AGENCY,
    body:  { question: 'How are we doing this week?' },
  })
  assert.equal(r.status, 503, `natural-language ask requires a key → 503 NO_AI (got ${r.status}: ${r.raw})`)
  assert.ok(!/NaN|Infinity/.test(r.raw), 'the 503 envelope itself leaks no non-finite value')
})

// ── (E) Client-token cold start: own book is clean; agency-only is fenced ─────
test('cold start: a client token reads its own empty book cleanly and is fenced from agency-only routes', async () => {
  await ready()

  // Own client metrics — scopeClientParam permits self → clean 200.
  const ownMetrics = await request('GET', `/api/metrics/${C}`, { token: CLIENT })
  assertClean(ownMetrics, 'GET /api/metrics/:own (client)')
  assert.ok(ownMetrics.status < 400, `client may read its own metrics (got ${ownMetrics.status})`)

  // Own per-client insights — also self-scoped.
  const ownInsights = await request('GET', `/api/insights/${C}`, { token: CLIENT })
  assertClean(ownInsights, 'GET /api/insights/:own (client)')
  assertNoCriticalSeverity(ownInsights, 'GET /api/insights/:own (client)')

  // Connections is agency-only (blanket requireAgency) → 403 even for own id.
  const conns = await request('GET', `/api/connections/${C}`, { token: CLIENT })
  assert.equal(conns.status, 403, 'connections is agency-only — a client token is forbidden')
})

// ── (F) Pure-lib floor: metricsCore stays finite on degenerate inputs ────────
test('metricsCore.derive yields finite zeros on undefined / empty / all-null rows', () => {
  const KPI = ['total_spend', 'total_leads', 'total_closed', 'total_revenue', 'roas', 'close_rate', 'cpl']
  const degenerate = [
    metricsCore.derive(undefined),
    metricsCore.derive({}),
    metricsCore.derive({
      ads_spend: null, lsa_spend: null, meta_spend: null,
      raw_leads: null, closed_won: null, projected_revenue: null,
    }),
  ]
  for (const d of degenerate) {
    for (const k of KPI) {
      assert.ok(Number.isFinite(d[k]), `derive(): ${k} must be finite, got ${d[k]}`)
    }
    // Every ratio divides by a guarded denominator → exactly 0, never NaN/Inf.
    assert.equal(d.roas, 0,       'roas is 0 when there is no spend')
    assert.equal(d.cpl, 0,        'cpl is 0 when there are no leads')
    assert.equal(d.close_rate, 0, 'close_rate is 0 when there are no leads')
  }
})

test('metricsCore.pctChange and detectAnomalies never fabricate a signal from no prior data', () => {
  // No comparable prior value → null, never a divide-by-zero percentage.
  assert.equal(metricsCore.pctChange(5, 0),    null, 'prev=0 → null (no %Δ)')
  assert.equal(metricsCore.pctChange(5, null), null, 'prev=null → null')
  assert.equal(metricsCore.pctChange(0, 0),    null)

  // An empty past week yields ZERO anomalies — the cold-start "no false alarm"
  // guarantee at the unit level: every check is skipped when past[key] is absent.
  const checks = [{ key: 'total_spend', label: 'Spend' }, { key: 'total_leads', label: 'Leads' }]
  assert.deepEqual(metricsCore.detectAnomalies({}, {}, checks, 30), [], 'empty past → []')
  assert.deepEqual(
    metricsCore.detectAnomalies({ total_spend: 100, total_leads: 5 }, {}, checks, 30), [],
    'a populated current week with NO prior week raises nothing'
  )
})
