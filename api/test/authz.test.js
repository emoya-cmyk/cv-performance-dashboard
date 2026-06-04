'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { sameId, requireAgency, scopeClientParam, scopeClientId } = require('../middleware/authz')

// ── test doubles ─────────────────────────────────────────────────────────────
// Minimal Express req/res/next stubs. res.status(n).json(body) records the
// outcome; next() records that the middleware passed control through.
function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}
function makeNext() {
  const calls = { count: 0 }
  const next = () => { calls.count += 1 }
  next.calls = calls
  return next
}

const AGENCY = { id: 'u-a', email: 'a@x.com', role: 'agency', client_id: null }
const CLIENT_A = { id: 'u-1', email: 'c1@x.com', role: 'client', client_id: 'client-aaa' }
const CLIENT_NOSCOPE = { id: 'u-2', email: 'c2@x.com', role: 'client', client_id: null }

// ── sameId ───────────────────────────────────────────────────────────────────
test('sameId: matches identical uuid strings', () => {
  assert.equal(sameId('client-aaa', 'client-aaa'), true)
})

test('sameId: tolerates int/string drift and surrounding whitespace', () => {
  assert.equal(sameId('5', 5), true)
  assert.equal(sameId(5, '5'), true)
  assert.equal(sameId(' client-aaa ', 'client-aaa'), true)
})

test('sameId: distinct ids never match', () => {
  assert.equal(sameId('client-aaa', 'client-bbb'), false)
  assert.equal(sameId('5', '50'), false)
})

test('sameId: null / undefined / empty fail closed', () => {
  assert.equal(sameId(null, 'client-aaa'), false)
  assert.equal(sameId('client-aaa', null), false)
  assert.equal(sameId(undefined, undefined), false)
  assert.equal(sameId('', ''), false)
  assert.equal(sameId('client-aaa', ''), false)
})

// ── requireAgency ────────────────────────────────────────────────────────────
test('requireAgency: agency passes through', () => {
  const next = makeNext(); const res = makeRes()
  requireAgency({ user: AGENCY }, res, next)
  assert.equal(next.calls.count, 1)
  assert.equal(res.statusCode, null)
})

test('requireAgency: client is forbidden', () => {
  const next = makeNext(); const res = makeRes()
  requireAgency({ user: CLIENT_A }, res, next)
  assert.equal(next.calls.count, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { error: 'Forbidden' })
})

test('requireAgency: missing user is forbidden (fail closed)', () => {
  const next = makeNext(); const res = makeRes()
  requireAgency({}, res, next)
  assert.equal(next.calls.count, 0)
  assert.equal(res.statusCode, 403)
})

test('requireAgency: unknown role is forbidden (fail closed)', () => {
  const next = makeNext(); const res = makeRes()
  requireAgency({ user: { role: 'superadmin' } }, res, next)
  assert.equal(next.calls.count, 0)
  assert.equal(res.statusCode, 403)
})

// ── scopeClientParam ─────────────────────────────────────────────────────────
test('scopeClientParam: agency may touch any client id', () => {
  const next = makeNext(); const res = makeRes()
  scopeClientParam('clientId')({ user: AGENCY, params: { clientId: 'client-zzz' } }, res, next)
  assert.equal(next.calls.count, 1)
  assert.equal(res.statusCode, null)
})

test('scopeClientParam: client may touch only its own id', () => {
  const next = makeNext(); const res = makeRes()
  scopeClientParam('clientId')({ user: CLIENT_A, params: { clientId: 'client-aaa' } }, res, next)
  assert.equal(next.calls.count, 1)
  assert.equal(res.statusCode, null)
})

test('scopeClientParam: client touching another client is forbidden', () => {
  const next = makeNext(); const res = makeRes()
  scopeClientParam('clientId')({ user: CLIENT_A, params: { clientId: 'client-bbb' } }, res, next)
  assert.equal(next.calls.count, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { error: 'Forbidden' })
})

test('scopeClientParam: client with no bound client_id is forbidden (fail closed)', () => {
  const next = makeNext(); const res = makeRes()
  scopeClientParam('clientId')({ user: CLIENT_NOSCOPE, params: { clientId: 'client-aaa' } }, res, next)
  assert.equal(next.calls.count, 0)
  assert.equal(res.statusCode, 403)
})

test('scopeClientParam: missing param is forbidden for client (fail closed)', () => {
  const next = makeNext(); const res = makeRes()
  scopeClientParam('clientId')({ user: CLIENT_A, params: {} }, res, next)
  assert.equal(next.calls.count, 0)
  assert.equal(res.statusCode, 403)
})

test('scopeClientParam: honors a custom param name (:id)', () => {
  const okNext = makeNext(); const okRes = makeRes()
  scopeClientParam('id')({ user: CLIENT_A, params: { id: 'client-aaa' } }, okRes, okNext)
  assert.equal(okNext.calls.count, 1)

  const badNext = makeNext(); const badRes = makeRes()
  scopeClientParam('id')({ user: CLIENT_A, params: { id: 'client-bbb' } }, badRes, badNext)
  assert.equal(badNext.calls.count, 0)
  assert.equal(badRes.statusCode, 403)
})

test('scopeClientParam: defaults to the clientId param when none is given', () => {
  const next = makeNext(); const res = makeRes()
  scopeClientParam()({ user: CLIENT_A, params: { clientId: 'client-aaa' } }, res, next)
  assert.equal(next.calls.count, 1)
})

// ── scopeClientId ────────────────────────────────────────────────────────────
test('scopeClientId: agency is unconfined (null)', () => {
  assert.equal(scopeClientId({ user: AGENCY }), null)
})

test('scopeClientId: client is confined to its own id', () => {
  assert.equal(scopeClientId({ user: CLIENT_A }), 'client-aaa')
})

test('scopeClientId: client with no bound id confines to null (match nothing)', () => {
  assert.equal(scopeClientId({ user: CLIENT_NOSCOPE }), null)
})

test('scopeClientId: missing user is unconfined null (route still requires auth upstream)', () => {
  assert.equal(scopeClientId({}), null)
})
