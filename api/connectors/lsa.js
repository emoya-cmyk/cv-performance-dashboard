'use strict'

/**
 * Google Local Services Ads (LSA) connector.
 *
 * NOTE: The Google Local Services Ads API requires special API access approval
 * and OAuth 2.0 with scope `https://www.googleapis.com/auth/adwords`.
 * LSA data is available via the Google Ads API using campaign type = LOCAL_SERVICES.
 *
 * For most clients, LSA call data flows automatically through GHL when:
 *   - GHL is configured as the call tracking destination in LSA
 *   - The GHL connector is active (contacts from LSA are tagged "lsa" or have source = "lsa")
 *
 * Manual spend entry: Use the Reports page → Manual Entry to enter LSA spend weekly
 * until the Google Ads connector (with LSA campaigns) is configured.
 *
 * Credentials:
 *   customer_id     — Google Ads customer ID (same account that runs LSA)
 *   developer_token — Google Ads API Developer Token
 *   refresh_token   — OAuth Refresh Token (scope: adwords)
 *   client_id       — OAuth Client ID (or GOOGLE_CLIENT_ID env var)
 *   client_secret   — OAuth Client Secret (or GOOGLE_CLIENT_SECRET env var)
 */

const axios = require('axios')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ADS_BASE  = 'https://googleads.googleapis.com/v17'

async function refreshAccessToken(creds) {
  const clientId     = creds.client_id     || process.env.GOOGLE_CLIENT_ID     || ''
  const clientSecret = creds.client_secret || process.env.GOOGLE_CLIENT_SECRET || ''

  if (!clientId || !clientSecret) {
    throw new Error(
      'client_id and client_secret required. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars or include in credentials.'
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

function cleanId(raw) {
  return String(raw || '').replace(/-/g, '')
}

// ── fetchStats ────────────────────────────────────────────────────────────────
// Queries LSA campaigns from Google Ads API

async function fetchStats(creds, weeksBack = 8) {
  const accessToken = await refreshAccessToken(creds)
  const custId      = cleanId(creds.customer_id)

  const endDate   = new Date(); endDate.setUTCHours(23,59,59,999)
  const startDate = new Date(); startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7)
  startDate.setUTCHours(0,0,0,0)

  const fmtDate = d => d.toISOString().split('T')[0]

  // LSA campaigns have advertising_channel_type = LOCAL_SERVICES
  const query = `
    SELECT
      segments.week,
      metrics.cost_micros,
      metrics.phone_calls,
      local_services_lead.lead_type
    FROM local_services_lead
    WHERE segments.date BETWEEN '${fmtDate(startDate)}' AND '${fmtDate(endDate)}'
    ORDER BY segments.week
  `

  let results = []
  try {
    const { data } = await axios.post(
      `${ADS_BASE}/customers/${custId}/googleAds:search`,
      { query },
      {
        headers: {
          Authorization:     `Bearer ${accessToken}`,
          'developer-token': creds.developer_token,
          'Content-Type':    'application/json',
        },
      }
    )
    results = data.results || []
  } catch (err) {
    // local_services_lead resource not available if account doesn't run LSA
    console.warn('[lsa] local_services_lead query failed, falling back to empty:', err.message)
    return []
  }

  const weeks = {}
  for (const row of results) {
    const week  = row.segments?.week
    if (!week) continue
    const spend = (parseInt(row.metrics?.costMicros || 0, 10)) / 1_000_000
    const calls = parseInt(row.metrics?.phoneCalls  || 0, 10)

    if (!weeks[week]) weeks[week] = { week_start: week, lsa_spend: 0, lsa_calls: 0 }
    weeks[week].lsa_spend += spend
    weeks[week].lsa_calls += calls
  }

  return Object.values(weeks)
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map(w => ({
      week_start: w.week_start,
      lsa_spend:  parseFloat(w.lsa_spend.toFixed(2)),
      lsa_calls:  Math.round(w.lsa_calls),
    }))
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  if (!creds?.customer_id)    throw new Error('customer_id required')
  if (!creds?.developer_token) throw new Error('developer_token required')
  if (!creds?.refresh_token)  throw new Error('refresh_token required')

  const accessToken = await refreshAccessToken(creds)
  const custId      = cleanId(creds.customer_id)

  const { data } = await axios.post(
    `${ADS_BASE}/customers/${custId}/googleAds:search`,
    { query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' },
    {
      headers: {
        Authorization:     `Bearer ${accessToken}`,
        'developer-token': creds.developer_token,
        'Content-Type':    'application/json',
      },
    }
  )

  const name = data.results?.[0]?.customer?.descriptiveName || custId
  return { ok: true, account: name, message: `Connected — LSA campaigns will sync from Google Ads account "${name}"` }
}

// ── Connector contract ─────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['customer_id', 'developer_token', 'refresh_token']

const FIELD_LABELS = {
  customer_id:     { label: 'Google Ads Customer ID', hint: 'Same account running your LSA campaigns', secret: false },
  developer_token: { label: 'Developer Token',        hint: 'Google Ads API Center → Developer Token', secret: true  },
  refresh_token:   { label: 'OAuth Refresh Token',    hint: 'scope: https://www.googleapis.com/auth/adwords', secret: true },
  client_id:       { label: 'OAuth Client ID',        hint: 'Optional — or set GOOGLE_CLIENT_ID env var', secret: false },
  client_secret:   { label: 'OAuth Client Secret',    hint: 'Optional — or set GOOGLE_CLIENT_SECRET env var', secret: true },
}

module.exports = { fetchStats, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
