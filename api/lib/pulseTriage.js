'use strict'

// ============================================================
// lib/pulseTriage.js — reliability-weighted "what's worth acting on today".
//
// THE GAP THIS CLOSES
// -------------------
// getClientPulse / getPortfolioPulse now emit, per firing signal, BOTH how bad it
// is (severity: critical|warning, from dayPulse) AND — when there's a track record —
// how sure we are (reliability 0..1 + label, from pulseReliability). Those are two
// independent axes, and rankPulse() only sorts on the first (worst-first by |z|).
// That means a Critical alert the sensor has MEASURED to be noise still sits at the
// top of the list, above a Warning the sensor has been right about ten times running.
// A human triaging a book of clients each morning has to mentally cross those two
// columns to decide what to actually touch. This module is that cross, made explicit
// and deterministic: it folds severity × learned-reliability into one priority and
// orders the day's signals by it — so a reliable Warning correctly outranks a noisy
// Critical, and the agency's attention lands where the evidence says it should.
// No model, no tuning; the same numbers dayPulse and pulseReliability already produced.
//
// WHY THIS IS "SELF-IMPROVING" AND NOT JUST A SORT
// ------------------------------------------------
// The reliability term is itself learned — pulseReliability grades the sensor's own
// past firings against each client's own history and updates every day as more
// firings mature. So the ranking re-weights itself automatically: a metric whose
// alerts start panning out climbs the list; one that keeps crying wolf sinks. The
// triage gets sharper the longer the dashboard runs, with zero operator input — it
// is the decision layer on top of the self-grading loop in [[pulseReliability]].
//
// THE TWO AXES, AND HOW THEY COMBINE
// ----------------------------------
//   priority = severityWeight × reliabilityMultiplier × (1 + 0.2·magNudge)
//
//   severityWeight        critical 1.0 · warning 0.6 · (none/unknown) 0   — HOW BAD
//   reliabilityMultiplier graded → clamp(reliability, FLOOR=0.25, 1)      — HOW SURE
//                         ungraded → NEUTRAL_PRIOR 0.6 (unproven > measured-noisy:
//                         a signal we haven't graded yet earns more benefit of the
//                         doubt than one we've measured to be unreliable)
//   magNudge              min(1, |delta_pct|/100) — a bounded ≤+20% tie-shaper so a
//                         bigger move edges ahead WITHIN its severity·confidence tier
//                         but never crosses it (magnitude refines, never overrules).
//
// `adverse` is the DOMINANT sort key, not folded into priority: bad news is always
// triaged before good news (a tailwind never displaces something to fix), exactly as
// rankPulse intends. priority then orders within each adverse-ness, |z| breaks ties,
// then client_name/metric make the order fully deterministic (test- and replay-safe).
//
// PURE + TOTAL: no Date, no randomness, no I/O; never mutates its input; tolerant of
// missing fields (a signal with no reliability, no delta_pct, no client_name still
// ranks). Mirrors the contract style of [[pulseReliability]] so the engine wiring (4b)
// and the agency "Act today" strip (4c) / client ordering (4d) read it the same way.
// ============================================================

// HOW BAD — only the two severities dayPulse actually emits; anything else → 0 (sorts last).
const SEVERITY_WEIGHT = { critical: 1.0, warning: 0.6 }

// HOW SURE — a measured-noisy signal still keeps a floor of presence (it may be real,
// just hard to call); an ungraded signal sits at a neutral prior above that floor.
const RELIABILITY_FLOOR = 0.25
const NEUTRAL_PRIOR     = 0.6

// magnitude's bounded influence: at most +20% within a tier, so it never reorders tiers.
const MAG_NUDGE_MAX = 0.2

// Stable lane vocabulary the surfaces map to copy/color. Orthogonal to severity's
// own tone: a Critical can be 'act_now' OR 'verify' depending on the learned grade.
const LANES = ['act_now', 'verify', 'worth_a_look', 'monitor', 'tailwind']

function severityWeight(sev) {
  return SEVERITY_WEIGHT[sev] != null ? SEVERITY_WEIGHT[sev] : 0
}

// graded → the learned reliability, clamped into [FLOOR,1]; ungraded → neutral prior.
function reliabilityMultiplier(sig) {
  const r = sig == null ? null : sig.reliability
  if (typeof r === 'number' && Number.isFinite(r)) {
    return Math.max(RELIABILITY_FLOOR, Math.min(1, r))
  }
  return NEUTRAL_PRIOR
}

function magNudge(sig) {
  const d = Math.abs(Number(sig && sig.delta_pct) || 0) // null/NaN (ratio metrics) → 0
  return Math.min(1, d / 100)
}

// The composite 0..1-ish priority — interpretable as "severity·confidence strength".
// Equal-severity signals separate by confidence; equal-confidence by magnitude.
function triagePriority(sig) {
  if (sig == null) return 0
  return severityWeight(sig.severity) * reliabilityMultiplier(sig) * (1 + MAG_NUDGE_MAX * magNudge(sig))
}

// Which action lane a signal falls in — the cross of severity × adverse × learned grade.
// reliable / ungraded keep the strong lane (act_now / worth_a_look); a MEASURED mixed
// or noisy grade softens it (verify / monitor) — the self-grading loop tempering the call.
function triageLane(sig) {
  if (sig == null || !SEVERITY_WEIGHT[sig.severity]) return 'monitor'
  if (!sig.adverse) return 'tailwind'
  const shaky = sig.reliability_label === 'noisy' || sig.reliability_label === 'mixed'
  if (sig.severity === 'critical') return shaky ? 'verify' : 'act_now'
  return shaky ? 'monitor' : 'worth_a_look' // warning
}

function lc(label) {
  return String(label == null ? 'this metric' : label).toLowerCase()
}

// One grounded sentence explaining the lane — agency-toned by default (triage is an
// agency morning-triage tool), with a gentle client branch for the per-client ordering.
// Reads only fields already on the signal; never invents a number.
function narrateTriage(sig, { audience = 'agency' } = {}) {
  if (sig == null) return ''
  const lane  = triageLane(sig)
  const label = sig.label || 'This metric'
  const rl    = sig.reliability_label
  const graded = rl === 'reliable' || rl === 'mixed' || rl === 'noisy'

  if (audience === 'client') {
    switch (lane) {
      case 'act_now':      return `Your ${lc(label)} needs attention today.`
      case 'verify':       return `Your ${lc(label)} dipped — we're confirming it before we act.`
      case 'worth_a_look': return `Your ${lc(label)} is worth a look this week.`
      case 'monitor':      return `We're keeping an eye on your ${lc(label)}.`
      case 'tailwind':     return `Your ${lc(label)} is pacing ahead — nice momentum.`
      default:             return ''
    }
  }
  // agency
  switch (lane) {
    case 'act_now':
      return graded // graded here means 'reliable' (shaky → 'verify')
        ? `${label} is critical and this alert has a reliable track record — act today.`
        : `${label} is critical — act today.`
    case 'verify':
      return `${label} is critical, but this alert has been ${rl} lately — confirm before acting.`
    case 'worth_a_look':
      return rl === 'reliable'
        ? `${label} is slipping and this alert has held up before — worth a look today.`
        : `${label} is slipping — worth a look.`
    case 'monitor':
      return `${label} is slipping, but this alert flickers${graded ? ` (${rl})` : ''} — monitor for now.`
    case 'tailwind':
      return rl === 'reliable'
        ? `${label} is well above its usual band and the gain is holding — a tailwind to lean into.`
        : `${label} is well above its usual band — a tailwind to lean into.`
    default:
      return ''
  }
}

// rankPulseSignals(signals, opts) — the public entry. Returns a NEW array, each item a
// shallow copy of the input signal enriched with { priority, lane, triage_reason,
// triage_client_reason, priority_rank }, ordered for action:
//   adverse desc → priority desc → |z| desc → client_name asc → metric asc
// opts.adverseOnly (default false) drops tailwinds before ranking (the "Act today" feed);
// opts.limit (default null) keeps the top N after sorting. priority_rank is 1-based over
// the final (filtered, limited) array. Empty / non-array input → [].
function rankPulseSignals(signals, { limit = null, adverseOnly = false } = {}) {
  if (!Array.isArray(signals) || signals.length === 0) return []

  let rows = signals.map((sig) => ({
    ...sig,
    priority:             triagePriority(sig),
    lane:                 triageLane(sig),
    triage_reason:        narrateTriage(sig, { audience: 'agency' }),
    triage_client_reason: narrateTriage(sig, { audience: 'client' }),
  }))

  if (adverseOnly) rows = rows.filter((r) => !!r.adverse)

  rows.sort((a, b) =>
    (Number(!!b.adverse) - Number(!!a.adverse)) ||
    (b.priority - a.priority) ||
    (Math.abs(Number(b.z) || 0) - Math.abs(Number(a.z) || 0)) ||
    String(a.client_name || '').localeCompare(String(b.client_name || '')) ||
    String(a.metric || '').localeCompare(String(b.metric || ''))
  )

  if (Number.isFinite(limit) && limit >= 0) rows = rows.slice(0, limit)

  return rows.map((r, i) => ({ ...r, priority_rank: i + 1 }))
}

module.exports = {
  rankPulseSignals,
  triagePriority,
  triageLane,
  narrateTriage,
  SEVERITY_WEIGHT,
  RELIABILITY_FLOOR,
  NEUTRAL_PRIOR,
  LANES,
}
