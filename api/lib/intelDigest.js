'use strict'

// ============================================================
// lib/intelDigest.js — distil the live intelligence organs into a compact,
// CLIENT-SAFE "posture" digest for the AI evidence pack (lib/evidence.js).
//
// WHY THIS EXISTS
// ---------------
// The weekly recap is narrated by an LLM that is only ever allowed to phrase the
// numbers in the evidence pack (lib/ai.js grounding verifier). Until now that
// pack carried only raw metric deltas, channels and the goal — so the recap was
// BLIND to everything the intelligence layer had learned: which problems the
// engine is actively re-strategising on, which ones it has already cleared, and
// whether the month is pacing to goal. This module hands the narrator a tiny,
// deterministic summary of that posture so the recap can finally say
//   "revenue recovered, we're changing our approach on leads, and you're on pace"
// instead of just reciting last week's dollars.
//
// TWO HARD CONSTRAINTS, BOTH SATISFIED BY CONSTRUCTION
// ----------------------------------------------------
//  1. CLIENT-SAFE. The recap is a client-facing artifact. The candid efficacy
//     statistic that drives an escalation ("this play cleared the problem only
//     30% of the time") and the internal word "escalate" must NEVER reach a
//     client (the same leak ClientView guards). So this digest copies ONLY the
//     escalated finding's METRIC — never its pct / successes / n — and frames it
//     as "adjusting our approach." There is no code path here that reads
//     escalation.pct/successes/n, so the leak is impossible, not merely avoided.
//  2. GROUNDED. Every value emitted is a small finite integer count or a metric
//     LABEL string. lib/ai.js collects every numeric leaf of the pack into its
//     allow-list, so these counts are grounded the instant they are attached;
//     the label strings are ignored by the numeric verifier. No verifier change
//     is required to let the narrator quote them.
//
// PURE + DEPENDENCY-FREE. Takes already-computed inputs (decorated findings, the
// recovery stream, the pacing block) and returns a plain object. No db, no
// network, no import of the heavy insight engine — so it stays trivially
// testable and carries zero circular-dependency risk against lib/evidence.js.
// ============================================================

// Default metric-key → human label. The authoritative labels live in
// lib/insights.js (METRIC_META); the wiring layer injects that map via
// opts.label so production never drifts. This built-in fallback keeps the module
// self-sufficient (and its tests dependency-free), and humanises a null metric —
// a data-freshness finding has no KPI — as "Data freshness".
const DEFAULT_LABELS = {
  revenue:    'Revenue',
  leads:      'Leads',
  jobs:       'Jobs won',
  spend:      'Ad spend',
  roas:       'ROAS',
  cpl:        'Cost per lead',
  close_rate: 'Close rate',
}
const defaultLabel = (m) => DEFAULT_LABELS[m] || (m ? String(m) : 'Data freshness')

// How many distinct areas to NAME per roll-up. The count is always the true
// distinct total (honest), but only the first few are spelled out so the recap
// stays a short paragraph, not a list.
const DEFAULT_MAX_AREAS = 3

// Roll a list of items down to { count, areas } keyed on each item's metric:
//   • count = number of DISTINCT metrics touched (the honest total)
//   • areas = the first `maxAreas` of them as { metric, label }, de-duped
// A null/absent metric collapses to one "Data freshness" bucket (key '').
// Reads ONLY the metric — never any sibling field — which is what makes the
// escalation roll-up leak-safe by construction.
function areaRoll(items, keyOf, label, maxAreas) {
  const seen  = new Set()
  const areas = []
  for (const it of (Array.isArray(items) ? items : [])) {
    const raw  = keyOf(it)
    const norm = raw == null ? '' : String(raw)
    if (seen.has(norm)) continue
    seen.add(norm)
    if (areas.length < maxAreas) {
      areas.push({ metric: norm || null, label: label(norm || null) })
    }
  }
  return { count: seen.size, areas }
}

/**
 * Summarise the client's current intelligence posture into a client-safe digest.
 *
 * @param {Array}  findings    Decorated active findings (each {severity, metric,
 *                             escalation?}). escalation.reason==='play_ineffective'
 *                             marks a play the self-improving loop is re-strategising.
 * @param {Array}  recoveries  Recently RECOVERED findings (each {metric}) — the wins.
 * @param {Object} pacing      getClientPacing() result: { metrics:[{status}] }.
 * @param {Object} [opts]
 * @param {Function} [opts.label]    metricKey|null → display label (default built-in).
 * @param {number}   [opts.maxAreas] max named areas per roll-up (default 3).
 * @returns {{active:number,
 *            by_severity:{critical:number,warning:number,info:number},
 *            adjusting:{count:number, areas:Array<{metric:?string,label:string}>},
 *            improving:{count:number, areas:Array<{metric:?string,label:string}>},
 *            pacing:{on_track:number, at_risk:number}}}
 *   A pure value; safe to JSON-embed in the evidence pack. Carries NO efficacy
 *   percentages and no peer identities.
 */
function summarizeIntelligence(findings, recoveries, pacing, opts = {}) {
  const label    = typeof opts.label === 'function' ? opts.label : defaultLabel
  const maxAreas = Number.isInteger(opts.maxAreas) && opts.maxAreas > 0
    ? opts.maxAreas : DEFAULT_MAX_AREAS

  const f  = Array.isArray(findings)   ? findings   : []
  const r  = Array.isArray(recoveries) ? recoveries : []
  const pm = pacing && Array.isArray(pacing.metrics) ? pacing.metrics : []

  // Severity census — conveys "needs attention" (critical + warning) without
  // importing the engine's isAdverse predicate.
  const by_severity = { critical: 0, warning: 0, info: 0 }
  for (const x of f) if (x && by_severity[x.severity] != null) by_severity[x.severity]++

  // ADJUSTING — the self-improving loop made visible: findings whose usual play
  // the engine has proven ineffective and is now switching levers on. Metric-only.
  const adjusting = areaRoll(
    f.filter(x => x && x.escalation && x.escalation.reason === 'play_ineffective'),
    (x) => x.metric, label, maxAreas)

  // IMPROVING — problems the engine flagged that then measurably cleared (wins).
  const improving = areaRoll(r, (x) => x && x.metric, label, maxAreas)

  // PACING posture — collapse per-metric pace bands to two client-safe counts.
  // 'early' (too soon to judge) and 'none' (no goal set) are deliberately ignored.
  let on_track = 0, at_risk = 0
  for (const m of pm) {
    if (!m) continue
    if (m.status === 'ahead' || m.status === 'on_track')      on_track++
    else if (m.status === 'behind' || m.status === 'at_risk') at_risk++
  }

  return {
    active: f.length,
    by_severity,
    adjusting,
    improving,
    pacing: { on_track, at_risk },
  }
}

module.exports = {
  summarizeIntelligence,
  defaultLabel,
  DEFAULT_MAX_AREAS,
}
