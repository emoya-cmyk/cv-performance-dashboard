'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { createRateLimiter, defaultKey, defaultSkip } = require('../middleware/rateLimit')

// Minimal Express-ish req/res doubles.
function mockReq(over = {}) {
  return { ip: '1.2.3.4', body: {}, socket: { remoteAddress: '9.9.9.9' }, ...over }
}
function mockRes() {
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v) },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
  return res
}
// A controllable clock so window math is deterministic (no sleeps).
function mkClock(start = 1_000_000) {
  let t = start
  const clock = () => t
  clock.advance = (ms) => { t += ms }
  return clock
}

test('allows up to max, then 429s with Retry-After + JSON error', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, skip: () => false })
  let nexted = 0
  const run = () => { const res = mockRes(); limiter(mockReq(), res, () => nexted++); return res }

  run(); run(); run()            // 3 allowed
  assert.equal(nexted, 3)

  const blocked = run()          // 4th → blocked
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

  run(); run()                   // fill the window
  assert.equal(run().statusCode, 429, 'blocked within the window')
  assert.equal(nexted, 2)

  clock.advance(1001)            // window elapses
  const after = run()
  assert.equal(after.statusCode, null, 'allowed again in the new window')
  assert.equal(nexted, 3)
})

test('default skip bypasses under the test runner unless FORCE_RATE_LIMIT=1', () => {
  const prevEnv = process.env.NODE_ENV
  const prevForce = process.env.FORCE_RATE_LIMIT
  try {
    // NODE_ENV=test + no FORCE → skipped: never blocks no matter how many calls.
    process.env.NODE_ENV = 'test'
    delete process.env.FORCE_RATE_LIMIT
    assert.equal(defaultSkip(mockReq()), true)
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 }) // uses default skip
    let nexted = 0
    for (let i = 0; i < 5; i++) { const res = mockRes(); limiter(mockReq(), res, () => nexted++); assert.equal(res.statusCode, null) }
    assert.equal(nexted, 5, 'all calls pass through while skipped')

    // FORCE_RATE_LIMIT=1 → not skipped, limiter engages.
    process.env.FORCE_RATE_LIMIT = '1'
    assert.equal(defaultSkip(mockReq()), false)

    // Non-test env → not skipped regardless of FORCE.
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

test('resetStore clears all buckets', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, skip: () => false })
  const r1 = mockRes(); limiter(mockReq(), r1, () => {})
  const r2 = mockRes(); limiter(mockReq(), r2, () => {})
  assert.equal(r2.statusCode, 429)
  limiter.resetStore()
  const r3 = mockRes(); let nexted = 0; limiter(mockReq(), r3, () => nexted++)
  assert.equal(nexted, 1, 'after reset the same key is allowed again')
  assert.equal(r3.statusCode, null)
})

test('rejects invalid config (fail fast at construction)', () => {
  assert.throws(() => createRateLimiter({ max: 5 }), /windowMs/)
  assert.throws(() => createRateLimiter({ windowMs: 1000 }), /max/)
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 5 }), /windowMs/)
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }), /max/)
})
