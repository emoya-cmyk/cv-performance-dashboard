'use strict'

const { query } = require('../db')

// ============================================================================
// lib/alertDelivery.js — Slack webhook + Resend email alert delivery
//
// Pure I/O module: takes a structured alert and fans it out to configured
// channels. Two delivery paths:
//   • Slack  — POST to SLACK_WEBHOOK_URL (webhook, no auth required in env)
//   • Email  — Resend REST API using RESEND_API_KEY + FROM_EMAIL env vars
//
// Both paths are opt-in: if the env var is absent, that channel is silently
// skipped. No crash, no noise. This ensures the server stays up even when
// Slack or email isn't configured.
//
// Usage:
//   const { sendAlert, sendDigest } = require('./alertDelivery')
//   await sendAlert({ title, body, severity, clientName, url })
//   await sendDigest({ to, subject, html })
// ============================================================================

const https = require('https')
const http  = require('http')

// ── Slack ────────────────────────────────────────────────────────────────────

function buildSlackPayload(alert) {
  const colorMap = { critical: '#e53e3e', warning: '#dd6b20', info: '#3182ce', success: '#38a169' }
  const color    = colorMap[alert.severity] || colorMap.info

  const fields = []
  if (alert.clientName) fields.push({ title: 'Client', value: alert.clientName, short: true })
  if (alert.channel)    fields.push({ title: 'Channel', value: alert.channel, short: true })
  if (alert.metric)     fields.push({ title: 'Metric', value: alert.metric, short: true })
  if (alert.value != null) fields.push({ title: 'Value', value: String(alert.value), short: true })

  const attachment = {
    color,
    title:     alert.title || 'Dashboard Alert',
    text:      alert.body  || '',
    fields,
    footer:    'Performance Dashboard',
    ts:        Math.floor(Date.now() / 1000),
  }
  if (alert.url) attachment.title_link = alert.url

  return JSON.stringify({ attachments: [attachment] })
}

async function postSlack(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(webhookUrl)
    const lib      = parsed.protocol === 'https:' ? https : http
    const body     = payload
    const options  = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true })
        else reject(new Error(`Slack ${res.statusCode}: ${data}`))
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Resend email ─────────────────────────────────────────────────────────────

async function postResend(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload)
    const options = {
      hostname: 'api.resend.com',
      port:     443,
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data))
        else reject(new Error(`Resend ${res.statusCode}: ${data}`))
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a structured alert to all configured channels (Slack and/or email).
 *
 * @param {{
 *   title:      string,
 *   body:       string,
 *   severity?:  'critical'|'warning'|'info'|'success',
 *   clientName?: string,
 *   channel?:   string,
 *   metric?:    string,
 *   value?:     number|string,
 *   url?:       string,
 *   to?:        string,   // override recipient for email alerts
 * }} alert
 * @returns {Promise<{ slack?: boolean, email?: boolean, errors: string[] }>}
 */
async function sendAlert(alert) {
  const results = { slack: false, email: false, errors: [] }

  const slackUrl = process.env.SLACK_WEBHOOK_URL
  if (slackUrl) {
    try {
      await postSlack(slackUrl, buildSlackPayload(alert))
      results.slack = true
    } catch (err) {
      results.errors.push(`slack: ${err.message}`)
      console.error('[alertDelivery] slack error:', err.message)
    }
  }

  const apiKey  = process.env.RESEND_API_KEY
  const from    = process.env.FROM_EMAIL || 'alerts@performancedashboard.io'
  const to      = alert.to || process.env.ALERT_EMAIL
  if (apiKey && to) {
    try {
      await postResend(apiKey, {
        from,
        to,
        subject: `[${(alert.severity || 'info').toUpperCase()}] ${alert.title}`,
        html: `<p>${alert.body}</p>${alert.url ? `<p><a href="${alert.url}">View in dashboard →</a></p>` : ''}`,
      })
      results.email = true
    } catch (err) {
      results.errors.push(`email: ${err.message}`)
      console.error('[alertDelivery] email error:', err.message)
    }
  }

  return results
}

/**
 * Send a rich HTML digest email (weekly reports, Monday brief, etc.).
 * Falls through silently if RESEND_API_KEY is absent.
 *
 * @param {{ to: string|string[], subject: string, html: string, from?: string }} opts
 */
async function sendDigest({ to, subject, html, from }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return { ok: false, reason: 'RESEND_API_KEY not configured' }

  const sender = from || process.env.FROM_EMAIL || 'reports@performancedashboard.io'
  try {
    const result = await postResend(apiKey, { from: sender, to, subject, html })
    return { ok: true, id: result.id }
  } catch (err) {
    console.error('[alertDelivery] digest error:', err.message)
    return { ok: false, error: err.message }
  }
}

/**
 * Fire-and-forget alert — logs errors but never throws. Safe for callers that
 * should never be blocked by delivery failure (e.g. the intelligence sweep).
 */
function fireAlert(alert) {
  query(
    `INSERT INTO fired_alerts (severity, title, body, client_id, client_name, metric, value, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      alert.severity   || null,
      alert.title      || null,
      alert.body       || null,
      alert.clientId   || null,
      alert.clientName || null,
      alert.metric     || null,
      alert.value != null ? String(alert.value) : null,
      alert.channel    || null,
    ]
  ).catch(err => console.error('[alertDelivery] fired_alerts insert error:', err.message))

  sendAlert(alert).catch(err => console.error('[alertDelivery] fireAlert error:', err.message))
}

module.exports = { sendAlert, sendDigest, fireAlert }
