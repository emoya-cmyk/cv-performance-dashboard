// ============================================================
// lib/facts.js — single source of truth tying the tidy fact_metric grain
// to the wide weekly_reports columns.
//
// Connectors emit facts (date, channel, metric_key, value). The rollup
// (lib/rollup.js) pivots those back into weekly_reports columns. Both sides —
// plus any legacy "mirror weekly row → facts" path — read the maps here so
// channel ids and metric keys never drift.
//
// IMPORTANT: CHANNEL_ID values must match migration 011_seed_dim_channel.
// Never renumber; only append.
// ============================================================

const CHANNEL_ID = {
  google_ads: 1,
  meta:       2,
  lsa:        3,
  gbp:        4,
  ga4:        5,
  ghl:        6,
  organic:    7,
}
const CHANNEL_KEY = Object.fromEntries(
  Object.entries(CHANNEL_ID).map(([k, v]) => [v, k])
)

function channelId(key)  { return CHANNEL_ID[key] }
function channelKey(id)  { return CHANNEL_KEY[id] }

// Free-form metric vocabulary. Adding a metric is a new ROW, never a migration;
// this list is documentation + a light guard, not a hard constraint.
const METRIC_KEYS = new Set([
  // paid media
  'spend', 'impressions', 'clicks', 'leads', 'conversions', 'revenue', 'roas',
  // local services
  'calls', 'booked_jobs',
  // google business profile
  'views', 'searches', 'directions', 'website_clicks',
  // analytics
  'sessions', 'new_users', 'organic_sessions', 'paid_sessions',
  'direct_sessions', 'engagement_rate',
  // crm / funnel
  'raw_leads', 'mql', 'sql_count', 'closed_won', 'projected_revenue',
  'avg_ticket', 'appointments',
])
const isKnownMetric = (k) => METRIC_KEYS.has(k)

// ── Wide weekly_reports column → fact descriptor ────────────────────────────
// agg:
//   'sum'   (default) — weekly column = SUM of that channel+metric over the days
//   'avg'             — weekly column = AVG (rates, not additive)
//   'ratio'           — weekly column = SUM(num) / SUM(den); not stored as its
//                       own fact. num/den name the metric_keys to combine.
//
// ONLY columns that exist on BOTH Postgres and SQLite are listed — the rollup
// writes these directly, so writing a Postgres-only column would throw on
// SQLite. Deliberately omitted (Postgres-only, added by migration 002):
//   google_ads_leads, lsa_leads, gbp_leads, organic_leads, appointments
// (meta_leads IS on both — defined in 001 — so it stays.)
const COLUMN_FACT_MAP = {
  // Google Ads
  ads_spend:        { channel: 'google_ads', metric_key: 'spend' },
  ads_impressions:  { channel: 'google_ads', metric_key: 'impressions' },
  ads_clicks:       { channel: 'google_ads', metric_key: 'clicks' },
  ads_leads:        { channel: 'google_ads', metric_key: 'leads' },
  ads_roas:         { channel: 'google_ads', metric_key: 'roas', agg: 'ratio', num: 'revenue', den: 'spend' },
  // LSA (Local Services Ads)
  lsa_spend:        { channel: 'lsa', metric_key: 'spend' },
  lsa_impressions:  { channel: 'lsa', metric_key: 'impressions' },
  lsa_calls:        { channel: 'lsa', metric_key: 'calls' },
  lsa_booked_jobs:  { channel: 'lsa', metric_key: 'booked_jobs' },
  // Meta Ads
  meta_spend:       { channel: 'meta', metric_key: 'spend' },
  meta_impressions: { channel: 'meta', metric_key: 'impressions' },
  meta_clicks:      { channel: 'meta', metric_key: 'clicks' },
  meta_leads:       { channel: 'meta', metric_key: 'leads' },
  meta_roas:        { channel: 'meta', metric_key: 'roas', agg: 'ratio', num: 'revenue', den: 'spend' },
  // Google Business Profile
  gbp_views:          { channel: 'gbp', metric_key: 'views' },
  gbp_searches:       { channel: 'gbp', metric_key: 'searches' },
  gbp_calls:          { channel: 'gbp', metric_key: 'calls' },
  gbp_directions:     { channel: 'gbp', metric_key: 'directions' },
  gbp_website_clicks: { channel: 'gbp', metric_key: 'website_clicks' },
  // Google Analytics 4
  ga4_sessions:         { channel: 'ga4', metric_key: 'sessions' },
  ga4_new_users:        { channel: 'ga4', metric_key: 'new_users' },
  ga4_organic_sessions: { channel: 'ga4', metric_key: 'organic_sessions' },
  ga4_paid_sessions:    { channel: 'ga4', metric_key: 'paid_sessions' },
  ga4_direct_sessions:  { channel: 'ga4', metric_key: 'direct_sessions' },
  ga4_conversions:      { channel: 'ga4', metric_key: 'conversions' },
  ga4_engagement_rate:  { channel: 'ga4', metric_key: 'engagement_rate', agg: 'avg' },
  // CRM / funnel (GHL) — account grain (entity = null)
  raw_leads:         { channel: 'ghl', metric_key: 'raw_leads' },
  mql:               { channel: 'ghl', metric_key: 'mql' },
  sql_count:         { channel: 'ghl', metric_key: 'sql_count' },
  closed_won:        { channel: 'ghl', metric_key: 'closed_won' },
  projected_revenue: { channel: 'ghl', metric_key: 'projected_revenue' },
  avg_ticket:        { channel: 'ghl', metric_key: 'avg_ticket', agg: 'avg' },
}

// Grouped view used by the rollup: channelKey → [{ col, metric_key, agg, num, den }]
const COLUMNS_BY_CHANNEL = {}
for (const [col, d] of Object.entries(COLUMN_FACT_MAP)) {
  ;(COLUMNS_BY_CHANNEL[d.channel] ||= []).push({ col, ...d })
}

function columnsForChannel(channelKey) {
  return COLUMNS_BY_CHANNEL[channelKey] || []
}

// Reverse lookup: (channelKey, metric_key) → weekly column name (or undefined).
function columnFor(channelKey, metricKey) {
  const hit = (COLUMNS_BY_CHANNEL[channelKey] || []).find(c => c.metric_key === metricKey)
  return hit && hit.col
}

// ── Legacy bridge: a wide weekly_reports row → daily-shaped facts ────────────
// Used by the golden parity test and as an optional mirror for connectors still
// on fetchStats. A weekly row only knows the week, so every emitted fact is
// dated on `week_start` at account grain (entity = null). 'ratio' columns are
// reconstructed into their numerator fact (e.g. ads_roas → a google_ads
// `revenue` fact = roas * spend) so the rollup's SUM(num)/SUM(den) round-trips.
//
// row: { week_start, ...wide cols }
// opts.channels: optional Array<channelKey> to restrict output
// → [{ date, channel, entity:null, metric_key, value }]
function factsFromWeeklyRow(row, opts = {}) {
  const only = opts.channels ? new Set(opts.channels) : null
  const date = row.week_start
  const facts = []

  for (const [col, d] of Object.entries(COLUMN_FACT_MAP)) {
    if (only && !only.has(d.channel)) continue
    const raw = row[col]
    if (raw == null) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue

    if (d.agg === 'ratio') {
      // reconstruct the numerator fact from ratio * denominator column
      const denCol = columnFor(d.channel, d.den)
      const denVal = denCol != null ? Number(row[denCol]) : NaN
      if (Number.isFinite(denVal) && value !== 0) {
        facts.push({ date, channel: d.channel, entity: null, metric_key: d.num, value: value * denVal })
      }
      continue
    }
    facts.push({ date, channel: d.channel, entity: null, metric_key: d.metric_key, value })
  }
  return facts
}

module.exports = {
  CHANNEL_ID,
  CHANNEL_KEY,
  channelId,
  channelKey,
  METRIC_KEYS,
  isKnownMetric,
  COLUMN_FACT_MAP,
  COLUMNS_BY_CHANNEL,
  columnsForChannel,
  columnFor,
  factsFromWeeklyRow,
}
