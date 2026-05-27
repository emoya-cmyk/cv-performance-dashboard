// GHL (GoHighLevel) CRM connector
// Fetches contacts and opportunities to populate MQL/SQL/revenue data.
// Complements webhook events with a full periodic backfill.
//
// Credentials required:
//   location_id — GHL sub-account location ID
//   api_key     — Private Integration Token (PIT)
//
// How to get a Private Integration Token:
//   GHL → Settings → API → Private Integrations → Create New Integration
//   Scopes needed: contacts.readonly, opportunities.readonly, locations.readonly
//
// Lead source detection logic:
//   Contact tags → "MQL", "SQL", "Google Ads", "LSA", "Meta" / "Facebook"
//   Contact attributionSource.medium → "cpc", "lsa", "paid_social"
//   Opportunity status → "won" → closed_won, monetaryValue → revenue

const axios = require('axios')

const BASE = 'https://services.leadconnectorhq.com'

function toWeekStart(dateStr) {
  const d   = new Date(dateStr)
  const day = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day))
  return d.toISOString().split('T')[0]
}

function headers(creds) {
  return {
    Authorization: `Bearer ${creds.api_key}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  }
}

function detectChannel(contact) {
  const src = (
    contact?.attributionSource?.medium ||
    contact?.attributionSource?.source ||
    contact?.source || ''
  ).toLowerCase()
  const tags = (contact.tags || []).map(t => t.toLowerCase())

  if (src.includes('lsa') || src.includes('local_service') || tags.includes('lsa')) return 'lsa'
  if (src.includes('facebook') || src.includes('instagram') || src.includes('fb') ||
      tags.some(t => t.includes('meta') || t.includes('facebook'))) return 'meta'
  if (src.includes('google') || src.includes('cpc') || tags.includes('google ads')) return 'google_ads'
  return 'organic'
}

async function fetchAllContacts(creds, startDate, endDate) {
  const all = []
  let page  = 1
  const limit = 100

  while (true) {
    const { data } = await axios.get(`${BASE}/contacts/`, {
      headers: headers(creds),
      params: {
        locationId: creds.location_id,
        limit,
        page,
        startDate: startDate.toISOString(),
        endDate:   endDate.toISOString(),
      },
    })
    const contacts = data.contacts || data.data || []
    all.push(...contacts)
    if (contacts.length < limit) break
    page++
    if (page > 20) break // safety cap
  }
  return all
}

async function fetchAllOpportunities(creds, startDate, endDate) {
  const all = []
  let startAfterId = null
  const limit = 100

  while (true) {
    const params = {
      location_id: creds.location_id,
      limit,
      date:    startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
    }
    if (startAfterId) params.startAfterId = startAfterId

    const { data } = await axios.get(`${BASE}/opportunities/search`, {
      headers: headers(creds),
      params,
    })
    const opps = data.opportunities || data.data || []
    all.push(...opps)
    if (opps.length < limit) break
    startAfterId = opps[opps.length - 1]?.id
    if (!startAfterId) break
  }
  return all
}

async function fetchStats(creds, weeksBack = 8) {
  const endDate   = new Date(); endDate.setUTCHours(23,59,59,999)
  const startDate = new Date(); startDate.setUTCDate(startDate.getUTCDate() - weeksBack * 7)
  startDate.setUTCHours(0,0,0,0)

  const [contacts, opps] = await Promise.all([
    fetchAllContacts(creds, startDate, endDate),
    fetchAllOpportunities(creds, startDate, endDate),
  ])

  const weeks = {}
  const ensure = (week) => {
    if (!weeks[week]) weeks[week] = {
      week,
      raw_leads: 0, mql: 0, sql: 0,
      closed_won: 0, projected_revenue: 0,
      lsa_calls: 0, ads_leads: 0, meta_leads: 0,
    }
    return weeks[week]
  }

  for (const c of contacts) {
    const week  = toWeekStart(c.dateAdded || c.createdAt)
    const w     = ensure(week)
    const tags  = (c.tags || []).map(t => t.toLowerCase())
    const ch    = detectChannel(c)

    w.raw_leads++
    if (tags.includes('mql') || tags.some(t => t.includes('marketing qualified'))) w.mql++
    if (tags.includes('sql') || tags.some(t => t.includes('sales qualified')))     w.sql++

    if (ch === 'lsa')        w.lsa_calls++
    if (ch === 'google_ads') w.ads_leads++
    if (ch === 'meta')       w.meta_leads++
  }

  for (const opp of opps) {
    const week = toWeekStart(opp.createdAt)
    const w    = ensure(week)
    if ((opp.status || '').toLowerCase() === 'won') {
      w.closed_won++
      w.projected_revenue += parseFloat(opp.monetaryValue) || 0
    }
  }

  return Object.values(weeks).map(w => ({
    week_start:         w.week,
    raw_leads:          w.raw_leads,
    mql:                w.mql,
    sql:                w.sql,
    closed_won:         w.closed_won,
    projected_revenue:  parseFloat(w.projected_revenue.toFixed(2)),
    // partial channel data from CRM (overlays ad platform data)
    _lsa_calls_crm:     w.lsa_calls,
    _ads_leads_crm:     w.ads_leads,
    _meta_leads_crm:    w.meta_leads,
  }))
}

async function testConnection(creds) {
  const { data } = await axios.get(`${BASE}/locations/${creds.location_id}`, {
    headers: headers(creds),
  })
  return { ok: true, account: data.location?.name || data.name || creds.location_id }
}

const REQUIRED_FIELDS = ['location_id', 'api_key']

const FIELD_LABELS = {
  location_id: { label: 'Location ID',               hint: 'GHL sub-account location ID (shown in URL)', secret: false },
  api_key:     { label: 'Private Integration Token',  hint: 'GHL → Settings → API → Private Integrations', secret: true },
}

module.exports = { fetchStats, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
