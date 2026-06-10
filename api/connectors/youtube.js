'use strict'

/**
 * YouTube Ads / Analytics connector.
 *
 * Uses the YouTube Analytics API v2 for channel/ad performance data.
 * Auth: OAuth 2.0 with Google refresh_token (same Google account that owns the YouTube channel).
 *
 * Credentials:
 *   refresh_token — OAuth refresh token (scope: youtube.readonly)
 *   client_id     — Google OAuth client_id (or GOOGLE_CLIENT_ID env var)
 *   client_secret — Google OAuth client_secret (or GOOGLE_CLIENT_SECRET env var)
 *   channel_id    — YouTube channel ID (starts with UC...) — optional, defaults to "mine"
 *
 * Metrics emitted (channel: youtube):
 *   views          — video views
 *   watch_time     — estimated minutes watched
 *   impressions    — ad impressions (where available)
 *   clicks         — card / overlay clicks
 *   subscriptions  — new subscribers gained
 */

const https = require('https')

const TOKEN_URL   = 'https://oauth2.googleapis.com'
const YOUTUBE_URL = 'https://youtubeanalytics.googleapis.com'

// ── OAuth ─────────────────────────────────────────────────────────────────────

async function refreshAccessToken(creds) {
  const clientId     = creds.client_id     || process.env.GOOGLE_CLIENT_ID     || ''
  const clientSecret = creds.client_secret || process.env.GOOGLE_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) throw new Error('client_id and client_secret required')

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: creds.refresh_token,
  }).toString()

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth2.googleapis.com',
      port:     443,
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(`OAuth: ${parsed.error_description || parsed.error}`))
          else resolve(parsed.access_token)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── YouTube Analytics API request ─────────────────────────────────────────────

async function fetchYouTubeAnalytics(accessToken, channelId, startDate, endDate) {
  const ids      = channelId ? `channel==${channelId}` : 'channel==MINE'
  const metrics  = 'views,estimatedMinutesWatched,subscribersGained,cardClicks,cardImpressions'
  const dims     = 'day'

  const qs = new URLSearchParams({
    ids,
    startDate,
    endDate,
    metrics,
    dimensions: dims,
    sort:       'day',
  }).toString()

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'youtubeanalytics.googleapis.com',
      port:     443,
      path:     `/v2/reports?${qs}`,
      method:   'GET',
      headers:  { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`YouTube Analytics ${res.statusCode}: ${data}`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── fetchFacts ────────────────────────────────────────────────────────────────

async function fetchFacts(creds, { since, until }) {
  if (!creds?.refresh_token) throw new Error('refresh_token required')

  const accessToken = await refreshAccessToken(creds)
  let data
  try {
    data = await fetchYouTubeAnalytics(accessToken, creds.channel_id || null, since, until)
  } catch (err) {
    console.warn('[youtube] analytics API error, falling back to empty:', err.message)
    return { entities: [], facts: [] }
  }

  // Parse column headers from the response
  const rows    = data.rows   || []
  const headers = (data.columnHeaders || []).map(h => h.name)

  const dayIdx         = headers.indexOf('day')
  const viewsIdx       = headers.indexOf('views')
  const watchTimeIdx   = headers.indexOf('estimatedMinutesWatched')
  const subsIdx        = headers.indexOf('subscribersGained')
  const clicksIdx      = headers.indexOf('cardClicks')
  const impressionsIdx = headers.indexOf('cardImpressions')

  const facts = []
  for (const row of rows) {
    const date = dayIdx >= 0 ? row[dayIdx] : null
    if (!date) continue

    const push = (metric_key, idx) => {
      if (idx < 0) return
      const value = Number(row[idx])
      if (value > 0) facts.push({ date, channel: 'youtube', entity: null, metric_key, value })
    }
    push('views',        viewsIdx)
    push('watch_time',   watchTimeIdx)
    push('subscriptions', subsIdx)
    push('clicks',       clicksIdx)
    push('impressions',  impressionsIdx)
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
  if (!creds?.refresh_token) throw new Error('refresh_token required')

  const accessToken = await refreshAccessToken(creds)

  // Verify by fetching channel info
  return new Promise((resolve, reject) => {
    const channelId = creds.channel_id || ''
    const qs = new URLSearchParams({
      part: 'snippet',
      ...(channelId ? { id: channelId } : { mine: 'true' }),
    }).toString()
    const options = {
      hostname: 'www.googleapis.com',
      port:     443,
      path:     `/youtube/v3/channels?${qs}`,
      method:   'GET',
      headers:  { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(`YouTube ${res.statusCode}: ${data}`))
            return
          }
          const channel = parsed.items?.[0]?.snippet?.title || 'Unknown channel'
          resolve({ ok: true, message: `Connected — YouTube channel: ${channel}` })
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Connector contract ────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['refresh_token']

const FIELD_LABELS = {
  refresh_token: { label: 'Google OAuth Refresh Token', hint: 'scope: youtube.readonly + yt-analytics.readonly', secret: true },
  client_id:     { label: 'Google Client ID',           hint: 'Optional — or set GOOGLE_CLIENT_ID env var', secret: false },
  client_secret: { label: 'Google Client Secret',       hint: 'Optional — or set GOOGLE_CLIENT_SECRET env var', secret: true },
  channel_id:    { label: 'YouTube Channel ID',         hint: 'Starts with UC… — optional, defaults to your account\'s channel', secret: false },
}

module.exports = { fetchStats, fetchFacts, testConnection, REQUIRED_FIELDS, FIELD_LABELS }
