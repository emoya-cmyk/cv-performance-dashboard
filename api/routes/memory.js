'use strict'

// ── Memory OS — Phase 3: REST surface ─────────────────────────────────────────
//
// Scoped HTTP access to the agent memory layer (lib/memory.js). Mounted behind
// requireAuth in server.js. Authorization mirrors the rest of the app:
//   • writes / deletes / fleet reads  → agency-only (requireAgency)
//   • per-client reads                → scopeClientParam (agency, or the client
//                                       itself for its OWN id)
// The engine independently clamps every operation to the caller's scope, so even
// if a guard were bypassed a client could never reach another tenant's memory —
// defense in depth, the same belt-and-suspenders the rest of the API uses.

const express = require('express')
const { requireAgency, scopeClientParam } = require('../middleware/authz')
const memory = require('../lib/memory')

const router = express.Router()

// Translate the authenticated user into an engine scope.
function scopeOf(req) {
  return req.user && req.user.role === 'agency'
    ? { role: 'agency' }
    : { role: 'client', clientId: req.user && req.user.client_id }
}

function clampK(v) { return Math.min(Math.max(parseInt(v, 10) || 20, 1), 200) }

// GET /api/memory — fleet-wide recall (agency-only). Filters: ?clientId &kind &text &k
// (?clientId=null targets agency-wide memories.)
router.get('/', requireAgency, async (req, res) => {
  try {
    const q = {}
    if (req.query.clientId !== undefined) q.clientId = req.query.clientId === 'null' ? null : req.query.clientId
    if (req.query.kind) q.kind = req.query.kind
    if (req.query.text) q.text = req.query.text
    const memories = await memory.recall({ role: 'agency' }, q, { k: clampK(req.query.k) })
    res.json({ memories, count: memories.length })
  } catch (err) {
    console.error('[memory] GET error', err.message)
    res.status(500).json({ error: 'Failed to load memory' })
  }
})

// POST /api/memory — write a memory (agency / system producer).
// Body: { client_id?, kind, content, source, confidence?, ttlDays?, evidence_ref? }
router.post('/', requireAgency, async (req, res) => {
  try {
    const result = await memory.remember({ role: 'agency' }, req.body || {})
    res.status(201).json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET /api/memory/health — store governance verdict (agency-only). Registered
// before /:clientId so "health" is never read as a clientId.
router.get('/health', requireAgency, async (_req, res) => {
  try {
    const { gatherMemoryStats, assessMemory } = require('../lib/memoryHealth')
    const stats = await gatherMemoryStats({})
    res.json(assessMemory(stats))
  } catch (err) {
    console.error('[memory] GET health error', err.message)
    res.status(500).json({ error: 'Failed to assess memory health' })
  }
})

// GET /api/memory/:clientId — recall one client's memories (agency or own client).
router.get('/:clientId', scopeClientParam('clientId'), async (req, res) => {
  try {
    const q = { clientId: req.params.clientId }
    if (req.query.kind) q.kind = req.query.kind
    if (req.query.text) q.text = req.query.text
    const memories = await memory.recall(scopeOf(req), q, { k: clampK(req.query.k) })
    res.json({ memories, count: memories.length })
  } catch (err) {
    console.error('[memory] GET client error', err.message)
    res.status(500).json({ error: 'Failed to load memory' })
  }
})

// DELETE /api/memory/:id — forget a memory by id (agency-only).
router.delete('/:id', requireAgency, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' })
  try {
    const forgotten = await memory.forget({ role: 'agency' }, { id })
    res.json({ forgotten })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

module.exports = router
