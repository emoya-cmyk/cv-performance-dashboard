'use strict'
const express = require('express')
const { query } = require('../db')
const { requireAgency } = require('../middleware/authz')
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

module.exports = router
