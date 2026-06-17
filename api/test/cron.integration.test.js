// External-cron heartbeat — REST integration test.
//
// Proves the P1 cron driver behaves correctly when mounted in front of the REAL
// router and driven over HTTP exactly as server.js wires it
// (`app.use('/api/cron', cronRouter)` — OUTSIDE requireAuth, so cronAuth is the
// ONLY gate):
//   • GET  /api/cron/health      — public; reports armed=true (secret set) + the
//                                   job catalog, no secret required, no leak.
//   • POST /api/cron/heartbeat   — cronAuth-gated:
//       (1) 401 with no Authorization header and 401 on a wrong secret — the gate
//           is closed to anyone without the exact bearer credential;
//       (2) 200 with the correct secret + jobs:['sync'] against an empty migrated
//           DB — the heartbeat RUNS the REAL sync sweep (0 active connections →
//           scanned 0, no network), proving the route drives runHeartbeat with the
//           same collaborators the in-process scheduler uses;
//       (3) 200 with the correct secret + default body — all three idempotent jobs
//           (sync→watchdog→insights) run against real lib code, in canonical order;
//       (4) 400 UNKNOWN_JOB on a typo'd cron config (jobs:['sync','digest']) — the
//           weekly client-email DIGEST is deliberately NOT reachable here, and an
//           unknown name fails loud (nothing ran) instead of silently mis-firing;
//       (5) 400 BAD_JOBS when `jobs` isn't an array;
//       (6) 503 (fail CLOSED) when CRON_SECRET is unset — a missing secret disables
//           the endpoint, it never reads as "open".
//
// ── Test seam ───────────────────────────────────────────────────────────────
// cronAuth reads CRON_SECRET at REQUEST time, so the unset cases (6 / health-unset)
// just delete the env var around a single awaited request and restore it in a
// finally — requests run sequentially, so there's no cross-talk. `node --test`
// runs each file in its own process, so these env mutations are contained here —
// zero blast radius on the rest of the suite. JWT_SECRET + SQLITE_PATH are pinned
// before any app module loads (db.js selects SQLite when DATABASE_URL is unset);
// the cron router carries no user auth, but db.migrate() needs the SQLite seam.

'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require ------------------------------------------
process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'cron-int-secret'
const CRON_SECRET = 'cron-heartbeat-int-secret-value'
process.env.CRON_SECRET = CRON_SECRET
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `cron_int_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// (2) Now require the real app pieces (share the SQLite singleton) ------------
const express = require('express')
const db      = require('../db')
const { router: cronRouter } = require('../routes/cron')
const { securityHeaders }    = require('../middleware/securityHeaders')
const { VALID_JOBS }         = require('../lib/heartbeat')

// (3) Build an app mirroring server.js's cron surface: trust proxy, security
//     headers, the raw-body capture (so the handler can read req.body.jobs),
//     then the cron router mounted OUTSIDE requireAuth — exactly server.js's
//     wiring. cronAuth is the only gate.
const app = express()
app.set('trust proxy', 1)
app.use(securityHeaders())
app.use((req, res, next) => {
  const buf = []
  req.on('data', (c) => buf.push(c))
  req.on('end', () => {
    req.rawBody = Buffer.concat(buf)
    try { req.body = JSON.parse(req.rawBody.toString()) } catch { req.body = {} }
    next()
  })
})
app.use('/api/cron', cronRouter)

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

// Minimal HTTP JSON client over the ephemeral server. `bearer` is optional — when
// omitted, no Authorization header is sent (the no-header 401 case).
function call(method, reqPath, { bearer, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers = {}
    if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const r = http.request(
      { hostname: '127.0.0.1', port: PORT, method, path: reqPath, headers },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json = null
          try { json = data ? JSON.parse(data) : null } catch {}
          resolve({ status: res.statusCode, body: json, headers: res.headers })
        })
      }
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}
const health    = ()         => call('GET',  '/api/cron/health')
const heartbeat = (opts)     => call('POST', '/api/cron/heartbeat', opts)

// Run one request with CRON_SECRET temporarily unset, then restore it. Requests
// are awaited sequentially, so toggling the request-time env around a single
// awaited call can't race another request.
async function withSecretUnset(fn) {
  delete process.env.CRON_SECRET
  try { return await fn() }
  finally { process.env.CRON_SECRET = CRON_SECRET }
}

// ── GET /health — public, reports armed + job catalog, leaks nothing ─────────
test('GET /api/cron/health is public and reports armed=true + the job catalog', async () => {
  await ready()
  const r = await health()
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.armed, true, 'armed reflects CRON_SECRET being set')
  assert.deepEqual(r.body.jobs, VALID_JOBS, 'health advertises the heartbeat job catalog')
  assert.equal(r.body.secret, undefined, 'health never echoes the secret')
})

test('GET /api/cron/health reports armed=false when CRON_SECRET is unset', async () => {
  await ready()
  const r = await withSecretUnset(health)
  assert.equal(r.status, 200, 'health stays public even when the route is disarmed')
  assert.equal(r.body.armed, false, 'armed=false signals the heartbeat is disabled')
})

// ── POST /heartbeat — cronAuth gate ──────────────────────────────────────────
test('POST /api/cron/heartbeat 401s with no Authorization header', async () => {
  await ready()
  const r = await heartbeat({ body: { jobs: ['sync'] } })  // no bearer
  assert.equal(r.status, 401)
  assert.match(r.body.error, /invalid cron credential/)
})

test('POST /api/cron/heartbeat 401s on a wrong bearer secret', async () => {
  await ready()
  const r = await heartbeat({ bearer: 'not-the-secret', body: { jobs: ['sync'] } })
  assert.equal(r.status, 401)
})

test('POST /api/cron/heartbeat 503s (fails CLOSED) when CRON_SECRET is unset', async () => {
  await ready()
  // Even presenting the would-be-correct secret: an unset env disables the route.
  const r = await withSecretUnset(() => heartbeat({ bearer: CRON_SECRET, body: { jobs: ['sync'] } }))
  assert.equal(r.status, 503, 'a disabled cron endpoint must never run work')
  assert.match(r.body.error, /disabled/)
})

// ── POST /heartbeat — runs the REAL jobs ─────────────────────────────────────
test('POST /api/cron/heartbeat runs the REAL sync sweep on an empty DB → 200, scanned 0, no network', async () => {
  await ready()
  const r = await heartbeat({ bearer: CRON_SECRET, body: { jobs: ['sync'] } })
  assert.equal(r.status, 200, `a correct secret + valid job runs the heartbeat (got ${r.status})`)
  assert.equal(r.body.ok, true, 'sync against an empty DB succeeds')
  assert.deepEqual(r.body.jobs, ['sync'], 'only the requested job ran')
  assert.equal(r.body.results.sync.ok, true)
  assert.equal(r.body.results.sync.scanned, 0, 'no active connections → nothing to sync')
  assert.equal(r.body.results.sync.synced, 0)
  assert.equal(r.body.results.watchdog, undefined, 'watchdog was not requested')
  assert.equal(r.body.results.insights, undefined, 'insights was not requested')
})

test('POST /api/cron/heartbeat default body runs all REAL jobs in canonical order → 200', async () => {
  await ready()
  // No `jobs` → the full idempotent set, driven through the real lib collaborators
  // (sync/watchdog/insights/alerts) against an empty migrated DB. This is the wiring
  // proof: a mis-imported collaborator would surface as that job's ok=false.
  const r = await heartbeat({ bearer: CRON_SECRET })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.jobs, VALID_JOBS, 'all jobs ran, in canonical order')
  for (const job of VALID_JOBS) {
    const res = r.body.results[job]
    assert.ok(res, `${job} produced a result`)
    assert.equal(res.ok, true, `${job} succeeded on an empty DB (error: ${res && res.error})`)
    assert.equal(typeof res.ms, 'number', `${job} carries an ms timing`)
  }
  assert.equal(r.body.ok, true, 'all idempotent jobs succeeded')
})

// ── POST /heartbeat — malformed request contract ─────────────────────────────
test('POST /api/cron/heartbeat 400 UNKNOWN_JOB on a typo / non-heartbeat job (digest is excluded)', async () => {
  await ready()
  const r = await heartbeat({ bearer: CRON_SECRET, body: { jobs: ['sync', 'digest'] } })
  assert.equal(r.status, 400, 'an unknown job name is a malformed request')
  assert.equal(r.body.code, 'UNKNOWN_JOB')
  assert.match(r.body.error, /digest/, 'the offending job name is surfaced')
})

test('POST /api/cron/heartbeat 400 BAD_JOBS when jobs is not an array', async () => {
  await ready()
  const r = await heartbeat({ bearer: CRON_SECRET, body: { jobs: 'sync' } })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'BAD_JOBS')
})

// ── POST /memory — the daily memory-autonomy driver (cronAuth-gated) ──────────
const memoryCron = (opts) => call('POST', '/api/cron/memory', opts)

test('POST /api/cron/memory 401s with no Authorization header', async () => {
  await ready()
  const r = await memoryCron({})
  assert.equal(r.status, 401)
})

test('POST /api/cron/memory 503s (fails CLOSED) when CRON_SECRET is unset', async () => {
  await ready()
  const r = await withSecretUnset(() => memoryCron({ bearer: CRON_SECRET }))
  assert.equal(r.status, 503)
})

test('POST /api/cron/memory runs governance + capture on an empty DB → 200', async () => {
  await ready()
  const r = await memoryCron({ bearer: CRON_SECRET })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(['healthy', 'degraded', 'critical'].includes(r.body.governance.status))
  assert.equal(r.body.governance.ok, true)        // live-count verify-after held
  assert.equal(r.body.capture.captured, 0)        // no clients/highlights yet
})

test('GET /api/cron/memory works too (Vercel-cron compatible) and still fails closed', async () => {
  await ready()
  const ok = await call('GET', '/api/cron/memory', { bearer: CRON_SECRET })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  const noAuth = await call('GET', '/api/cron/memory')
  assert.equal(noAuth.status, 401)
})
