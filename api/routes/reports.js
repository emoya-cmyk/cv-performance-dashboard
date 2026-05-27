'use strict'

const express = require('express')
const { query } = require('../db')
const router = express.Router()

// GET /api/reports/:clientId — return weekly reports for a client
// Query: ?weeks=12 (default 12), ?from=YYYY-MM-DD, ?to=YYYY-MM-DD
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const weeks = parseInt(req.query.weeks) || 12

  try {
    const { rows } = await query(
      `SELECT * FROM weekly_reports
        WHERE client_id = $1
        ORDER BY week_start DESC
        LIMIT $2`,
      [clientId, weeks]
    )
    res.json(rows)
  } catch (err) {
    console.error('[reports] GET error', err.message)
    res.status(500).json({ error: 'Failed to load reports' })
  }
})

// GET /api/reports/:clientId/latest — return the most recent weekly report
router.get('/:clientId/latest', async (req, res) => {
  const { clientId } = req.params
  try {
    const { rows } = await query(
      `SELECT * FROM weekly_reports
        WHERE client_id = $1
        ORDER BY week_start DESC
        LIMIT 1`,
      [clientId]
    )
    res.json(rows[0] || null)
  } catch (err) {
    console.error('[reports] GET latest error', err.message)
    res.status(500).json({ error: 'Failed to load report' })
  }
})

// POST /api/reports/:clientId — upsert a weekly report
// Body: { week_start, ads_spend, ads_clicks, ... }
router.post('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const b = req.body

  if (!b.week_start) return res.status(400).json({ error: 'week_start required' })

  try {
    const { rows } = await query(
      `INSERT INTO weekly_reports (
          client_id, week_start,
          ads_spend, ads_impressions, ads_clicks, ads_leads, ads_roas,
          lsa_spend, lsa_impressions, lsa_calls, lsa_booked_jobs,
          meta_spend, meta_impressions, meta_clicks, meta_leads, meta_roas,
          gbp_views, gbp_searches, gbp_calls, gbp_directions, gbp_website_clicks,
          ga4_sessions, ga4_new_users, ga4_organic_sessions, ga4_paid_sessions,
          ga4_direct_sessions, ga4_conversions, ga4_engagement_rate,
          raw_leads, mql, sql_count, closed_won, projected_revenue, avg_ticket
        ) VALUES (
          $1, $2,
          $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
          $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
        )
        ON CONFLICT (client_id, week_start) DO UPDATE SET
          ads_spend = EXCLUDED.ads_spend,
          ads_impressions = EXCLUDED.ads_impressions,
          ads_clicks = EXCLUDED.ads_clicks,
          ads_leads = EXCLUDED.ads_leads,
          ads_roas = EXCLUDED.ads_roas,
          lsa_spend = EXCLUDED.lsa_spend,
          lsa_impressions = EXCLUDED.lsa_impressions,
          lsa_calls = EXCLUDED.lsa_calls,
          lsa_booked_jobs = EXCLUDED.lsa_booked_jobs,
          meta_spend = EXCLUDED.meta_spend,
          meta_impressions = EXCLUDED.meta_impressions,
          meta_clicks = EXCLUDED.meta_clicks,
          meta_leads = EXCLUDED.meta_leads,
          meta_roas = EXCLUDED.meta_roas,
          gbp_views = EXCLUDED.gbp_views,
          gbp_searches = EXCLUDED.gbp_searches,
          gbp_calls = EXCLUDED.gbp_calls,
          gbp_directions = EXCLUDED.gbp_directions,
          gbp_website_clicks = EXCLUDED.gbp_website_clicks,
          ga4_sessions = EXCLUDED.ga4_sessions,
          ga4_new_users = EXCLUDED.ga4_new_users,
          ga4_organic_sessions = EXCLUDED.ga4_organic_sessions,
          ga4_paid_sessions = EXCLUDED.ga4_paid_sessions,
          ga4_direct_sessions = EXCLUDED.ga4_direct_sessions,
          ga4_conversions = EXCLUDED.ga4_conversions,
          ga4_engagement_rate = EXCLUDED.ga4_engagement_rate,
          raw_leads = EXCLUDED.raw_leads,
          mql = EXCLUDED.mql,
          sql_count = EXCLUDED.sql_count,
          closed_won = EXCLUDED.closed_won,
          projected_revenue = EXCLUDED.projected_revenue,
          avg_ticket = EXCLUDED.avg_ticket,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
      [
        clientId, b.week_start,
        b.ads_spend||null, b.ads_impressions||null, b.ads_clicks||null, b.ads_leads||null, b.ads_roas||null,
        b.lsa_spend||null, b.lsa_impressions||null, b.lsa_calls||null, b.lsa_booked_jobs||null,
        b.meta_spend||null, b.meta_impressions||null, b.meta_clicks||null, b.meta_leads||null, b.meta_roas||null,
        b.gbp_views||null, b.gbp_searches||null, b.gbp_calls||null, b.gbp_directions||null, b.gbp_website_clicks||null,
        b.ga4_sessions||null, b.ga4_new_users||null, b.ga4_organic_sessions||null, b.ga4_paid_sessions||null,
        b.ga4_direct_sessions||null, b.ga4_conversions||null, b.ga4_engagement_rate||null,
        b.raw_leads||null, b.mql||null, b.sql_count||null, b.closed_won||null,
        b.projected_revenue||null, b.avg_ticket||null,
      ]
    )
    res.json(rows[0])
  } catch (err) {
    console.error('[reports] POST error', err.message)
    res.status(500).json({ error: 'Failed to save report' })
  }
})

module.exports = router
