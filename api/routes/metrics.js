'use strict'

const express   = require('express')
const { query } = require('../db')
const router    = express.Router()

// ── helpers ───────────────────────────────────────────────────────────────────
function periodCutoff(weeks) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - weeks * 7)
  return d.toISOString().split('T')[0]
}

function prevRange(weeks) {
  const now   = new Date()
  const end   = new Date(now); end.setUTCDate(end.getUTCDate() - weeks * 7)
  const start = new Date(now); start.setUTCDate(start.getUTCDate() - weeks * 14)
  return {
    start: start.toISOString().split('T')[0],
    end:   end.toISOString().split('T')[0],
  }
}

const AGG = `
  COALESCE(SUM(ads_spend),0)                     AS ads_spend,
  COALESCE(SUM(ads_clicks),0)                    AS ads_clicks,
  COALESCE(SUM(ads_impressions),0)               AS ads_impressions,
  COALESCE(SUM(lsa_spend),0)                     AS lsa_spend,
  COALESCE(SUM(lsa_impressions),0)               AS lsa_impressions,
  COALESCE(SUM(meta_spend),0)                    AS meta_spend,
  COALESCE(SUM(meta_clicks),0)                   AS meta_clicks,
  COALESCE(SUM(meta_impressions),0)              AS meta_impressions,
  COALESCE(SUM(raw_leads),0)                     AS raw_leads,
  COALESCE(SUM(mql),0)                           AS mql,
  COALESCE(SUM(sql_count),0)                     AS sql_count,
  COALESCE(SUM(closed_won),0)                    AS closed_won,
  COALESCE(SUM(projected_revenue),0)             AS projected_revenue,
  COALESCE(AVG(NULLIF(ads_roas,0)),0)            AS ads_roas,
  COALESCE(AVG(NULLIF(meta_roas,0)),0)           AS meta_roas,
  COALESCE(SUM(ads_leads),0)                     AS ads_leads,
  COALESCE(SUM(lsa_calls),0)                     AS lsa_calls,
  COALESCE(SUM(lsa_booked_jobs),0)               AS lsa_booked_jobs,
  COALESCE(SUM(meta_leads),0)                    AS meta_leads,
  COALESCE(SUM(gbp_views),0)                     AS gbp_views,
  COALESCE(SUM(gbp_calls),0)                     AS gbp_calls,
  COALESCE(SUM(gbp_searches),0)                  AS gbp_searches,
  COALESCE(SUM(gbp_directions),0)                AS gbp_directions,
  COALESCE(SUM(gbp_website_clicks),0)            AS gbp_website_clicks,
  COALESCE(SUM(ga4_sessions),0)                  AS ga4_sessions,
  COALESCE(SUM(ga4_new_users),0)                 AS ga4_new_users,
  COALESCE(SUM(ga4_organic_sessions),0)          AS ga4_organic_sessions,
  COALESCE(SUM(ga4_paid_sessions),0)             AS ga4_paid_sessions,
  COALESCE(SUM(ga4_direct_sessions),0)           AS ga4_direct_sessions,
  COALESCE(SUM(ga4_conversions),0)               AS ga4_conversions,
  COALESCE(AVG(NULLIF(ga4_engagement_rate,0)),0) AS ga4_engagement_rate,
  COALESCE(AVG(avg_ticket),0)                    AS avg_ticket,
  COUNT(*)                                       AS weeks_count
`

function derive(row) {
  const r = {}
  Object.entries(row || {}).forEach(([k, v]) => { r[k] = parseFloat(v) || 0 })
  r.total_spend   = r.ads_spend + r.lsa_spend + r.meta_spend
  r.total_leads   = r.raw_leads
  r.total_closed  = r.closed_won
  r.total_revenue = r.projected_revenue
  r.roas = r.total_spend > 0 ? r.total_revenue / r.total_spend : 0
  r.close_rate = r.total_leads > 0 ? (r.total_closed / r.total_leads) * 100 : 0
  r.cpl = r.total_leads > 0 ? r.total_spend / r.total_leads : 0
  return r
}

// ── GET /api/metrics/:clientId ────────────────────────────────────────────────
// Query: ?period=this_week|last_4w|last_8w|last_12w  (default: last_4w)
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const weekMap = { this_week: 1, last_4w: 4, last_8w: 8, last_12w: 12 }
  const weeks   = weekMap[req.query.period] || 4
  const cutoff  = periodCutoff(weeks)
  const prev    = prevRange(weeks)

  try {
    const [currR, prevR, trendR, goalsR] = await Promise.all([
      query(
        `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`,
        [clientId, cutoff]
      ),
      query(
        `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2 AND week_start < $3`,
        [clientId, prev.start, prev.end]
      ),
      query(
        `SELECT
           week_start                                                   AS week,
           COALESCE(SUM(projected_revenue),0)                          AS revenue,
           COALESCE(SUM(raw_leads),0)                                  AS leads,
           COALESCE(SUM(closed_won),0)                                 AS jobs,
           COALESCE(SUM(ads_spend)+SUM(lsa_spend)+SUM(meta_spend),0)  AS spend,
           COALESCE(SUM(ga4_sessions),0)                               AS ga4_sessions,
           COALESCE(SUM(ga4_new_users),0)                              AS ga4_new_users,
           COALESCE(SUM(ga4_organic_sessions),0)                       AS ga4_organic_sessions,
           COALESCE(SUM(ga4_paid_sessions),0)                          AS ga4_paid_sessions,
           COALESCE(SUM(ga4_direct_sessions),0)                        AS ga4_direct_sessions,
           COALESCE(SUM(ga4_conversions),0)                            AS ga4_conversions,
           COALESCE(AVG(NULLIF(ga4_engagement_rate,0)),0)              AS ga4_engagement_rate,
           COALESCE(SUM(gbp_calls),0)                                  AS gbp_calls,
           COALESCE(SUM(gbp_directions),0)                             AS gbp_directions,
           COALESCE(SUM(gbp_website_clicks),0)                         AS gbp_website
         FROM weekly_reports
         WHERE client_id = $1 AND week_start >= $2
         GROUP BY week_start
         ORDER BY week_start`,
        [clientId, periodCutoff(12)]
      ),
      query(
        `SELECT revenue_target, leads_target, jobs_target, month
         FROM client_goals
         WHERE client_id = $1
         ORDER BY month DESC
         LIMIT 1`,
        [clientId]
      ),
    ])

    const stats     = derive(currR.rows[0])
    const prevStats = derive(prevR.rows[0])

    const revDelta = prevStats.total_revenue > 0
      ? ((stats.total_revenue - prevStats.total_revenue) / prevStats.total_revenue) * 100
      : null
    const leadsDelta = prevStats.total_leads > 0
      ? ((stats.total_leads - prevStats.total_leads) / prevStats.total_leads) * 100
      : null

    const trend = trendR.rows.map(r => ({
      week:    r.week,
      revenue: parseFloat(r.revenue) || 0,
      leads:   parseFloat(r.leads)   || 0,
      jobs:    parseFloat(r.jobs)    || 0,
      spend:   parseFloat(r.spend)   || 0,
      // GA4 per-week breakdown
      ga4_sessions:         parseFloat(r.ga4_sessions)         || 0,
      ga4_new_users:        parseFloat(r.ga4_new_users)        || 0,
      ga4_organic_sessions: parseFloat(r.ga4_organic_sessions) || 0,
      ga4_paid_sessions:    parseFloat(r.ga4_paid_sessions)    || 0,
      ga4_direct_sessions:  parseFloat(r.ga4_direct_sessions)  || 0,
      ga4_conversions:      parseFloat(r.ga4_conversions)      || 0,
      ga4_engagement_rate:  parseFloat(r.ga4_engagement_rate)  || 0,
      // GBP per-week breakdown
      gbp_calls:      parseFloat(r.gbp_calls)      || 0,
      gbp_directions: parseFloat(r.gbp_directions) || 0,
      gbp_website:    parseFloat(r.gbp_website)    || 0,
    }))

    res.json({
      stats,
      prevStats,
      revDelta,
      leadsDelta,
      trend,
      goal: goalsR.rows[0] || null,
    })
  } catch (err) {
    console.error('[metrics] GET error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/metrics/:clientId/weekly?weeks=8 ────────────────────────────────
// Per-week channel data for sparklines — one row per week, ordered ascending
router.get('/:clientId/weekly', async (req, res) => {
  const { clientId } = req.params
  const weeks  = Math.min(parseInt(req.query.weeks) || 8, 52)
  const cutoff = periodCutoff(weeks)
  try {
    const { rows } = await query(
      `SELECT week_start,
              COALESCE(ads_spend,          0) AS ads_spend,
              COALESCE(ads_leads,          0) AS ads_leads,
              COALESCE(ads_roas,           0) AS ads_roas,
              COALESCE(ads_clicks,         0) AS ads_clicks,
              COALESCE(meta_spend,         0) AS meta_spend,
              COALESCE(meta_leads,         0) AS meta_leads,
              COALESCE(meta_roas,          0) AS meta_roas,
              COALESCE(meta_clicks,        0) AS meta_clicks,
              COALESCE(lsa_spend,          0) AS lsa_spend,
              COALESCE(lsa_calls,          0) AS lsa_calls,
              COALESCE(gbp_calls,          0) AS gbp_calls,
              COALESCE(raw_leads,          0) AS raw_leads,
              COALESCE(closed_won,         0) AS closed_won,
              COALESCE(projected_revenue,  0) AS projected_revenue
       FROM weekly_reports
       WHERE client_id = $1 AND week_start >= $2
       ORDER BY week_start ASC`,
      [clientId, cutoff]
    )
    res.json(rows.map(r => {
      const o = { week_start: r.week_start }
      Object.entries(r).forEach(([k, v]) => { if (k !== 'week_start') o[k] = parseFloat(v) || 0 })
      return o
    }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/metrics/:clientId/summary ────────────────────────────────────────
// Lightweight summary for dashboard cards
router.get('/:clientId/summary', async (req, res) => {
  const { clientId } = req.params
  const weeks  = 4
  const cutoff = periodCutoff(weeks)

  try {
    const { rows } = await query(
      `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`,
      [clientId, cutoff]
    )
    res.json(derive(rows[0]))
  } catch (err) {
    console.error('[metrics] summary error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/metrics/:clientId/anomalies ─────────────────────────────────────
// Return metrics that deviate significantly from the prior period
router.get('/:clientId/anomalies', async (req, res) => {
  const { clientId } = req.params
  const weekMap = { this_week: 1, last_4w: 4, last_8w: 8 }
  const weeks   = weekMap[req.query.period] || 4
  const cutoff  = periodCutoff(weeks)
  const prev    = prevRange(weeks)

  try {
    const [currR, prevR] = await Promise.all([
      query(
        `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`,
        [clientId, cutoff]
      ),
      query(
        `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2 AND week_start < $3`,
        [clientId, prev.start, prev.end]
      ),
    ])

    const curr = derive(currR.rows[0])
    const past = derive(prevR.rows[0])

    const anomalies = []
    const THRESHOLD = 15  // % change to flag

    const checks = [
      { key: 'total_spend',   label: 'Total Spend' },
      { key: 'total_leads',   label: 'Total Leads' },
      { key: 'total_revenue', label: 'Revenue' },
      { key: 'roas',          label: 'ROAS' },
      { key: 'gbp_calls',     label: 'GBP Calls' },
      { key: 'ads_leads',     label: 'Google Ads Leads' },
    ]

    for (const { key, label } of checks) {
      if (!past[key] || past[key] === 0) continue
      const pct = ((curr[key] - past[key]) / past[key]) * 100
      if (Math.abs(pct) >= THRESHOLD) {
        anomalies.push({ key, label, current: curr[key], previous: past[key], pct_change: pct })
      }
    }

    anomalies.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change))
    res.json(anomalies)
  } catch (err) {
    console.error('[metrics] anomalies error', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/metrics (agency-wide anomalies) ──────────────────────────────────
// Used by AnomalyStrip: returns anomalies across all clients
router.get('/', async (req, res) => {
  const weekMap = { this_week: 1, last_4w: 4, last_8w: 8 }
  const weeks   = weekMap[req.query.period] || 4
  const cutoff  = periodCutoff(weeks)
  const prev    = prevRange(weeks)

  try {
    const { rows: clients } = await query(`SELECT id, name FROM clients WHERE status = 'active'`)

    const results = []
    for (const client of clients) {
      const [currR, prevR] = await Promise.all([
        query(
          `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`,
          [client.id, cutoff]
        ),
        query(
          `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2 AND week_start < $3`,
          [client.id, prev.start, prev.end]
        ),
      ])

      const curr = derive(currR.rows[0])
      const past = derive(prevR.rows[0])

      const checks = [
        { key: 'total_leads',   label: 'Leads' },
        { key: 'total_revenue', label: 'Revenue' },
        { key: 'roas',          label: 'ROAS' },
        { key: 'total_spend',   label: 'Spend' },
      ]

      const THRESHOLD = 20
      for (const { key, label } of checks) {
        if (!past[key] || past[key] === 0) continue
        const pct = ((curr[key] - past[key]) / past[key]) * 100
        if (Math.abs(pct) >= THRESHOLD) {
          results.push({
            client_id:   client.id,
            client_name: client.name,
            key, label,
            current:  curr[key],
            previous: past[key],
            pct_change: pct,
          })
        }
      }
    }

    results.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change))
    res.json(results)
  } catch (err) {
    console.error('[metrics] agency anomalies error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
