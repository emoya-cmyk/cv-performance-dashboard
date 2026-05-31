// ============================================================
// semantic/registry.js — the allow-list that makes POST /api/query safe.
//
// This is the vocabulary the query compiler is allowed to speak. Every metric
// id and dimension id a caller can name MUST appear here; anything else is
// rejected before a single character reaches SQL. Because the compiler only
// ever interpolates identifiers taken from THIS file (plus the fixed
// fact_metric column names) and binds every runtime value as $N, the registry
// is the injection boundary.
//
// Metrics are defined over the tidy fact_metric grain (metric_key vocabulary in
// lib/facts.js), NOT the wide weekly_reports columns. That is the whole point:
// the wide table baked channel into the column name (ads_spend, meta_spend) and
// threw the day away, so it can answer neither "spend by channel" nor "by day".
// fact_metric still has channel_id and date, so the query layer can.
//
// kind:
//   'sum'   — additive; bucket value = SUM(metric_value) of that metric_key
//   'avg'   — a rate stored per period; bucket value = unweighted mean (mirrors
//             the rollup's AVG aggregation of 'avg' columns)
//   'ratio' — NOT stored; computed AFTER aggregation as SUM(num)/SUM(den) so it
//             composes correctly across days/channels. num/den name base
//             metric_keys. Optional `scale` (e.g. 100 for a percentage) and
//             `dp` (decimal places, default 2).
//
// `format` is display metadata only — the compiler never does unit math from it.
// ============================================================

'use strict'

const facts = require('../lib/facts')

// ── Metrics ─────────────────────────────────────────────────────────────────
// Keyed by the public metric id the caller passes in `metrics: [...]`.
const METRICS = {
  // —— additive base metrics (one metric_key each) ——
  spend:             { kind: 'sum', metric_key: 'spend',             label: 'Spend',             format: 'currency' },
  revenue:           { kind: 'sum', metric_key: 'revenue',           label: 'Revenue',           format: 'currency' },
  impressions:       { kind: 'sum', metric_key: 'impressions',       label: 'Impressions',       format: 'number' },
  clicks:            { kind: 'sum', metric_key: 'clicks',            label: 'Clicks',            format: 'number' },
  leads:             { kind: 'sum', metric_key: 'leads',             label: 'Leads',             format: 'number' },
  conversions:       { kind: 'sum', metric_key: 'conversions',       label: 'Conversions',       format: 'number' },
  calls:             { kind: 'sum', metric_key: 'calls',             label: 'Calls',             format: 'number' },
  booked_jobs:       { kind: 'sum', metric_key: 'booked_jobs',       label: 'Booked Jobs',       format: 'number' },
  // Google Business Profile
  views:             { kind: 'sum', metric_key: 'views',             label: 'Profile Views',     format: 'number' },
  searches:          { kind: 'sum', metric_key: 'searches',          label: 'Searches',          format: 'number' },
  directions:        { kind: 'sum', metric_key: 'directions',        label: 'Direction Requests',format: 'number' },
  website_clicks:    { kind: 'sum', metric_key: 'website_clicks',    label: 'Website Clicks',    format: 'number' },
  // GA4
  sessions:          { kind: 'sum', metric_key: 'sessions',          label: 'Sessions',          format: 'number' },
  new_users:         { kind: 'sum', metric_key: 'new_users',         label: 'New Users',         format: 'number' },
  organic_sessions:  { kind: 'sum', metric_key: 'organic_sessions',  label: 'Organic Sessions',  format: 'number' },
  paid_sessions:     { kind: 'sum', metric_key: 'paid_sessions',     label: 'Paid Sessions',     format: 'number' },
  direct_sessions:   { kind: 'sum', metric_key: 'direct_sessions',   label: 'Direct Sessions',   format: 'number' },
  // CRM / funnel (GHL)
  raw_leads:         { kind: 'sum', metric_key: 'raw_leads',         label: 'Raw Leads',         format: 'number' },
  mql:               { kind: 'sum', metric_key: 'mql',               label: 'MQLs',              format: 'number' },
  sql_count:         { kind: 'sum', metric_key: 'sql_count',         label: 'SQLs',              format: 'number' },
  closed_won:        { kind: 'sum', metric_key: 'closed_won',        label: 'Closed Won',        format: 'number' },
  projected_revenue: { kind: 'sum', metric_key: 'projected_revenue', label: 'Projected Revenue', format: 'currency' },
  appointments:      { kind: 'sum', metric_key: 'appointments',      label: 'Appointments',      format: 'number' },

  // —— rate metrics stored per period (averaged, never summed) ——
  engagement_rate:   { kind: 'avg', metric_key: 'engagement_rate',   label: 'Engagement Rate',   format: 'percent' },
  avg_ticket:        { kind: 'avg', metric_key: 'avg_ticket',        label: 'Avg Ticket',        format: 'currency' },

  // —— derived ratios (computed post-aggregation as SUM(num)/SUM(den)) ——
  roas:              { kind: 'ratio', num: 'revenue',    den: 'spend',       dp: 2, label: 'ROAS',            format: 'multiple' },
  cpl:               { kind: 'ratio', num: 'spend',      den: 'leads',       dp: 2, label: 'Cost / Lead',     format: 'currency' },
  cpc:               { kind: 'ratio', num: 'spend',      den: 'clicks',      dp: 2, label: 'Cost / Click',    format: 'currency' },
  cpa:               { kind: 'ratio', num: 'spend',      den: 'conversions', dp: 2, label: 'Cost / Acq.',     format: 'currency' },
  ctr:               { kind: 'ratio', num: 'clicks',     den: 'impressions', dp: 2, scale: 100, label: 'CTR',            format: 'percent' },
  close_rate:        { kind: 'ratio', num: 'closed_won', den: 'raw_leads',   dp: 2, scale: 100, label: 'Close Rate',     format: 'percent' },
  conversion_rate:   { kind: 'ratio', num: 'conversions',den: 'sessions',    dp: 2, scale: 100, label: 'Conversion Rate',format: 'percent' },
}

// The set of base metric_keys a metric depends on (what the compiler must fetch).
function metricKeyDeps(id) {
  const m = METRICS[id]
  if (!m) return []
  return m.kind === 'ratio' ? [m.num, m.den] : [m.metric_key]
}

// ── Dimensions ──────────────────────────────────────────────────────────────
// Non-date dimensions are a fixed, tiny set. Date is special: it carries a
// grain, written `date:day` | `date:week` | `date:month` in groupBy.
const DIMENSIONS = {
  channel: { label: 'Channel' },
  client:  { label: 'Client' },
}
const DATE_GRAINS = new Set(['day', 'week', 'month'])

// Parse one groupBy token → a normalized dim descriptor, or null if unknown.
//   'channel'    → { type: 'channel' }
//   'client'     → { type: 'client' }
//   'date:week'  → { type: 'date', grain: 'week' }
function parseGroupByToken(tok) {
  if (typeof tok !== 'string') return null
  if (DIMENSIONS[tok]) return { type: tok }
  const m = tok.match(/^date:(\w+)$/)
  if (m && DATE_GRAINS.has(m[1])) return { type: 'date', grain: m[1] }
  return null
}

// The row key a dimension produces in output rows.
function dimOutputKey(dim) {
  return dim.type === 'date' ? 'date' : dim.type
}

module.exports = {
  METRICS,
  DIMENSIONS,
  DATE_GRAINS,
  metricKeyDeps,
  parseGroupByToken,
  dimOutputKey,
  // re-export channel helpers so the compiler has one import surface
  channelId:  facts.channelId,
  channelKey: facts.channelKey,
}
