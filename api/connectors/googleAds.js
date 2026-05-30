'use strict'

/**
 * Google Ads connector — uses the Google Ads REST API v17 (GAQL).
 *
 * Credentials stored per-connection:
 *   customer_id     — 10-digit customer ID (dashes optional, e.g. "123-456-7890")
 *   developer_token — Google Ads API Developer Token
 *   refresh_token   — OAuth2 refresh token (scope: adwords)
 *
 * Optional — if not in credentials, falls back to server env vars:
 *   client_id       — OAuth2 client ID  (or GOOGLE_CLIENT_ID env var)
 *   client_secret   — OAuth2 client secret (or GOOGLE_CLIENT_SECRET env var)
 *   login_customer_id — MCC manager account ID (only needed for multi-account access)
 *
 * How to get credentials:
 *   1. Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client
 *   2. Enable Google Ads API in the project
 *   3. Google Ads API Center → Apply for developer token
 *   4. OAuth Playground → scope: https://www.googleapis.com/auth/adwords → get refresh token
 */

const axios = require('axios')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ADS_BASE  = 'https://googleads.googleapis.com/v17'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanId(raw) {
  return String(raw || '').replace(/-/g, '')
}

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

function buildHeaders(creds, accessToken) {
  const h = {
    Authorization:     `Bearer ${accessToken}`,
    'developer-token': creds.developer_token,
    'Content-Type':    'application/json',
  }
  const mcc = creds.login_customer_id || process.env.GOOGLE_ADS_MCC_ID
  if (mcc) h['login-customer-id'] = cleanId(mcc)
  return h
}

function fmtDate(d) {
  return d.toISOString().split('T')[0]
}

// ── fetchStats ────────────────────────────────────────────────────────────────
// Returns array of { week_start, ads_spend, ads_clicks, ads_impressions, ads_leads, ads_roas }
// Caller: sync.js → upsertWeeklyReport

async function fetchStats(creds, weeksBack = 8) {
  const accessToken = await refreshAccessToken(creds)
  const custId      = cleanId(creds.customer_id)

  const endDate   = new Date(); endDate.setUTCHours(23,59,59,999)
  const startDate = new Date(); startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7)
  startDate.setUTCHours(0,0,0,0)

  // GAQL: aggregate all campaign metrics, segmented by week
  const gaqlQuery = `
    SELECT
      segments.week,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.all_conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${fmtDate(startDate)}' AND '${fmtDate(endDate)}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.week
  `

  const { data } = await axios.post(
    `${ADS_BASE}/customers/${custId}/googleAds:search`,
    { query: gaqlQuery },
    { headers: buildHeaders(creds, accessToken) }
  )

  // Aggregate campaign rows → weekly buckets
  const weeks = {}
  for (const row of (data.results || [])) {
    const week    = row.segments?.week         // 'YYYY-MM-DD' (Monday)
    if (!week) continue
    const spend   = (parseInt(row.metrics?.costMicros   || 0, 10)) / 1_000_000
    const clicks  = parseInt(row.metrics?.clicks        || 0, 10)
    const imps    = parseInt(row.metrics?.impressions   || 0, 10)
    const convs   = parseFloat(row.metrics?.conversions || 0)
    const revenue = parseFloat(row.metrics?.allConversionsValue || 0)

    if (!weeks[week]) {
      weeks[week] = {
        week_start: week,
        ads_spend: 0, ads_clicks: 0, ads_impressions: 0, ads_leads: 0, _revenue: 0,
      }
    }
    weeks[week].ads_spend       += spend
    weeks[week].ads_clicks      += clicks
    weeks[week].ads_impressions += imps
    weeks[week].ads_leads       += convs
    weeks[week]._revenue        += revenue
  }

  return Object.values(weeks)
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map(w => ({
      week_start:      w.week_start,
      ads_spend:       parseFloat(w.ads_spend.toFixed(2)),
      ads_clicks:      Math.round(w.ads_clicks),
      ads_impressions: Math.round(w.ads_impressions),
      ads_leads:       Math.round(w.ads_leads),
      ads_roas:        w.ads_spend > 0 ? parseFloat((w._revenue / w.ads_spend).toFixed(2)) : 0,
    }))
}

// ── fetchFacts (atomic grain — the new path) ────────────────────────────────────
// Returns { entities, facts } at daily × per-campaign grain. sync.js prefers
// this over fetchStats; ingestFacts lands the rows in fact_metric and the
// column-scoped rollup re-derives the legacy ads_* weekly_reports columns, so
// no JS weekly bucketing happens here — the week math is a SUM in SQL.
//
//   entities[] = the account + one row per campaign (campaign.parent = account)
//   facts[]    = one row per (date, campaign, metric) for spend / clicks /
//                impressions / leads(conversions) / revenue. spend + revenue
//                are what the ads_roas ratio is rebuilt from.
//
// metric_key mapping mirrors fetchStats' column mapping exactly:
//   cost_micros/1e6 → spend   clicks → clicks   impressions → impressions
//   conversions     → leads   all_conversions_value → revenue
async function fetchFacts(creds, { since, until }) {
  const accessToken = await refreshAccessToken(creds)
  const custId      = cleanId(creds.customer_id)

  // Per-DAY, per-campaign — segments.date (not segments.week). The grain is the
  // atomic fact; weekly aggregation is the rollup's job, not the connector's.
  const gaqlQuery = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.all_conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date
  `

  const { data } = await axios.post(
    `${ADS_BASE}/customers/${custId}/googleAds:search`,
    { query: gaqlQuery },
    { headers: buildHeaders(creds, accessToken) }
  )

  // The account is the parent of every campaign in the hierarchy.
  const entities = [{ type: 'account', external_id: custId, name: null }]
  const seenCampaigns = new Set()
  const facts = []

  // Skip zero/NaN: omitting a zero leaves the SUM unchanged and keeps fact_metric
  // lean. The smart-upsert guard means a missing zero never clobbers a prior value.
  const push = (date, campId, metric_key, value) => {
    if (!Number.isFinite(value) || value === 0) return
    facts.push({
      date,
      channel:    'google_ads',
      entity:     { type: 'campaign', external_id: campId },
      metric_key,
      value,
    })
  }

  for (const row of (data.results || [])) {
    const date   = row.segments?.date
    const campId = row.campaign?.id != null ? String(row.campaign.id) : null
    if (!date || !campId) continue

    if (!seenCampaigns.has(campId)) {
      seenCampaigns.add(campId)
      entities.push({
        type:               'campaign',
        external_id:        campId,
        name:               row.campaign?.name ?? null,
        status:             row.campaign?.status ?? null,
        parent_external_id: custId,
      })
    }

    const spend   = parseInt(row.metrics?.costMicros   || 0, 10) / 1_000_000
    const clicks  = parseInt(row.metrics?.clicks       || 0, 10)
    const imps    = parseInt(row.metrics?.impressions  || 0, 10)
    const leads   = parseFloat(row.metrics?.conversions || 0)
    const revenue = parseFloat(row.metrics?.allConversionsValue || 0)

    push(date, campId, 'spend',       parseFloat(spend.toFixed(2)))
    push(date, campId, 'clicks',      clicks)
    push(date, campId, 'impressions', imps)
    push(date, campId, 'leads',       leads)
    push(date, campId, 'revenue',     parseFloat(revenue.toFixed(2)))
  }

  return { entities, facts }
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  if (!creds?.customer_id)    throw new Error('customer_id required')
  if (!creds?.developer_token) throw new Error('developer_token required')
  if (!creds?.refresh_token)  throw new Error('refresh_token required')

  const accessToken = await refreshAccessToken(creds)
  const custId      = cleanId(creds.customer_id)

  // Simple GAQL to verify the customer is accessible
  const { data } = await axios.post(
    `${ADS_BASE}/customers/${custId}/googleAds:search`,
    { query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' },
    { headers: buildHeaders(creds, accessToken) }
  )

  const name = data.results?.[0]?.customer?.descriptiveName || custId
  return { ok: true, account: name, message: `Connected to Google Ads customer "${name}"` }
}

// ── Connector contract ─────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['customer_id', 'developer_token', 'refresh_token']

const FIELD_LABELS = {
  customer_id:     { label: 'Customer ID',         hint: 'Format: 123-456-7890',                                      secret: false },
  developer_token: { label: 'Developer Token',     hint: 'Google Ads API Center → Apply → Developer Token',            secret: true  },
  refresh_token:   { label: 'OAuth Refresh Token', hint: 'OAuth Playground → scope: https://www.googleapis.com/auth/adwords', secret: true },
  client_id:       { label: 'OAuth Client ID',     hint: 'Optional — or set GOOGLE_CLIENT_ID env var on the server',  secret: false },
  client_secret:   { label: 'OAuth Client Secret', hint: 'Optional — or set GOOGLE_CLIENT_SECRET env var on server',  secret: true  },
}

module.exports = { fetchStats, fetchFacts, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
