'use strict'

/**
 * CallRail connector — phone call tracking data.
 *
 * Auth:   Authorization: Token token="{api_key}"
 * Base:   https://api.callrail.com/v3/a/{account_id}/
 * Docs:   https://apidocs.callrail.com/
 *
 * Credentials:
 *   api_key    — CallRail API key (Settings → Integrations → API)
 *   account_id — CallRail account ID (visible in the account URL or dashboard)
 *
 * Metrics emitted (channel: callrail):
 *   calls              — total inbound calls
 *   answered_calls     — calls marked answered
 *   first_time_callers — first-time callers (lead signal)
 *   missed_calls       — unanswered calls (lost lead signal)
 */

const https = require('https')

const BASE_URL = 'https://api.callrail.com'

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.callrail.com',
      port:     443,
      path,
      method:   'GET',
      headers:  { Authorization: `Token token="${apiKey}"`, 'Accept': 'application/json' },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`CallRail ${res.statusCode}: ${data}`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Fetch all pages of calls in [startDate, endDate] ─────────────────────────

async function fetchCallPages(apiKey, accountId, startDate, endDate) {
  const fields = [
    'start_time', 'duration', 'answered', 'first_call',
    'tracking_source', 'lead_status', 'direction'
  ].join(',')

  const calls = []
  let page = 1
  let totalPages = 1

  do {
    const qs = new URLSearchParams({
      date_range:   'custom',
      start_date:   startDate,
      end_date:     endDate,
      fields,
      per_page:     '250',
      page:         String(page),
      sort:         'start_time',
      direction:    'inbound',
    }).toString()

    const data = await get(`/v3/a/${accountId}/calls.json?${qs}`, apiKey)
    const batch = data.calls || []
    calls.push(...batch)
    totalPages = data.pagination?.total_pages ?? 1
    page++
  } while (page <= totalPages)

  return calls
}

// ── fetchFacts ────────────────────────────────────────────────────────────────

async function fetchFacts(creds, { since, until }) {
  const { api_key, account_id } = creds
  if (!api_key)    throw new Error('api_key required')
  if (!account_id) throw new Error('account_id required')

  const calls = await fetchCallPages(api_key, account_id, since, until)

  // Bucket by date
  const byDay = {}
  for (const call of calls) {
    const date = (call.start_time || '').split('T')[0]
    if (!date || date < since || date > until) continue

    const d = (byDay[date] ||= { total: 0, answered: 0, first_time: 0, missed: 0 })
    d.total++
    if (call.answered)    d.answered++
    if (call.first_call)  d.first_time++
    if (!call.answered)   d.missed++
  }

  const facts = []
  for (const [date, d] of Object.entries(byDay)) {
    const push = (metric_key, value) => {
      if (value > 0) facts.push({ date, channel: 'callrail', entity: null, metric_key, value })
    }
    push('calls',              d.total)
    push('answered_calls',     d.answered)
    push('first_time_callers', d.first_time)
    push('missed_calls',       d.missed)
  }

  return { entities: [], facts }
}

// ── fetchStats (legacy weekly path) ──────────────────────────────────────────

async function fetchStats(creds, weeksBack = 8) {
  const { api_key, account_id } = creds
  if (!api_key)    throw new Error('api_key required')
  if (!account_id) throw new Error('account_id required')

  const until = new Date()
  const since = new Date(until)
  since.setUTCDate(since.getUTCDate() - weeksBack * 7)

  const fmt = d => d.toISOString().split('T')[0]
  const calls = await fetchCallPages(api_key, account_id, fmt(since), fmt(until))

  // Group by week
  const weeks = {}
  for (const call of calls) {
    const date = (call.start_time || '').split('T')[0]
    if (!date) continue
    const d     = new Date(date)
    const day   = d.getUTCDay()
    const monday = new Date(d)
    monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7))
    const week = monday.toISOString().split('T')[0]

    const w = (weeks[week] ||= { week_start: week, total: 0, answered: 0, first_time: 0 })
    w.total++
    if (call.answered)   w.answered++
    if (call.first_call) w.first_time++
  }

  return Object.values(weeks).sort((a, b) => a.week_start.localeCompare(b.week_start))
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  if (!creds?.api_key)    throw new Error('api_key required')
  if (!creds?.account_id) throw new Error('account_id required')

  const data = await get(`/v3/a/${creds.account_id}/trackers.json?per_page=1`, creds.api_key)
  const count = data.pagination?.total_records ?? 0
  return { ok: true, message: `Connected — ${count} tracker(s) found on account ${creds.account_id}` }
}

// ── Connector contract ────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['api_key', 'account_id']

const FIELD_LABELS = {
  api_key:    { label: 'CallRail API Key',  hint: 'Settings → Integrations → API → API Key', secret: true },
  account_id: { label: 'Account ID',        hint: 'Visible in your CallRail account URL',      secret: false },
}

module.exports = { fetchStats, fetchFacts, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
