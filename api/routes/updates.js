const express = require('express')
const { query, weekStart } = require('../db')
const { requireAgency, scopeClientParam } = require('../middleware/authz')
const router = express.Router()

// GET /api/updates/:clientId — return last N weekly updates
// Query: ?weeks=8 (default 8)
router.get('/:clientId', scopeClientParam('clientId'), async (req, res) => {
  const { clientId } = req.params
  const weeks = Math.min(parseInt(req.query.weeks || '8', 10), 52)

  try {
    const { rows } = await query(
      `SELECT id, client_id, week_start, this_week, next_week, status, created_by, updated_at
         FROM client_updates
        WHERE client_id = $1
        ORDER BY week_start DESC
        LIMIT $2`,
      [clientId, weeks]
    )
    res.json(rows)
  } catch (err) {
    console.error('[updates] GET error', err.message)
    res.status(500).json({ error: 'Failed to load updates' })
  }
})

// PUT /api/updates/:clientId — upsert this week's update (agency only)
// Body: { week_start: 'YYYY-MM-DD', this_week, next_week, status }
router.put('/:clientId', requireAgency, async (req, res) => {
  const { clientId } = req.params
  const { this_week, next_week, status } = req.body

  // Default to current week's Monday
  const ws = req.body.week_start || weekStart()

  const validStatus = ['on_track', 'monitoring', 'adjusted']
  const safeStatus  = validStatus.includes(status) ? status : 'on_track'

  try {
    const { rows } = await query(
      `INSERT INTO client_updates (client_id, week_start, this_week, next_week, status, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (client_id, week_start) DO UPDATE
         SET this_week  = EXCLUDED.this_week,
             next_week  = EXCLUDED.next_week,
             status     = EXCLUDED.status,
             updated_at = now()
       RETURNING *`,
      [clientId, ws, this_week || null, next_week || null, safeStatus, req.user?.id || null]
    )
    res.json(rows[0])
  } catch (err) {
    console.error('[updates] PUT error', err.message)
    res.status(500).json({ error: 'Failed to save update' })
  }
})

module.exports = router
