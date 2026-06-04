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
//   GET  /api/insights/systemic[?minClients=&minShare=]
//        Portfolio SYSTEMIC SCAN: cross-client common-cause clusters — the same adverse
//        signal (channel, metric, direction) independently hitting ≥ minClients distinct
//        clients, collapsed into ONE signal that answers "is this us, or the platform?"
//        Agency surface ONLY (a signal names other clients + the book-wide share — the
//        same cross-tenant boundary as /benchmarks); never in the per-client payload.
//
//   GET  /api/insights/trajectory[?horizon=]
//        Portfolio EARLY-WARNING ROSTER: the PREDICTIVE grain. Reads the per-sweep health
//        history forward and flags clients still in a safe band but projected to slide
//        THROUGH a floor within the horizon — "will churn unless you act," not "churned."
//        Agency surface ONLY (the roster names other clients); never per-client payload.
//
//   GET  /api/insights/pacing
//        Portfolio GOAL-PACING ROSTER: month-to-date actual vs. the human-set monthly GOAL
//        (client_goals) by linear run-rate — every client who, at today's pace, will MISS a
//        goal, worst-first ("on pace for 60% of leads goal"). The save before the month closes.
//        Agency surface ONLY (the roster names other clients); a client's OWN pace rides inside
//        GET /:clientId (.pacing), own numbers only.
//
//   GET  /api/insights/:clientId[?limit=]
//        One client's active feed — the per-client Insights card — plus that
//        client's own health verdict (same pure synthesis as the roster), its
//        privacy-safe peer STANDING (own percentile vs the anonymous distribution),
//        its recent RECOVERIES (the "what we fixed lately" win list), and its own
//        PACING (pace-to-goal per metric this month). All own-numbers-only — no peers.
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
  getPortfolioSystemic,
  getPortfolioEfficacy, getEfficacyTable, attachEfficacyNotes, attachEscalations,
  getPortfolioTrajectory,
  getPortfolioPacing, getClientPacing,
  getPortfolioReallocation, getPortfolioReallocationEfficacy, getReallocationEfficacyHealth,
  getConnectionHealth, getClientConnectionNote,
  getImpactLedger,
  getPortfolioPulse, getClientPulse, clientSafePulse,
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

// Clamp ?minClients (systemic distinct-client floor) to 1..100; undefined/invalid → null
// so the lib default of 3 stands. Coerced HERE — query params arrive as strings.
function parseMinClients(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(Math.floor(n), 100)
}

// Clamp ?minShare (systemic book-fraction floor) to [0,1]; undefined/invalid → null so the
// lib default of 0 (off) stands.
function parseMinShare(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(n, 1)
}

// Clamp ?horizon (trajectory: sweeps ahead to project) to 1..52; undefined/invalid → null
// so the lib default of 4 stands. Same string-coercion rationale as parseWeeks.
function parseHorizon(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(Math.floor(n), 52)
}

// Clamp ?priorWeight (efficacy: pseudo-count strength of the Beta-Bernoulli shrink toward the
// pooled base rate) to 0..100; undefined/invalid → null so the lib default (PRIOR_WEIGHT=6)
// stands. 0 is a legitimate value (no shrink — raw rates), so it must survive the floor; only
// negative/non-finite is rejected. Same string-coercion rationale as the other parsers.
function parsePriorWeight(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(n, 100)
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
    const [insights, effTable] = await Promise.all([
      getPortfolioInsights({ limit: parseLimit(req.query.limit, 100) }),
      // pooled, ANONYMOUS efficacy ledger (Map play→record): used only to ESCALATE the advice on
      // adverse findings whose play this book has PROVEN ineffective (band-low, n≥5). Names no client.
      getEfficacyTable(),
    ])
    // ACT half on the agency read path: where the learned record says the usual play keeps failing,
    // reviseAction bumps the urgency and rewrites the action in place (+ a structured `escalation` for
    // the chip). Pure read-time decorator off that table — a play that hasn't earned the override is an
    // untouched pass-through. by_severity is tallied on the decorated set (escalation changes the action's
    // urgency, not the finding's severity, so the tally is unchanged — but it never drifts from the feed).
    const escalated = attachEscalations(insights, effTable)
    res.json({ insights: escalated, count: escalated.length, by_severity: tallyBySeverity(escalated) })
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

// ── GET /api/insights/systemic ────────────────────────────────────────────────
// Portfolio SYSTEMIC SCAN: the cross-client common-cause pass. When one upstream event
// hits the whole book (Meta dark platform-wide, an iOS update tanking attribution), the
// per-client engine surfaces it as N independent findings; this collapses each such
// cluster into ONE signal — "leads down across 14 clients, 38% of the book, 4 critical" —
// answering the only question that changes the response: "is this us, or the platform?"
// AGENCY-ONLY: a signal names other clients (affected_clients) + the book-wide share, the
// same cross-tenant boundary /benchmarks respects, so it lives here and never rides the
// per-client GET /:clientId (or any shared-link) payload. Declared before the :clientId
// route so the literal "systemic" can never be captured as a client id. Optional
// ?minClients (distinct-client floor, default 3) and ?minShare (0..1 book-fraction floor,
// default 0 = off; the count gate is the size-independent primary).
router.get('/systemic', async (req, res) => {
  try {
    const opts = {}
    const mc = parseMinClients(req.query.minClients)
    if (mc != null) opts.minClients = mc
    const ms = parseMinShare(req.query.minShare)
    if (ms != null) opts.minShare = ms
    const out = await getPortfolioSystemic(opts)
    res.json({ ...out, count: out.signals.length })
  } catch (err) {
    console.error('[insights] GET systemic error', err.message)
    res.status(500).json({ error: 'Failed to load systemic signals' })
  }
})

// ── GET /api/insights/trajectory ──────────────────────────────────────────────
// Portfolio EARLY-WARNING ROSTER: the PREDICTIVE grain. Every other endpoint is
// retrospective — it reports where clients stand now or stood lately. This one reads the
// per-sweep health history (table 017) FORWARD: clients still inside a safe band but, by
// the slope of their own recent scores, projected to slide THROUGH a band floor within the
// horizon. It is the difference between "this client churned" and "this client will churn
// unless you act this week." rankEarlyWarnings already filters to the actionable set
// (crossing a floor, declining, not already-critical) and ranks by urgency. AGENCY-ONLY:
// the roster names other clients, the same cross-tenant boundary /systemic and /benchmarks
// respect, so it lives here and never rides the per-client GET /:clientId (or shared-link)
// payload. Declared before the :clientId route so the literal "trajectory" can never be
// captured as a client id. Optional ?horizon (sweeps ahead to project, 1..52; default 4).
router.get('/trajectory', async (req, res) => {
  try {
    const opts = {}
    const h = parseHorizon(req.query.horizon)
    if (h != null) opts.horizon = h
    const out = await getPortfolioTrajectory(opts)
    res.json({ ...out, count: out.warnings.length })
  } catch (err) {
    console.error('[insights] GET trajectory error', err.message)
    res.status(500).json({ error: 'Failed to load trajectory warnings' })
  }
})

// ── GET /api/insights/pacing ──────────────────────────────────────────────────
// Portfolio GOAL-PACING ROSTER: the predictive grain pointed at the monthly GOAL. Every other
// endpoint measures a client against itself or its peers; this one measures month-to-date actual
// against the human-set target (client_goals) by plain linear run-rate and returns only the clients
// who, at today's pace, will MISS a goal — worst-first ("on pace for 60% of the leads goal, must run
// 2× the current rate to still hit it"). The save you can still make, days before the month closes,
// instead of the post-mortem after. AGENCY-ONLY: the roster names other clients, the same cross-tenant
// boundary /benchmarks · /systemic · /trajectory respect, so it lives here and never rides the
// per-client GET /:clientId (or shared-link) payload — a client sees only its OWN pace, folded in
// below. Declared before the :clientId route so the literal "pacing" can never be captured as a
// client id. No params: the window is the current calendar month, the clock is "now".
router.get('/pacing', async (_req, res) => {
  try {
    const out = await getPortfolioPacing()
    res.json({ ...out, count: out.roster.length })
  } catch (err) {
    console.error('[insights] GET pacing error', err.message)
    res.status(500).json({ error: 'Failed to load pacing roster' })
  }
})

// ── GET /api/insights/reallocation ────────────────────────────────────────────
// Portfolio CHANNEL-REALLOCATION ROSTER (intel-v10): the first PRESCRIPTIVE grain. Every other
// endpoint diagnoses ("leads slid", "will miss goal"); this one PRESCRIBES where the next budget
// dollar should go. For each client it compares paid channels on realized cost-per-outcome WITHIN a
// single outcome type (never $/lead vs $/booked-job), reads each channel's returns trend from its own
// spend↔cpo correlation, and surfaces only clients with a defensible shift right now — most-defensible
// first ("Google Ads turns out leads at $38 vs Facebook's $61; move 10% and measure"). A hypothesis to
// TEST, never an autopilot move. AGENCY-ONLY and the most sensitive boundary of all: it names other
// clients AND carries dollar budget advice, so — like /systemic · /trajectory · /pacing · /pulse — it
// lives here behind requireAuth and NEVER rides the per-client GET /:clientId (or shared-link) payload;
// narrateReallocation is silent for the client audience and getClientReallocation is deliberately NOT
// folded into /:clientId. Declared before the :clientId route so the literal "reallocation" can never be
// captured as a client id. No params: the window is the trailing 26 weeks, the clock is "now".
router.get('/reallocation', async (_req, res) => {
  try {
    const out = await getPortfolioReallocation()
    res.json({ ...out, count: out.roster.length })
  } catch (err) {
    console.error('[insights] GET reallocation error', err.message)
    res.status(500).json({ error: 'Failed to load reallocation roster' })
  }
})

// ── GET /api/insights/reallocation-efficacy ─────────────────────────────────────
// The FEEDBACK LOOP that closes /reallocation (intel-v10 Layer 25): /reallocation PRESCRIBES budget
// shifts; this grades whether past prescriptions actually PAID OFF. It reconstructs each Layer-24
// proposal from the window it would have seen, re-measures the SAME from/to cost-per-outcome over the
// weeks that followed, and pools every client's track record into ONE confidence CALIBRATION the engine
// can multiply through — "moderate-strength reallocates have held 7/10 times, so trust them ~0.9×". The
// most sensitive boundary there is: it exposes per-client hit/miss verdicts AND a names-and-counts
// by_client breakdown, so — like /reallocation · /systemic · /trajectory · /pacing · /pulse — it lives
// here behind requireAuth and NEVER rides the per-client GET /:clientId (or shared-link) payload;
// getClientReallocationEfficacy is deliberately NOT folded into /:clientId. Declared before the :clientId
// route so the literal "reallocation-efficacy" can never be captured as a client id. No params: the span
// is the trailing (decision + boundaries·horizon) weeks, the clock is "now".
router.get('/reallocation-efficacy', async (_req, res) => {
  try {
    const out = await getPortfolioReallocationEfficacy()
    res.json(out)
  } catch (err) {
    console.error('[insights] GET reallocation-efficacy error', err.message)
    res.status(500).json({ error: 'Failed to load reallocation-efficacy calibration' })
  }
})

// ── GET /api/insights/reallocation-efficacy-health ──────────────────────────────
// The STABILITY watchdog that rides on top of the feedback loop (intel-v10 Layer 26): /reallocation-efficacy
// emits ONE confidence calibration per as-of; sampled over successive as-of points it becomes a SERIES, and a
// series can misbehave — flip damp<->embolden every episode (hunting), get pinned at a clamp rail, or run on
// too few trials to trust. This endpoint re-derives the pooled calibration at M stepped as-of points, reads the
// resulting series, and reports whether the live budget engine should TRUST the latest calibration or self-heal
// to neutral 1.0 — plus the gated factor it actually applies. It surfaces a calibration-stability verdict and a
// names-free pooled readout, so — like /reallocation · /reallocation-efficacy · /systemic · /trajectory ·
// /pacing · /pulse — it lives here behind requireAuth and NEVER rides the per-client GET /:clientId (or
// shared-link) payload; the client narration is unconditionally silent (Layer 26d proves it). Declared before
// the :clientId route so the literal "reallocation-efficacy-health" can never be captured as a client id. No
// params: the span is M samples stepped one realized-horizon apart back from "now".
router.get('/reallocation-efficacy-health', async (_req, res) => {
  try {
    const out = await getReallocationEfficacyHealth()
    res.json(out)
  } catch (err) {
    console.error('[insights] GET reallocation-efficacy-health error', err.message)
    res.status(500).json({ error: 'Failed to load reallocation-efficacy-health verdict' })
  }
})

// ── GET /api/insights/connection-health ─────────────────────────────────────────
// The self-healing pipeline's agency READ (intel-v11). Returns every connection's state
// worst-first (HEALTHY / STALE / ERRORING / AUTH_EXPIRED / NEVER_SYNCED / DISABLED), the
// portfolio rollup (counts, needs_attention, operator_required, next_wake_at), and a
// one-line operator instruction for the worst actionable item. The cron watchdog
// auto-recovers everything except auth; this is what the Pipeline-health UI + Reconnect
// CTA read. AGENCY-ONLY: it names channels and carries reconnect steps + redacted error
// excerpts, so — like /systemic · /reallocation* — it mounts behind requireAuth and NEVER
// rides a per-client payload (the client-safe degraded note is A4's separate job).
// Optional ?clientId scopes to one client (drill-down); absent = the whole portfolio.
// Declared before the :clientId route so the literal can't be captured as a client id.
router.get('/connection-health', async (req, res) => {
  try {
    const clientId = req.query.clientId ? String(req.query.clientId) : null
    const out = await getConnectionHealth({ clientId })
    res.json(out)
  } catch (err) {
    console.error('[insights] GET connection-health error', err.message)
    res.status(500).json({ error: 'Failed to load connection-health verdict' })
  }
})

// ── GET /api/insights/impact ──────────────────────────────────────────────────
// intel-v12 INFLUENCE LEDGER — the honest scoreboard of what the intelligence layer has been
// WORTH: recovered findings (problems measurably cleared) and vindicated budget shifts, each
// weighted by the confidence its OWN track record earned, totaled strictly per unit (dollars
// protected, wins booked — units never sum across each other), flagged `proven` only once enough
// calibrated evidence clears a real bar. AGENCY surface: the pooled reallocation component is a
// cross-client media-buying instrument, so it rides ONLY the portfolio ledger and never a client
// one — the getter drops it at the source for any client scope. Optional ?clientId scopes an agency
// drill-down into one client's recovery ledger (own numbers only; reallocation excluded). The
// client-FACING "your wins" surface is a separate client-safe reducer (B4), never this route.
// Declared before the :clientId route so the literal "impact" can't be captured as a client id.
router.get('/impact', async (req, res) => {
  try {
    const clientId = req.query.clientId ? String(req.query.clientId) : null
    const out = await getImpactLedger({ clientId })
    res.json(out)
  } catch (err) {
    console.error('[insights] GET impact error', err.message)
    res.status(500).json({ error: 'Failed to load impact ledger' })
  }
})

// ── GET /api/insights/pulse ───────────────────────────────────────────────────
// INTRA-WEEK PULSE roster — the early-warning capstone over the ATOMIC DAILY grain.
// Everything the weekly engine raises waits for the ISO week to close; this watches the
// trailing-week LEVEL every day, so a client cratering on a Tuesday surfaces here days
// before the Monday recap. Each row: a client + a flow metric whose trailing-week total
// has slid out of that client's OWN recent band right now, worst-first across the book.
// AGENCY-ONLY: the roster names other clients — the same cross-tenant boundary
// /systemic · /trajectory · /pacing respect — so it lives here and NEVER rides the
// per-client GET /:clientId payload (a client sees only its OWN pulse, folded in below).
// Declared before the :clientId route so the literal "pulse" can't be read as a client id.
// No params: the window is the trailing week, the clock is "now".
router.get('/pulse', async (_req, res) => {
  try {
    const out = await getPortfolioPulse()
    res.json({ ...out, count: out.roster.length, act_today_count: out.act_today.length })
  } catch (err) {
    console.error('[insights] GET pulse error', err.message)
    res.status(500).json({ error: 'Failed to load pulse roster' })
  }
})

// ── GET /api/insights/efficacy ────────────────────────────────────────────────
// Portfolio EFFICACY LEDGER: the self-improving grain — does the recommended PLAY actually
// fix the problem? Every adverse finding ships with a recommendedAction; the recovery
// classifier later proves whether that finding cleared or merely lapsed. This endpoint joins
// the two across the whole book and returns, per play archetype (kind::metric), the measured
// recovery rate (Beta-Bernoulli shrunk toward the pooled base rate, ranked by a Wilson 95%
// lower bound so a deep 9/10 outranks a lucky 1/1) plus the median days-to-recovery. It is
// how the system learns which of its OWN advice earns its place — the loop that lets the next
// recommendation carry a track record ("this play has cleared it 73% of the time, ~2 days").
// Pooled + ANONYMOUS: a rate names no client, so unlike /systemic this isn't a cross-tenant
// disclosure — but it's mounted here beside the agency reads because the full ranked TABLE is
// an agency-operations view; 1c lifts a single play's note onto the client surface. Declared
// before the :clientId route so the literal "efficacy" can never be captured as a client id.
// Optional ?priorWeight (shrink strength, 0..100; default 6; 0 = raw rates, no shrink).
router.get('/efficacy', async (req, res) => {
  try {
    const opts = {}
    const pw = parsePriorWeight(req.query.priorWeight)
    if (pw != null) opts.priorWeight = pw
    const out = await getPortfolioEfficacy(opts)
    res.json({ ...out, count: out.plays.length })
  } catch (err) {
    console.error('[insights] GET efficacy error', err.message)
    res.status(500).json({ error: 'Failed to load efficacy ledger' })
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
    const [insights, standing, recoveries, pacing, pulse, effTable, connectionNote] = await Promise.all([
      getInsightFeed(clientId, { limit: parseLimit(req.query.limit, 50) }),
      getClientStanding(clientId),
      // recent WINS for this client — problems the engine flagged that then cleared.
      // Folded in beside the active feed so /my-dashboard can lead with the good news.
      getRecentRecoveries(clientId, { limit: 10, days: 30 }),
      // this client's OWN pace-to-goal this month (per metric with a target) — computed
      // from its own MTD actual vs. target alone, NO peers, so it's safe in the client view.
      getClientPacing(clientId),
      // this client's OWN intra-week pulse — flow metrics whose trailing-week LEVEL has slid out
      // of its own recent band RIGHT NOW, computed live off the atomic daily grain. Own numbers
      // only, names no peer, so it's safe in the shared per-client payload the client view reads.
      getClientPulse(clientId),
      // the pooled, ANONYMOUS efficacy ledger (Map play→record) — used only to stamp a
      // client-safe "this play has worked X% of the time" note onto adverse findings that
      // already carry advice. Names no peer; quotes only the play's own track record.
      getEfficacyTable(),
      // the ONE client-safe egress for pipeline trouble (A4): { degraded, severity, note } and
      // nothing else. If a data connection is stale/erroring/auth-expired, this is a soft "some
      // data is catching up / your team is on it" line — it never names a channel, a status, a
      // count, the credential vocabulary, or any ask. All the agency machinery
      // (getConnectionHealth) is dropped at the source inside getClientConnectionNote.
      getClientConnectionNote(clientId),
    ])
    // self-improving join: first ANNOTATE each adverse, advised finding with its play's proven
    // track record (efficacy_note, n≥4 decided), then ESCALATE — where that record proves the play
    // INEFFECTIVE (band-low, n≥5) reviseAction bumps the urgency and rewrites the advice in place,
    // hoisting a structured `escalation` for the surfaces. Both are pure read-time decorators off the
    // SAME pooled table; count/severity/health are computed on the fully-decorated set so the feed and
    // its roll-ups never drift. (The two write disjoint fields, so the order is purely for readability.)
    const annotated = attachEscalations(attachEfficacyNotes(insights, effTable), effTable)
    res.json({
      client_id: clientId,
      insights: annotated,
      count: annotated.length,
      by_severity: tallyBySeverity(annotated),
      // the one-number verdict for this client's badge, from the same pure synthesis
      // the portfolio roster uses — score, band, counts, and the headline driver
      health: scoreClient(annotated),
      // privacy-safe peer standing: this client's OWN percentile vs the anonymous
      // portfolio distribution (never a peer's identity). Empty `standing` under a
      // thin cohort — the surface shows nothing, never a half-built comparison.
      benchmark: standing,
      // "what we fixed lately" — recovered findings, newest first (may be empty).
      recoveries,
      // "will you hit your goal?" — this client's own pace-to-goal per metric this month
      // (ahead/on_track/behind/at_risk/early, or empty when no goal is set). Own numbers only.
      pacing,
      // "anything cratering RIGHT NOW?" — this client's own intra-week pulse: flow metrics whose
      // trailing-week level is outside its own recent band today, days before the ISO week closes.
      // Own numbers only; the client view reads each signal's client_message, the agency card message.
      // clientSafePulse strips the self-tuning machinery (sig.tuning*) from this client-shared
      // envelope: the EFFECT (the signal already fired at the tuned band) rides through, the dial
      // never egresses — machinery-free on the WIRE, not merely unread by the client UI.
      pulse: clientSafePulse(pulse),
      // "is my data current?" — a soft, deliberately-vague degraded note when a pipeline
      // connection is behind, and NOTHING when everything is healthy. { degraded, severity, note }
      // only; leak-proof by construction (see getClientConnectionNote / clientConnectionNote).
      connection_note: connectionNote,
    })
  } catch (err) {
    console.error('[insights] GET client feed error', err.message)
    res.status(500).json({ error: 'Failed to load client insights' })
  }
})

module.exports = router
