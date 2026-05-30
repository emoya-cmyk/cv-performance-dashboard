'use strict'

// ============================================================
// lib/evidence.js — the deterministic "evidence pack" for one (client, week).
//
// This is the contract that makes the AI recap trustworthy: CODE computes
// every number here (reusing lib/metricsCore.js — the same derive()/AGG the
// live dashboard uses) and the LLM is only ever allowed to NARRATE this pack.
// The model never calculates a figure and never sees a raw weekly_reports row
// it could misread or a free-text field it could be injected through.
//
// The pack is also persisted (ai_recaps.evidence_pack) so any recap can be
// re-verified after the fact, and it is the allow-list the grounding verifier
// (lib/ai.js) checks the generated text against.
// ============================================================

const { query }                      = require('../db')
const { AGG, derive, pctChange, detectAnomalies } = require('./metricsCore')
const { weekStartOf, weekEndOf }     = require('./rollup')

// ── rounding helpers — these define the CANONICAL values the verifier allows ──
const r0 = n => Math.round(Number(n) || 0)
const r1 = n => Math.round((Number(n) || 0) * 10) / 10
const r2 = n => Math.round((Number(n) || 0) * 100) / 100

// First-of-month (UTC) for the month containing an ISO 'YYYY-MM-DD'.
const monthFirstOf = (iso) => `${iso.slice(0, 7)}-01`

// Pretty "May 19 – May 25, 2026" label from a Monday week_start.
function periodLabel(weekStart, weekEnd) {
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  const s = new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-US', opts)
  const e = new Date(weekEnd   + 'T00:00:00Z').toLocaleDateString('en-US', opts)
  const year = weekEnd.slice(0, 4)
  return `${s} – ${e}, ${year}`
}

// One change-vs-prior block: { current, previous, pct_change } rounded to dp.
function delta(curr, past, key, dp) {
  const round = dp === 2 ? r2 : dp === 1 ? r1 : r0
  const c  = curr[key] || 0
  const p  = past[key] || 0
  const pc = pctChange(c, p)
  return { current: round(c), previous: round(p), pct_change: pc == null ? null : r1(pc) }
}

// Load a single ISO week's aggregated + derived stats for a client.
async function loadWeek(clientId, weekStart) {
  const { rows } = await query(
    `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start = $2`,
    [clientId, weekStart]
  )
  const stats = derive(rows[0] || {})
  return { stats, weeks_count: r0(rows[0]?.weeks_count) }
}

// Anomaly seeds — the SAME logic & 15% threshold as the per-client
// /metrics/:id/anomalies endpoint, extended with the headline KPIs. The LLM
// does NOT choose what's notable; code does, then the model phrases it.
const HIGHLIGHT_CHECKS = [
  { key: 'total_revenue', label: 'Revenue' },
  { key: 'total_leads',   label: 'Leads' },
  { key: 'total_closed',  label: 'Jobs Won' },
  { key: 'total_spend',   label: 'Spend' },
  { key: 'roas',          label: 'ROAS' },
  { key: 'ads_leads',     label: 'Google Ads Leads' },
  { key: 'gbp_calls',     label: 'GBP Calls' },
]
const HIGHLIGHT_THRESHOLD = 15

/**
 * Build the deterministic evidence pack for a client's ISO week.
 * @param {string} clientId
 * @param {string} [weekStart] Monday 'YYYY-MM-DD'. Defaults to the most recently
 *        completed week (last Monday relative to now).
 */
async function buildEvidencePack(clientId, weekStart) {
  // Default = the week that just ended (last Monday). weekStartOf(today) is the
  // CURRENT (incomplete) week, so step back 7 days for the completed one.
  if (!weekStart) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 7)
    weekStart = weekStartOf(d.toISOString().slice(0, 10))
  }
  const weekEnd   = weekEndOf(weekStart)
  const priorStart = weekStartOf(
    new Date(new Date(weekStart + 'T00:00:00Z').getTime() - 7 * 864e5).toISOString().slice(0, 10)
  )
  const priorEnd  = weekEndOf(priorStart)

  const [{ rows: clientRows }, cur, pri] = await Promise.all([
    query(`SELECT id, name FROM clients WHERE id = $1`, [clientId]),
    loadWeek(clientId, weekStart),
    loadWeek(clientId, priorStart),
  ])
  const client = clientRows[0] || { id: clientId, name: 'Client' }
  const curr = cur.stats
  const past = pri.stats

  // ── Goal (monthly revenue target) ──────────────────────────────────────────
  const monthFirst = monthFirstOf(weekStart)
  const [{ rows: goalRows }, { rows: mtdRows }] = await Promise.all([
    query(
      `SELECT revenue_target, month FROM client_goals
        WHERE client_id = $1 AND month = $2 LIMIT 1`,
      [clientId, monthFirst]
    ),
    query(
      `SELECT COALESCE(SUM(projected_revenue),0) AS month_revenue
         FROM weekly_reports
        WHERE client_id = $1 AND week_start >= $2 AND week_start <= $3`,
      [clientId, monthFirst, weekStart]
    ),
  ])
  let goal = null
  if (goalRows[0] && Number(goalRows[0].revenue_target) > 0) {
    const target = r0(goalRows[0].revenue_target)
    const monthRev = r0(mtdRows[0].month_revenue)
    goal = {
      month:          goalRows[0].month,
      revenue_target: target,
      month_revenue:  monthRev,
      pct:            target > 0 ? r0((monthRev / target) * 100) : 0,
    }
  }

  // ── Deterministic highlights (what changed ≥15%, biggest first) ────────────
  const highlights = detectAnomalies(curr, past, HIGHLIGHT_CHECKS, HIGHLIGHT_THRESHOLD)
    .map(a => ({
      label:      a.label,
      current:    r2(a.current),
      previous:   r2(a.previous),
      pct_change: r1(a.pct_change),
      direction:  a.pct_change >= 0 ? 'up' : 'down',
    }))

  return {
    client:       { id: client.id, name: client.name },
    period:       { week_start: weekStart,  week_end: weekEnd,  label: periodLabel(weekStart, weekEnd) },
    prior_period: { week_start: priorStart, week_end: priorEnd, label: periodLabel(priorStart, priorEnd) },

    metrics: {
      revenue:    delta(curr, past, 'total_revenue', 0),
      leads:      delta(curr, past, 'total_leads',   0),
      jobs:       delta(curr, past, 'total_closed',  0),
      spend:      delta(curr, past, 'total_spend',   0),
      roas:       delta(curr, past, 'roas',          2),
      cpl:        delta(curr, past, 'cpl',           2),
      close_rate: delta(curr, past, 'close_rate',    1),
    },

    channels: {
      google_ads: { spend: r0(curr.ads_spend),  leads: r0(curr.ads_leads),   roas: r2(curr.ads_roas) },
      meta:       { spend: r0(curr.meta_spend), leads: r0(curr.meta_leads),  roas: r2(curr.meta_roas) },
      lsa:        { spend: r0(curr.lsa_spend),  calls: r0(curr.lsa_calls),   booked_jobs: r0(curr.lsa_booked_jobs) },
      gbp:        { calls: r0(curr.gbp_calls),  directions: r0(curr.gbp_directions), website_clicks: r0(curr.gbp_website_clicks) },
      ga4:        { sessions: r0(curr.ga4_sessions), conversions: r0(curr.ga4_conversions) },
    },

    highlights,
    goal,

    meta: {
      has_data:           cur.weeks_count > 0,
      weeks_count:        cur.weeks_count,
      prior_weeks_count:  pri.weeks_count,
    },
  }
}

module.exports = { buildEvidencePack, periodLabel, HIGHLIGHT_CHECKS, HIGHLIGHT_THRESHOLD }
