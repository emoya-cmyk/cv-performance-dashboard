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
      raw_leads: 0, mql: 0, sql_count: 0,
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
    if (tags.includes('sql') || tags.some(t => t.includes('sales qualified')))     w.sql_count++

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
    sql_count:          w.sql_count,
    closed_won:         w.closed_won,
    projected_revenue:  parseFloat(w.projected_revenue.toFixed(2)),
    // partial channel data from CRM (overlays ad platform data)
    _lsa_calls_crm:     w.lsa_calls,
    _ads_leads_crm:     w.ads_leads,
    _meta_leads_crm:    w.meta_leads,
  }))
}

// ── fetchFacts (atomic grain — the new path) ────────────────────────────────────
// Account-grain CRM facts on the ghl channel, daily-grained by the contact's
// dateAdded / opportunity's createdAt. sync.js prefers this over fetchStats; the
// column-scoped rollup re-derives raw_leads / mql / sql_count / closed_won /
// projected_revenue in weekly_reports — exactly the columns fetchStats wrote.
//
// Entities: none. These are account-level CRM metrics (entity = null), so the
// facts carry no dim_entity rows.
//
// SCOPE NOTE (Phase 0): we deliberately emit ONLY ghl-channel metrics. The CRM
// also knows channel-attributed lead counts (lsa/google_ads/meta), but:
//   • ads_leads / meta_leads are owned by the googleAds / meta connectors
//     (sourced from platform conversions); a CRM 'leads' fact on those channels
//     would double-count in the rollup's SUM.
//   • the dedicated CRM columns (google_ads_leads, lsa_leads, …) are Postgres-
//     only and intentionally absent from COLUMN_FACT_MAP, so the rollup can't
//     write them on SQLite.
// fetchStats already discarded those counts (the _-prefixed keys), so emitting
// only ghl metrics keeps exact parity with the current product. Channel-
// attributed CRM facts are a later increment (distinct metric_key + a both-
// backend column).
async function fetchFacts(creds, { since, until }) {
  const startDate = new Date(`${since}T00:00:00.000Z`)
  const endDate   = new Date(`${until}T23:59:59.999Z`)

  const [contacts, opps] = await Promise.all([
    fetchAllContacts(creds, startDate, endDate),
    fetchAllOpportunities(creds, startDate, endDate),
  ])

  // Daily aggregation at account grain.
  const byDay = {}
  const dayOf = (v) => {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]
  }
  const ensure = (date) => (byDay[date] ||= {
    raw_leads: 0, mql: 0, sql_count: 0, closed_won: 0, projected_revenue: 0,
  })

  for (const c of contacts) {
    const date = dayOf(c.dateAdded || c.createdAt)
    if (!date) continue
    const b    = ensure(date)
    const tags = (c.tags || []).map(t => t.toLowerCase())
    b.raw_leads++
    if (tags.includes('mql') || tags.some(t => t.includes('marketing qualified'))) b.mql++
    if (tags.includes('sql') || tags.some(t => t.includes('sales qualified')))     b.sql_count++
  }

  for (const opp of opps) {
    const date = dayOf(opp.createdAt)
    if (!date) continue
    if ((opp.status || '').toLowerCase() !== 'won') continue
    const b = ensure(date)
    b.closed_won++
    b.projected_revenue += parseFloat(opp.monetaryValue) || 0
  }

  // One account-grain (entity:null) fact per (date, metric) — skip zeros so the
  // table stays lean; the smart-upsert guard means a missing zero never clobbers.
  const facts = []
  for (const [date, b] of Object.entries(byDay)) {
    const push = (metric_key, value) => {
      if (!Number.isFinite(value) || value === 0) return
      facts.push({ date, channel: 'ghl', entity: null, metric_key, value })
    }
    push('raw_leads',         b.raw_leads)
    push('mql',               b.mql)
    push('sql_count',         b.sql_count)
    push('closed_won',        b.closed_won)
    push('projected_revenue', parseFloat(b.projected_revenue.toFixed(2)))
  }

  return { entities: [], facts }
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

module.exports = { fetchStats, fetchFacts, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
