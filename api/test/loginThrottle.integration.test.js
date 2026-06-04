// Login brute-force throttle — REST integration test.
//
// Proves the P0.2 login limiter behaves correctly when mounted in front of the
// REAL auth router and driven over HTTP exactly as server.js wires it:
//   (1) under-limit attempts pass through to auth (bad creds → 401) and carry
//       X-RateLimit-* headers;
//   (2) the (max+1)th attempt on the same (IP+email) bucket is throttled (429)
//       BEFORE auth runs, with Retry-After + X-RateLimit-Remaining:0;
//   (3) a different account is an independent bucket — one hammered login never
//       collateral-locks another tenant;
//   (4) a correct credential under the limit still logs in (200 + JWT) — the
//       limiter never breaks the happy path.
//
// ── Test seam ───────────────────────────────────────────────────────────────
// The limiter's DEFAULT skip bypasses it under `node --test`, so the existing
// suite is never throttled. This file OPTS IN with FORCE_RATE_LIMIT=1 and pins a
// low LOGIN_RATE_MAX so a 4th request trips the throttle without 20 real calls.
// `node --test` runs each test file in its own process, so these env mutations
// are contained to this file — zero blast radius on the rest of the suite.
// JWT_SECRET + SQLITE_PATH are pinned BEFORE any app module is required (auth.js
// captures JWT_SECRET at load; db.js selects SQLite when DATABASE_URL is unset).

'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require ------------------------------------------
process.env.NODE_ENV         = 'test'
process.env.FORCE_RATE_LIMIT = '1'   // opt the limiter IN under the runner
process.env.LOGIN_RATE_MAX   = '3'   // low ceiling so attempt #4 trips it
process.env.JWT_SECRET       = 'login-throttle-int-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `login_throttle_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// (2) Now require the real app pieces (share the SQLite singleton) ------------
const express = require('express')
const bcrypt  = require('bcryptjs')
const db      = require('../db')
const authRouter            = require('../routes/auth')
const { securityHeaders }   = require('../middleware/securityHeaders')
const { createRateLimiter } = require('../middleware/rateLimit')

const LOGIN_MAX = Number(process.env.LOGIN_RATE_MAX) // 3

// (3) Build an app mirroring server.js's login surface: trust proxy, security
//     headers, the raw-body capture (so the limiter keyFn can read
//     req.body.email), the login limiter (keyed by IP+email), then auth router.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: LOGIN_MAX,
  keyFn: (req) => `${req.ip}:${(req.body && req.body.email ? String(req.body.email) : '').toLowerCase()}`,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
})

const app = express()
app.set('trust proxy', 1)
app.use(securityHeaders())
// server.js's raw-body capture: sets req.body from JSON before the limiter runs.
app.use((req, res, next) => {
  const buf = []
  req.on('data', (c) => buf.push(c))
  req.on('end', () => {
    req.rawBody = Buffer.concat(buf)
    try { req.body = JSON.parse(req.rawBody.toString()) } catch { req.body = {} }
    next()
  })
})
app.use('/api/auth/login', loginLimiter)
app.use('/api/auth', authRouter)

// (4) One seeded user with a known password (bcrypt cost 10, as auth.js uses) --
const GOOD_EMAIL = 'throttle-good@test'
const GOOD_PASS  = 'correct-horse-battery'

let server = null
let PORT = 0
let readyPromise = null
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate()
      const hash = await bcrypt.hash(GOOD_PASS, 10)
      await db.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'agency')`,
        [GOOD_EMAIL, hash]
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

// Minimal HTTP login client over the ephemeral server.
function login(email, password) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ email, password })
    const r = http.request(
      {
        hostname: '127.0.0.1', port: PORT, method: 'POST', path: '/api/auth/login',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
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
    r.write(payload)
    r.end()
  })
}

// ── (1)+(2) under-limit reaches auth (401); (max+1)th is throttled (429) ──────
test('login throttle: under-limit attempts 401, the (max+1)th is 429 with Retry-After', async () => {
  await ready()
  loginLimiter.resetStore()
  const email = 'bruteforce-target@test'   // unseeded → auth returns 401

  // The first LOGIN_MAX attempts pass the limiter and reach auth → 401.
  for (let i = 1; i <= LOGIN_MAX; i++) {
    const r = await login(email, 'wrong-password')
    assert.equal(r.status, 401, `attempt ${i} must reach auth and 401 (got ${r.status})`)
    assert.equal(r.headers['x-ratelimit-limit'], String(LOGIN_MAX))
    assert.equal(r.headers['x-ratelimit-remaining'], String(LOGIN_MAX - i),
      `attempt ${i} remaining header`)
  }

  // The next attempt is over the limit → 429 BEFORE auth runs.
  const blocked = await login(email, 'wrong-password')
  assert.equal(blocked.status, 429, `attempt ${LOGIN_MAX + 1} must be throttled (got ${blocked.status})`)
  assert.equal(blocked.body.error, 'Too many login attempts. Please wait a few minutes and try again.')
  assert.ok(Number(blocked.headers['retry-after']) >= 1, 'Retry-After present and >= 1s')
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0')
})

// ── (3) bucket isolation — a hot account never locks out another ──────────────
test('login throttle: a different IP+email is an independent bucket', async () => {
  await ready()
  loginLimiter.resetStore()
  const hot = 'hot-account@test'

  // Exhaust the hot account's bucket (max passes + 1 blocked).
  for (let i = 0; i < LOGIN_MAX; i++) await login(hot, 'x')
  const hotBlocked = await login(hot, 'x')
  assert.equal(hotBlocked.status, 429, 'the hammered account is throttled')

  // A different email still reaches auth (separate bucket) → 401, not 429.
  const other = await login('cold-account@test', 'x')
  assert.equal(other.status, 401, `a different account must not be collateral-throttled (got ${other.status})`)
})

// ── (4) happy path intact — a correct credential under the limit logs in ──────
test('login throttle: a correct credential under the limit still logs in (200 + JWT)', async () => {
  await ready()
  loginLimiter.resetStore()
  const r = await login(GOOD_EMAIL, GOOD_PASS)
  assert.equal(r.status, 200, `valid login under the limit should succeed (got ${r.status})`)
  assert.ok(r.body && typeof r.body.token === 'string' && r.body.token.length > 0, 'returns a JWT')
  assert.equal(r.body.user.email, GOOD_EMAIL)
})
