'use strict'

/**
 * HouseCall Pro connector — job management & revenue data.
 *
 * Auth:   Authorization: Bearer {api_key}
 * Base:   https://api.housecallpro.com/v1/
 * Docs:   https://docs.housecallpro.com/
 *
 * Credentials:
 *   api_key — HouseCall Pro API key (Settings → Integrations → API)
 *
 * Metrics emitted (channel: housecallpro):
 *   jobs_created    — new jobs created per day
 *   jobs_completed  — jobs completed per day
 *   job_revenue     — invoiced/paid revenue per day
 *   avg_ticket      — avg invoice value (rate, averaged)
 *   booked_jobs     — jobs scheduled (maps to existing semantic metric)
 */

const https = require('https')

const HCPRO_HOST = 'api.housecallpro.com'

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(path, apiKey, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HCPRO_HOST,
      port:     443,
      path,
      method,
      headers:  { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HouseCallPro ${res.statusCode}: ${data}`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Fetch all jobs in a date range ────────────────────────────────────────────

async function fetchJobs(apiKey, startDate, endDate) {
  const jobs = []
  let page = 1
  const perPage = 100

  while (true) {
    const qs = new URLSearchParams({
      page:          String(page),
      per_page:      String(perPage),
      sort_direction: 'asc',
      // Filter by scheduled date range
      scheduled_start_min: `${startDate}T00:00:00Z`,
      scheduled_start_max: `${endDate}T23:59:59Z`,
    }).toString()

    const data = await request(`/v1/jobs?${qs}`, apiKey)
    const batch = data.jobs || []
    jobs.push(...batch)

    if (batch.length < perPage) break
    page++
    if (page > 50) break  // safety cap: 5000 jobs
  }

  return jobs
}

// ── fetchFacts ────────────────────────────────────────────────────────────────

async function fetchFacts(creds, { since, until }) {
  const { api_key } = creds
  if (!api_key) throw new Error('api_key required')

  const jobs = await fetchJobs(api_key, since, until)

  const byDay = {}

  for (const job of jobs) {
    // created_at for "jobs_created", completed_at for "jobs_completed"
    const createdDate   = (job.created_at   || '').split('T')[0]
    const completedDate = (job.completed_at || '').split('T')[0]
    const scheduledDate = (job.scheduled_start || job.scheduled_at || '').split('T')[0]

    // Track created jobs
    const cDate = createdDate || scheduledDate
    if (cDate && cDate >= since && cDate <= until) {
      const d = (byDay[cDate] ||= { created: 0, completed: 0, revenue: 0, booked: 0, revCount: 0 })
      d.created++
      if (job.work_status === 'scheduled') d.booked++
    }

    // Track completed jobs + revenue
    if (completedDate && completedDate >= since && completedDate <= until) {
      const d = (byDay[completedDate] ||= { created: 0, completed: 0, revenue: 0, booked: 0, revCount: 0 })
      d.completed++
      const rev = parseFloat(job.total_amount || job.invoice_total || 0)
      if (rev > 0) {
        d.revenue   += rev
        d.revCount++
      }
    }
  }

  const facts = []
  for (const [date, d] of Object.entries(byDay)) {
    const push = (metric_key, value) => {
      if (value > 0) facts.push({ date, channel: 'housecallpro', entity: null, metric_key, value })
    }
    push('jobs_created',   d.created)
    push('jobs_completed', d.completed)
    push('booked_jobs',    d.booked)
    if (d.revenue > 0) {
      push('job_revenue', parseFloat(d.revenue.toFixed(2)))
      if (d.revCount > 0) push('avg_ticket', parseFloat((d.revenue / d.revCount).toFixed(2)))
    }
  }

  return { entities: [], facts }
}

// ── fetchStats (legacy) ───────────────────────────────────────────────────────

async function fetchStats(creds, weeksBack = 8) {
  const until = new Date()
  const since = new Date(until)
  since.setUTCDate(since.getUTCDate() - weeksBack * 7)
  const fmt = d => d.toISOString().split('T')[0]

  const payload = await fetchFacts(creds, { since: fmt(since), until: fmt(until) })
  return payload.facts || []
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  if (!creds?.api_key) throw new Error('api_key required')
  const data = await request('/v1/company', creds.api_key)
  const name = data.company?.name || 'Unknown company'
  return { ok: true, message: `Connected — ${name}` }
}

// ── Connector contract ────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['api_key']

const FIELD_LABELS = {
  api_key: { label: 'HouseCall Pro API Key', hint: 'Settings → Integrations → API', secret: true },
}

module.exports = { fetchStats, fetchFacts, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
