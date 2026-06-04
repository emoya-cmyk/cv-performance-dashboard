const express    = require('express')
const { query }  = require('../db')
const { requireAgency } = require('../middleware/authz')
const router     = express.Router()

// Every route on this router (create / list / revoke share links) is an agency
// operation: it controls who can view a client's data through a public snapshot
// link. A role='client' caller must never mint or enumerate share tokens, so the
// whole router is agency-only. The PUBLIC read path is the standalone
// publicSnapshot() handler (mounted separately at GET /api/share/:token with no
// auth, by design) — it is NOT registered on this router, so this guard never
// touches it.
router.use(requireAgency)

// ── helpers (inline – mirrors metrics.js) ─────────────────────────────────────
function periodCutoff(weeks) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - weeks * 7)
  return d.toISOString().split('T')[0]
}

function prevRange(weeks) {
  const now = new Date()
  const end   = new Date(now); end.setUTCDate(end.getUTCDate() - weeks * 7)
  const start = new Date(now); start.setUTCDate(start.getUTCDate() - weeks * 14)
  return { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] }
}

const AGG = `
  COALESCE(SUM(ads_spend),0)           AS ads_spend,
  COALESCE(SUM(lsa_spend),0)           AS lsa_spend,
  COALESCE(SUM(meta_spend),0)          AS meta_spend,
  COALESCE(SUM(raw_leads),0)           AS raw_leads,
  COALESCE(SUM(closed_won),0)          AS closed_won,
  COALESCE(SUM(projected_revenue),0)   AS projected_revenue,
  COALESCE(AVG(NULLIF(ads_roas,0)),0)  AS ads_roas,
  COALESCE(SUM(ads_leads),0)           AS ads_leads,
  COALESCE(SUM(lsa_calls),0)           AS lsa_calls,
  COALESCE(SUM(meta_leads),0)          AS meta_leads,
  COALESCE(SUM(gbp_calls),0)           AS gbp_calls
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
  return r
}

// ── POST /api/shares/:clientId  (auth required — mounted behind requireAuth) ──
router.post('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { expiry_days } = req.body   // 7 | 30 | null
  const userId = req.user?.id

  try {
    // Verify client exists and belongs to agency
    const { rows: clients } = await query(
      'SELECT id FROM clients WHERE id = $1', [clientId]
    )
    if (!clients.length) return res.status(404).json({ error: 'Client not found' })

    const expiresAt = expiry_days
      ? new Date(Date.now() + expiry_days * 86400000).toISOString()
      : null

    const { rows } = await query(
      `INSERT INTO report_shares (client_id, created_by, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, token, expires_at, created_at`,
      [clientId, userId || null, expiresAt]
    )
    res.json(rows[0])
  } catch (err) {
    console.error('[shares] create', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/shares/:clientId  (auth required) ────────────────────────────────
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params
  try {
    const { rows } = await query(
      `SELECT token, expires_at, revoked_at, access_count, created_at
       FROM report_shares
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [clientId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── DELETE /api/shares/revoke/:token  (auth required) ─────────────────────────
router.delete('/revoke/:token', async (req, res) => {
  const { token } = req.params
  try {
    await query(
      `UPDATE report_shares SET revoked_at = now()
       WHERE token = $1 AND revoked_at IS NULL`,
      [token]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/share/:token  (PUBLIC — no auth, mounted separately) ──────────────
// Returns full snapshot: client info + metrics + trend + goal + latest update
async function publicSnapshot(req, res) {
  const { token } = req.params
  try {
    // 1. Look up + validate share
    const { rows: shareRows } = await query(
      `SELECT rs.*, c.name, c.location, c.industry
       FROM report_shares rs
       JOIN clients c ON c.id = rs.client_id
       WHERE rs.token = $1`,
      [token]
    )
    if (!shareRows.length)        return res.status(404).json({ error: 'Link not found' })
    const share = shareRows[0]
    if (share.revoked_at)         return res.status(410).json({ error: 'revoked' })
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'expired' })
    }

    // 2. Increment access counter (fire-and-forget)
    query('UPDATE report_shares SET access_count = access_count + 1 WHERE token = $1', [token])
      .catch(() => {})

    const clientId = share.client_id
    const cutoff   = periodCutoff(4)          // last 4 weeks
    const prev     = prevRange(4)

    // 3. Parallel fetch: current metrics, prev metrics, trend, goal, latest update, agency settings
    const [currR, prevR, trendR, goalR, updR, agencyR] = await Promise.all([
      query(
        `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`,
        [clientId, cutoff]
      ),
      query(
        `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2 AND week_start < $3`,
        [clientId, prev.start, prev.end]
      ),
      query(
        `SELECT week_start AS week,
                COALESCE(SUM(projected_revenue),0) AS revenue,
                COALESCE(SUM(raw_leads),0)          AS leads,
                COALESCE(SUM(closed_won),0)          AS jobs
         FROM weekly_reports
         WHERE client_id = $1 AND week_start >= $2
         GROUP BY week_start ORDER BY week_start`,
        [clientId, periodCutoff(8)]
      ),
      query(
        `SELECT revenue_target, leads_target, jobs_target
         FROM client_goals
         WHERE client_id = $1 AND month >= date_trunc('month', now())::date
         LIMIT 1`,
        [clientId]
      ),
      query(
        `SELECT this_week, next_week, status, week_start
         FROM client_updates
         WHERE client_id = $1
         ORDER BY week_start DESC
         LIMIT 1`,
        [clientId]
      ),
      query(
        `SELECT agency_name, logo_url, accent_hex, contact_email, calendar_url
         FROM agency_settings WHERE id = 1`
      ),
    ])

    const stats     = derive(currR.rows[0])
    const prevStats = derive(prevR.rows[0])
    const agency    = agencyR.rows[0] || { agency_name: '10X Performance', accent_hex: '#e53935', logo_url: null, contact_email: null, calendar_url: null }

    // Revenue delta
    const revDelta = prevStats.total_revenue > 0
      ? ((stats.total_revenue - prevStats.total_revenue) / prevStats.total_revenue) * 100
      : null

    // Trend — normalize types
    const trend = trendR.rows.map(r => ({
      week:    r.week,
      revenue: parseFloat(r.revenue) || 0,
      leads:   parseFloat(r.leads)   || 0,
      jobs:    parseFloat(r.jobs)    || 0,
    }))

    res.json({
      share: {
        token,
        expires_at:   share.expires_at,
        access_count: share.access_count + 1,
      },
      client: {
        id:       clientId,
        name:     share.name,
        location: share.location,
        industry: share.industry,
      },
      stats,
      prevStats,
      revDelta,
      trend,
      goal:   goalR.rows[0]   || null,
      update: updR.rows[0]    || null,
      agency,
    })
  } catch (err) {
    console.error('[share/public]', err.message)
    res.status(500).json({ error: err.message })
  }
}

module.exports = { router, publicSnapshot }
