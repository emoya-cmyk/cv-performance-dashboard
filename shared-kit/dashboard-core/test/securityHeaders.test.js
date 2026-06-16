'use strict'

// Ported from agency's api/test/securityHeaders.test.js.

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { securityHeaders } = require('..')

function mockRes() {
  const headers = {}
  return {
    headers,
    setHeader(k, v) { headers[k.toLowerCase()] = String(v) },
    removeHeader(k) { delete headers[k.toLowerCase()] },
  }
}

test('securityHeaders sets the hardening header set and calls next exactly once', () => {
  const mw  = securityHeaders()
  const res = mockRes()
  let nexted = 0
  mw({}, res, () => { nexted++ })

  assert.equal(nexted, 1, 'must call next exactly once')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(res.headers['x-dns-prefetch-control'], 'off')
  assert.equal(res.headers['x-download-options'], 'noopen')
  assert.equal(res.headers['x-permitted-cross-domain-policies'], 'none')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin')
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin')
  assert.equal(res.headers['origin-agent-cluster'], '?1')
  assert.match(res.headers['strict-transport-security'], /^max-age=\d+; includeSubDomains$/)
})

test('securityHeaders honors a custom hstsMaxAge', () => {
  const mw  = securityHeaders({ hstsMaxAge: 60 })
  const res = mockRes()
  mw({}, res, () => {})
  assert.equal(res.headers['strict-transport-security'], 'max-age=60; includeSubDomains')
})

test('securityHeaders does NOT set a Content-Security-Policy (SPA-safe by design)', () => {
  const mw  = securityHeaders()
  const res = mockRes()
  mw({}, res, () => {})
  assert.equal(res.headers['content-security-policy'], undefined)
  assert.equal(res.headers['cross-origin-embedder-policy'], undefined)
})
