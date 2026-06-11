'use strict'
const express = require('express')
const { query } = require('../db')
const { requireAgency, scopeClientParam } = require('../middleware/authz')
const router = express.Router()

// GET /api/alerts — last 90 days of fired alerts, agency-only
router.get('/', requireAgency, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500)
  try {
    const { rows } = await query(
      `SELECT id, fired_at, severity, title, body, client_id, client_name, metric, value, channel
         FROM fired_alerts
        ORDER BY fired_at DESC
        LIMIT $1`,
      [limit]
    )
    res.json({ alerts: rows, count: rows.length })
  } catch (err) {
    console.error('[alerts] GET error', err.message)
    res.status(500).json({ error: 'Failed to load alert log' })
  }
})

// GET /api/alerts/rules — fleet-wide thresholds for all clients (agency-only, no-param form must come first)
router.get('/rules', requireAgency, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT client_id, revenue_drop_warn, revenue_drop_crit, leads_drop_warn, leads_drop_crit
         FROM client_alert_rules`
    )
    const rules = {}
    rows.forEach(r => { rules[r.client_id] = r })
    res.json({ rules })
  } catch (err) {
    console.error('[alerts] GET all rules error', err.message)
    res.status(500).json({ error: 'Failed to load rules' })
  }
})

// GET /api/alerts/rules/:clientId — per-client thresholds (agency-only)
router.get('/rules/:clientId', requireAgency, async (req, res) => {
  const { clientId } = req.params
  try {
    const { rows } = await query(
      `SELECT revenue_drop_warn, revenue_drop_crit, leads_drop_warn, leads_drop_crit
         FROM client_alert_rules WHERE client_id = $1`,
      [clientId]
    )
    if (!rows.length) {
      return res.json({ revenue_drop_warn: 0.20, revenue_drop_crit: 0.40, leads_drop_warn: 0.20, leads_drop_crit: 0.40 })
    }
    res.json(rows[0])
  } catch (err) {
    console.error('[alerts] GET rules error', err.message)
    res.status(500).json({ error: 'Failed to load alert rules' })
  }
})

// PUT /api/alerts/rules/:clientId — upsert per-client thresholds (agency-only)
router.put('/rules/:clientId', requireAgency, async (req, res) => {
  const { clientId } = req.params
  const clamp = (v, def) => { const n = parseFloat(v); return isNaN(n) ? def : Math.max(0.01, Math.min(0.99, n)) }
  const rdw = clamp(req.body.revenue_drop_warn, 0.20)
  const rdc = clamp(req.body.revenue_drop_crit, 0.40)
  const ldw = clamp(req.body.leads_drop_warn,   0.20)
  const ldc = clamp(req.body.leads_drop_crit,   0.40)
  try {
    await query(
      `INSERT INTO client_alert_rules (client_id, revenue_drop_warn, revenue_drop_crit, leads_drop_warn, leads_drop_crit)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET
         revenue_drop_warn = EXCLUDED.revenue_drop_warn,
         revenue_drop_crit = EXCLUDED.revenue_drop_crit,
         leads_drop_warn   = EXCLUDED.leads_drop_warn,
         leads_drop_crit   = EXCLUDED.leads_drop_crit,
         updated_at        = CURRENT_TIMESTAMP`,
      [clientId, rdw, rdc, ldw, ldc]
    )
    res.json({ client_id: clientId, revenue_drop_warn: rdw, revenue_drop_crit: rdc, leads_drop_warn: ldw, leads_drop_crit: ldc })
  } catch (err) {
    console.error('[alerts] PUT rules error', err.message)
    res.status(500).json({ error: 'Failed to save alert rules' })
  }
})

// GET /api/alerts/client/:clientId — last 10 fired alerts for one client (agency sees any; client sees own)
router.get('/client/:clientId', scopeClientParam('clientId'), async (req, res) => {
  const { clientId } = req.params
  try {
    const { rows } = await query(
      `SELECT id, fired_at, severity, title, body, metric, value
         FROM fired_alerts
        WHERE client_id = $1
        ORDER BY fired_at DESC
        LIMIT 10`,
      [clientId]
    )
    res.json({ alerts: rows })
  } catch (err) {
    console.error('[alerts] GET client alerts error', err.message)
    res.status(500).json({ error: 'Failed to load alerts' })
  }
})

module.exports = router
