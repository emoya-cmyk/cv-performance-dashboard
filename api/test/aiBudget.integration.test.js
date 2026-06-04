// AI cost cap — REST integration test.
//
// Proves the P0.3 per-caller AI budget behaves correctly when mounted in front of
// the REAL ai router and driven over HTTP exactly as server.js wires it
// (`app.use('/api/ai', requireAuth, aiRouter)`):
//   (1) the budget caps the LLM-minting routes — the first AI_RATE_MAX POST /ask
//       calls reach the handler (and 503 here, since ANTHROPIC_API_KEY is unset),
//       and the (max+1)th is shed with 429 + Retry-After + X-RateLimit-Remaining:0
//       BEFORE the handler runs. The budget counts ATTEMPTS, not successes — a
//       stuck poller that keeps 503-ing still gets throttled, which is the point;
//   (2) the cap is SURGICAL: a pure-DB AI route (POST /ask/explain) is NEVER
//       throttled, even for a caller whose AI mint budget is fully spent — it
//       still returns its normal 400 (spec required), because explain costs a SQL
//       query, not an Anthropic token;
//   (3) each caller has an INDEPENDENT budget — one hot token (a runaway client
//       poller) never collateral-throttles another tenant's AI narration.
//
// ── Test seam ───────────────────────────────────────────────────────────────
// The budget shares the login throttle's limiter, whose DEFAULT skip bypasses it
// under `node --test`. This file OPTS IN with FORCE_RATE_LIMIT=1 and pins a low
// AI_RATE_MAX so a 3rd mint trips the cap without 60 real calls. `node --test`
// runs each file in its own process, so these env mutations are contained here —
// zero blast radius on the rest of the suite. AI_RATE_MAX must be pinned BEFORE
// routes/ai.js is required, because it builds the limiter (createAiBudget()) at
// module load. ANTHROPIC_API_KEY is DELETED so POST /ask deterministically 503s
// (NO_AI) with no network call — the test never mints a real Anthropic request.
// JWT_SECRET + SQLITE_PATH are pinned before any app module loads (auth.js
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
process.env.AI_RATE_MAX      = '2'   // low ceiling so the 3rd mint trips the cap
process.env.JWT_SECRET       = 'ai-budget-int-secret'
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY // POST /ask → 503 NO_AI, never a real call
const DB_PATH = path.join(os.tmpdir(), `ai_budget_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// (2) Now require the real app pieces (share the SQLite singleton) ------------
const express = require('express')
const jwt     = require('jsonwebtoken')
const db      = require('../db')
const aiRouter            = require('../routes/ai')
const { requireAuth }     = require('../middleware/auth')
const { securityHeaders } = require('../middleware/securityHeaders')

const AI_MAX = Number(process.env.AI_RATE_MAX) // 2

// (3) Build an app mirroring server.js's AI surface: trust proxy, security
//     headers, the raw-body capture (so handlers can read req.body), then
//     requireAuth in front of the real ai router — exactly server.js's wiring.
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
app.use('/api/ai', requireAuth, aiRouter)

// (4) Agency tokens are self-contained — requireAuth verifies the JWT and sets
//     req.user = payload (no DB lookup), and resolveAskScope returns the whole
//     book for an agency token with no clientId (no DB hit). So a signed token is
//     all we need; the budget buckets by req.user.id.
function agencyToken(id) {
  return jwt.sign({ id, role: 'agency' }, process.env.JWT_SECRET, { expiresIn: '1h' })
}

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

// Minimal HTTP JSON client over the ephemeral server.
function call(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers = { authorization: `Bearer ${token}` }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const r = http.request(
      { hostname: '127.0.0.1', port: PORT, method, path, headers },
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
const ask        = (token, q) => call('POST', '/api/ai/ask', token, { question: q })
const askExplain = (token, b) => call('POST', '/api/ai/ask/explain', token, b)

// ── (1)+(2) the budget caps /ask at AI_RATE_MAX, then 429s; /ask/explain is uncapped
test('AI budget: caps the LLM-minting /ask at AI_RATE_MAX, then 429s; pure-DB /ask/explain stays open', async () => {
  await ready()
  const token = agencyToken('agency-cap-1')   // unique caller → fresh bucket

  // The first AI_MAX mints pass the budget and reach the handler. With no
  // ANTHROPIC_API_KEY the handler throws NO_AI → 503 (the call was ATTEMPTED,
  // so it still consumes one unit of the caller's mint budget).
  for (let i = 1; i <= AI_MAX; i++) {
    const r = await ask(token, 'how are leads trending?')
    assert.equal(r.status, 503, `mint ${i} should reach the handler and 503 NO_AI (got ${r.status})`)
    assert.equal(r.headers['x-ratelimit-limit'], String(AI_MAX), `mint ${i} carries the budget limit header`)
    assert.equal(r.headers['x-ratelimit-remaining'], String(AI_MAX - i), `mint ${i} remaining header`)
  }

  // The next mint is over budget → 429 BEFORE the handler runs.
  const blocked = await ask(token, 'how are leads trending?')
  assert.equal(blocked.status, 429, `mint ${AI_MAX + 1} must be throttled (got ${blocked.status})`)
  assert.match(blocked.body.error, /AI request budget/, 'over-budget error message')
  assert.ok(Number(blocked.headers['retry-after']) >= 1, 'Retry-After present and >= 1s')
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0', 'remaining is 0 once spent')

  // SAME caller, budget fully spent — a pure-DB AI route is NEVER throttled. It
  // costs a SQL query, not a token, so it still returns its normal 400 (missing
  // spec), proving the cap is surgical to the LLM-minting routes only.
  const explain = await askExplain(token, {})  // no spec → 400, not 429
  assert.equal(explain.status, 400, `pure-DB /ask/explain must stay open after the AI budget is spent (got ${explain.status})`)
  assert.equal(explain.body.error, 'spec is required')
  assert.equal(explain.headers['x-ratelimit-limit'], undefined, 'uncapped route carries no rate-limit headers')
})

// ── (3) bucket isolation — a hot caller never throttles another tenant ────────
test('AI budget: each caller has an independent budget — one hot token never starves another', async () => {
  await ready()
  const hot  = agencyToken('agency-hot')
  const cold = agencyToken('agency-cold')

  // Exhaust the hot caller's budget (AI_MAX passes + 1 blocked).
  for (let i = 0; i < AI_MAX; i++) await ask(hot, 'spend the budget')
  const hotBlocked = await ask(hot, 'one too many')
  assert.equal(hotBlocked.status, 429, 'the hammered caller is throttled')

  // A different token still reaches the handler (its own bucket) → 503, not 429.
  const coldFirst = await ask(cold, 'my first ask')
  assert.equal(coldFirst.status, 503, `a different caller must not be collateral-throttled (got ${coldFirst.status})`)
  assert.equal(coldFirst.headers['x-ratelimit-remaining'], String(AI_MAX - 1), 'cold caller starts fresh at its own limit')
})
