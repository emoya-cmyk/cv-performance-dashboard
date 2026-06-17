// ============================================================
// routes/dashboards.js — Phase 3: saved / composable dashboards.
//
// A dashboard is a named bag of widgets; each widget is a SAVED semantic query
// spec ({ metrics, dateRange|range, groupBy, filters, compareTo }) + a viz type
// + title + layout. The specs are persisted (migration 034: dashboards.widgets
// JSONB on PG / TEXT on SQLite) but NEVER trusted at render time.
//
// LEAK-PROOF GUARANTEE — the load-bearing invariant of this whole feature:
// a widget spec is run through clampSpec() (below), which is a byte-for-byte
// copy of the multi-tenant clamp in routes/query.js — for a 'client' caller it
// pins spec.clients to the caller's own id AND strips any dim:'client' filter,
// so a forged cross-tenant `clients`/`dim:client` in a saved spec can never read
// another tenant's facts. We do NOT duplicate the compiler: POST /:id/run hands
// the clamped spec straight to semantic/compile.runQuerySpec, the same engine
// behind POST /api/query. (The FE may equivalently re-run each widget's spec via
// POST /api/query, which applies the identical clamp.)
//
// AUTHZ — mirrors the rest of the app (vendor/dashboard-core guards):
//   • agency-owned dashboards (client_id NULL) — agency-only to write; an agency
//     caller sees them all. A client never sees an agency dashboard.
//   • client-owned dashboards (client_id set) — the owning client OR agency may
//     read/write; a client is hard-pinned to its own id (a peer's → 403/hidden).
// Fail closed: anything ambiguous → 403.
// ============================================================

'use strict'

const express = require('express')
const { query } = require('../db')
const { runQuerySpec, QuerySpecError } = require('../semantic/compile')
const { scopeClientId } = require('../middleware/authz')

const router = express.Router()

// ── multi-tenant clamp — IDENTICAL to routes/query.js's clamp ────────────────
// For a 'client' caller, pin spec.clients to their own id and strip any
// dim:'client' filter so a saved spec can never re-open the tenant boundary.
// Agency is unconfined. Returns the (possibly mutated) spec.
function clampSpec(req, rawSpec) {
  const spec = { ...(rawSpec || {}) }
  if (req.user && req.user.role === 'client') {
    const cid = scopeClientId(req)
    if (!cid) return null // unscoped client → caller treats as forbidden
    spec.clients = [cid]
    if (Array.isArray(spec.filters)) {
      spec.filters = spec.filters.filter(f => !(f && f.dim === 'client'))
    }
  }
  return spec
}

// ── widget normalization ─────────────────────────────────────────────────────
// widgets arrive as JSON (PG → array; SQLite → TEXT). Parse defensively and keep
// only the shape we render. A widget = { id?, title, viz, spec, layout? }.
function parseWidgets(raw) {
  if (raw == null) return []
  let arr = raw
  if (typeof raw === 'string') { try { arr = JSON.parse(raw) } catch { return [] } }
  return Array.isArray(arr) ? arr : []
}

// Validate the widgets payload on write: must be an array; each widget needs a
// spec object carrying at least a non-empty metrics array. We do NOT fully
// validate the spec here (the compiler is the single source of truth at run
// time) — we only reject obviously malformed payloads so a save can't persist
// junk that every render would then 400 on.
function validateWidgets(widgets) {
  if (!Array.isArray(widgets)) throw new Error('widgets must be an array')
  return widgets.map((w, i) => {
    if (!w || typeof w !== 'object') throw new Error(`widget[${i}] must be an object`)
    const spec = w.spec
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`widget[${i}].spec must be an object`)
    if (!Array.isArray(spec.metrics) || spec.metrics.length === 0) throw new Error(`widget[${i}].spec.metrics must be a non-empty array`)
    return {
      id:     typeof w.id === 'string' ? w.id : `w${i + 1}`,
      title:  typeof w.title === 'string' ? w.title : '',
      viz:    typeof w.viz === 'string' ? w.viz : 'table',
      spec,
      ...(w.layout && typeof w.layout === 'object' ? { layout: w.layout } : {}),
    }
  })
}

// Serialize widgets for storage. PG accepts a JS array bound to a JSONB column
// only via JSON.stringify (node-pg won't auto-cast an array to jsonb), and the
// SQLite TEXT column stores the same string — so one path serves both.
function serializeWidgets(widgets) {
  return JSON.stringify(widgets)
}

// Shape a DB row into the API response (parse the widgets blob).
function rowToDashboard(row) {
  return {
    id:         row.id,
    client_id:  row.client_id ?? null,
    name:       row.name,
    widgets:    parseWidgets(row.widgets),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── scope helpers ─────────────────────────────────────────────────────────────
// A client may only ever touch dashboards whose client_id is its own. Returns
// the WHERE fragment + params for a scoped list, or { agency:true } for agency.
function isAgency(req) { return req.user && req.user.role === 'agency' }

// Can the caller read/write this dashboard row? agency → any; client → only its
// own client-scoped rows (never agency-owned, never a peer's).
function canAccess(req, row) {
  if (isAgency(req)) return true
  const cid = scopeClientId(req)
  return Boolean(cid) && row.client_id != null && String(row.client_id) === String(cid)
}

// ── LIST — GET /api/dashboards ───────────────────────────────────────────────
// agency: every dashboard. client: only its own client-scoped dashboards.
router.get('/', async (req, res) => {
  try {
    if (isAgency(req)) {
      const { rows } = await query(`SELECT * FROM dashboards ORDER BY updated_at DESC, id DESC`, [])
      return res.json({ dashboards: rows.map(rowToDashboard) })
    }
    const cid = scopeClientId(req)
    if (!cid) return res.json({ dashboards: [] }) // unscoped client sees nothing
    const { rows } = await query(
      `SELECT * FROM dashboards WHERE client_id = $1 ORDER BY updated_at DESC, id DESC`, [cid],
    )
    res.json({ dashboards: rows.map(rowToDashboard) })
  } catch (err) {
    console.error('[dashboards] list error', err.message)
    res.status(500).json({ error: 'Failed to load dashboards' })
  }
})

async function loadRow(id) {
  const { rows } = await query(`SELECT * FROM dashboards WHERE id = $1`, [id])
  return rows[0] || null
}

// ── GET one — GET /api/dashboards/:id ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' })
  try {
    const row = await loadRow(id)
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!canAccess(req, row)) return res.status(403).json({ error: 'Forbidden' })
    res.json({ dashboard: rowToDashboard(row) })
  } catch (err) {
    console.error('[dashboards] get error', err.message)
    res.status(500).json({ error: 'Failed to load dashboard' })
  }
})

// ── CREATE — POST /api/dashboards ────────────────────────────────────────────
// Body: { name, widgets?, client_id? }. An agency caller may create an
// agency-owned dashboard (client_id omitted/null) or a client-scoped one (any
// client_id). A client caller's dashboard is ALWAYS pinned to its own id — the
// body's client_id is ignored, so a client can never plant a dashboard on a peer.
router.post('/', async (req, res) => {
  try {
    const body = req.body || {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return res.status(400).json({ error: 'name is required' })

    let clientId
    if (isAgency(req)) {
      clientId = body.client_id != null ? String(body.client_id) : null
    } else {
      clientId = scopeClientId(req)
      if (!clientId) return res.status(403).json({ error: 'Forbidden' })
    }

    let widgets
    try { widgets = validateWidgets(body.widgets || []) }
    catch (e) { return res.status(400).json({ error: e.message }) }

    const createdBy = (req.user && (req.user.id || req.user.email)) || null
    const { rows } = await query(
      `INSERT INTO dashboards (client_id, name, widgets, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [clientId, name, serializeWidgets(widgets), createdBy],
    )
    res.status(201).json({ dashboard: rowToDashboard(rows[0]) })
  } catch (err) {
    console.error('[dashboards] create error', err.message)
    res.status(500).json({ error: 'Failed to create dashboard' })
  }
})

// ── UPDATE — PUT /api/dashboards/:id ─────────────────────────────────────────
// Rename and/or replace widgets. Scope is immutable (a client can never re-home
// a dashboard; an agency edit leaves client_id untouched).
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' })
  try {
    const row = await loadRow(id)
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!canAccess(req, row)) return res.status(403).json({ error: 'Forbidden' })

    const body = req.body || {}
    const name = body.name != null
      ? (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null)
      : row.name
    if (name == null) return res.status(400).json({ error: 'name must be a non-empty string' })

    let widgetsBlob = row.widgets
    if (body.widgets !== undefined) {
      let widgets
      try { widgets = validateWidgets(body.widgets) }
      catch (e) { return res.status(400).json({ error: e.message }) }
      widgetsBlob = serializeWidgets(widgets)
    }

    const { rows } = await query(
      `UPDATE dashboards
          SET name = $1, widgets = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 RETURNING *`,
      [name, widgetsBlob, id],
    )
    res.json({ dashboard: rowToDashboard(rows[0]) })
  } catch (err) {
    console.error('[dashboards] update error', err.message)
    res.status(500).json({ error: 'Failed to update dashboard' })
  }
})

// ── DELETE — DELETE /api/dashboards/:id ──────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' })
  try {
    const row = await loadRow(id)
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!canAccess(req, row)) return res.status(403).json({ error: 'Forbidden' })
    await query(`DELETE FROM dashboards WHERE id = $1`, [id])
    res.json({ deleted: true })
  } catch (err) {
    console.error('[dashboards] delete error', err.message)
    res.status(500).json({ error: 'Failed to delete dashboard' })
  }
})

// ── RUN — POST /api/dashboards/:id/run ───────────────────────────────────────
// Server-side render: compile + run every widget's saved spec through the SAME
// semantic engine + tenant clamp as POST /api/query, and return each widget's
// result. A per-widget failure is captured as { error } so one bad spec never
// sinks the whole dashboard.
router.post('/:id/run', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' })
  try {
    const row = await loadRow(id)
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!canAccess(req, row)) return res.status(403).json({ error: 'Forbidden' })

    const widgets = parseWidgets(row.widgets)
    const results = []
    for (const w of widgets) {
      const clamped = clampSpec(req, w.spec)
      if (clamped == null) { results.push({ id: w.id, error: 'Forbidden' }); continue }
      try {
        const out = await runQuerySpec(clamped, query)
        results.push({ id: w.id, title: w.title, viz: w.viz, result: out })
      } catch (err) {
        const msg = (err instanceof QuerySpecError || err.status === 400)
          ? err.message : 'query failed'
        results.push({ id: w.id, title: w.title, viz: w.viz, error: msg })
      }
    }
    res.json({ id, name: row.name, widgets: results })
  } catch (err) {
    console.error('[dashboards] run error', err.message)
    res.status(500).json({ error: 'Failed to run dashboard' })
  }
})

module.exports = router
