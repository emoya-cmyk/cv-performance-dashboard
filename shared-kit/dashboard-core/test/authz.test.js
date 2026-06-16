'use strict'

// Unit tests for the authz guards — ported from agency's api/test/authz.test.js,
// pulling the guards out of the package exactly as a consumer would.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  sameId,
  requireAgency,
  scopeClientParam,
  scopeClientQuery,
  scopeClientId,
  createAuth,
} = require('..')

// The factory must hand back the same guards (so a consumer can take the whole
// layer from one createAuth call).
const auth = createAuth({ jwtSecret: 'unit-test-secret' })

// ── test doubles ─────────────────────────────────────────────────────────────
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

// the factory-returned guard must behave identically
test('requireAgency (from createAuth): client forbidden, agency passes', () => {
  const n1 = makeNext(); const r1 = makeRes()
  auth.requireAgency({ user: CLIENT_A }, r1, n1)
  assert.equal(r1.statusCode, 403)
  const n2 = makeNext(); const r2 = makeRes()
  auth.requireAgency({ user: AGENCY }, r2, n2)
  assert.equal(n2.calls.count, 1)
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

// ── scopeClientQuery (added in the package; same boundary, ?clientId=) ─────────
test('scopeClientQuery: agency passes, client→own ok, client→other 403, noscope 403', () => {
  const ag = makeNext(); const agRes = makeRes()
  scopeClientQuery('clientId')({ user: AGENCY, query: { clientId: 'client-zzz' } }, agRes, ag)
  assert.equal(ag.calls.count, 1)

  const own = makeNext(); const ownRes = makeRes()
  scopeClientQuery('clientId')({ user: CLIENT_A, query: { clientId: 'client-aaa' } }, ownRes, own)
  assert.equal(own.calls.count, 1)

  const other = makeNext(); const otherRes = makeRes()
  scopeClientQuery('clientId')({ user: CLIENT_A, query: { clientId: 'client-bbb' } }, otherRes, other)
  assert.equal(other.calls.count, 0)
  assert.equal(otherRes.statusCode, 403)

  const noscope = makeNext(); const noscopeRes = makeRes()
  scopeClientQuery('clientId')({ user: CLIENT_NOSCOPE, query: { clientId: 'client-aaa' } }, noscopeRes, noscope)
  assert.equal(noscope.calls.count, 0)
  assert.equal(noscopeRes.statusCode, 403)

  const missing = makeNext(); const missingRes = makeRes()
  scopeClientQuery('clientId')({ user: CLIENT_A, query: {} }, missingRes, missing)
  assert.equal(missing.calls.count, 0)
  assert.equal(missingRes.statusCode, 403)
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
