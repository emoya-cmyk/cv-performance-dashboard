'use strict'

// Ported from agency's api/test/rateLimit.test.js (+ aiBudget + loginThrottle
// derived limiters), exercising the package's createRateLimiter / createAiBudget /
// createLoginThrottle.

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const {
  createRateLimiter, defaultKey, defaultSkip,
  createAiBudget, aiBudgetKey,
  createLoginThrottle, loginThrottleKey,
} = require('..')

function mockReq(over = {}) {
  return { ip: '1.2.3.4', body: {}, socket: { remoteAddress: '9.9.9.9' }, ...over }
}
function mockRes() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v) },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}
function mkClock(start = 1_000_000) {
  let t = start
  const clock = () => t
  clock.advance = (ms) => { t += ms }
  return clock
}

// ── createRateLimiter ─────────────────────────────────────────────────────────
test('allows up to max, then 429s with Retry-After + JSON error', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, skip: () => false })
  let nexted = 0
  const run = () => { const res = mockRes(); limiter(mockReq(), res, () => nexted++); return res }

  run(); run(); run()
  assert.equal(nexted, 3)

  const blocked = run()
  assert.equal(nexted, 3, 'next must NOT be called on the blocked request')
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.body.error, 'Too many requests, please try again later.')
  assert.ok(Number(blocked.headers['retry-after']) >= 1, 'Retry-After present and >= 1s')
  assert.equal(blocked.headers['x-ratelimit-limit'], '3')
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0')
})

test('tracks keys independently (one hot key does not starve another)', () => {
  const limiter = createRateLimiter({
    windowMs: 1000, max: 1, skip: () => false,
    keyFn: (req) => req.body.email,
  })
  const a1 = mockRes(); limiter(mockReq({ body: { email: 'a@x.com' } }), a1, () => {})
  const a2 = mockRes(); limiter(mockReq({ body: { email: 'a@x.com' } }), a2, () => {})
  const b1 = mockRes(); let bNext = 0; limiter(mockReq({ body: { email: 'b@x.com' } }), b1, () => bNext++)

  assert.equal(a1.statusCode, null, 'first a allowed')
  assert.equal(a2.statusCode, 429, 'second a blocked')
  assert.equal(bNext, 1, 'b is a separate bucket — allowed')
  assert.equal(b1.statusCode, null)
})

test('window resets after windowMs elapses (deterministic clock)', () => {
  const clock = mkClock()
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, skip: () => false, clock })
  let nexted = 0
  const run = () => { const res = mockRes(); limiter(mockReq(), res, () => nexted++); return res }

  run(); run()
  assert.equal(run().statusCode, 429, 'blocked within the window')
  assert.equal(nexted, 2)

  clock.advance(1001)
  const after = run()
  assert.equal(after.statusCode, null, 'allowed again in the new window')
  assert.equal(nexted, 3)
})

test('default skip bypasses under the test runner unless FORCE_RATE_LIMIT=1', () => {
  const prevEnv = process.env.NODE_ENV
  const prevForce = process.env.FORCE_RATE_LIMIT
  try {
    process.env.NODE_ENV = 'test'
    delete process.env.FORCE_RATE_LIMIT
    assert.equal(defaultSkip(mockReq()), true)
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
    let nexted = 0
    for (let i = 0; i < 5; i++) { const res = mockRes(); limiter(mockReq(), res, () => nexted++); assert.equal(res.statusCode, null) }
    assert.equal(nexted, 5, 'all calls pass through while skipped')

    process.env.FORCE_RATE_LIMIT = '1'
    assert.equal(defaultSkip(mockReq()), false)

    process.env.NODE_ENV = 'production'
    delete process.env.FORCE_RATE_LIMIT
    assert.equal(defaultSkip(mockReq()), false)
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv
    if (prevForce === undefined) delete process.env.FORCE_RATE_LIMIT; else process.env.FORCE_RATE_LIMIT = prevForce
  }
})

test('defaultKey prefers req.ip, falls back to socket then "unknown"', () => {
  assert.equal(defaultKey({ ip: '5.5.5.5', socket: { remoteAddress: '6.6.6.6' } }), '5.5.5.5')
  assert.equal(defaultKey({ socket: { remoteAddress: '6.6.6.6' } }), '6.6.6.6')
  assert.equal(defaultKey({}), 'unknown')
})

test('rejects invalid config (fail fast at construction)', () => {
  assert.throws(() => createRateLimiter({ max: 5 }), /windowMs/)
  assert.throws(() => createRateLimiter({ windowMs: 1000 }), /max/)
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 5 }), /windowMs/)
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }), /max/)
})

// ── createAiBudget ────────────────────────────────────────────────────────────
test('aiBudgetKey buckets by user id first, then client_id, then ip, then unknown', () => {
  assert.equal(aiBudgetKey({ user: { id: 'u-1', client_id: 'c-9' }, ip: '9.9.9.9' }), 'ai:u-1')
  assert.equal(aiBudgetKey({ user: { client_id: 'c-7' }, ip: '9.9.9.9' }), 'ai:c-7')
  assert.equal(aiBudgetKey({ ip: '5.5.5.5' }), 'ai:5.5.5.5')
  assert.equal(aiBudgetKey({}), 'ai:unknown')
})

test('createAiBudget allows up to max mints per caller, then 429s; independent buckets', () => {
  const budget = createAiBudget({ max: 2, windowMs: 60_000, skip: () => false })
  const caller = { user: { id: 'u-budget' }, ip: '1.1.1.1' }
  let passed = 0
  const hit = () => { const res = mockRes(); budget({ ...caller }, res, () => passed++); return res }
  hit(); hit()
  assert.equal(passed, 2)
  const blocked = hit()
  assert.equal(passed, 2)
  assert.equal(blocked.statusCode, 429)
  assert.match(blocked.body.error, /AI request budget/)
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0')

  const budget2 = createAiBudget({ max: 1, windowMs: 60_000, skip: () => false })
  const a1 = mockRes(); budget2({ user: { id: 'a' } }, a1, () => {})
  const a2 = mockRes(); budget2({ user: { id: 'a' } }, a2, () => {})
  let bP = 0; const b1 = mockRes(); budget2({ user: { id: 'b' } }, b1, () => bP++)
  assert.equal(a2.statusCode, 429)
  assert.equal(bP, 1, 'B has its own budget')
})

test('createAiBudget reads AI_RATE_MAX when max is not passed', () => {
  const prev = process.env.AI_RATE_MAX
  try {
    process.env.AI_RATE_MAX = '1'
    const budget = createAiBudget({ windowMs: 60_000, skip: () => false })
    const caller = { user: { id: 'env-caller' } }
    const r1 = mockRes(); budget({ ...caller }, r1, () => {})
    const r2 = mockRes(); budget({ ...caller }, r2, () => {})
    assert.equal(r1.statusCode, null)
    assert.equal(r2.statusCode, 429)
    assert.equal(r1.headers['x-ratelimit-limit'], '1')
  } finally {
    if (prev === undefined) delete process.env.AI_RATE_MAX
    else process.env.AI_RATE_MAX = prev
  }
})

// ── createLoginThrottle ───────────────────────────────────────────────────────
test('loginThrottleKey buckets by (ip + lowercased email)', () => {
  assert.equal(loginThrottleKey({ ip: '1.2.3.4', body: { email: 'A@x.com' } }), '1.2.3.4:a@x.com')
  assert.equal(loginThrottleKey({ ip: '1.2.3.4', body: {} }), '1.2.3.4:')
})

test('createLoginThrottle: same (ip+email) trips at max+1; another email is independent', () => {
  const throttle = createLoginThrottle({ max: 3, windowMs: 60_000, skip: () => false })
  const A = { ip: '7.7.7.7', body: { email: 'a@x.com' } }
  const B = { ip: '7.7.7.7', body: { email: 'b@x.com' } }
  let aPass = 0
  const hitA = () => { const res = mockRes(); throttle({ ...A }, res, () => aPass++); return res }
  hitA(); hitA(); hitA()
  assert.equal(aPass, 3)
  const blockedA = hitA()
  assert.equal(blockedA.statusCode, 429)
  assert.match(blockedA.body.error, /login attempts/i)

  let bPass = 0; const b1 = mockRes(); throttle({ ...B }, b1, () => bPass++)
  assert.equal(bPass, 1, 'a different account is an independent bucket')
})

test('createLoginThrottle reads LOGIN_RATE_MAX when max is not passed', () => {
  const prev = process.env.LOGIN_RATE_MAX
  try {
    process.env.LOGIN_RATE_MAX = '1'
    const throttle = createLoginThrottle({ windowMs: 60_000, skip: () => false })
    const A = { ip: '8.8.8.8', body: { email: 'c@x.com' } }
    const r1 = mockRes(); throttle({ ...A }, r1, () => {})
    const r2 = mockRes(); throttle({ ...A }, r2, () => {})
    assert.equal(r1.statusCode, null)
    assert.equal(r2.statusCode, 429)
    assert.equal(r1.headers['x-ratelimit-limit'], '1')
  } finally {
    if (prev === undefined) delete process.env.LOGIN_RATE_MAX
    else process.env.LOGIN_RATE_MAX = prev
  }
})
