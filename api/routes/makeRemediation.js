'use strict'

// ── Make.com Remediation — operator surface ───────────────────────────────────
//
// Authenticated, agency-only REST for the humans in the loop. Mounted behind
// requireAuth in server.js; every route additionally requires the agency role.
//   • Operator fix queue (FR-4): list + resolve dead-lettered payloads
//   • Circuit breaker (FR-5):    list state + manual override to clear a trip
//   • Stats:                     success-metric rollup (tier mix, auto-resolution)

const express = require('express')
const { requireAgency } = require('../middleware/authz')
const { query } = require('../db')
const { getCorrectnessStats } = require('../lib/writeVerificationStore')

const router = express.Router()

const asBool = v => v === 1 || v === true

// GET /api/make-remediation/dead-letter?status=open — operator fix queue (FR-4).
router.get('/dead-letter', requireAgency, async (req, res) => {
  try {
    const status = req.query.status === 'resolved' ? 'resolved'
      : req.query.status === 'all' ? null : 'open'
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
    const rows = status
      ? (await query(
          `SELECT * FROM make_dead_letter WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
          [status, limit])).rows
      : (await query(
          `SELECT * FROM make_dead_letter ORDER BY created_at DESC LIMIT $1`, [limit])).rows
    res.json({ items: rows, count: rows.length })
  } catch (err) {
    console.error('[make-remediation] dead-letter list error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/make-remediation/dead-letter/:id/resolve — mark an item resolved.
router.post('/dead-letter/:id/resolve', requireAgency, async (req, res) => {
  try {
    const { rowCount } = await query(
      `UPDATE make_dead_letter
         SET status = 'resolved', resolved_at = $2, resolved_by = $3
       WHERE id = $1 AND status = 'open'`,
      [req.params.id, new Date().toISOString(), req.user?.email || 'operator']
    )
    if (!rowCount) return res.status(404).json({ error: 'not found or already resolved' })
    res.json({ ok: true, id: req.params.id })
  } catch (err) {
    console.error('[make-remediation] dead-letter resolve error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/make-remediation/circuit-breakers — current breaker state per pair.
router.get('/circuit-breakers', requireAgency, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM make_circuit_breaker ORDER BY tripped DESC, updated_at DESC`
    )
    res.json({ breakers: rows.map(r => ({ ...r, tripped: asBool(r.tripped) })) })
  } catch (err) {
    console.error('[make-remediation] breaker list error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/make-remediation/circuit-breakers/clear — manual override (FR-5).
// Body: { tenant_id, vendor }. Resets the breaker and its failure counter.
router.post('/circuit-breakers/clear', requireAgency, async (req, res) => {
  const { tenant_id, vendor } = req.body || {}
  if (!tenant_id || !vendor) {
    return res.status(400).json({ error: 'tenant_id and vendor required' })
  }
  try {
    const { rowCount } = await query(
      `UPDATE make_circuit_breaker
         SET tripped = 0, consecutive_failures = 0,
             cleared_at = $3, cleared_by = $4, updated_at = $3
       WHERE tenant_id = $1 AND vendor = $2`,
      [tenant_id, vendor, new Date().toISOString(), req.user?.email || 'operator']
    )
    if (!rowCount) return res.status(404).json({ error: 'no breaker for that tenant+vendor' })
    res.json({ ok: true, tenant_id, vendor, cleared: true })
  } catch (err) {
    console.error('[make-remediation] breaker clear error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/make-remediation/stats — success-metric rollup over a window.
router.get('/stats', requireAgency, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90)
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { rows } = await query(
      `SELECT failure_tier, remediation_outcome,
              SUM(CASE WHEN auto_resolved = 1 THEN 1 ELSE 0 END) AS auto,
              COUNT(*) AS n
         FROM make_remediation_log
        WHERE created_at >= $1
        GROUP BY failure_tier, remediation_outcome`,
      [since]
    )
    const total = rows.reduce((s, r) => s + Number(r.n), 0)
    const auto  = rows.reduce((s, r) => s + Number(r.auto), 0)
    const byTier = {}
    for (const r of rows) byTier[r.failure_tier] = (byTier[r.failure_tier] || 0) + Number(r.n)
    const openDL = Number((await query(
      `SELECT COUNT(*) AS c FROM make_dead_letter WHERE status = 'open'`)).rows[0]?.c || 0)

    res.json({
      window_days: days,
      total_events: total,
      auto_resolution_rate: total ? Number((auto / total).toFixed(3)) : 0,
      by_tier: byTier,
      open_dead_letter: openDL,
    })
  } catch (err) {
    console.error('[make-remediation] stats error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/make-remediation/recurring-unknowns — Phase 3 pattern analysis.
// Groups Tier 3 (unknown) events by error signature over a window and surfaces
// the recurring ones as candidates for promotion to a deterministic Tier 1 rule.
// Promotion stays a human decision (safe by design) — this is the evidence for it.
router.get('/recurring-unknowns', requireAgency, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
    const min  = Math.max(parseInt(req.query.min, 10) || 2, 2)
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { rows } = await query(
      `SELECT vendor, error_message, COUNT(*) AS occurrences,
              COUNT(DISTINCT tenant_id) AS tenants, MAX(created_at) AS last_seen
         FROM make_remediation_log
        WHERE failure_tier = 3 AND created_at >= $1
        GROUP BY vendor, error_message
        HAVING COUNT(*) >= $2
        ORDER BY occurrences DESC`,
      [since, min]
    )
    res.json({ window_days: days, min_occurrences: min, candidates: rows, count: rows.length })
  } catch (err) {
    console.error('[make-remediation] recurring-unknowns error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/make-remediation/correctness?tenant_id=… — write-verification
// correctness per (tenant, endpoint): the persistence-vs-correctness ledger
// (Spec A). `verified_rate` and `wilson_lower` are surfaced for operators but are
// NOT yet used to gate promotion — correctness samples must accumulate first.
router.get('/correctness', requireAgency, async (req, res) => {
  try {
    const tenantId = req.query.tenant_id ? String(req.query.tenant_id) : null
    const endpoints = await getCorrectnessStats({ query, tenantId })
    res.json({ scope: tenantId || 'all', endpoints, count: endpoints.length })
  } catch (err) {
    console.error('[make-remediation] correctness error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
