'use strict'

// ============================================================
// lib/impactSources.js — the influence layer's ADAPTER (PURE).
//
// impactLedger.js is a pure algebra over ONE canonical impact-event shape; it
// deliberately knows nothing about WHERE a win came from. This module is the thin,
// honest seam that maps each upstream verdict — a recovered finding (outcomes.js),
// a vindicated budget shift (reallocationEfficacy.js), an early-warning that proved
// out (pulseAccuracy.js) — into that canonical shape. Engine I/O (the DB reads)
// lives in insights.getImpactLedger (B2); the MAPPING RULES live HERE so they stay a
// pure, testable function of already-computed upstream outputs, and a new source can
// be added without ever touching the ledger algebra.
//
// HONESTY IS THE WHOLE JOB. Each mapping carries exactly the confidence the upstream
// track record actually earned — never more:
//
//   • recovery      outcomes.js confirms a flagged problem measurably cleared, but it
//                   does NOT attach a calibrated "how often does a fix of this kind
//                   hold?" rate. So a recovery asserts NO confidence of its own and
//                   inherits the ledger's neutral default (0.5): a real win, counted,
//                   never dressed up as proven. A recovered REVENUE anomaly is the one
//                   case with a legible dollar magnitude — the weekly deviation that
//                   was flagged and then cleared, |baseline − latest|, booked in
//                   DOLLARS. Every other recovery is one COUNT (you fixed one issue;
//                   you can't fix 7.5 of them).
//
//   • reallocation  reallocationEfficacy.js already backtested the budget shifts and
//                   shrank the result toward a neutral prior: `vindicated` is how many
//                   held up, `hit_rate` is the calibrated rate. So this maps to ONE
//                   agency-level COUNT carrying that earned hit_rate as its confidence.
//                   AGENCY-ONLY by construction: client_id is null — it is a pooled
//                   media-buying instrument and must never ride a client payload.
//
//   • early_warning pulseAccuracy.js graded each early call against the weekly outcome:
//                   `tp` true positives at `precision`. So this maps to one COUNT per
//                   graded (client, metric) carrying that precision — and ONLY when the
//                   grade is actually `graded` with a real positive count. An ungraded
//                   or empty sensor contributes nothing.
//
// pacing_save is intentionally NOT synthesized here: a pacing shortfall is a PROJECTED
// miss, not a proven save, so v1 never fabricates one. CATEGORY.PACING_SAVE exists for
// when a real "caught early → returned to track" verdict is wired; until then this
// adapter leaves it empty rather than inventing a win.
//
// PURE: upstream outputs in, raw canonical events out. No DB, no clock, no network, no
// LLM, no input mutation. Deterministic: identical inputs → identical event list.
// Defensive: a malformed row maps to null and is dropped, never throws — a missing
// source is simply "no events from there." Every event is a RAW candidate; downstream
// impactLedger.recordImpact re-validates, rounds and weights it, so this module only
// has to map fields, not police them.
// ============================================================

const { CATEGORY, UNIT } = require('./impactLedger')

// ── tiny, boring, pure helpers ────────────────────────────────────────────────
// finite number or null (so callers can test presence, not just falsiness — 0 is a
// real value but never a positive magnitude, which the ledger drops anyway).
function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}
// trimmed non-empty string or null.
function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null }
// id coercion that survives a numeric/UUID id without losing it (String(123) → '123').
function strId(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
}

// the metric labels the canonical event recognizes; anything else (spend, a CRM-only
// metric, undefined) rides as an untyped count — honest, just not typed.
const IMPACT_METRICS = new Set(['revenue', 'leads', 'jobs'])
function metricOf(m) { const s = str(m); return s && IMPACT_METRICS.has(s) ? s : null }

// ── recovery → impact ─────────────────────────────────────────────────────────
// One recovered finding (an insights row, status='recovered', as normalized by
// insights.normalizeRecoveryRow). A revenue recovery with a finite, MOVED baseline→
// latest pair books the cleared weekly deviation in DOLLARS; every other recovery is
// one COUNT. No confidence is asserted (outcomes.js proves the fix happened, not a
// hold-rate) — the event omits `confidence` so the ledger applies its neutral default.
function recoveryToImpact(row) {
  if (!row || typeof row !== 'object') return null

  const metric = metricOf(row.metric)
  const ev = row.evidence && typeof row.evidence === 'object' ? row.evidence : {}
  const baseline = num(ev.baseline)
  const latest = num(ev.latest)

  let unit = UNIT.COUNT
  let value = 1
  if (metric === 'revenue' && baseline != null && latest != null && baseline !== latest) {
    unit = UNIT.DOLLARS
    value = Math.abs(baseline - latest)
  }

  return {
    category: CATEGORY.RECOVERY,
    client_id: strId(row.client_id),
    client_name: str(row.client_name),
    metric,
    unit,
    value,
    // confidence intentionally omitted — neutral default applies (see header).
    occurred_at: str(row.recovered_at),
    detail: str(row.recovery_reason) || str(row.title),
  }
}

// ── reallocation → impact ─────────────────────────────────────────────────────
// The serialized portfolio reallocation-efficacy table (insights.getPortfolioReallo-
// cationEfficacy → { ...meta, overall, ... }). Reads the pooled `overall` row: how
// many budget shifts were vindicated, at what calibrated hit_rate. Maps to ONE agency-
// level COUNT (client_id = null). Returns null when there is no `overall` row or no
// vindicated win to claim — silence beats a zero-win brag.
function reallocationToImpact(table) {
  if (!table || typeof table !== 'object') return null
  const overall = table.overall
  if (!overall || typeof overall !== 'object') return null

  const vindicated = num(overall.vindicated)
  if (vindicated == null || vindicated <= 0) return null

  const hit = num(overall.hit_rate)   // calibrated, prior-shrunk rate; null → neutral default
  const wins = Math.round(vindicated)

  return {
    category: CATEGORY.REALLOCATION,
    client_id: null,                  // AGENCY-ONLY — never attributed to a client
    client_name: null,
    metric: null,
    unit: UNIT.COUNT,
    value: wins,
    confidence: hit == null ? undefined : hit,
    occurred_at: str(table.as_of),
    detail: `${wins} budget shift${wins === 1 ? '' : 's'} held up in backtest`,
  }
}

// ── early_warning → impact ────────────────────────────────────────────────────
// One graded pulseAccuracy result for a (client, metric). `ctx` carries the attribution
// the grade itself doesn't: { clientId, clientName, metric, occurredAt }. Maps to one
// COUNT of the true positives at the grade's precision — ONLY when the grade is `graded`
// with a real positive count and a finite precision. Ungraded / empty / no-precision →
// null (no track record to stand on yet).
function pulseAccuracyToImpact(grade, ctx = {}) {
  if (!grade || typeof grade !== 'object') return null
  if (grade.status !== 'graded') return null

  const tp = num(grade.tp)
  if (tp == null || tp <= 0) return null

  const precision = num(grade.precision)
  if (precision == null) return null            // a count with no proven precision isn't a track record

  const wins = Math.round(tp)
  return {
    category: CATEGORY.EARLY_WARNING,
    client_id: strId(ctx.clientId),
    client_name: str(ctx.clientName),
    metric: metricOf(ctx.metric),
    unit: UNIT.COUNT,
    value: wins,
    confidence: precision,
    occurred_at: str(ctx.occurredAt),
    detail: `${wins} early warning${wins === 1 ? '' : 's'} that proved out`,
  }
}
// semantic alias for call sites that think in the ledger's category name.
const earlyWarningToImpact = pulseAccuracyToImpact

// ── collect every source into one flat list of raw candidate events ───────────
// sources: {
//   recoveries:    [ normalized recovery row, … ],        // per-client, newest first
//   reallocation:  serialized efficacy table | null,      // ONE agency-level table
//   earlyWarnings: [ { grade, clientId, clientName, metric, occurredAt }, … ],
// }
// Maps each, drops every null, returns a flat array ready for impactLedger.buildImpact-
// Ledger. Tolerant of missing / non-array sources — anything absent yields nothing.
function collectImpactEvents(sources = {}, _opts = {}) {
  const s = sources && typeof sources === 'object' ? sources : {}
  const events = []

  const recoveries = Array.isArray(s.recoveries) ? s.recoveries : []
  for (const row of recoveries) {
    const e = recoveryToImpact(row)
    if (e) events.push(e)
  }

  const realloc = reallocationToImpact(s.reallocation)
  if (realloc) events.push(realloc)

  const earlyWarnings = Array.isArray(s.earlyWarnings) ? s.earlyWarnings : []
  for (const ew of earlyWarnings) {
    if (!ew || typeof ew !== 'object') continue
    const e = pulseAccuracyToImpact(ew.grade, ew)
    if (e) events.push(e)
  }

  return events
}

module.exports = {
  recoveryToImpact,
  reallocationToImpact,
  pulseAccuracyToImpact,
  earlyWarningToImpact,
  collectImpactEvents,
  IMPACT_METRICS,
  metricOf,
}
