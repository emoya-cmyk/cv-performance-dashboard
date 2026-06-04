'use strict'

// Unit tests for the cron bearer guard (routes/cron.js → cronAuth). Pure, no DB,
// no HTTP — mock req/res, toggle CRON_SECRET per case. cronAuth reads the secret
// at REQUEST time, so each case sets/restores it in a finally; node --test runs
// this file in its own process, so even a leaked mutation can't reach the rest of
// the suite (zero blast radius). The end-to-end behavior through the real router
// (200/400/health) is covered separately in cron.integration.test.js.

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { cronAuth } = require('../routes/cron')

// req.get is Express's case-insensitive header getter — model it.
function mockReq(headers = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  return { get(name) { return lower[String(name).toLowerCase()] } }
}
function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

// Run cronAuth under a pinned secret + headers; restore env afterwards.
function run({ secret, headers }) {
  const prev = process.env.CRON_SECRET
  try {
    if (secret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = secret
    const req = mockReq(headers)
    const res = mockRes()
    let nextCalled = false
    cronAuth(req, res, () => { nextCalled = true })
    return { res, nextCalled }
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prev
  }
}

test('cronAuth fails CLOSED — 503 when CRON_SECRET is unset, never opens', () => {
  const { res, nextCalled } = run({ secret: undefined, headers: { authorization: 'Bearer anything' } })
  assert.equal(res.statusCode, 503)
  assert.match(res.body.error, /disabled/)
  assert.equal(nextCalled, false, 'an unset secret must never let a request through')
})

test('cronAuth 401s when no Authorization header is present', () => {
  const { res, nextCalled } = run({ secret: 's3cr3t-value', headers: {} })
  assert.equal(res.statusCode, 401)
  assert.equal(nextCalled, false)
})

test('cronAuth 401s on a non-Bearer scheme even if the token equals the secret', () => {
  const { res, nextCalled } = run({ secret: 's3cr3t-value', headers: { authorization: 'Basic s3cr3t-value' } })
  assert.equal(res.statusCode, 401, 'only the Bearer scheme is accepted')
  assert.equal(nextCalled, false)
})

test('cronAuth 401s on a wrong secret of the SAME length (real compare, not a length check)', () => {
  const { res, nextCalled } = run({ secret: 'abcdefgh', headers: { authorization: 'Bearer abcdefgX' } })
  assert.equal(res.statusCode, 401)
  assert.equal(nextCalled, false)
})

test('cronAuth 401s when the presented token is a PREFIX of the secret (full compare, not prefix-match)', () => {
  const { res, nextCalled } = run({ secret: 'long-secret-value', headers: { authorization: 'Bearer long-secret' } })
  assert.equal(res.statusCode, 401)
  assert.equal(nextCalled, false)
})

test('cronAuth calls next() and sets no status on the correct Bearer secret', () => {
  const { res, nextCalled } = run({ secret: 'the-right-secret', headers: { authorization: 'Bearer the-right-secret' } })
  assert.equal(nextCalled, true, 'a correct secret passes through to the handler')
  assert.equal(res.statusCode, null, 'no error status is set on success')
})
