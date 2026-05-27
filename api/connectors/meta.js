'use strict'

/**
 * Meta (Facebook / Instagram) Ads connector — Graph API v19.
 *
 * Credentials:
 *   account_id   — Ad Account ID (numeric, or with 'act_' prefix)
 *   access_token — System User Access Token (long-lived; does not expire unless revoked)
 *
 * How to get credentials:
 *   1. Meta Business Manager → Settings → Business Users → System Users → Create
 *   2. Generate Token with scopes: ads_read, ads_management, business_management
 *   3. Add the system user as an Admin on the Ad Account
 *
 * Leads are counted from the "lead" action_type family in insights response.
 * Revenue comes from "purchase" / "omni_purchase" action values.
 */

const axios = require('axios')

const GRAPH_BASE = 'https://graph.facebook.com/v19.0'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d) {
  return d.toISOString().split('T')[0]
}

// Normalize an ISO date string to the Monday of that week
function toWeekStart(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z')
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

// Sum values for lead-type actions
const LEAD_TYPES = new Set([
  'lead',
  'onsite_lead',
  'offsite_conversion.fb_pixel_lead',
  'omni_lead',
  'contact_total',
])

function extractLeads(actions = []) {
  return actions
    .filter(a => LEAD_TYPES.has(a.action_type))
    .reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0)
}

const REVENUE_TYPES = new Set(['purchase', 'omni_purchase'])

function extractRevenue(actionValues = []) {
  return actionValues
    .filter(a => REVENUE_TYPES.has(a.action_type))
    .reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0)
}

// ── fetchStats ────────────────────────────────────────────────────────────────
// Returns array of { week_start, meta_spend, meta_clicks, meta_impressions, meta_leads, meta_roas }

async function fetchStats(creds, weeksBack = 8) {
  const endDate   = new Date(); endDate.setUTCHours(0,0,0,0)
  const startDate = new Date(endDate)
  startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7)

  const accountId = String(creds.account_id).replace(/^act_/, '')

  // time_increment=7 returns one row per 7-day window
  const { data } = await axios.get(
    `${GRAPH_BASE}/act_${accountId}/insights`,
    {
      params: {
        access_token:    creds.access_token,
        fields:          'spend,clicks,impressions,actions,action_values,date_start,date_stop',
        time_increment:  7,
        time_range:      JSON.stringify({ since: fmtDate(startDate), until: fmtDate(endDate) }),
        limit:           200,
        level:           'account',
      },
    }
  )

  if (data.error) throw new Error(`Meta API: ${data.error.message || JSON.stringify(data.error)}`)

  const weeks = {}
  for (const row of (data.data || [])) {
    const week    = toWeekStart(row.date_start)
    const spend   = parseFloat(row.spend       || 0)
    const clicks  = parseInt(row.clicks        || 0, 10)
    const imps    = parseInt(row.impressions   || 0, 10)
    const leads   = extractLeads(row.actions   || [])
    const revenue = extractRevenue(row.action_values || [])

    if (!weeks[week]) {
      weeks[week] = {
        week_start: week,
        meta_spend: 0, meta_clicks: 0, meta_impressions: 0, meta_leads: 0, _revenue: 0,
      }
    }
    weeks[week].meta_spend       += spend
    weeks[week].meta_clicks      += clicks
    weeks[week].meta_impressions += imps
    weeks[week].meta_leads       += leads
    weeks[week]._revenue         += revenue
  }

  return Object.values(weeks)
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map(w => ({
      week_start:       w.week_start,
      meta_spend:       parseFloat(w.meta_spend.toFixed(2)),
      meta_clicks:      Math.round(w.meta_clicks),
      meta_impressions: Math.round(w.meta_impressions),
      meta_leads:       Math.round(w.meta_leads),
      meta_roas:        w.meta_spend > 0 ? parseFloat((w._revenue / w.meta_spend).toFixed(2)) : 0,
    }))
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  if (!creds?.access_token) throw new Error('access_token required')
  if (!creds?.account_id)   throw new Error('account_id required')

  const accountId = String(creds.account_id).replace(/^act_/, '')

  const { data } = await axios.get(
    `${GRAPH_BASE}/act_${accountId}`,
    {
      params: {
        access_token: creds.access_token,
        fields:       'id,name,account_status,currency',
      },
    }
  )

  if (data.error) throw new Error(`Meta API: ${data.error.message || JSON.stringify(data.error)}`)

  const STATUS_MAP = {
    1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED',
    7: 'PENDING_RISK_REVIEW', 9: 'IN_GRACE_PERIOD',
    100: 'PENDING_CLOSURE', 101: 'CLOSED',
    201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
  }
  const status = STATUS_MAP[data.account_status] || `Status ${data.account_status}`
  const name   = data.name || `act_${accountId}`

  if (data.account_status !== 1) {
    return { ok: false, account: name, message: `Account "${name}" status: ${status}` }
  }
  return { ok: true, account: name, message: `Connected to Meta Ad Account "${name}" (${data.currency || ''})` }
}

// ── Connector contract ─────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['account_id', 'access_token']

const FIELD_LABELS = {
  account_id:   { label: 'Ad Account ID',            hint: 'Numeric ID or act_XXXXXXXXXX from Business Manager', secret: false },
  access_token: { label: 'System User Access Token', hint: 'Meta Business Manager → System Users → Generate Token (ads_read scope)', secret: true },
}

module.exports = { fetchStats, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
