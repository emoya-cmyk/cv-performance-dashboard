'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { createAiBudget, aiBudgetKey } = require('../middleware/aiBudget')

// Minimal req/res doubles (same shape as rateLimit.test.js).
function mockReq(over = {}) {
  return { ip: '1.2.3.4', user: undefined, ...over }
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

// ── keyFn precedence: user.id → client_id → ip → 'unknown' ────────────────────
test('aiBudgetKey buckets by user id first', () => {
  assert.equal(
    aiBudgetKey({ user: { id: 'u-1', client_id: 'c-9' }, ip: '9.9.9.9' }),
    'ai:u-1',
    'an authenticated user is bucketed by id, not client_id or ip'
  )
})

test('aiBudgetKey falls back to client_id, then ip, then unknown', () => {
  // No id but a client_id (e.g. a client-role token) → bucket by client_id.
  assert.equal(aiBudgetKey({ user: { client_id: 'c-7' }, ip: '9.9.9.9' }), 'ai:c-7')
  // No user at all (would only happen if requireAuth were bypassed) → ip.
  assert.equal(aiBudgetKey({ ip: '5.5.5.5' }), 'ai:5.5.5.5')
  // Nothing identifying → a stable 'unknown' bucket (never throws).
  assert.equal(aiBudgetKey({}), 'ai:unknown')
})

test('two different callers never share a bucket', () => {
  assert.notEqual(
    aiBudgetKey({ user: { id: 'u-1' } }),
    aiBudgetKey({ user: { id: 'u-2' } })
  )
})

// ── the limiter engages at max and 429s the (max+1)th for that caller ─────────
test('createAiBudget allows up to max mints per caller, then 429s', () => {
  // skip:()=>false forces the limiter on regardless of NODE_ENV under the runner.
  const budget = createAiBudget({ max: 2, windowMs: 60_000, skip: () => false })
  const caller = { user: { id: 'u-budget' }, ip: '1.1.1.1' }

  let passed = 0
  const hit = () => { const res = mockRes(); budget(mockReq(caller), res, () => passed++); return res }

  hit(); hit()                       // 2 allowed (== max)
  assert.equal(passed, 2)

  const blocked = hit()              // 3rd → over budget
  assert.equal(passed, 2, 'next is NOT called once the budget is spent')
  assert.equal(blocked.statusCode, 429)
  assert.match(blocked.body.error, /AI request budget/)
  assert.ok(Number(blocked.headers['retry-after']) >= 1, 'Retry-After present and >= 1s')
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0')
})

test('createAiBudget keeps each caller on an independent budget', () => {
  const budget = createAiBudget({ max: 1, windowMs: 60_000, skip: () => false })
  const a = { user: { id: 'caller-a' } }
  const b = { user: { id: 'caller-b' } }

  const a1 = mockRes(); budget(mockReq(a), a1, () => {})            // a: allowed
  const a2 = mockRes(); budget(mockReq(a), a2, () => {})            // a: blocked
  let bPassed = 0
  const b1 = mockRes(); budget(mockReq(b), b1, () => bPassed++)     // b: allowed (own bucket)

  assert.equal(a1.statusCode, null, 'first call for A passes')
  assert.equal(a2.statusCode, 429,  'second call for A is over budget')
  assert.equal(bPassed, 1, 'B has its own budget — one hot caller never starves another')
  assert.equal(b1.statusCode, null)
})

test('createAiBudget reads AI_RATE_MAX when max is not passed', () => {
  const prev = process.env.AI_RATE_MAX
  try {
    process.env.AI_RATE_MAX = '1'
    const budget = createAiBudget({ windowMs: 60_000, skip: () => false })
    const caller = { user: { id: 'env-caller' } }
    const r1 = mockRes(); budget(mockReq(caller), r1, () => {})
    const r2 = mockRes(); budget(mockReq(caller), r2, () => {})
    assert.equal(r1.statusCode, null, 'first within the AI_RATE_MAX=1 budget')
    assert.equal(r2.statusCode, 429,  'second over the AI_RATE_MAX=1 budget')
    assert.equal(r1.headers['x-ratelimit-limit'], '1', 'limit header reflects AI_RATE_MAX')
  } finally {
    if (prev === undefined) delete process.env.AI_RATE_MAX
    else process.env.AI_RATE_MAX = prev
  }
})
