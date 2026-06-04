'use strict'
// lib/scopeNowcastCoherence.js — intel-v14 D8 (step a): does the WHOLE projected basket tell ONE
// coherent story, or is the headline metric masking trouble underneath it?
//
// D3 projects each trending metric forward; D4–D6 calibrate how firmly the LEAD projection may speak;
// D7 corroborates that lead against an independent lens. Every one of those is LEAD-CENTRIC — it
// reasons about a single metric (the most salient projection) in isolation. But a scope rarely moves
// on one number. A nowcast can project revenue UP and look triumphant while, in the same basket, cost
// per lead is projected UP too and leads projected DOWN — i.e. the revenue is being bought with fewer,
// costlier leads. That is the classic vanity-metric trap, and it is structurally invisible to D1–D7
// because they never read the projection VECTOR as a whole.
//
// D8 is the first lens that does. It classifies each projection by its POLARITY — not its raw
// direction — using the `improving` flag the pace oracle already attached (improving===true means the
// move is GOOD for that metric, so CPL ticking up reads as "worsening", revenue ticking up as
// "improving"). It then asks whether the polarity-bearing projections agree:
//   • unified       — every assessed metric is improving → the basket moves as one; the headline is
//                     backed by the whole story, lean in.
//   • deteriorating — every assessed metric is worsening → the weakness is broad, not isolated.
//   • divergent     — improving AND worsening metrics coexist → the gain isn't clean; name the tension
//                     (e.g. "revenue improving but cost per lead worsening") so the headline is read
//                     with the cost it's hiding.
// A single polarity-bearing projection has nothing to cohere WITH, so the module needs ≥2 assessed
// metrics; below that it returns { status:'none' } and adds no cue.
//
// This NEVER inflates confidence: like its D4–D7 siblings it can only add a reassurance (unified) or a
// caution (divergent / deteriorating) beside the voice; it does not touch nowcast.headline,
// nowcast.voice, nowcast.corroboration, or any number.
//
// Design properties (the same discipline as its D1–D7 siblings):
//   • PURE + leak-safe — the sole input is the ALREADY leak-safe projection set (metric ids + labels +
//     the run's own directions/polarity only). This module sees no clientId and emits none; its output
//     is metric labels + direction words + small counts, identical on the agency and client surfaces.
//   • One polarity oracle — agreement is on the SAME `improving` flag every lens computes via the
//     shared polarity oracle, so "favorable" can never be defined inconsistently across metrics.
//   • Additive + only ever a tempering — emits a sibling cue; never mutates the voice or the number.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; stable input order (salience order is
//     preserved, so the lead favorable/unfavorable are the most salient of each); any malformed input
//     degrades to { status:'none' } and never throws.

const isDir = (d) => d === 'up' || d === 'down'
const lc = (s) => String(s == null ? '' : s).toLowerCase()

// A compact, leak-safe descriptor of one projection for the favorable/unfavorable rosters:
// just the metric id, its display label, and the raw direction (for the UI icon). No tenant data.
const entryOf = (p) => ({
  metric: String(p.metric),
  label: p.metric_label != null ? String(p.metric_label) : String(p.metric),
  direction: isDir(p.direction) ? p.direction : null,
})

// The honest one-line story for the cue. Metric-light by design (the projection chips below already
// name every figure) but it names the lead metric(s) so it reads standalone. The agency renders it
// as-is; the client surface softens only the peripheral pill label (in the UI), never this line.
function composeNote(level, favorable, unfavorable) {
  const favN = favorable.length
  const unfavN = unfavorable.length
  if (level === 'unified') {
    if (favN === 2) return `Both ${lc(favorable[0].label)} and ${lc(favorable[1].label)} are projected to improve — the basket is moving as one.`
    return `All ${favN} projected metrics are moving the right way — the trajectory is coherent.`
  }
  if (level === 'deteriorating') {
    if (unfavN === 2) return `Both ${lc(unfavorable[0].label)} and ${lc(unfavorable[1].label)} are projected to worsen — the slide is broad, not isolated.`
    return `All ${unfavN} projected metrics are projected to worsen — the slide is broad, not isolated.`
  }
  // divergent — the lead of each side, plus a count clause when more than a clean 1-v-1.
  const a = favorable[0].label
  const b = lc(unfavorable[0].label)
  const tail = favN + unfavN > 2 ? ` (${favN} improving, ${unfavN} worsening).` : `.`
  return `${a} is projected to improve, but ${b} is projected to worsen — the gain isn't clean${tail}`
}

// assessNowcastCoherence(nowcast, opts)
//   nowcast : a projectScopeTrend() result ({status:'projected', projections:[...]}).
//   opts    : reserved for a future per-metric policy (e.g. a required-metric set); unused today.
// Returns { status, reason, level, favorable, unfavorable, favorableCount, unfavorableCount,
//           assessedCount, leadFavorable, leadUnfavorable, note, meta }.
//   status : 'none'     — no projection / fewer than 2 polarity-bearing projections to compare;
//            'assessed' — ≥2 polarity-bearing projections were read as one basket.
//   level  : 'unified' (all assessed metrics improving) | 'deteriorating' (all worsening) |
//            'divergent' (both present) | 'indeterminate' (status 'none').
//   favorable / unfavorable : the polarity-bearing projections, salience order, each {metric,label,direction}.
function assessNowcastCoherence(nowcast, opts) {
  const none = (reason) => ({
    status: 'none',
    reason,
    level: 'indeterminate',
    favorable: [],
    unfavorable: [],
    favorableCount: 0,
    unfavorableCount: 0,
    assessedCount: 0,
    leadFavorable: null,
    leadUnfavorable: null,
    note: null,
    meta: { basis: 'projection-vector' },
  })
  try {
    // opts is accepted for signature symmetry with its D4–D7 siblings; no field is read yet.
    void (opts && typeof opts === 'object' ? opts : {})

    if (!nowcast || typeof nowcast !== 'object' || nowcast.status !== 'projected') return none('no-nowcast')
    const projections = Array.isArray(nowcast.projections) ? nowcast.projections : []

    // Split the basket by POLARITY (the `improving` flag), preserving salience order and deduping by
    // metric id so a malformed double-entry can't double-count. Null-polarity projections (unknown
    // metrics with no defensible "good direction") are excluded — they can neither cohere nor conflict.
    const favorable = []
    const unfavorable = []
    const seen = new Set()
    for (const p of projections) {
      if (!p || typeof p !== 'object' || p.metric == null) continue
      const id = String(p.metric)
      if (seen.has(id)) continue
      if (p.improving === true) { seen.add(id); favorable.push(entryOf(p)) }
      else if (p.improving === false) { seen.add(id); unfavorable.push(entryOf(p)) }
    }

    const favorableCount = favorable.length
    const unfavorableCount = unfavorable.length
    const assessedCount = favorableCount + unfavorableCount
    // Coherence is a relation BETWEEN metrics — a single one has nothing to cohere with.
    if (assessedCount < 2) return none('not-enough-metrics')

    const level = unfavorableCount === 0 ? 'unified'
      : favorableCount === 0 ? 'deteriorating'
      : 'divergent'

    return {
      status: 'assessed',
      reason: null,
      level,
      favorable,
      unfavorable,
      favorableCount,
      unfavorableCount,
      assessedCount,
      leadFavorable: favorable[0] || null,
      leadUnfavorable: unfavorable[0] || null,
      note: composeNote(level, favorable, unfavorable),
      meta: { basis: 'projection-vector' },
    }
  } catch {
    return none('error')
  }
}

module.exports = { assessNowcastCoherence }
