'use strict'

// ============================================================
// routes/insights.js — the Intelligence-layer HTTP surface.
//
//   GET  /api/insights[?limit=]
//        Portfolio roll-up: every client's active findings (open + acknowledged)
//        in one severity-ranked stream, each tagged with its client_name. This is
//        what the agency-wide Intelligence page hits.
//
//   GET  /api/insights/health
//        Portfolio TRIAGE ROSTER: every client rolled into one 0–100 health score
//        and band, ranked worst-first — the "where do I look first?" capstone. The
//        synthesis grain on top of the per-finding stream above.
//
//   GET  /api/insights/benchmarks[?weeks=]
//        Portfolio PEER BENCHMARK: each KPI's cross-client distribution + every
//        client's direction-aware percentile/quartile over a trailing window. The
//        one axis the per-client baselines can't see — "who leads, who lags." Agency
//        surface only (carries peer identities); the client view is the standing
//        folded into GET /:clientId, which is stripped to anonymous self-numbers.
//
//   GET  /api/insights/recoveries[?limit=&days=]
//        Portfolio "what we fixed" win stream: every client's recently RECOVERED
//        findings (problem measurably cleared), newest fix first, each tagged with
//        its client_name. The positive counterpart to GET / (active problems).
//
//   GET  /api/insights/:clientId[?limit=]
//        One client's active feed — the per-client Insights card — plus that
//        client's own health verdict (same pure synthesis as the roster), its
//        privacy-safe peer STANDING (own percentile vs the anonymous distribution),
//        and its recent RECOVERIES (the "what we fixed lately" win list).
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
  getInsightFeed, getPortfolioInsights, getPortfolioHealth,
  getPortfolioBenchmarks, getClientStanding,
  getRecentRecoveries, getPortfolioRecoveries,
  ackInsight, resolveInsight,
  runInsightsForClient, runInsightsForAll,
} = require('../lib/insights')
// Pure synthesis: one client's feed → { score, band, counts, driver, contributors }.
const { scoreClient } = require('../lib/health')

const router = express.Router()

// Clamp a caller-supplied ?limit to a sane window; undefined → use the lib default.
function parseLimit(raw, fallback) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), 500)
}

// Clamp a caller-supplied ?weeks (benchmark trailing window) to 1..52; undefined →
// fallback. Coerced HERE because query params arrive as strings — the lib's numeric
// guard would otherwise see "4" (a string), fail Number.isFinite, and silently default.
function parseWeeks(raw, fallback) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), 52)
}

// Clamp a caller-supplied ?days (recoveries trailing window) to 1..365; undefined →
// fallback. Same string-coercion rationale as parseWeeks.
function parseDays(raw, fallback) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), 365)
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

// Roll a health roster into a {healthy,watch,at_risk,critical} count — the triage
// header's "3 at risk, 1 critical" summary at a glance.
function tallyByBand(roster) {
  const t = { healthy: 0, watch: 0, at_risk: 0, critical: 0 }
  for (const r of roster) if (t[r.band] != null) t[r.band]++
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

// ── GET /api/insights/health ────────────────────────────────────────────────
// Portfolio TRIAGE ROSTER: every client rolled into one 0–100 health score, ranked
// worst-first — "where do I look first?" in a single list. Declared before the
// :clientId route so the literal "health" can never be captured as a client id.
router.get('/health', async (_req, res) => {
  try {
    const roster = await getPortfolioHealth()
    res.json({
      roster,
      count: roster.length,
      by_band: tallyByBand(roster),
    })
  } catch (err) {
    console.error('[insights] GET health error', err.message)
    res.status(500).json({ error: 'Failed to load portfolio health' })
  }
})

// ── GET /api/insights/benchmarks ──────────────────────────────────────────────
// Portfolio peer benchmark: per-KPI cross-client distribution + each client's
// direction-aware percentile/quartile over a trailing window (default 4 weeks).
// Agency surface — this payload CARRIES peer identities; the client-facing view is
// the anonymous standing folded into GET /:clientId. Declared before the :clientId
// route so the literal "benchmarks" can never be captured as a client id.
router.get('/benchmarks', async (req, res) => {
  try {
    const benchmarks = await getPortfolioBenchmarks({ weeks: parseWeeks(req.query.weeks, 4) })
    res.json(benchmarks)
  } catch (err) {
    console.error('[insights] GET benchmarks error', err.message)
    res.status(500).json({ error: 'Failed to load portfolio benchmarks' })
  }
})

// ── GET /api/insights/recoveries ──────────────────────────────────────────────
// Portfolio "what we fixed" win stream: every client's recently RECOVERED findings
// (the problem measurably cleared — metric back to baseline / channel reconnected),
// newest fix first, each tagged with its client_name. Default trailing window 30d.
// The positive counterpart to GET / (active problems). Declared before the :clientId
// route so the literal "recoveries" can never be captured as a client id.
router.get('/recoveries', async (req, res) => {
  try {
    const recoveries = await getPortfolioRecoveries({
      limit: parseLimit(req.query.limit, 50),
      days:  parseDays(req.query.days, 30),
    })
    res.json({ recoveries, count: recoveries.length })
  } catch (err) {
    console.error('[insights] GET recoveries error', err.message)
    res.status(500).json({ error: 'Failed to load recoveries' })
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
    const [insights, standing, recoveries] = await Promise.all([
      getInsightFeed(clientId, { limit: parseLimit(req.query.limit, 50) }),
      getClientStanding(clientId),
      // recent WINS for this client — problems the engine flagged that then cleared.
      // Folded in beside the active feed so /my-dashboard can lead with the good news.
      getRecentRecoveries(clientId, { limit: 10, days: 30 }),
    ])
    res.json({
      client_id: clientId,
      insights,
      count: insights.length,
      by_severity: tallyBySeverity(insights),
      // the one-number verdict for this client's badge, from the same pure synthesis
      // the portfolio roster uses — score, band, counts, and the headline driver
      health: scoreClient(insights),
      // privacy-safe peer standing: this client's OWN percentile vs the anonymous
      // portfolio distribution (never a peer's identity). Empty `standing` under a
      // thin cohort — the surface shows nothing, never a half-built comparison.
      benchmark: standing,
      // "what we fixed lately" — recovered findings, newest first (may be empty).
      recoveries,
    })
  } catch (err) {
    console.error('[insights] GET client feed error', err.message)
    res.status(500).json({ error: 'Failed to load client insights' })
  }
})

module.exports = router
