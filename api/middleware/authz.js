'use strict'

// ── Multi-tenant authorization guards ────────────────────────────────────────
//
// These layer on top of requireAuth (middleware/auth.js), which has ALREADY
// verified the JWT and populated:
//     req.user = { id, email, role, client_id }
//
// requireAuth proves WHO you are. These guards prove WHAT you may touch.
//
// The single-agency-per-deploy model has exactly two roles:
//   • 'agency' — trusted staff; may read and manage EVERY client. client_id null.
//   • 'client' — an external login pinned to ONE client_id; may only ever touch
//                that one client.
//
// Without these guards every authenticated token could read or modify any
// client's data by changing an id in the URL or request body (IDOR). This is
// the REST/structured-query counterpart to the already-scoped /ask path
// (lib/ask.js compileQuery scopeClientId) — same principle, same hard boundary.
//
// Guiding rule: FAIL CLOSED. Anything ambiguous (missing user, client token with
// no bound client_id, unknown role) → 403. Never default-open.

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
// links. 403 for anyone who is not agency (mirrors auth.js:71 'Agency only').
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

module.exports = { sameId, requireAgency, scopeClientParam, scopeClientId }
