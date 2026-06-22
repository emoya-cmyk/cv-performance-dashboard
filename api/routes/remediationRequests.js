'use strict'

// Operator remediation-request queue — the OUTBOUND half of the cli_framework ↔
// dashboard bridge.
//
// WHY THIS EXISTS
//   routes/integrationHealth.js is the INBOUND half: cli_framework PUSHES a
//   per-tenant integration-health snapshot in, agency operators READ it on the
//   Integration-Health tile. THIS module is the reverse channel. From that same
//   tile an agency operator can REQUEST a safe cli operation on a tenant; the
//   request lands here as a 'pending' row and just SITS there. cli_framework
//   (a SEPARATE toolkit, a later PR on its side) PULLS the pending rows, executes
//   them, and reports the result back. The dashboard NEVER calls cli_framework and
//   NEVER executes anything — it only RECORDS the request and stores cli's report.
//   INERT until cli pulls: a request with no puller stays 'pending' forever, safely.
//
// CAUSE/EFFECT INVARIANT — SAFE BY CONSTRUCTION
//   Create is OPERATOR-INITIATED (agency auth) and the action is limited to a FIXED
//   ALLOW-LIST of SAFE, idempotent operations (ALLOWED_ACTIONS below). There is NO
//   vendor-write action in the enum — nothing here can create/update/delete a vendor
//   record; the dashboard only ever asks cli to RE-READ / CLEAR-LOCAL-STATE / EXPORT.
//   An action not in the allow-list is rejected 400 (and the DB CHECK is a second
//   wall behind the route guard).
//
// FOUR SURFACES, TWO GATES (mounted in server.js under /api/integration-health):
//   • POST   /requests          — AGENCY operators (requireAuth + requireAgency): create.
//   • GET    /requests          — AGENCY operators: list (for the tile).
//   • GET    /requests/pending  — MACHINE (ihAuth shared-secret): cli pulls + atomically
//                                 claims pending rows.
//   • POST   /requests/:id/result — MACHINE (ihAuth shared-secret): cli reports terminal status.

const crypto  = require('crypto')
const express = require('express')

const { query }         = require('../db')
const { requireAuth }   = require('../middleware/auth')
const { requireAgency } = require('../middleware/authz')
const { ihAuth }        = require('./integrationHealth')

// ── The allow-list. The ONLY operations an operator may request. SAFE + idempotent;
//    NO vendor-write exists here by design. Mirrored by the DB CHECK constraint. ──
const ALLOWED_ACTIONS = new Set(['reaudit', 'clear_breaker', 'rebuild_index', 'export_queue'])

// Terminal statuses cli may report back.
const TERMINAL_STATUS = new Set(['done', 'failed'])

const router = express.Router()

// Parse a JSON-or-object column defensively (params/result are TEXT in SQLite, JSONB
// in Postgres — pg may hand back an already-parsed object). Always returns a plain
// object (or the passed fallback) so the wire shape is stable across dialects.
function parseJson(v, fallback = {}) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); return (p && typeof p === 'object') ? p : fallback }
    catch { return fallback }
  }
  return fallback
}

// Shape a DB row → the stable wire object both the tile and cli read.
function toWire(r) {
  return {
    id:           r.id,
    client_id:    r.client_id,
    action:       r.action,
    params:       parseJson(r.params, {}),
    status:       r.status,
    result:       r.result == null ? null : parseJson(r.result, null),
    requested_by: r.requested_by || null,
    created_at:   r.created_at || null,
    updated_at:   r.updated_at || null,
    completed_at: r.completed_at || null,
  }
}

// ── POST /requests — agency-only: create a remediation request ────────────────
// Body: { client_id, action, params? }. Validates action ∈ ALLOWED_ACTIONS (else
// 400), stores status='pending'. Defensive: a bad body is 400, never 500.
router.post('/requests', requireAuth, requireAgency, async (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'body must be an object', code: 'BAD_BODY' })
  }

  const clientId = (typeof body.client_id === 'string') ? body.client_id.trim() : ''
  if (!clientId) {
    return res.status(400).json({ error: 'client_id is required', code: 'BAD_CLIENT' })
  }

  const action = (typeof body.action === 'string') ? body.action.trim() : ''
  if (!ALLOWED_ACTIONS.has(action)) {
    // The cause/effect wall: only the fixed safe allow-list is acceptable.
    return res.status(400).json({
      error: `action must be one of: ${[...ALLOWED_ACTIONS].join(', ')}`,
      code:  'BAD_ACTION',
    })
  }

  // params is an optional object (e.g. {vendor} for clear_breaker). Reject a
  // non-object (array / scalar) rather than silently coercing.
  let params = body.params
  if (params == null) params = {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    return res.status(400).json({ error: 'params must be an object', code: 'BAD_PARAMS' })
  }

  const requestedBy = req.user ? (req.user.email || req.user.id || null) : null

  try {
    const id  = crypto.randomUUID()
    const now = new Date().toISOString()
    const { rows } = await query(
      `INSERT INTO remediation_requests
         (id, client_id, action, params, status, requested_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6)
       RETURNING id, client_id, action, params, status, result,
                 requested_by, created_at, updated_at, completed_at`,
      [id, clientId, action, JSON.stringify(params), requestedBy, now]
    )
    // SQLite RETURNING is reconstructed from the INSERT rowid; fall back to a
    // direct read on the unlikely miss so the response is always the created row.
    let row = rows && rows[0]
    if (!row) {
      const back = await query(`SELECT * FROM remediation_requests WHERE id = $1`, [id])
      row = back.rows[0]
    }
    res.status(201).json({ ok: true, request: toWire(row) })
  } catch (err) {
    console.error('[remediation] create error', err.message)
    res.status(400).json({ error: 'could not create request', code: 'CREATE_FAILED' })
  }
})

// ── GET /requests — agency-only: list requests (newest first) ─────────────────
// Optional ?status= filter (one of the enum) and ?client_id= scope for the tile.
// Empty table → { requests: [] } at 200 (INERT until an operator requests one).
router.get('/requests', requireAuth, requireAgency, async (req, res) => {
  try {
    const where  = []
    const params = []
    const status = (typeof req.query.status === 'string') ? req.query.status.trim() : ''
    if (status) {
      // An unknown status simply matches nothing (no rows), never an error.
      params.push(status)
      where.push(`status = $${params.length}`)
    }
    const clientId = (typeof req.query.client_id === 'string') ? req.query.client_id.trim() : ''
    if (clientId) {
      params.push(clientId)
      where.push(`client_id = $${params.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT id, client_id, action, params, status, result,
              requested_by, created_at, updated_at, completed_at
         FROM remediation_requests
         ${whereSql}
        ORDER BY created_at DESC, id DESC`,
      params
    )
    res.json({ requests: rows.map(toWire) })
  } catch (err) {
    console.error('[remediation] list error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /requests/pending — machine (ihAuth): pull + atomically claim ─────────
// cli pulls the pending queue. To stop two concurrent pulls double-claiming the
// SAME row, we DON'T return then mark — we MARK FIRST under a unique claim_token,
// then read back exactly the rows that token stamped. The UPDATE … WHERE
// status='pending' is the atomic gate (a row can only transition pending→claimed
// once; a second concurrent pull's UPDATE finds it already 'claimed' and skips
// it). This avoids relying on UPDATE…RETURNING, which the SQLite shim can't
// reconstruct once the WHERE predicate (status) no longer matches post-update.
// Idempotent-ish: a pull with nothing pending returns { requests: [] }.
router.get('/requests/pending', ihAuth, async (_req, res) => {
  try {
    const claimToken = crypto.randomUUID()
    const now        = new Date().toISOString()

    // Atomic claim: flip every currently-pending row to 'claimed' under this
    // pull's unique token. Concurrent pulls each carry their own token and the
    // status='pending' predicate ensures a row is claimed by exactly one of them.
    await query(
      `UPDATE remediation_requests
          SET status = 'claimed', claim_token = $1, updated_at = $2
        WHERE status = 'pending'`,
      [claimToken, now]
    )

    // Read back exactly the rows THIS pull claimed (oldest first — FIFO execution).
    const { rows } = await query(
      `SELECT id, client_id, action, params, status, result,
              requested_by, created_at, updated_at, completed_at
         FROM remediation_requests
        WHERE claim_token = $1
        ORDER BY created_at ASC, id ASC`,
      [claimToken]
    )
    res.json({ requests: rows.map(toWire) })
  } catch (err) {
    console.error('[remediation] pull error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /requests/:id/result — machine (ihAuth): cli reports terminal status ─
// Body: { status: 'done'|'failed', result? }. Sets completed_at. Defensive: a bad
// body is 400, never 500; an unknown id is 404.
router.post('/requests/:id/result', ihAuth, async (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'body must be an object', code: 'BAD_BODY' })
  }
  const status = (typeof body.status === 'string') ? body.status.trim() : ''
  if (!TERMINAL_STATUS.has(status)) {
    return res.status(400).json({ error: "status must be 'done' or 'failed'", code: 'BAD_STATUS' })
  }
  // result is optional; if present it must be an object (cli's payload/error).
  let result = body.result
  if (result === undefined) result = null
  if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
    return res.status(400).json({ error: 'result must be an object', code: 'BAD_RESULT' })
  }

  try {
    const now = new Date().toISOString()
    // Enforce the lifecycle pending|claimed → done|failed server-side: a row must
    // exist and not already be terminal. (Don't add the status predicate to an
    // UPDATE…RETURNING — the SQLite shim reconstructs RETURNING by re-applying the
    // WHERE, which no longer matches post-update. Pre-check, then plain UPDATE, then
    // re-select — robust across both dialects.)
    const cur = await query(`SELECT status FROM remediation_requests WHERE id = $1`, [req.params.id])
    if (!cur.rows.length) return res.status(404).json({ error: 'request not found', code: 'NOT_FOUND' })
    const prev = cur.rows[0].status
    if (prev === 'done' || prev === 'failed') {
      return res.status(409).json({ error: 'request already finalized', code: 'ALREADY_TERMINAL', status: prev })
    }

    await query(
      `UPDATE remediation_requests
          SET status = $2, result = $3, updated_at = $4, completed_at = $4
        WHERE id = $1 AND status IN ('pending','claimed')`,
      [req.params.id, status, result == null ? null : JSON.stringify(result), now]
    )
    const back = await query(
      `SELECT id, client_id, action, params, status, result,
              requested_by, created_at, updated_at, completed_at
         FROM remediation_requests WHERE id = $1`,
      [req.params.id]
    )
    const row = back.rows[0]
    if (!row) return res.status(404).json({ error: 'request not found', code: 'NOT_FOUND' })
    res.json({ ok: true, request: toWire(row) })
  } catch (err) {
    console.error('[remediation] result error', err.message)
    res.status(400).json({ error: 'could not record result', code: 'RESULT_FAILED' })
  }
})

module.exports = { router, ALLOWED_ACTIONS }
