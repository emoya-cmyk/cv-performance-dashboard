'use strict'

// ============================================================================
// test/realtime.test.js — per-tenant SSE fan-out (intel-v13 C2, step b).
//
// The live stream is one process-wide broadcast. Before scoping, every browser
// received every tenant's clientId on the wire — a peer-id leak visible in the
// network tab even though the C1 hook never reads ev.data. routes/realtime.js
// now tags each socket with a scope derived from the query-string JWT (EventSource
// can't send a Bearer header) and delivers an event only when visibleTo() says so.
//
// These are the leak-proof guarantees the client surface depends on:
//   1. scopeFromRequest — agency token → agency; client token → its clientId;
//      absent/garbage/clientId-less → the most restrictive client scope.
//   2. visibleTo        — agency sees all; a client sees its own + tenant-less
//      events, NEVER a peer's; fail-closed for a missing/degenerate scope.
//   3. broadcast        — end-to-end through sseMiddleware with mock sockets:
//      a client receives its own event + the connect hello but not a peer's,
//      and one broken socket never breaks the fan-out to the others.
//
// CommonJS module → required directly (no dynamic import needed here).
// ============================================================================

const { test }  = require('node:test')
const assert    = require('node:assert/strict')
const jwt       = require('jsonwebtoken')

const realtime = require('../routes/realtime')
const { scopeFromRequest, visibleTo, sseMiddleware, broadcast } = realtime

// Must match the secret the module captured at load (middleware/auth uses the same).
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'
const sign = (payload) => jwt.sign(payload, SECRET)

// A mock SSE connection: captures every res.write and exposes the close handler
// so a test can deregister itself (the clients Set is module-level and shared).
function makeConn(query) {
  const writes = []
  let closeHandler = null
  const req = {
    query: query || {},
    on(evt, cb) { if (evt === 'close') closeHandler = cb },
  }
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    flushHeaders() {},
    write(chunk) { writes.push(chunk); return true },
  }
  return { req, res, writes, close: () => { if (closeHandler) closeHandler() } }
}

const got = (conn, eventName) => conn.writes.some((w) => w.includes(`event: ${eventName}`))

// ── 1. scopeFromRequest ─────────────────────────────────────────────────────────
test('agency token → agency scope (sees all tenants)', () => {
  const s = scopeFromRequest({ query: { token: sign({ role: 'agency' }) } })
  assert.deepEqual(s, { role: 'agency' })
})

test('client token → client scope bound to its clientId (coerced to string)', () => {
  const s = scopeFromRequest({ query: { token: sign({ role: 'client', client_id: 42 }) } })
  assert.deepEqual(s, { role: 'client', clientId: '42' })
})

test('client token with no client_id → client scope bound to null', () => {
  const s = scopeFromRequest({ query: { token: sign({ role: 'client' }) } })
  assert.deepEqual(s, { role: 'client', clientId: null })
})

test('absent token → most-restrictive client scope (no tenant data)', () => {
  assert.deepEqual(scopeFromRequest({ query: {} }),            { role: 'client', clientId: null })
  assert.deepEqual(scopeFromRequest({}),                       { role: 'client', clientId: null })
  assert.deepEqual(scopeFromRequest(null),                     { role: 'client', clientId: null })
})

test('garbage / wrong-secret token → fail-closed client scope, never throws', () => {
  assert.deepEqual(scopeFromRequest({ query: { token: 'not.a.jwt' } }), { role: 'client', clientId: null })
  const foreign = jwt.sign({ role: 'agency' }, 'some-other-secret')
  assert.deepEqual(scopeFromRequest({ query: { token: foreign } }),     { role: 'client', clientId: null })
})

test('token parses from req.url query string when req.query is absent', () => {
  const token = sign({ role: 'client', client_id: 7 })
  const s = scopeFromRequest({ url: `/api/realtime?token=${encodeURIComponent(token)}` })
  assert.deepEqual(s, { role: 'client', clientId: '7' })
})

// ── 2. visibleTo ────────────────────────────────────────────────────────────────
test('agency scope sees every event, tenant-scoped or not', () => {
  const agency = { role: 'agency' }
  assert.equal(visibleTo(agency, { clientId: 1 }),    true)
  assert.equal(visibleTo(agency, { clientId: 'xyz' }),true)
  assert.equal(visibleTo(agency, {}),                 true)
  assert.equal(visibleTo(agency, { clientId: null }), true)
})

test('client scope sees its own events and tenant-less events, NEVER a peer', () => {
  const me = { role: 'client', clientId: '42' }
  assert.equal(visibleTo(me, { clientId: '42' }), true,  'own (string)')
  assert.equal(visibleTo(me, { clientId: 42 }),   true,  'own (number coerces)')
  assert.equal(visibleTo(me, {}),                 true,  'tenant-less')
  assert.equal(visibleTo(me, { clientId: null }), true,  'explicit null clientId = tenant-less')
  assert.equal(visibleTo(me, { clientId: '99' }), false, 'peer never visible')
  assert.equal(visibleTo(me, { clientId: 99 }),   false, 'peer never visible (number)')
})

test('client scope with null clientId sees ONLY tenant-less events', () => {
  const anon = { role: 'client', clientId: null }
  assert.equal(visibleTo(anon, {}),               true)
  assert.equal(visibleTo(anon, { clientId: '1' }), false)
  assert.equal(visibleTo(anon, { clientId: 1 }),   false)
})

test('a missing / degenerate scope fails closed — no tenant event leaks', () => {
  // Unreachable via sseMiddleware (it always assigns a scope), but visibleTo must
  // still never hand a tenant id to an unknown viewer.
  for (const bad of [null, undefined, {}, { role: 'mystery' }]) {
    assert.equal(visibleTo(bad, { clientId: '1' }), false, `${JSON.stringify(bad)} sees no tenant event`)
    assert.equal(visibleTo(bad, {}),                true,  `${JSON.stringify(bad)} still sees tenant-less`)
  }
})

// ── 3. broadcast routing end-to-end through sseMiddleware ───────────────────────
test('broadcast routes a tenant event to agency + owner, never to a peer', () => {
  const agency  = makeConn({ token: sign({ role: 'agency' }) })
  const owner   = makeConn({ token: sign({ role: 'client', client_id: 42 }) })
  const peer    = makeConn({ token: sign({ role: 'client', client_id: 99 }) })
  sseMiddleware(agency.req, agency.res)
  sseMiddleware(owner.req,  owner.res)
  sseMiddleware(peer.req,   peer.res)
  try {
    // Every socket gets the tenant-less connect hello on open.
    assert.ok(got(agency, 'connected') && got(owner, 'connected') && got(peer, 'connected'))

    broadcast('ghl_event', { clientId: 42, type: 'ContactCreate', ts: 'T' })

    assert.equal(got(agency, 'ghl_event'), true,  'agency sees the tenant event')
    assert.equal(got(owner,  'ghl_event'), true,  'owner sees its own event')
    assert.equal(got(peer,   'ghl_event'), false, 'peer NEVER sees another tenant on the wire')
    // No tenant-event bytes reach the peer at all. Scope this to event payloads:
    // the tenant-less connect hello carries an ISO timestamp that can incidentally
    // contain the digits of a clientId (e.g. ".842Z" includes "42"), so a raw
    // substring check on ALL bytes is a false-positive flake — assert on the
    // event/payload markers instead, which never appear in a timestamp.
    const peerEventBytes = peer.writes.filter((w) => w.includes('ghl_event') || w.includes('ContactCreate'))
    assert.deepEqual(peerEventBytes, [], 'no tenant-event bytes reached the peer')
  } finally {
    agency.close(); owner.close(); peer.close()
  }
})

test('a tenant-less event reaches every connected socket', () => {
  const agency = makeConn({ token: sign({ role: 'agency' }) })
  const client = makeConn({ token: sign({ role: 'client', client_id: 42 }) })
  const anon   = makeConn({})   // no token → restricted client scope
  sseMiddleware(agency.req, agency.res)
  sseMiddleware(client.req, client.res)
  sseMiddleware(anon.req,   anon.res)
  try {
    broadcast('system_notice', { ts: 'T' })   // no clientId → global
    assert.ok(got(agency, 'system_notice'))
    assert.ok(got(client, 'system_notice'))
    assert.ok(got(anon,   'system_notice'), 'even an unauthenticated socket sees global events')
  } finally {
    agency.close(); client.close(); anon.close()
  }
})

test('an unauthenticated socket receives the hello + pings but no tenant data', () => {
  const anon = makeConn({})
  sseMiddleware(anon.req, anon.res)
  try {
    assert.equal(got(anon, 'connected'), true, 'gets the transport hello')
    broadcast('hubspot_event', { clientId: 5, type: 'x', ts: 'T' })
    assert.equal(got(anon, 'hubspot_event'), false, 'no tenant event without a verified token')
  } finally {
    anon.close()
  }
})

test('one broken socket does not break the fan-out to healthy peers', () => {
  const healthy = makeConn({ token: sign({ role: 'agency' }) })
  const broken  = makeConn({ token: sign({ role: 'agency' }) })
  sseMiddleware(healthy.req, healthy.res)
  sseMiddleware(broken.req,  broken.res)
  // Simulate a dead pipe (EPIPE): the next write throws.
  broken.res.write = () => { throw new Error('EPIPE') }
  try {
    assert.doesNotThrow(() => broadcast('supermetrics_sync', { clientId: 1, source: 'ga', ts: 'T' }))
    assert.equal(got(healthy, 'supermetrics_sync'), true, 'healthy socket still served')
    // The broken socket was evicted; a second broadcast must not retry (would throw).
    assert.doesNotThrow(() => broadcast('supermetrics_sync', { clientId: 1, source: 'ga', ts: 'T' }))
  } finally {
    healthy.close()
    broken.close()   // broken's close handler clears its interval and removes it if still present
  }
})

test('closing a connection removes it from the fan-out', () => {
  const a = makeConn({ token: sign({ role: 'agency' }) })
  sseMiddleware(a.req, a.res)
  a.close()
  const before = a.writes.length
  broadcast('ghl_event', { clientId: 1, type: 'x', ts: 'T' })
  assert.equal(a.writes.length, before, 'a closed socket receives nothing further')
})
