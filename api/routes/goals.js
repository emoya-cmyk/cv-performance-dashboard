const express = require('express')
const { query } = require('../db')
const router = express.Router()

// GET /api/goals/:clientId — return goals for the current month (and optionally next)
// Query: ?month=2026-05  (defaults to current month)
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { month }    = req.query

  // Normalize to first-of-month DATE
  const targetMonth = month
    ? `${month}-01`
    : new Date().toISOString().slice(0, 7) + '-01'

  try {
    const { rows } = await query(
      `SELECT id, client_id, month, revenue_target, leads_target, jobs_target, updated_at
         FROM client_goals
        WHERE client_id = $1 AND month = $2`,
      [clientId, targetMonth]
    )
    res.json(rows[0] || null)
  } catch (err) {
    console.error('[goals] GET error', err.message)
    res.status(500).json({ error: 'Failed to load goal' })
  }
})

// PUT /api/goals/:clientId — upsert monthly goal (agency only)
// Body: { month: '2026-05' | '2026-05-01', revenue_target|revenue_goal, leads_target|leads_goal, jobs_target|jobs_goal }
router.put('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const body = req.body
  const month          = body.month
  const revenue_target = body.revenue_target ?? body.revenue_goal ?? null
  const leads_target   = body.leads_target   ?? body.leads_goal   ?? null
  const jobs_target    = body.jobs_target    ?? body.jobs_goal     ?? null

  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM or YYYY-MM-DD)' })

  // Normalize: accept both 'YYYY-MM' and 'YYYY-MM-DD' (take first 7 chars then append -01)
  const monthBase  = String(month).slice(0, 7)  // 'YYYY-MM'
  const targetMonth = `${monthBase}-01`

  try {
    await query(
      `INSERT INTO client_goals (client_id, month, revenue_target, leads_target, jobs_target, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (client_id, month) DO UPDATE
         SET revenue_target = EXCLUDED.revenue_target,
             leads_target   = EXCLUDED.leads_target,
             jobs_target    = EXCLUDED.jobs_target,
             updated_at     = CURRENT_TIMESTAMP`,
      [clientId, targetMonth, revenue_target || null, leads_target || null, jobs_target || null, req.user?.id || null]
    )
    // Re-fetch after upsert (avoids RETURNING quirks on SQLite)
    const { rows } = await query(
      `SELECT id, client_id, month, revenue_target, leads_target, jobs_target, updated_at
         FROM client_goals WHERE client_id = $1 AND month = $2`,
      [clientId, targetMonth]
    )
    res.json(rows[0] || { client_id: clientId, month: targetMonth, revenue_target, leads_target, jobs_target })
  } catch (err) {
    console.error('[goals] PUT error', err.message)
    res.status(500).json({ error: 'Failed to save goal' })
  }
})

module.exports = router
