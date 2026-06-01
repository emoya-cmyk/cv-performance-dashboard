'use strict'

// ============================================================
// routes/insights.js — the Intelligence-layer HTTP surface.
//
//   GET  /api/insights[?limit=]
//        Portfolio roll-up: every client's active findings (open + acknowledged)
//        in one severity-ranked stream, each tagged with its client_name. This is
//        what the agency-wide Intelligence page hits.
//
//   GET  /api/insights/:clientId[?limit=]
//        One client's active feed — the per-client Insights card.
//
//   POST /api/insights/:id/ack
//   POST /api/insights/:id/resolve
//        Lifecycle: a human acknowledges ("we're on it", stays visible/muted) or
//        resolves ("handled", drops out). The engine's re-sweeps never overwrite a
//        status set here, so the decision sticks. 404 if the id is unknown.
//
//   POST /api/insights/run            { asOf?, weeks? }
//   POST /api/insights/:clientId/run  { asOf?, weeks? }
//        Manually trigger an intelligence pass — the whole portfolio, or one
//        client. Normally the scheduler fires the portfolio sweep nightly; this is
//        the on-demand button for a fresh look right now.
//
// Mounted behind requireAuth in server.js — every caller is agency/internal staff,
// so insight ids are not tenant-scoped in the path. The engine never throws on the
// detection path (degrades to deterministic templates), so a 5xx here only ever
// means a DB/transport fault.
// ============================================================

const express = require('express')
const { query } = require('../db')
const {
  getInsightFeed, getPortfolioInsights,
  ackInsight, resolveInsight,
  runInsightsForClient, runInsightsForAll,
} = require('../lib/insights')

const router = express.Router()

// Clamp a caller-supplied ?limit to a sane window; undefined → use the lib default.
function parseLimit(raw, fallback) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), 500)
}

// Insights FK-reference clients(id); a sweep for an unknown client would trip the
// foreign key. Check up front so we can 404 cleanly.
async function clientExists(clientId) {
  const { rows } = await query(`SELECT id FROM clients WHERE id = $1`, [clientId])
  return rows.length > 0
}

// Roll a feed into a {critical,warning,info} tally for the header badges.
function tallyBySeverity(insights) {
  const t = { critical: 0, warning: 0, info: 0 }
  for (const i of insights) if (t[i.severity] != null) t[i.severity]++
  return t
}

// ── GET /api/insights ─────────────────────────────────────────────────────────
// Portfolio-wide active feed, severity-ranked, with per-client names.
router.get('/', async (req, res) => {
  try {
    const insights = await getPortfolioInsights({ limit: parseLimit(req.query.limit, 100) })
    res.json({ insights, count: insights.length, by_severity: tallyBySeverity(insights) })
  } catch (err) {
    console.error('[insights] GET portfolio error', err.message)
    res.status(500).json({ error: 'Failed to load insights' })
  }
})

// ── POST /api/insights/run ────────────────────────────────────────────────────
// On-demand full-portfolio sweep. Body may pin { asOf, weeks } (the scheduler
// passes neither → "now", 26 weeks). Declared before the param routes so the
// literal "run" can never be swallowed as a :clientId.
router.post('/run', async (req, res) => {
  try {
    const summary = await runInsightsForAll({ asOf: req.body?.asOf, weeks: req.body?.weeks })
    res.json(summary)
  } catch (err) {
    console.error('[insights] POST run-all error', err.message)
    res.status(500).json({ error: 'Failed to run insights sweep' })
  }
})

// ── POST /api/insights/:id/ack ────────────────────────────────────────────────
router.post('/:id/ack', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'insight id must be a positive integer' })
  }
  try {
    const row = await ackInsight(id)
    if (!row) return res.status(404).json({ error: 'insight not found' })
    res.json(row)
  } catch (err) {
    console.error('[insights] POST ack error', err.message)
    res.status(500).json({ error: 'Failed to acknowledge insight' })
  }
})

// ── POST /api/insights/:id/resolve ────────────────────────────────────────────
router.post('/:id/resolve', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'insight id must be a positive integer' })
  }
  try {
    const row = await resolveInsight(id)
    if (!row) return res.status(404).json({ error: 'insight not found' })
    res.json(row)
  } catch (err) {
    console.error('[insights] POST resolve error', err.message)
    res.status(500).json({ error: 'Failed to resolve insight' })
  }
})

// ── POST /api/insights/:clientId/run ──────────────────────────────────────────
// Single-client on-demand sweep. :clientId is a UUID, distinct from the integer
// :id of the ack/resolve routes, so the patterns never collide.
router.post('/:clientId/run', async (req, res) => {
  const { clientId } = req.params
  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const result = await runInsightsForClient(clientId, {
      asOf: req.body?.asOf,
      weeks: req.body?.weeks ?? 26,
    })
    res.json(result)
  } catch (err) {
    console.error('[insights] POST run-client error', err.message)
    res.status(500).json({ error: 'Failed to run insights for client' })
  }
})

// ── GET /api/insights/:clientId ───────────────────────────────────────────────
// One client's active feed. Declared last so it can't shadow the literal routes.
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params
  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const insights = await getInsightFeed(clientId, { limit: parseLimit(req.query.limit, 50) })
    res.json({
      client_id: clientId,
      insights,
      count: insights.length,
      by_severity: tallyBySeverity(insights),
    })
  } catch (err) {
    console.error('[insights] GET client feed error', err.message)
    res.status(500).json({ error: 'Failed to load client insights' })
  }
})

module.exports = router
