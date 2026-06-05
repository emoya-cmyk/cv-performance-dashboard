const express   = require('express')
const { query } = require('../db')
const { requireAgency, scopeClientParam } = require('../middleware/authz')
const router    = express.Router()

// Resolve period → cutoff date string
function cutoff(weeks = 4) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - weeks * 7)
  return d.toISOString().slice(0, 10)
}

// ── GET /api/campaigns/:clientId?period=last_4w ───────────────────────────────
// Returns campaigns aggregated over the period, grouped by external_id
router.get('/:clientId', scopeClientParam('clientId'), async (req, res) => {
  const { clientId } = req.params
  const weeks = { this_week: 1, last_4w: 4, last_8w: 8 }[req.query.period] || 4
  try {
    const { rows } = await query(
      `SELECT
         g.external_id,
         g.name,
         g.channel,
         (SELECT status FROM campaigns s
          WHERE s.client_id = g.client_id AND s.external_id = g.external_id
          ORDER BY s.week_start DESC LIMIT 1) AS status,
         ROUND(CAST(SUM(g.spend) AS REAL), 2)   AS total_spend,
         SUM(g.impressions)                      AS total_impressions,
         SUM(g.clicks)                           AS total_clicks,
         SUM(g.leads)                            AS total_leads,
         ROUND(CAST(SUM(g.revenue) AS REAL), 2)  AS total_revenue,
         MAX(g.week_start)                       AS latest_week
       FROM campaigns g
       WHERE g.client_id = $1 AND g.week_start >= $2
       GROUP BY g.external_id, g.name, g.channel
       ORDER BY SUM(g.spend) DESC`,
      [clientId, cutoff(weeks)]
    )

    // Attach derived ROAS
    const result = rows.map(r => {
      const s = parseFloat(r.total_spend) || 0
      const v = parseFloat(r.total_revenue) || 0
      return { ...r, roas: s > 0 ? v / s : null }
    })
    res.json(result)
  } catch (err) {
    console.error('[campaigns] get', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/campaigns/:clientId ─────────────────────────────────────────────
// Upsert a campaign row for this week. external_id auto-assigned if omitted.
router.post('/:clientId', requireAgency, async (req, res) => {
  const { clientId } = req.params
  const {
    name, channel, status = 'active',
    spend = 0, impressions = 0, clicks = 0, leads = 0, revenue = 0,
    external_id,
  } = req.body

  if (!name || !channel) return res.status(400).json({ error: 'name and channel are required' })

  // For manually-entered campaigns, use a stable external_id based on name+channel
  const extId = external_id || `manual-${channel}-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`

  // Use Monday of current week as week_start
  const now = new Date()
  const day  = now.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day
  now.setUTCDate(now.getUTCDate() + diff)
  const weekStart = now.toISOString().slice(0, 10)

  try {
    const { rows } = await query(
      `INSERT INTO campaigns
         (client_id, external_id, channel, name, status, week_start,
          spend, impressions, clicks, leads, revenue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (client_id, external_id, week_start)
       DO UPDATE SET
         name        = EXCLUDED.name,
         channel     = EXCLUDED.channel,
         status      = EXCLUDED.status,
         spend       = EXCLUDED.spend,
         impressions = EXCLUDED.impressions,
         clicks      = EXCLUDED.clicks,
         leads       = EXCLUDED.leads,
         revenue     = EXCLUDED.revenue
       RETURNING *`,
      [clientId, extId, channel, name, status, weekStart,
       spend, impressions, clicks, leads, revenue]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error('[campaigns] post', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── PUT /api/campaigns/:clientId/:externalId ──────────────────────────────────
router.put('/:clientId/:externalId', requireAgency, async (req, res) => {
  const { clientId, externalId } = req.params
  const { name, status, spend, leads, revenue, clicks, impressions } = req.body
  try {
    const { rows } = await query(
      `UPDATE campaigns SET
         name = COALESCE($3, name),
         status = COALESCE($4, status),
         spend  = COALESCE($5, spend),
         leads  = COALESCE($6, leads),
         revenue = COALESCE($7, revenue),
         clicks = COALESCE($8, clicks),
         impressions = COALESCE($9, impressions)
       WHERE client_id = $1 AND external_id = $2
       RETURNING *`,
      [clientId, externalId, name, status, spend, leads, revenue, clicks, impressions]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /api/campaigns/:clientId/:externalId ───────────────────────────────
// Soft-delete: set status = 'ended' on all weeks for this campaign
router.delete('/:clientId/:externalId', requireAgency, async (req, res) => {
  const { clientId, externalId } = req.params
  try {
    await query(
      `UPDATE campaigns SET status = 'ended'
       WHERE client_id = $1 AND external_id = $2`,
      [clientId, externalId]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
