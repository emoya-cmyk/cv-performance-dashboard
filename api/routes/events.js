const express = require('express')
const { query } = require('../db')
const { requireAgency, scopeClientParam } = require('../middleware/authz')
const router = express.Router()

// GET /api/events/:clientId?limit=N
router.get('/:clientId', scopeClientParam('clientId'), async (req, res) => {
  const { clientId } = req.params
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
  try {
    const { rows } = await query(
      `SELECT id, client_id, event_date, label, note, created_at
         FROM campaign_events
        WHERE client_id = $1
        ORDER BY event_date DESC, created_at DESC
        LIMIT $2`,
      [clientId, limit]
    )
    res.json(rows)
  } catch (err) {
    console.error('[events] GET error', err.message)
    res.status(500).json({ error: 'Failed to load events' })
  }
})

// POST /api/events/:clientId — agency only
router.post('/:clientId', requireAgency, async (req, res) => {
  const { clientId } = req.params
  const { event_date, label, note } = req.body
  if (!event_date || !label) {
    return res.status(400).json({ error: 'event_date and label are required' })
  }
  try {
    const { rows } = await query(
      `INSERT INTO campaign_events (client_id, event_date, label, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, client_id, event_date, label, note, created_at`,
      [clientId, event_date, label.trim(), note?.trim() || null, req.user?.id || null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    console.error('[events] POST error', err.message)
    res.status(500).json({ error: 'Failed to create event' })
  }
})

// DELETE /api/events/:clientId/:id — agency only
router.delete('/:clientId/:id', requireAgency, async (req, res) => {
  const { clientId, id } = req.params
  try {
    await query(
      `DELETE FROM campaign_events WHERE id = $1 AND client_id = $2`,
      [id, clientId]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('[events] DELETE error', err.message)
    res.status(500).json({ error: 'Failed to delete event' })
  }
})

module.exports = router
