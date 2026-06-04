// Auth-provisioning hardening — REST + boot integration test (gate 6, step b).
//
// Proves the three wirings added on top of lib/authSecurity behave correctly when
// driven through the REAL auth router over HTTP and the REAL server bootstrap:
//
//   (A) Password floor — POST /api/auth/setup and POST /api/auth/users reject a
//       weak password (< 10 chars) with 400 BEFORE hashing, and accept a strong
//       one. The most privileged account (first agency admin) can't be created
//       with a 1-char password.
//   (B) Login timing equalizer — POST /api/auth/login for a non-existent email
//       returns 401 (not 500): the no-user branch now runs a bcrypt compare
//       against DUMMY_HASH to equalize latency, and that branch must not throw.
//       The happy path (correct credential) still returns 200 + JWT.
//   (C) Fail-closed boot guard — `node server.js` with NODE_ENV=production and NO
//       JWT_SECRET refuses to boot (exit 1 + "[boot] FATAL ... JWT_SECRET"); with
//       a real secret it boots normally. We never generate the secret — we only
//       refuse to run insecurely without one.
//
// ── Test seam ───────────────────────────────────────────────────────────────
// Env is pinned BEFORE any app module is required (auth.js captures JWT_SECRET at
// load; db.js selects SQLite when DATABASE_URL is unset). `node --test` runs each
// file in its own process, so these mutations don't leak to the rest of the suite.
// The boot-guard subprocess (C) is spawned with cwd = a FRESH EMPTY temp dir so
// dotenv can't load api/.env and silently re-supply JWT_SECRET, and with the
// secret explicitly stripped from the child env.

'use strict'

const os    = require('os')
const path  = require('path')
const fs    = require('fs')
const http  = require('http')
const { spawn } = require('child_process')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// (1) Pin env BEFORE any app require ------------------------------------------
process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'auth-prov-int-secret'
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `auth_prov_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// (2) Now require the real app pieces (share the SQLite singleton) ------------
const express    = require('express')
const db         = require('../db')
const authRouter = require('../routes/auth')

const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)

const SERVER_PATH = path.join(__dirname, '..', 'server.js')
const STRONG_PASS = 'correct-horse-battery'   // 21 chars — clears the 10-char floor
const WEAK_PASS   = 'short'                    // 5 chars  — below the floor

let server = null
let PORT = 0
let readyPromise = null
let adminToken = null

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

// Minimal JSON HTTP client over the ephemeral server.
function reqJson(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body)
    const r = http.request(
      {
        hostname: '127.0.0.1', port: PORT, method, path: urlPath,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
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
    if (payload) r.write(payload)
    r.end()
  })
}

// ── (A) Password floor on first-run setup ─────────────────────────────────────
test('setup: a weak password is rejected (400) before any admin is created', async () => {
  await ready()
  const r = await reqJson('POST', '/api/auth/setup', { email: 'admin@test', password: WEAK_PASS })
  assert.equal(r.status, 400, `weak setup password must 400 (got ${r.status})`)
  assert.match(r.body.error, /at least/)
  // Nothing was created — the count guard would otherwise 403 the next strong setup.
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM users')
  assert.equal(Number(rows[0].n), 0, 'no user row may be created on a rejected setup')
})

test('setup: a strong password creates the first agency admin (200 + JWT)', async () => {
  await ready()
  const r = await reqJson('POST', '/api/auth/setup', { email: 'admin@test', password: STRONG_PASS })
  assert.equal(r.status, 200, `strong setup must succeed (got ${r.status})`)
  assert.ok(r.body && typeof r.body.token === 'string' && r.body.token.length > 0, 'returns a JWT')
  assert.equal(r.body.user.role, 'agency')
  adminToken = r.body.token
})

// ── (A) Password floor on agency-created client users ─────────────────────────
test('users: agency creating a client with a weak password is rejected (400)', async () => {
  await ready()
  const r = await reqJson(
    'POST', '/api/auth/users',
    { email: 'client@test', password: WEAK_PASS, client_id: 'client-co' },
    { authorization: `Bearer ${adminToken}` }
  )
  assert.equal(r.status, 400, `weak client password must 400 (got ${r.status})`)
  assert.match(r.body.error, /at least/)
})

test('users: a >72-byte password is rejected (400, bcrypt ceiling) end-to-end', async () => {
  await ready()
  const r = await reqJson(
    'POST', '/api/auth/users',
    { email: 'client2@test', password: 'a'.repeat(73), client_id: 'client-co' },
    { authorization: `Bearer ${adminToken}` }
  )
  assert.equal(r.status, 400, `73-byte password must 400 (got ${r.status})`)
  assert.match(r.body.error, /bytes/)
})

test('users: agency creating a client with a strong password succeeds (201)', async () => {
  await ready()
  const r = await reqJson(
    'POST', '/api/auth/users',
    { email: 'client@test', password: STRONG_PASS, client_id: 'client-co' },
    { authorization: `Bearer ${adminToken}` }
  )
  assert.equal(r.status, 201, `strong client creation must 201 (got ${r.status})`)
  assert.equal(r.body.user.role, 'client')
  assert.equal(r.body.user.client_id, 'client-co')
})

// ── (B) Login timing equalizer — no-user branch returns 401, never 500 ────────
test('login: a non-existent email returns 401 (DUMMY_HASH compare branch, no throw)', async () => {
  await ready()
  const r = await reqJson('POST', '/api/auth/login', { email: 'nobody@test', password: STRONG_PASS })
  assert.equal(r.status, 401, `unknown email must 401, not 500 (got ${r.status})`)
  assert.match(r.body.error, /Invalid credentials/)
})

test('login: the seeded admin with the correct password still logs in (200 + JWT)', async () => {
  await ready()
  const r = await reqJson('POST', '/api/auth/login', { email: 'admin@test', password: STRONG_PASS })
  assert.equal(r.status, 200, `valid login should succeed (got ${r.status})`)
  assert.ok(r.body && typeof r.body.token === 'string' && r.body.token.length > 0, 'returns a JWT')
  assert.equal(r.body.user.email, 'admin@test')
})

// ── (C) Fail-closed boot guard against the REAL server.js ─────────────────────
// Spawn `node server.js` with a controlled env + a fresh empty cwd so dotenv
// cannot load api/.env and re-supply the secret behind our back.
function spawnServer(extraEnv, { expectListen = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'authboot-'))
  const env = { ...process.env, ...extraEnv }
  // Every boot child uses its OWN sqlite file and never a Postgres URL.
  delete env.DATABASE_URL
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_PATH], { cwd, env })
    let stdout = '', stderr = '', settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      try { fs.rmSync(cwd, { recursive: true, force: true }) } catch {}
      resolve(result)
    }
    child.stdout.on('data', (c) => {
      stdout += c
      if (expectListen && /http:\/\/localhost/.test(stdout)) done({ booted: true, stdout, stderr })
    })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('exit', (code) => done({ code, stdout, stderr }))
    // Safety net so a hung child can never wedge the suite.
    setTimeout(() => done({ timedOut: true, stdout, stderr }), 12000)
  })
}

test('boot guard: production + NO JWT_SECRET refuses to start (exit 1 + FATAL)', async () => {
  const bootDb = path.join(os.tmpdir(), `auth_boot_fail_${process.pid}.db`)
  const r = await spawnServer({ NODE_ENV: 'production', JWT_SECRET: '', PORT: '0', SQLITE_PATH: bootDb })
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(bootDb + ext) } catch {} }
  assert.equal(r.code, 1, `must exit 1 in production without a secret (got code=${r.code}, timedOut=${!!r.timedOut})`)
  assert.match(r.stderr, /\[boot] FATAL/, 'logs the FATAL boot refusal')
  assert.match(r.stderr, /JWT_SECRET/, 'names the missing secret')
})

test('boot guard: production + a real JWT_SECRET boots normally', async () => {
  const bootDb = path.join(os.tmpdir(), `auth_boot_ok_${process.pid}.db`)
  const r = await spawnServer(
    { NODE_ENV: 'production', JWT_SECRET: 'a-genuinely-random-long-secret-value', PORT: '0', SQLITE_PATH: bootDb },
    { expectListen: true }
  )
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(bootDb + ext) } catch {} }
  assert.equal(r.booted, true, `must boot to listen with a real secret (code=${r.code}, timedOut=${!!r.timedOut}, stderr=${r.stderr.slice(0, 200)})`)
})
