'use strict'

/**
 * Google Business Profile connector — Business Profile Performance API v1.
 *
 * Credentials stored per-connection:
 *   location_id   — GBP location ID (numeric, from Google Business Profile dashboard)
 *   refresh_token — OAuth2 refresh token (scope: business.manage)
 *
 * Optional — if not in creds, falls back to env vars:
 *   client_id     — OAuth2 client ID  (or GOOGLE_CLIENT_ID env var)
 *   client_secret — OAuth2 client secret (or GOOGLE_CLIENT_SECRET env var)
 *
 * How to get credentials:
 *   1. Google Cloud Console → APIs → Enable "Business Profile Performance API"
 *   2. Create OAuth 2.0 credentials (same project as GA4/Ads is fine)
 *   3. OAuth Playground → scope: https://www.googleapis.com/auth/business.manage
 *   4. Location ID: Business Profile Manager URL → /locations/{id} or in API listing
 *
 * Metrics fetched (daily, then aggregated to weekly):
 *   CALL_CLICKS, DIRECTION_REQUESTS, WEBSITE_CLICKS,
 *   BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, BUSINESS_IMPRESSIONS_MOBILE_SEARCH,
 *   BUSINESS_SEARCHES
 */

const axios = require('axios')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function refreshAccessToken(creds) {
  const clientId     = creds.client_id     || process.env.GOOGLE_CLIENT_ID     || ''
  const clientSecret = creds.client_secret || process.env.GOOGLE_CLIENT_SECRET || ''

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth client_id and client_secret required. ' +
      'Include them in credentials or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars.'
    )
  }

  const { data } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )

  if (data.error) throw new Error(`OAuth: ${data.error_description || data.error}`)
  return data.access_token
}

function toWeekStart(dateObj) {
  const d   = new Date(dateObj)
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

// GBP Performance API returns { year, month, day } date objects
function parseGbpDate({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day))
}

// Fetch a single daily metric series for a location
async function fetchDailyMetric(locationId, metricName, startDate, endDate, accessToken) {
  const start = parseGbpDate ? undefined : undefined // handled below
  const sd = startDate; const ed = endDate

  const { data } = await axios.get(
    `${PERF_BASE}/locations/${locationId}:getDailyMetrics`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        dailyMetric:                     metricName,
        'dailyRange.start_date.year':    sd.getUTCFullYear(),
        'dailyRange.start_date.month':   sd.getUTCMonth() + 1,
        'dailyRange.start_date.day':     sd.getUTCDate(),
        'dailyRange.end_date.year':      ed.getUTCFullYear(),
        'dailyRange.end_date.month':     ed.getUTCMonth() + 1,
        'dailyRange.end_date.day':       ed.getUTCDate(),
      },
    }
  )

  return data.timeSeries?.datedValues || []
}

// ── fetchStats ────────────────────────────────────────────────────────────────
// Returns array of { week_start, gbp_calls, gbp_directions, gbp_website_clicks, gbp_views, gbp_searches }

async function fetchStats(creds, weeksBack = 8) {
  const accessToken = await refreshAccessToken(creds)
  const locationId  = String(creds.location_id)

  const endDate   = new Date(); endDate.setUTCHours(0,0,0,0)
  const startDate = new Date(endDate)
  startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7)

  const METRICS = [
    'CALL_CLICKS',
    'DIRECTION_REQUESTS',
    'WEBSITE_CLICKS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_SEARCHES',
  ]

  // Fetch all metrics in parallel
  const results = await Promise.all(
    METRICS.map(m => fetchDailyMetric(locationId, m, startDate, endDate, accessToken))
  )

  const [calls, directions, websiteClicks, desktopImps, mobileImps, searches] = results

  // Aggregate daily values to weekly buckets
  const weeks = {}
  const ensure = (week) => {
    if (!weeks[week]) weeks[week] = {
      week_start: week,
      gbp_calls: 0, gbp_directions: 0, gbp_website_clicks: 0,
      gbp_views: 0, gbp_searches: 0,
    }
    return weeks[week]
  }

  const addSeries = (series, field) => {
    for (const { date, value } of series) {
      const week = toWeekStart(parseGbpDate(date))
      ensure(week)[field] += parseInt(value || 0, 10)
    }
  }

  addSeries(calls,        'gbp_calls')
  addSeries(directions,   'gbp_directions')
  addSeries(websiteClicks,'gbp_website_clicks')
  addSeries(desktopImps,  'gbp_views')
  addSeries(mobileImps,   'gbp_views')
  addSeries(searches,     'gbp_searches')

  return Object.values(weeks).sort((a, b) => a.week_start.localeCompare(b.week_start))
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  if (!creds?.location_id)   throw new Error('location_id required')
  if (!creds?.refresh_token) throw new Error('refresh_token required')

  const accessToken = await refreshAccessToken(creds)

  // Fetch 1 day of CALL_CLICKS to verify location access
  const today = new Date(); today.setUTCHours(0,0,0,0)
  const yesterday = new Date(today); yesterday.setUTCDate(today.getUTCDate() - 1)

  const { data } = await axios.get(
    `${PERF_BASE}/locations/${creds.location_id}:getDailyMetrics`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        dailyMetric:                     'CALL_CLICKS',
        'dailyRange.start_date.year':    yesterday.getUTCFullYear(),
        'dailyRange.start_date.month':   yesterday.getUTCMonth() + 1,
        'dailyRange.start_date.day':     yesterday.getUTCDate(),
        'dailyRange.end_date.year':      today.getUTCFullYear(),
        'dailyRange.end_date.month':     today.getUTCMonth() + 1,
        'dailyRange.end_date.day':       today.getUTCDate(),
      },
    }
  )

  const locationName = data.name || `locations/${creds.location_id}`
  return { ok: true, account: locationName, message: `Connected to GBP location ${locationName}` }
}

// ── Connector contract ─────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['location_id', 'refresh_token']

const FIELD_LABELS = {
  location_id:   { label: 'Location ID',         hint: 'Numeric ID from GBP dashboard URL or API', secret: false },
  refresh_token: { label: 'OAuth Refresh Token', hint: 'OAuth Playground → scope: https://www.googleapis.com/auth/business.manage', secret: true },
  client_id:     { label: 'OAuth Client ID',     hint: 'Optional — or set GOOGLE_CLIENT_ID env var', secret: false },
  client_secret: { label: 'OAuth Client Secret', hint: 'Optional — or set GOOGLE_CLIENT_SECRET env var', secret: true },
}

module.exports = { fetchStats, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
