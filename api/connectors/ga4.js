// Google Analytics 4 connector — GA4 Data API v1beta
//
// Credentials stored in client_connections.credentials:
//   property_id   — numeric GA4 property ID (e.g. "123456789") — no "properties/" prefix
//   client_id     — OAuth2 client ID (same Cloud project as Google Ads)
//   client_secret — OAuth2 client secret
//   refresh_token — OAuth2 refresh token (scope: analytics.readonly)
//
// How to get a refresh_token:
//   1. Google Cloud Console → Credentials → OAuth 2.0 Desktop Client
//   2. OAuth Playground → scope: https://www.googleapis.com/auth/analytics.readonly
//   3. Exchange authorization code → copy refresh token
//
// Channel groups returned by sessionDefaultChannelGroup:
//   "Organic Search", "Paid Search", "Direct", "Referral",
//   "Organic Social", "Paid Social", "Email", "Affiliates", "(Other)"

const axios = require('axios')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GA4_BASE  = 'https://analyticsdata.googleapis.com/v1beta/properties'

// ── OAuth token refresh ────────────────────────────────────────────────────────
async function refreshAccessToken(creds) {
  const clientId     = creds.client_id     || process.env.GOOGLE_CLIENT_ID     || ''
  const clientSecret = creds.client_secret || process.env.GOOGLE_CLIENT_SECRET || ''

  if (!clientId || !clientSecret) {
    throw new Error(
      'client_id and client_secret required. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars or include in credentials.'
    )
  }

  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: creds.refresh_token,
    grant_type:    'refresh_token',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })

  if (data.error) throw new Error(`GA4 token refresh: ${data.error_description || data.error}`)
  return data.access_token
}

// ── Date helpers ───────────────────────────────────────────────────────────────
function toWeekStart(dateStr) {
  // ISO-8601 YYYYMMDD from GA4 → Monday of that week
  const y = parseInt(dateStr.slice(0, 4), 10)
  const m = parseInt(dateStr.slice(4, 6), 10) - 1
  const d = parseInt(dateStr.slice(6, 8), 10)
  const dt  = new Date(Date.UTC(y, m, d))
  const day = dt.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day
  dt.setUTCDate(dt.getUTCDate() + diff)
  return dt.toISOString().split('T')[0]
}

function fmtDate(d) {
  // Date object → YYYY-MM-DD
  return d.toISOString().split('T')[0]
}

// ── Core fetch ─────────────────────────────────────────────────────────────────
async function fetchStats(creds, weeksBack = 8) {
  const accessToken = await refreshAccessToken(creds)
  const propId      = String(creds.property_id).replace(/^properties\//, '')

  const endDate   = new Date(); endDate.setUTCHours(0, 0, 0, 0)
  const startDate = new Date(endDate)
  startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7)

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  // Request daily data broken out by channel group so we can isolate organic
  const body = {
    dateRanges: [{ startDate: fmtDate(startDate), endDate: fmtDate(endDate) }],
    dimensions: [
      { name: 'date' },
      { name: 'sessionDefaultChannelGroup' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'newUsers' },
      { name: 'conversions' },
      { name: 'engagedSessions' },
    ],
    returnPropertyQuota: false,
    limit: 100000,
  }

  const { data } = await axios.post(
    `${GA4_BASE}/${propId}:runReport`,
    body,
    { headers }
  )

  // ── Aggregate to weeks ───────────────────────────────────────────────────────
  const weeks = {}

  const dimIdx = {}
  ;(data.dimensionHeaders || []).forEach((h, i) => { dimIdx[h.name] = i })
  const metIdx = {}
  ;(data.metricHeaders  || []).forEach((h, i) => { metIdx[h.name]  = i })

  for (const row of (data.rows || [])) {
    const dateStr  = row.dimensionValues[dimIdx['date']].value
    const channel  = row.dimensionValues[dimIdx['sessionDefaultChannelGroup']].value

    const sessions  = parseInt(row.metricValues[metIdx['sessions']].value        || 0, 10)
    const newUsers  = parseInt(row.metricValues[metIdx['newUsers']].value         || 0, 10)
    const convs     = parseInt(row.metricValues[metIdx['conversions']].value      || 0, 10)
    const engaged   = parseInt(row.metricValues[metIdx['engagedSessions']].value  || 0, 10)

    const week = toWeekStart(dateStr)
    if (!weeks[week]) weeks[week] = {
      week,
      ga4_sessions:         0,
      ga4_new_users:        0,
      ga4_organic_sessions: 0,
      ga4_paid_sessions:    0,
      ga4_direct_sessions:  0,
      ga4_conversions:      0,
      ga4_engaged_sessions: 0,
    }

    const w = weeks[week]
    w.ga4_sessions         += sessions
    w.ga4_new_users        += newUsers
    w.ga4_conversions      += convs
    w.ga4_engaged_sessions += engaged

    const ch = channel.toLowerCase()
    if (ch.includes('organic search'))       w.ga4_organic_sessions += sessions
    else if (ch.includes('paid search') ||
             ch.includes('paid social'))     w.ga4_paid_sessions    += sessions
    else if (ch.includes('direct'))          w.ga4_direct_sessions  += sessions
  }

  return Object.values(weeks).map(w => ({
    week_start:           w.week,
    ga4_sessions:         w.ga4_sessions,
    ga4_new_users:        w.ga4_new_users,
    ga4_organic_sessions: w.ga4_organic_sessions,
    ga4_paid_sessions:    w.ga4_paid_sessions,
    ga4_direct_sessions:  w.ga4_direct_sessions,
    ga4_conversions:      w.ga4_conversions,
    // engagement_rate = engaged / sessions (0–100)
    ga4_engagement_rate:  w.ga4_sessions > 0
      ? parseFloat(((w.ga4_engaged_sessions / w.ga4_sessions) * 100).toFixed(1))
      : 0,
  }))
}

// ── fetchFacts (atomic grain — the new path) ────────────────────────────────────
// Account-grain facts on the ga4 channel. The 6 additive metrics (sessions,
// new_users, conversions, organic/paid/direct_sessions) are emitted PER DAY — the
// date dimension is the atomic grain and the rollup does the weekly SUM.
//
// engagement_rate is the exception. It is a sessions-WEIGHTED ratio: fetchStats
// computes it per week as (Σ engaged / Σ sessions)·100. The rollup aggregates 'avg'
// columns with an unweighted SQL AVG, so emitting one rate per day would skew the
// week on low-traffic days (a 1-session day reads 0% or 100%). To preserve EXACT
// parity we accumulate engaged + sessions per WEEK and emit a SINGLE engagement_rate
// fact per week, dated on the week's Monday — AVG over a single value returns it
// unchanged. (Weeks are always fully re-fetched each sync, so this stays consistent
// across incremental runs.)
async function fetchFacts(creds, { since, until }) {
  const accessToken = await refreshAccessToken(creds)
  const propId      = String(creds.property_id).replace(/^properties\//, '')

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const body = {
    dateRanges: [{ startDate: since, endDate: until }],
    dimensions: [
      { name: 'date' },
      { name: 'sessionDefaultChannelGroup' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'newUsers' },
      { name: 'conversions' },
      { name: 'engagedSessions' },
    ],
    returnPropertyQuota: false,
    limit: 100000,
  }

  const { data } = await axios.post(
    `${GA4_BASE}/${propId}:runReport`,
    body,
    { headers }
  )

  const dimIdx = {}
  ;(data.dimensionHeaders || []).forEach((h, i) => { dimIdx[h.name] = i })
  const metIdx = {}
  ;(data.metricHeaders  || []).forEach((h, i) => { metIdx[h.name]  = i })

  // 6 additive metrics → per-day buckets (account grain).
  const byDay = {}
  const ensureDay = (date) => (byDay[date] ||= {
    sessions: 0, new_users: 0, conversions: 0,
    organic_sessions: 0, paid_sessions: 0, direct_sessions: 0,
  })

  // engagement_rate → per-week weighted accumulation (engaged + sessions).
  const byWeek = {}
  const ensureWeek = (week) => (byWeek[week] ||= { engaged: 0, sessions: 0 })

  for (const row of (data.rows || [])) {
    const ymd      = row.dimensionValues[dimIdx['date']].value          // 'YYYYMMDD'
    const channel  = row.dimensionValues[dimIdx['sessionDefaultChannelGroup']].value
    const sessions = parseInt(row.metricValues[metIdx['sessions']].value        || 0, 10)
    const newUsers = parseInt(row.metricValues[metIdx['newUsers']].value         || 0, 10)
    const convs    = parseInt(row.metricValues[metIdx['conversions']].value      || 0, 10)
    const engaged  = parseInt(row.metricValues[metIdx['engagedSessions']].value  || 0, 10)

    // GA4 returns YYYYMMDD; the fact grain is ISO YYYY-MM-DD.
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
    const d = ensureDay(date)
    d.sessions    += sessions
    d.new_users   += newUsers
    d.conversions += convs

    const ch = channel.toLowerCase()
    if (ch.includes('organic search'))      d.organic_sessions += sessions
    else if (ch.includes('paid search') ||
             ch.includes('paid social'))    d.paid_sessions    += sessions
    else if (ch.includes('direct'))         d.direct_sessions  += sessions

    const wk = ensureWeek(toWeekStart(ymd))
    wk.engaged  += engaged
    wk.sessions += sessions
  }

  const facts = []

  for (const [date, d] of Object.entries(byDay)) {
    const push = (metric_key, value) => {
      if (!Number.isFinite(value) || value === 0) return
      facts.push({ date, channel: 'ga4', entity: null, metric_key, value })
    }
    push('sessions',         d.sessions)
    push('new_users',        d.new_users)
    push('conversions',      d.conversions)
    push('organic_sessions', d.organic_sessions)
    push('paid_sessions',    d.paid_sessions)
    push('direct_sessions',  d.direct_sessions)
  }

  // One sessions-weighted engagement_rate fact per week, dated on the week's Monday.
  for (const [week, w] of Object.entries(byWeek)) {
    if (w.sessions <= 0) continue
    const rate = parseFloat(((w.engaged / w.sessions) * 100).toFixed(1))
    if (!Number.isFinite(rate) || rate === 0) continue
    facts.push({ date: week, channel: 'ga4', entity: null, metric_key: 'engagement_rate', value: rate })
  }

  return { entities: [], facts }
}

// ── Connection test ────────────────────────────────────────────────────────────
async function testConnection(creds) {
  if (!creds?.property_id)  throw new Error('property_id required')
  if (!creds?.refresh_token) throw new Error('refresh_token required')

  const accessToken = await refreshAccessToken(creds)
  const propId      = String(creds.property_id).replace(/^properties\//, '')

  // Fetch property metadata — validates property ID and OAuth scope in one call
  const { data } = await axios.get(
    `${GA4_BASE}/${propId}/metadata`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  const name = data.name || `properties/${propId}`
  return { ok: true, account: name, message: `Connected to GA4 property "${name}"` }
}

// ── Connector contract ─────────────────────────────────────────────────────────
const REQUIRED_FIELDS = ['property_id', 'client_id', 'client_secret', 'refresh_token']

const FIELD_LABELS = {
  property_id:   { label: 'GA4 Property ID',      hint: 'Admin → Property Settings → Property ID (numbers only)', secret: false },
  client_id:     { label: 'OAuth Client ID',       hint: 'Google Cloud Console → Credentials (same as Google Ads)',  secret: false },
  client_secret: { label: 'OAuth Client Secret',   hint: 'Google Cloud Console → Credentials',                       secret: true  },
  refresh_token: { label: 'Refresh Token',          hint: 'OAuth scope: analytics.readonly — use OAuth Playground',   secret: true  },
}

module.exports = { fetchStats, fetchFacts, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
