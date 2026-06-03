'use strict'

// ============================================================
// lib/briefLeadPolicyHealth.js — watch the watcher: is the lead-policy
// loop trustworthy right now, or has it started chasing its own tail?
//
// THE GAP THIS CLOSES
// -------------------
// [[briefImpact]] MEASURES the brief's own front page; [[briefLeadPolicy]] TUNES
// that record into a bounded per-lane nudge the engine applies when it ranks the
// one lead slot. That is a closed feedback loop — and an unsupervised feedback
// loop can go wrong in ways no single snapshot reveals:
//   • OSCILLATION   — a lane flips promote↔demote morning after morning, the loop
//                     chasing noise instead of signal. Each day's policy looks sane;
//                     only the SEQUENCE shows the thrash.
//   • SATURATION    — a lane's weight pins at a bound (min/max) and stays there. The
//                     ±20% band has run out of room; the loop wants to push harder
//                     than it is allowed to, and the nudge has quietly become a wall.
//   • FLOOR-MASKING — the safety floor keeps catching `act_now` (its raw record would
//                     demote it, but the floor holds it at neutral) morning after
//                     morning. The client is protected exactly as designed — but a
//                     persistent overcall is hiding behind the safety valve, and a
//                     human should know.
// deriveLeadPolicy hands back ONE snapshot. This module reads a HISTORY of them and
// asks the question the loop cannot ask itself: is this still self-improvement, or
// has it become self-harm? It is the brief grading its own grader.
//
// A SELF-HEALING VALVE, NOT JUST A DIAGNOSIS
// ------------------------------------------
// The verdict carries a single recommended_action, and one value of it is load-bearing:
// 'revert_to_neutral'. When a lane is oscillating, the safest thing the loop can do is
// stop trusting itself — fall back to a neutral lead order until the thrash settles.
// shouldRevertToNeutral(verdict) is the one-line predicate the engine consults BEFORE
// it applies the policy, so the loop can take its own hands off the wheel with no human
// in the path. The other actions (widen_bounds, investigate_floor) are agency advisories:
// surfaced, never auto-applied, because widening a safety band or reading a masked
// overcall is a judgement call a person should make.
//
// INTERNAL CALIBRATION — NEVER CLIENT-FACING
// ------------------------------------------
// Whether our own tuning loop is healthy is agency machinery, the same family as
// [[briefLeadPolicy]]'s nudge and [[pulseTuning]]'s sensitivity. narrateLeadPolicyHealth
// speaks only to the agency; its client branch is hard-wired to '' so the no-leak
// discipline lives in the module, not in a surface that has to remember it.
//
// PURE: a history in, a verdict out. No DB, no clock-of-now, no network, no LLM, no
// mutation, never throws. Every field is read off the snapshots it was handed, so it
// stays trivially testable on plain literals — exactly like the rest of the family.
// ============================================================

// How many of the most-recent snapshots to weigh. Older history still informs trend but
// a loop's CURRENT health is a recent-window question — six mornings/weeks of policy.
const DEFAULT_WINDOW = 6
// promote↔demote reversals within the window before a lane reads as oscillating. 2 = it
// has changed its mind and changed it BACK — one reversal is a correction, two is a thrash.
const DEFAULT_OSCILLATION_FLIPS = 2
// Consecutive trailing snapshots a lane must sit pinned at a bound before it reads as
// saturated. 3 = not a one-morning spike but a standing wall the band can't contain.
const DEFAULT_SATURATION_RUNS = 3
// Consecutive trailing snapshots the safety floor must catch a lane before we flag the
// masking. Same shape as saturation: a standing pattern, not a single caught morning.
const DEFAULT_MASK_RUNS = 3
// Weight spread (max−min) across the window at or below which a lane is "converged" —
// it has settled on a learned value and stopped moving. A hair under the rounding grain.
const DEFAULT_EPSILON = 0.02
// Fewest usable snapshots before we will say anything at all. One policy is not a trend;
// below this the verdict abstains, exactly the abstention floor the rest of the family lives by.
const DEFAULT_MIN_HISTORY = 2
// Bound defaults — mirror [[briefLeadPolicy]] DEFAULT_MIN_WEIGHT / DEFAULT_MAX_WEIGHT, used
// only when a snapshot omits its own bounds. Kept local so this module stays self-contained.
const DEFAULT_MIN_WEIGHT = 0.8
const DEFAULT_MAX_WEIGHT = 1.2
// Tolerance for "at the bound": clamp pins a saturated weight exactly, but float math and
// 4dp rounding leave a hair of slack. Tight enough that a merely-demoted 0.81 never counts.
const BOUND_EPS = 1e-6

// ── tiny pure guards (same idioms as briefLeadPolicy) ────────────────────────
const str = (x) => (x == null ? '' : String(x))
const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f }
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const nonNegNum = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d)

// humanizeLane('worth_a_look') → 'worth a look'. Underscore→space, lowercased — the lane
// vocabulary read aloud mid-sentence in the agency narration.
function humanizeLane(lane) {
  return str(lane).replace(/_/g, ' ').trim().toLowerCase()
}

// Join a short list of phrases with serial commas: [a]→'a', [a,b]→'a and b',
// [a,b,c]→'a, b and c'. Deterministic; used only for the agency one-liner.
function joinList(xs) {
  const a = xs.filter(Boolean)
  if (a.length <= 1) return a[0] || ''
  if (a.length === 2) return `${a[0]} and ${a[1]}`
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
}

// Normalise one history element to { as_of, policy } or null if unusable. Accepts a bare
// deriveLeadPolicy() result (has .lanes), a { as_of, policy } wrapper, or { as_of, ...policy }.
function normSnapshot(s) {
  if (!s || typeof s !== 'object') return null
  if (s.policy && typeof s.policy === 'object' && s.policy.lanes && typeof s.policy.lanes === 'object') {
    return { as_of: s.as_of != null ? str(s.as_of) : (s.policy.as_of != null ? str(s.policy.as_of) : null), policy: s.policy }
  }
  if (s.lanes && typeof s.lanes === 'object') {
    return { as_of: s.as_of != null ? str(s.as_of) : null, policy: s }
  }
  return null
}

// The bounds a snapshot's weights live in — its own if present, else the family defaults.
function snapBounds(policy) {
  const b = policy && policy.bounds
  const min = b && Number.isFinite(b.min) ? b.min : DEFAULT_MIN_WEIGHT
  const max = b && Number.isFinite(b.max) ? b.max : DEFAULT_MAX_WEIGHT
  return { min, max }
}

// Read one lane out of one snapshot into a flat per-morning cell. Absent lane → { present:false }.
// direction prefers the policy's own field, falling back to the sign of the weight.
function laneCell(policy, laneKey) {
  const lanes = policy && policy.lanes
  const e = lanes && typeof lanes === 'object' ? lanes[laneKey] : null
  if (!e || typeof e !== 'object') return { present: false, weight: null, direction: 'neutral', floored: false, atHigh: false, atLow: false }
  const weight = Number.isFinite(e.weight) ? e.weight : 1
  const floored = !!e.safetyFloored
  const direction = e.direction === 'promote' || e.direction === 'demote' || e.direction === 'neutral'
    ? e.direction
    : (weight > 1 ? 'promote' : weight < 1 ? 'demote' : 'neutral')
  const { min, max } = snapBounds(policy)
  return {
    present: true,
    weight,
    direction,
    floored,
    atHigh: weight >= max - BOUND_EPS,
    atLow: weight <= min + BOUND_EPS,
  }
}

// Count promote↔demote reversals in a morning-ordered cell list. Neutrals and gaps are
// skipped (they neither make nor break a reversal); a flip is an adjacent unequal pair in
// the remaining promote/demote subsequence.
function countFlips(cells) {
  const dirs = cells.filter(c => c.present && (c.direction === 'promote' || c.direction === 'demote')).map(c => c.direction)
  let flips = 0
  for (let i = 1; i < dirs.length; i++) if (dirs[i] !== dirs[i - 1]) flips++
  return flips
}

// Length of the trailing run (from the newest morning backward) for which pred holds on a
// PRESENT cell. A gap or a failing cell stops the count — saturation/masking are about being
// pinned RIGHT NOW, not ever.
function trailingRun(cells, pred) {
  let run = 0
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]
    if (c.present && pred(c)) run++
    else break
  }
  return run
}

/**
 * assessLeadPolicyHealth(history, opts) — read a HISTORY of deriveLeadPolicy snapshots and
 * judge whether the lead-selection loop is healthy. Pure; never throws.
 *   history : ordered OLDEST→NEWEST array. Each element is a deriveLeadPolicy() result, a
 *             { as_of, policy } wrapper, or { as_of, ...policy }. Unusable elements are skipped.
 *   opts    : { window, oscillationFlips, saturationRuns, maskRuns, epsilon, minHistory }
 *
 * Returns:
 *   { status:'stable'|'settling'|'unstable'|'constrained'|'flagged'|'idle'|'abstained',
 *     recommended_action:'trust'|'hold'|'widen_bounds'|'revert_to_neutral'|'investigate_floor'|'none',
 *     as_of, window_used, history_len, bounds:{min,max},
 *     lanes:{ [lane]:{ state, flips, high_run, low_run, mask_runs, spread,
 *                      last_weight, last_direction, present, series:[w|null,...] } },
 *     counts:{ oscillating, saturated, masked, settling, stable, idle, active },
 *     verdict_reason }
 *   • 'abstained' — fewer than minHistory usable snapshots; nothing trend-worthy to say.
 *   • 'idle'      — usable history, but no lane was ever active across the window.
 *   status/action precedence (most→least urgent): oscillation → saturation → floor-mask →
 *   settling → stable → idle. Only oscillation yields the self-healing 'revert_to_neutral'.
 */
function assessLeadPolicyHealth(history, opts = {}) {
  const window = posInt(opts.window, DEFAULT_WINDOW)
  const oscFlips = posInt(opts.oscillationFlips, DEFAULT_OSCILLATION_FLIPS)
  const satRuns = posInt(opts.saturationRuns, DEFAULT_SATURATION_RUNS)
  const maskRuns = posInt(opts.maskRuns, DEFAULT_MASK_RUNS)
  const epsilon = nonNegNum(opts.epsilon, DEFAULT_EPSILON)
  const minHistory = posInt(opts.minHistory, DEFAULT_MIN_HISTORY)

  const usable = (Array.isArray(history) ? history : []).map(normSnapshot).filter(Boolean)

  if (usable.length < minHistory) {
    return {
      status: 'abstained',
      recommended_action: 'none',
      as_of: usable.length ? usable[usable.length - 1].as_of : null,
      window_used: usable.length,
      history_len: usable.length,
      bounds: usable.length ? snapBounds(usable[usable.length - 1].policy) : { min: DEFAULT_MIN_WEIGHT, max: DEFAULT_MAX_WEIGHT },
      lanes: {},
      counts: { oscillating: 0, saturated: 0, masked: 0, settling: 0, stable: 0, idle: 0, active: 0 },
      verdict_reason: 'abstained:thin_history',
    }
  }

  // Analyse the most-recent `window` snapshots only — current health is a recent question.
  const win = usable.slice(-window)
  const newest = win[win.length - 1]

  // Union of lane keys seen anywhere in the window, in first-seen order for determinism.
  const laneKeys = []
  const seen = new Set()
  for (const snap of win) {
    for (const k of Object.keys(snap.policy.lanes || {})) {
      if (!seen.has(k)) { seen.add(k); laneKeys.push(k) }
    }
  }

  const lanes = {}
  const counts = { oscillating: 0, saturated: 0, masked: 0, settling: 0, stable: 0, idle: 0, active: 0 }

  for (const laneKey of laneKeys) {
    const cells = win.map(snap => laneCell(snap.policy, laneKey))
    const present = cells.filter(c => c.present)
    const weights = present.map(c => c.weight)
    const spread = weights.length ? round(Math.max(...weights) - Math.min(...weights), 6) : 0
    const everActive = present.some(c => c.weight !== 1 || c.floored)
    const flips = countFlips(cells)
    const high_run = trailingRun(cells, c => c.atHigh)
    const low_run = trailingRun(cells, c => c.atLow)
    const mask_runs = trailingRun(cells, c => c.floored)
    const lastCell = cells[cells.length - 1]

    let state
    if (!everActive) state = 'idle'
    else if (mask_runs >= maskRuns) state = 'floor_masked'
    else if (flips >= oscFlips) state = 'oscillating'
    else if (high_run >= satRuns) state = 'saturated_high'
    else if (low_run >= satRuns) state = 'saturated_low'
    else if (spread <= epsilon) state = 'stable'
    else state = 'settling'

    if (state === 'idle') counts.idle++
    else {
      counts.active++
      if (state === 'oscillating') counts.oscillating++
      else if (state === 'saturated_high' || state === 'saturated_low') counts.saturated++
      else if (state === 'floor_masked') counts.masked++
      else if (state === 'settling') counts.settling++
      else if (state === 'stable') counts.stable++
    }

    lanes[laneKey] = {
      state, flips, high_run, low_run, mask_runs, spread,
      last_weight: lastCell.present ? lastCell.weight : null,
      last_direction: lastCell.present ? lastCell.direction : null,
      present: present.length,
      series: cells.map(c => (c.present ? c.weight : null)),
    }
  }

  // Verdict precedence — most urgent concern wins the status and the single action.
  let status, recommended_action, verdict_reason
  if (counts.oscillating > 0) {
    status = 'unstable'; recommended_action = 'revert_to_neutral'
    verdict_reason = `oscillation:${laneKeys.filter(k => lanes[k].state === 'oscillating').join(',')}`
  } else if (counts.saturated > 0) {
    status = 'constrained'; recommended_action = 'widen_bounds'
    verdict_reason = `saturation:${laneKeys.filter(k => lanes[k].state === 'saturated_high' || lanes[k].state === 'saturated_low').join(',')}`
  } else if (counts.masked > 0) {
    status = 'flagged'; recommended_action = 'investigate_floor'
    verdict_reason = `floor_mask:${laneKeys.filter(k => lanes[k].state === 'floor_masked').join(',')}`
  } else if (counts.settling > 0) {
    status = 'settling'; recommended_action = 'hold'; verdict_reason = 'settling'
  } else if (counts.stable > 0) {
    status = 'stable'; recommended_action = 'trust'; verdict_reason = 'converged'
  } else {
    status = 'idle'; recommended_action = 'none'; verdict_reason = 'idle'
  }

  return {
    status,
    recommended_action,
    as_of: newest.as_of,
    window_used: win.length,
    history_len: usable.length,
    bounds: snapBounds(newest.policy),
    lanes,
    counts,
    verdict_reason,
  }
}

/**
 * shouldRevertToNeutral(verdict) — the one self-healing hook the engine consults before it
 * applies the lead policy. True ONLY when the loop is oscillating (recommended_action
 * 'revert_to_neutral'); saturation and floor-masking are advisories, not auto-actions. Pure.
 */
function shouldRevertToNeutral(verdict) {
  return !!(verdict && verdict.recommended_action === 'revert_to_neutral')
}

// The largest trailing run among lanes in a given set of states — the "for N mornings"
// figure the narration quotes. 0 if none.
function maxRun(verdict, states, pick) {
  let n = 0
  for (const k of Object.keys(verdict.lanes || {})) {
    const l = verdict.lanes[k]
    if (states.includes(l.state)) n = Math.max(n, pick(l))
  }
  return n
}

/**
 * narrateLeadPolicyHealth(verdict, opts) — ONE agency-only sentence about the loop's health.
 * Deterministic; names only the lanes that triggered the concern, so it can never overclaim.
 *   CLIENT : '' always — loop health is internal calibration, never client-facing.
 *   AGENCY : speaks for the four states worth knowing about (unstable / constrained / flagged
 *            / stable); silent ('') for settling, idle, and abstained — no news is good news.
 */
function narrateLeadPolicyHealth(verdict, opts = {}) {
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  if (audience === 'client') return ''
  if (!verdict || !verdict.status || !verdict.lanes) return ''

  const lanesInState = (states) =>
    Object.keys(verdict.lanes).filter(k => states.includes(verdict.lanes[k].state)).map(humanizeLane)

  if (verdict.status === 'unstable') {
    const names = joinList(lanesInState(['oscillating']))
    if (!names) return ''
    return `Our lead-selection tuning is oscillating on ${names} — we've fallen back to a neutral lead order until it settles.`
  }

  if (verdict.status === 'constrained') {
    const highs = lanesInState(['saturated_high'])
    const lows = lanesInState(['saturated_low'])
    const names = joinList(lanesInState(['saturated_high', 'saturated_low']))
    if (!names) return ''
    const where = highs.length && lows.length ? 'at its bounds' : (lows.length ? 'at its floor' : 'at its ceiling')
    const n = maxRun(verdict, ['saturated_high', 'saturated_low'], l => Math.max(l.high_run, l.low_run))
    const b = verdict.bounds || {}
    const pctUp = Number.isFinite(b.max) ? round((b.max - 1) * 100, 0) : null
    const pctDn = Number.isFinite(b.min) ? round((1 - b.min) * 100, 0) : null
    const band = pctUp != null && pctDn != null && pctUp === pctDn ? `±${pctUp}%` : 'weight'
    return `Our lead-selection tuning has pinned ${names} ${where} for ${n} ${n === 1 ? 'morning' : 'mornings'} — the ${band} band may be too tight.`
  }

  if (verdict.status === 'flagged') {
    const names = joinList(lanesInState(['floor_masked']))
    if (!names) return ''
    const n = maxRun(verdict, ['floor_masked'], l => l.mask_runs)
    return `The safety floor has caught ${names} for ${n} ${n === 1 ? 'morning' : 'mornings'} running — its recent record would otherwise ease it down; worth a look at why.`
  }

  if (verdict.status === 'stable') {
    return `Our lead-selection tuning has settled — the learned front-page priorities are holding steady.`
  }

  return ''
}

module.exports = {
  assessLeadPolicyHealth,
  shouldRevertToNeutral,
  narrateLeadPolicyHealth,
  humanizeLane,
  DEFAULT_WINDOW,
  DEFAULT_OSCILLATION_FLIPS,
  DEFAULT_SATURATION_RUNS,
  DEFAULT_MASK_RUNS,
  DEFAULT_EPSILON,
  DEFAULT_MIN_HISTORY,
}
