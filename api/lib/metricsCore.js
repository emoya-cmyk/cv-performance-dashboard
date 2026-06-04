'use strict'

// ============================================================
// lib/metricsCore.js — the SINGLE source of truth for derived KPIs.
//
// Extracted verbatim from routes/metrics.js so the live metrics endpoints,
// the Grounded-AI evidence pack (lib/evidence.js), and the weekly digest all
// compute numbers ONE way. The accuracy guarantee of the AI layer rests on
// this: every number the LLM is allowed to narrate is produced HERE by code,
// never by the model. If this drifts from metrics.js, the golden parity test
// and the evidence-pack exactness test fail loudly.
//
// Pure functions only — no DB, no Express — so it is trivially unit-testable
// and safe to require from anywhere.
// ============================================================

// Wide weekly_reports aggregate — COALESCE(SUM/AVG…) over every column the
// dashboard reads. Used as `SELECT ${AGG} FROM weekly_reports WHERE …`.
// SUM for additive counters; AVG(NULLIF(x,0)) for ratio/rate columns so empty
// weeks don't drag the average to zero; AVG(avg_ticket) for the ticket mean.
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

// Coerce a wide weekly_reports row → numeric, then add the derived KPIs.
// This is the ONE derive the live metrics endpoints (routes/metrics.js imports
// it), the AI evidence pack, and the digest all share.
//
// Cold-start hardening: a present column is already zeroed by `parseFloat(v)||0`,
// but an ABSENT column (degenerate/empty row, or a caller passing `undefined`)
// would leave it `undefined` and make the additive base `NaN`. The `|| 0`
// fallbacks below keep every derived KPI a finite number even on an empty row —
// no behavior change for real rows (all columns present → already numbers), so
// the golden-parity and evidence-exactness tests are unaffected.
function derive(row) {
  const r = {}
  Object.entries(row || {}).forEach(([k, v]) => { r[k] = parseFloat(v) || 0 })
  r.total_spend   = (r.ads_spend || 0) + (r.lsa_spend || 0) + (r.meta_spend || 0)
  r.total_leads   = r.raw_leads || 0
  r.total_closed  = r.closed_won || 0
  r.total_revenue = r.projected_revenue || 0
  r.roas = r.total_spend > 0 ? r.total_revenue / r.total_spend : 0
  r.close_rate = r.total_leads > 0 ? (r.total_closed / r.total_leads) * 100 : 0
  r.cpl = r.total_leads > 0 ? r.total_spend / r.total_leads : 0
  return r
}

// Signed percent change; null when there is no comparable prior value
// (mirrors the `if (!past[key] || past[key] === 0) continue` guard used by the
// metrics anomaly endpoints, surfaced as null instead of a skip).
function pctChange(curr, prev) {
  if (prev == null || prev === 0) return null
  return ((curr - prev) / prev) * 100
}

// Generic anomaly pass shared by the evidence pack (and available to the
// metrics endpoints): flag any check whose |%Δ| ≥ threshold, sorted by
// magnitude descending. Same skip rule as metrics.js.
function detectAnomalies(curr, past, checks, threshold) {
  const out = []
  for (const { key, label } of checks) {
    if (!past[key] || past[key] === 0) continue
    const pct = ((curr[key] - past[key]) / past[key]) * 100
    if (Math.abs(pct) >= threshold) {
      out.push({ key, label, current: curr[key], previous: past[key], pct_change: pct })
    }
  }
  out.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change))
  return out
}

module.exports = { AGG, derive, pctChange, detectAnomalies }
