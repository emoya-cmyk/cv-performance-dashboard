'use strict'

// ============================================================
// lib/briefLeadPolicy.js — lead with the lanes that have EARNED it.
//
// THE GAP THIS CLOSES
// -------------------
// [[briefImpact]] grades the brief's own front page: of all the mornings we led
// with a given triage lane (act_now / verify / worth_a_look / monitor / tailwind),
// how often did that lead actually hold up over the following mornings — earned
// (≥0.70), fair (0.40–0.69), or overcalled (<0.40). Its header names the very
// layer this file is: "the empirical signal a later layer can tune lead SELECTION
// on (lead with the lanes that have earned it), exactly as [[pulseTuning]] consumes
// [[pulseAccuracy]]. This is the MEASURE half of that loop." briefImpact MEASURES.
// This module is the TUNE half — it turns that per-lane track record into a bounded
// per-lane nudge the briefing engine applies when it ranks candidates for the one
// lead slot. The brief grading its own front page, then quietly rewriting its own
// editorial priorities from the result. No human, no model, no new statistics.
//
// A NUDGE, NEVER A VETO — AND A HARD SAFETY FLOOR
// ----------------------------------------------
// Two disciplines keep this honest and safe:
//   1. BOUNDED. A lane's weight lives in [minWeight, maxWeight] (default ±20%), a
//      gentle reprioritisation, never a silencer. A lane we keep overcalling is
//      eased DOWN the queue; a lane that keeps earning its place is nudged UP. The
//      magnitude is continuous in the measured hit rate, so it sharpens smoothly as
//      more mornings close — true self-improvement, not a step function.
//   2. SAFETY-ASYMMETRIC. Crying wolf is bad; BURYING A REAL EMERGENCY is far worse.
//      So the safety lane (`act_now`) is FLOORED at neutral: the policy may promote
//      it, but can never demote it, no matter how mediocre its recent record. And at
//      application time, applyLeadPolicy pins protected-lane candidates ahead of all
//      others — a learned promotion of a strong tailwind can never displace a live
//      act_now alert from the lead. The asymmetry is encoded HERE, not left to each
//      caller to remember.
//
// FAIR BY ABSTENTION
// ------------------
// A lane is nudged only once its record is a record: fewer than `minSample` RESOLVED
// leads → weight 1.0 (neutral), exactly the abstention floor briefImpact/pulseAccuracy
// live by. And the whole policy abstains (every lane neutral, status 'abstained') until
// the impact grade itself is 'graded' — we do not reprioritise the front page on a
// track record too thin to trust. A young lane is abstained on, never punished.
//
// INTERNAL CALIBRATION — NEVER CLIENT-FACING
// ------------------------------------------
// Which lanes we have learned to trust is agency-side machinery, the same family as
// pulseTuning's sensitivity calibration. narrateLeadPolicy speaks only to the agency;
// its client branch is hard-wired to '' so the no-leak discipline is enforced in the
// module, not left to a surface to remember.
//
// PURE: a grade in, a policy out. No DB, no clock-of-now, no network, no LLM, no
// mutation, never throws. Every field is read off the grade it was handed, so it
// stays trivially testable on plain literals — exactly like the rest of the family.
// ============================================================

// Minimum RESOLVED leads (hits+misses) in a lane before its nudge is trusted — mirrors
// briefImpact.DEFAULT_MIN_SAMPLE so the abstention floor is the same shape family-wide.
const DEFAULT_MIN_SAMPLE = 4
// The hit rate that maps to NO nudge (weight exactly 1.0). 0.5 = a coin-flip lead is
// neither promoted nor demoted; above it earns a lift, below it earns a trim.
const DEFAULT_NEUTRAL_RATE = 0.5
// Bounds on a lane weight — a ±20% nudge. Bounded so the policy can reprioritise but
// never silence: even a perfectly-earned lane tops out at maxWeight, even a never-held
// lane bottoms out at minWeight (and a safety lane never goes below 1.0 at all).
const DEFAULT_MAX_WEIGHT = 1.2
const DEFAULT_MIN_WEIGHT = 0.8
// Lanes that may be promoted but NEVER demoted — burying a live emergency is worse than
// the occasional false alarm. The one safety-critical triage lane.
const SAFETY_FLOOR_LANES = ['act_now']

// ── tiny pure guards (same idioms as briefImpact) ────────────────────────────
const str = (x) => (x == null ? '' : String(x))
const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f }
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
// A weight bound strictly inside (0,1) — defends the demote side and the neutral-rate
// denominators. Anything else falls back to the default.
const unitOpen = (v, d) => (Number.isFinite(v) && v > 0 && v < 1 ? v : d)
// A promote-side bound ≥ 1. A maxWeight below 1 would be nonsense (no promotion).
const atLeastOne = (v, d) => (Number.isFinite(v) && v >= 1 ? v : d)

// humanizeLane('worth_a_look') → 'worth a look'. Underscore→space, lowercased — the
// lane vocabulary read aloud mid-sentence in the agency narration.
function humanizeLane(lane) {
  return str(lane).replace(/_/g, ' ').trim().toLowerCase()
}

// Join a short list of phrases with serial commas: [a] → 'a', [a,b] → 'a and b',
// [a,b,c] → 'a, b and c'. Deterministic; used only for the agency one-liner.
function joinList(xs) {
  const a = xs.filter(Boolean)
  if (a.length <= 1) return a[0] || ''
  if (a.length === 2) return `${a[0]} and ${a[1]}`
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
}

/**
 * rawLaneWeight(bucket, opts) — map ONE briefImpact lane bucket to a bounded weight,
 * with NO safety knowledge (deriveLeadPolicy owns the floor). Pure; never throws.
 *   bucket : a briefImpact by_lane[k] = { judged, hit_rate, label, ... } (any shape;
 *            missing/!finite fields are treated as un-gradeable → neutral).
 *   opts   : { minSample, neutralRate, maxWeight, minWeight } — forwarded by derive.
 *
 * Returns { weight, adjusted, judged, hit_rate, label, direction, reason }
 *   • judged < minSample OR hit_rate null → weight 1.0, reason 'insufficient_sample'.
 *   • else weight is continuous in hit_rate, piecewise-linear so it pins the endpoints
 *     exactly: hit_rate=1 → maxWeight, hit_rate=neutralRate → 1.0, hit_rate=0 → minWeight.
 */
function rawLaneWeight(bucket, opts = {}) {
  const minSample = posInt(opts.minSample, DEFAULT_MIN_SAMPLE)
  const neutral = unitOpen(opts.neutralRate, DEFAULT_NEUTRAL_RATE)
  const maxW = atLeastOne(opts.maxWeight, DEFAULT_MAX_WEIGHT)
  const minW = unitOpen(opts.minWeight, DEFAULT_MIN_WEIGHT)

  const judged = bucket && Number.isFinite(bucket.judged) ? bucket.judged : 0
  const rate = bucket && Number.isFinite(bucket.hit_rate) ? bucket.hit_rate : null
  const label = bucket && bucket.label != null ? bucket.label : null

  if (judged < minSample || rate == null) {
    return { weight: 1, adjusted: false, judged, hit_rate: rate, label, direction: 'neutral', reason: 'insufficient_sample' }
  }

  let w
  if (rate >= neutral) {
    const gainUp = (maxW - 1) / (1 - neutral)   // neutral ∈ (0,1) ⇒ denom > 0
    w = 1 + (rate - neutral) * gainUp
  } else {
    const gainDn = (1 - minW) / neutral         // neutral ∈ (0,1) ⇒ denom > 0
    w = 1 - (neutral - rate) * gainDn
  }
  w = clamp(round(w, 4), minW, maxW)
  const direction = w > 1 ? 'promote' : w < 1 ? 'demote' : 'neutral'
  return { weight: w, adjusted: w !== 1, judged, hit_rate: rate, label, direction, reason: direction === 'neutral' ? 'neutral' : `${direction}d` }
}

/**
 * deriveLeadPolicy(impact, opts) — a briefImpact grade → a per-lane lead-selection
 * policy. Pure; never throws.
 *   impact : a summarizeBriefImpact() result. Only its `status` ('graded' gates any
 *            nudge at all) and `by_lane` map are read.
 *   opts   : { minSample, neutralRate, maxWeight, minWeight, safetyFloorLanes }
 *
 * Returns:
 *   { status:'tuned'|'idle'|'abstained', neutral_rate, min_sample,
 *     bounds:{min,max}, safety_floor_lanes:[...],
 *     lanes: { [lane]: { weight, direction, adjusted, judged, hit_rate, label,
 *                        reason, safetyFloored } },
 *     promoted, demoted, floored, adjusted_count }
 *   • 'abstained' — impact not graded; every lane forced neutral (weight 1.0).
 *   • 'idle'      — graded, but no lane crossed minSample (nothing to tune yet).
 *   • 'tuned'     — graded and ≥1 lane nudged off neutral.
 *   Display fields (judged/hit_rate/label) stay truthful even when the weight is held
 *   neutral, so a surface can show a thin or floored lane honestly.
 */
function deriveLeadPolicy(impact, opts = {}) {
  const minSample = posInt(opts.minSample, DEFAULT_MIN_SAMPLE)
  const neutralRate = unitOpen(opts.neutralRate, DEFAULT_NEUTRAL_RATE)
  const maxWeight = atLeastOne(opts.maxWeight, DEFAULT_MAX_WEIGHT)
  const minWeight = unitOpen(opts.minWeight, DEFAULT_MIN_WEIGHT)
  const floorLanes = Array.isArray(opts.safetyFloorLanes)
    ? opts.safetyFloorLanes.map(str)
    : SAFETY_FLOOR_LANES.slice()

  const graded = !!(impact && impact.status === 'graded')
  const byLane = (impact && impact.by_lane && typeof impact.by_lane === 'object') ? impact.by_lane : {}
  const subOpts = { minSample, neutralRate, maxWeight, minWeight }

  const lanes = {}
  let promoted = 0, demoted = 0, floored = 0, adjusted = 0

  for (const laneKey of Object.keys(byLane)) {
    const raw = rawLaneWeight(byLane[laneKey], subOpts)
    // Only APPLY a nudge when the corpus is graded; otherwise hold neutral but keep the
    // raw display fields so a surface still shows the lane's real (un-acted-on) record.
    let weight = graded ? raw.weight : 1
    let reason = graded ? raw.reason : 'abstained'
    let safetyFloored = false
    if (floorLanes.includes(laneKey) && weight < 1) {
      weight = 1
      safetyFloored = true
      reason = 'safety_floored'
    }
    const direction = weight > 1 ? 'promote' : weight < 1 ? 'demote' : 'neutral'
    lanes[laneKey] = {
      weight, direction, adjusted: weight !== 1,
      judged: raw.judged, hit_rate: raw.hit_rate, label: raw.label,
      reason, safetyFloored,
    }
    if (safetyFloored) floored++
    if (weight !== 1) { adjusted++; if (direction === 'promote') promoted++; else demoted++ }
  }

  const status = !graded ? 'abstained' : (adjusted > 0 ? 'tuned' : 'idle')
  return {
    status,
    neutral_rate: neutralRate,
    min_sample: minSample,
    bounds: { min: minWeight, max: maxWeight },
    safety_floor_lanes: floorLanes.slice(),
    lanes,
    promoted, demoted, floored,
    adjusted_count: adjusted,
  }
}

/**
 * applyLeadPolicy(candidates, policy, opts) — re-rank lead candidates by the learned
 * policy. Pure: returns a NEW array of copies, never mutates the input, never drops or
 * invents a candidate.
 *   candidates : [{ lane, score, ... }, ...] — the engine's ranked lead contenders.
 *   policy     : a deriveLeadPolicy() result (or null → every weight 1.0).
 *   opts       : { scoreKey='score', protectLanes=SAFETY_FLOOR_LANES }
 *
 * Ordering, in priority:
 *   1. PROTECTED lanes first, always — a live act_now can never be displaced from the
 *      lead by a learned promotion of any other lane (pass protectLanes:[] to opt out).
 *   2. then by weighted score (base × lane weight),
 *   3. then stable on the original index (ties never reshuffle).
 * Each returned candidate carries base_score and lead_weight for transparency, and its
 * scoreKey overwritten with the weighted value.
 */
function applyLeadPolicy(candidates, policy, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const lanes = (policy && policy.lanes && typeof policy.lanes === 'object') ? policy.lanes : {}
  const scoreKey = typeof opts.scoreKey === 'string' && opts.scoreKey ? opts.scoreKey : 'score'
  const protect = Array.isArray(opts.protectLanes) ? opts.protectLanes.map(str) : SAFETY_FLOOR_LANES.slice()

  const dec = list.map((c, i) => {
    const base = c && Number.isFinite(c[scoreKey]) ? c[scoreKey] : 0
    const laneKey = c ? str(c.lane) : ''
    const entry = lanes[laneKey]
    const weight = entry && Number.isFinite(entry.weight) ? entry.weight : 1
    const protectedLane = protect.includes(laneKey) ? 1 : 0
    return { c, i, base, weight, adj: base * weight, protectedLane }
  })

  dec.sort((a, b) =>
    (b.protectedLane - a.protectedLane) ||   // protected lanes always lead
    (b.adj - a.adj) ||                        // then weighted score, descending
    (a.i - b.i))                              // then stable on input order

  return dec.map(d => ({ ...d.c, base_score: d.base, lead_weight: d.weight, [scoreKey]: round(d.adj, 6) }))
}

/**
 * narrateLeadPolicy(policy, opts) — ONE agency-only sentence about what the brief has
 * learned to lead with. Deterministic; names only lanes that actually crossed sample and
 * moved off neutral, so it can never overclaim. Returns '' when there is nothing learned.
 *   CLIENT  : '' always — lead-selection tuning is internal calibration, never client-facing.
 *   AGENCY  : e.g. "From our own front-page track record, we've learned to lead more with
 *             tailwinds and ease off verify." Silent unless status is 'tuned'.
 */
function narrateLeadPolicy(policy, opts = {}) {
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  if (audience === 'client') return ''
  if (!policy || policy.status !== 'tuned' || !policy.lanes) return ''

  const ups = [], downs = []
  for (const k of Object.keys(policy.lanes)) {
    const e = policy.lanes[k]
    if (!e || !e.adjusted) continue
    if (e.direction === 'promote') ups.push(humanizeLane(k))
    else if (e.direction === 'demote') downs.push(humanizeLane(k))
  }
  if (!ups.length && !downs.length) return ''

  const clauses = []
  if (ups.length) clauses.push(`lead more with ${joinList(ups)}`)
  if (downs.length) clauses.push(`ease off ${joinList(downs)}`)
  return `From our own front-page track record, we've learned to ${joinList(clauses)}.`
}

module.exports = {
  rawLaneWeight,
  deriveLeadPolicy,
  applyLeadPolicy,
  narrateLeadPolicy,
  humanizeLane,
  SAFETY_FLOOR_LANES,
  DEFAULT_MIN_SAMPLE,
  DEFAULT_NEUTRAL_RATE,
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
}
