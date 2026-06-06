'use strict'

// ============================================================
// routes/seo.js — SEMrush organic search HTTP surface.
//
//   GET  /api/seo/:clientId
//        Latest SEMrush snapshot + 12-week history (traffic trend).
//        Returns { connected, domain, latest, history, armed }.
//        `armed` = SEMRUSH_API_KEY is set.  `connected` = at least
//        one snapshot exists.  Safe for both agency and client roles.
//
//   GET  /api/seo/:clientId/keywords
//        Full keyword list from the latest snapshot (top 20).
//
//   PUT  /api/seo/:clientId/domain
//        Set or update the website_domain for this client. Agency-only.
//        Body: { domain: "example.com" }
//
//   POST /api/seo/:clientId/sync
//        Trigger an on-demand SEMrush fetch for this client. Agency-only.
//        Returns the sync result. No-ops if key is missing.
// ============================================================

const express = require('express')
const { query } = require('../db')
const { syncClientSEO, getKey } = require('../lib/semrush')
const { requireAgency, scopeClientParam } = require('../middleware/authz')

const router = express.Router()

// Helper: parse JSONB / SQLite TEXT field to array
function parseJSON(v) {
  if (!v) return []
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return [] }
  }
  return Array.isArray(v) ? v : []
}

// ── GET /api/seo/:clientId ────────────────────────────────────────────────────
router.get('/:clientId', scopeClientParam('clientId'), async (req, res) => {
  const { clientId } = req.params
  try {
    // Client domain config
    const { rows: cRows } = await query(
      'SELECT website_domain FROM clients WHERE id = $1',
      [clientId]
    )
    const domain = cRows[0]?.website_domain || null

    // Latest snapshot
    const { rows: snap } = await query(
      `SELECT * FROM semrush_snapshots
       WHERE client_id = $1
       ORDER BY snapshot_date DESC LIMIT 1`,
      [clientId]
    )
    const latest = snap[0] || null

    // 12-week history for traffic trend
    const { rows: hist } = await query(
      `SELECT snapshot_date, organic_traffic, organic_keywords, traffic_value, domain_rank
       FROM semrush_snapshots
       WHERE client_id = $1
       ORDER BY snapshot_date ASC`,
      [clientId]
    )

    const history = hist.map(r => ({
      date:             r.snapshot_date instanceof Date
                          ? r.snapshot_date.toISOString().split('T')[0]
                          : String(r.snapshot_date).slice(0, 10),
      organic_traffic:  parseInt(r.organic_traffic)  || 0,
      organic_keywords: parseInt(r.organic_keywords) || 0,
      traffic_value:    parseFloat(r.traffic_value)  || 0,
      domain_rank:      parseInt(r.domain_rank)      || 0,
    }))

    res.json({
      armed:     Boolean(getKey()),
      connected: Boolean(latest),
      domain,
      latest: latest ? {
        domain:           latest.domain,
        snapshot_date:    latest.snapshot_date instanceof Date
                            ? latest.snapshot_date.toISOString().split('T')[0]
                            : String(latest.snapshot_date).slice(0, 10),
        organic_keywords: parseInt(latest.organic_keywords)  || 0,
        organic_traffic:  parseInt(latest.organic_traffic)   || 0,
        traffic_value:    parseFloat(latest.traffic_value)   || 0,
        domain_rank:      parseInt(latest.domain_rank)       || 0,
        top_keywords:     parseJSON(latest.top_keywords).slice(0, 20),
        competitors:      parseJSON(latest.competitors).slice(0, 8),
      } : null,
      history,
    })
  } catch (err) {
    console.error('[seo] GET error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/seo/:clientId/keywords ──────────────────────────────────────────
router.get('/:clientId/keywords', scopeClientParam('clientId'), async (req, res) => {
  const { clientId } = req.params
  try {
    const { rows } = await query(
      `SELECT top_keywords FROM semrush_snapshots
       WHERE client_id = $1
       ORDER BY snapshot_date DESC LIMIT 1`,
      [clientId]
    )
    res.json(parseJSON(rows[0]?.top_keywords))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── PUT /api/seo/:clientId/domain ─────────────────────────────────────────────
// Agency-only: set the website domain for a client
router.put('/:clientId/domain', requireAgency, async (req, res) => {
  const { clientId } = req.params
  const { domain }   = req.body || {}
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'domain is required' })
  }
  // Normalise: strip protocol and trailing slash
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim()
  if (!clean) return res.status(400).json({ error: 'invalid domain' })

  try {
    await query(
      'UPDATE clients SET website_domain = $1 WHERE id = $2',
      [clean, clientId]
    )
    res.json({ ok: true, domain: clean })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/seo/:clientId/sync ─────────────────────────────────────────────
// Agency-only: on-demand SEMrush fetch for this client
router.post('/:clientId/sync', requireAgency, async (req, res) => {
  const { clientId } = req.params
  try {
    const result = await syncClientSEO(clientId)
    if (!result) {
      return res.status(202).json({
        ok:     false,
        reason: !getKey()
          ? 'SEMRUSH_API_KEY not set'
          : 'no website_domain configured for this client',
      })
    }
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[seo] sync error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
