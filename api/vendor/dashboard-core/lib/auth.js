'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// lib/auth.js — JWT verify + multi-tenant authorization guards, as a factory.
//
// Ported from agency-performance-dashboard's api/middleware/auth.js (requireAuth)
// and api/middleware/authz.js (requireAgency, scopeClientParam, scopeClientQuery,
// scopeClientId). The ONLY change from agency is that the JWT secret — which
// agency read directly from process.env at module load — is now injected via
// createAuth({ jwtSecret }). The default preserves agency's exact behaviour:
// process.env.JWT_SECRET, falling back to the public dev literal.
//
// requireAuth proves WHO you are (verifies the JWT, populates req.user). The
// authz guards prove WHAT you may touch. Payload shape:
//     req.user = { id, email, role: 'agency' | 'client', client_id }
//
// The single-agency-per-deploy model has exactly two roles:
//   • 'agency' — trusted staff; may read and manage EVERY client. client_id null.
//   • 'client' — an external login pinned to ONE client_id; may only ever touch
//                that one client.
//
// Guiding rule: FAIL CLOSED. Anything ambiguous (missing user, client token with
// no bound client_id, unknown role) → 403/401. Never default-open.
// ─────────────────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken')
const { DEV_SECRET_FALLBACK } = require('./authSecurity')

// Compare two ids for equality, tolerant of type drift. client_id is a UUID
// here, but a URL param always arrives as a string and the SQLite test path may
// store ids as TEXT — coerce both sides to trimmed strings so '5' === 5 and a
// UUID matches regardless of casing differences in storage. null/undefined on
// either side is never a match (fail closed).
function sameId(a, b) {
  if (a === null || a === undefined || a === '') return false
  if (b === null || b === undefined || b === '') return false
  return String(a).trim() === String(b).trim()
}

// Agency-only endpoints: portfolio-wide reads (anomalies across all clients) and
// every client mutation a scoped client must never perform — create/update/
// delete clients, trigger syncs, manage connection credentials, mint share
// links. 403 for anyone who is not agency.
function requireAgency(req, res, next) {
  if (!req.user || req.user.role !== 'agency') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  return next()
}

// Per-client endpoints where the target client id lives in the URL (req.params).
// Agency passes through (may touch any client). A 'client' caller may proceed
// ONLY when the requested id matches their own bound client_id; otherwise 403.
// A client token with no bound client_id can never match → denied (fail closed).
//
//   router.get('/:clientId', scopeClientParam('clientId'), handler)
//   router.get('/:id',       scopeClientParam('id'),       handler)
function scopeClientParam(paramName = 'clientId') {
  return function (req, res, next) {
    const role = req.user && req.user.role
    if (role === 'agency') return next()
    if (role === 'client' && sameId(req.params[paramName], req.user.client_id)) {
      return next()
    }
    return res.status(403).json({ error: 'Forbidden' })
  }
}

// Per-client endpoints where the target client id lives in the QUERY STRING
// (req.query). Same boundary as scopeClientParam: agency passes through; a client
// proceeds only when the requested id matches its own bound client_id; a client
// with no bound id, or a missing/foreign id, is 403. Fail closed.
//
//   router.get('/', scopeClientQuery('clientId'), handler)   // ?clientId=...
function scopeClientQuery(paramName = 'clientId') {
  return function (req, res, next) {
    const role = req.user && req.user.role
    if (role === 'agency') return next()
    const requested = req.query ? req.query[paramName] : undefined
    if (role === 'client' && sameId(requested, req.user.client_id)) {
      return next()
    }
    return res.status(403).json({ error: 'Forbidden' })
  }
}

// For handlers that must FILTER or CLAMP rather than reject — list endpoints
// (GET /clients returns only your own row) and the semantic POST /query (whose
// body carries a client list that must be overridden, never trusted). Returns
// the HARD client id a caller is confined to, or null for an agency caller
// (no confinement). A client token with no client_id confines to null, which
// callers MUST treat as "match nothing" (an unscoped client sees no data).
function scopeClientId(req) {
  if (req.user && req.user.role === 'client') {
    return req.user.client_id || null
  }
  return null
}

// Factory: bind requireAuth to a JWT secret (injected, not read from the module's
// process.env at import time). The authz guards are stateless w.r.t. the secret,
// but are returned from the same factory so a caller gets the whole layer from
// one call: createAuth({ jwtSecret }) → { requireAuth, requireAgency,
// scopeClientParam, scopeClientQuery, scopeClientId, sameId }.
//
//   jwtSecret — defaults to process.env.JWT_SECRET || DEV_SECRET_FALLBACK, i.e.
//               EXACTLY what agency's middleware/auth.js captured at module load.
function createAuth(opts = {}) {
  const jwtSecret =
    opts.jwtSecret != null ? opts.jwtSecret : (process.env.JWT_SECRET || DEV_SECRET_FALLBACK)

  function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || ''
    const token = header.replace(/^Bearer\s+/i, '').trim()

    if (!token) {
      return res.status(401).json({ error: 'No token provided' })
    }

    try {
      const payload = jwt.verify(token, jwtSecret)
      req.user = payload
      next()
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
  }

  return {
    requireAuth,
    requireAgency,
    scopeClientParam,
    scopeClientQuery,
    scopeClientId,
    sameId,
  }
}

module.exports = {
  createAuth,
  // Also export the stateless guards directly — they don't depend on the secret,
  // so a caller can pull just these without minting a full auth factory.
  sameId,
  requireAgency,
  scopeClientParam,
  scopeClientQuery,
  scopeClientId,
}
