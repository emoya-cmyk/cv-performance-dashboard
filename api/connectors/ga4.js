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

module.exports = { fetchStats, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
