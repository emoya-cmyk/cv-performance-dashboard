'use strict'

/**
 * Server-Sent Events (SSE) for real-time dashboard updates (intel-v13).
 *
 * Browsers connect to GET /api/realtime and receive a named event whenever a
 * connected source pushes: ghl_event / supermetrics_sync / hubspot_event — each
 * carrying a `clientId` — plus a `: ping` comment every 30s to hold the socket.
 *
 * PER-TENANT FAN-OUT (leak-proof at the wire): the stream is one process-wide
 * broadcast, so without scoping every browser would receive every tenant's
 * clientId — a peer-id leak visible in the network tab even though the C1 hook
 * never reads ev.data. We therefore tag each connection with the viewer's scope,
 * derived from the JWT, and deliver an event only when it is visible to that
 * scope: an agency viewer sees everything; a client viewer sees ONLY events for
 * its own clientId (plus tenant-less/global events); an unauthenticated or
 * unverifiable connection gets nothing tenant-specific (fail-closed) — just the
 * connect hello and keep-alives. The badge stays honest in every case.
 *
 * EventSource cannot set headers, so the token rides the query string
 * (?token=...) and is verified here exactly as middleware/auth.requireAuth does.
 */

const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

// Each entry: { res, scope }. scope = { role: 'agency' } | { role: 'client', clientId }
const clients = new Set()

/**
 * Derive the viewer scope from an SSE request's query-string token. Fail-closed:
 * a missing/invalid token, or a client token with no client_id, yields a client
 * scope bound to NO clientId — which matches only tenant-less events, never a
 * peer's data. Pure and exported so the routing decision is unit-testable.
 *
 * @param {{query?: {token?: string}, url?: string}} req
 * @returns {{role: 'agency'} | {role: 'client', clientId: string|null}}
 */
function scopeFromRequest(req) {
  let token = ''
  if (req && req.query && typeof req.query.token === 'string') {
    token = req.query.token
  } else if (req && typeof req.url === 'string') {
    const q = req.url.indexOf('?')
    if (q >= 0) token = new URLSearchParams(req.url.slice(q + 1)).get('token') || ''
  }
  if (!token) return { role: 'client', clientId: null }
  try {
    const p = jwt.verify(token, JWT_SECRET)
    if (p && p.role === 'agency') return { role: 'agency' }
    return { role: 'client', clientId: p && p.client_id != null ? String(p.client_id) : null }
  } catch {
    return { role: 'client', clientId: null }   // unverifiable → no tenant data
  }
}

/**
 * Is an event with payload `data` visible to a viewer with `scope`?
 * - agency → everything.
 * - client → tenant-less events (no clientId) or events whose clientId matches
 *   theirs. Never a peer's clientId. Pure and exported for exhaustive testing.
 *
 * @param {{role: string, clientId?: string|null}} scope
 * @param {{clientId?: unknown}} data
 * @returns {boolean}
 */
function visibleTo(scope, data) {
  if (scope && scope.role === 'agency') return true
  const evClient = data && data.clientId != null ? String(data.clientId) : null
  if (evClient == null) return true                          // tenant-less/global
  // Fail-closed: a missing/degenerate scope, or a client scope with no clientId,
  // matches NO tenant event. Coerce both sides so a numeric id never slips past
  // a string id (or vice-versa) on a manually-constructed scope.
  const myClient = scope && scope.clientId != null ? String(scope.clientId) : null
  return myClient != null && evClient === myClient
}

function sseMiddleware(req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const entry = { res, scope: scopeFromRequest(req) }

  // Connect hello — tenant-less; the FE hook uses it to mark the transport open.
  res.write(`event: connected\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)
  clients.add(entry)

  // Keep-alive ping every 30s. unref so the timer never holds the process open
  // on its own (the HTTP server keeps it alive in prod; tests stay drainable).
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`) } catch { clearInterval(ping) }
  }, 30_000)
  if (typeof ping.unref === 'function') ping.unref()

  req.on('close', () => {
    clearInterval(ping)
    clients.delete(entry)
  })
}

/**
 * Broadcast a named event to every connection it is visible to (see visibleTo).
 * Signature unchanged from the original — the webhook emitters call it as before.
 */
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const entry of clients) {
    if (!visibleTo(entry.scope, data)) continue
    try { entry.res.write(msg) } catch { clients.delete(entry) }
  }
}

module.exports = { sseMiddleware, broadcast, scopeFromRequest, visibleTo }
