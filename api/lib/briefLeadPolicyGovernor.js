'use strict'

// ============================================================
// lib/briefLeadPolicyGovernor.js — the governor: act on the watcher's verdict,
// surgically, with no human in the path.
//
// THE GAP THIS CLOSES
// -------------------
// [[briefLeadPolicy]] TUNES the front page (a bounded per-lane nudge); [[briefLeadPolicyHealth]]
// WATCHES that loop and, when a lane oscillates, hands back recommended_action
// 'revert_to_neutral'. Until now the engine consumed that as ONE blunt, global switch
// (shouldRevertToNeutral): the instant ANY lane thrashed, the WHOLE learned policy was
// thrown out and every lane — including the ones that had honestly earned their lift —
// snapped back to neutral. A single noisy `verify` lane silenced a perfectly stable
// `tailwind` promotion. Self-healing, yes; but with a sledgehammer.
//
// This module is the SURGEON. It reads the policy AND the verdict together and produces the
// policy the engine should ACTUALLY apply — neutralising ONLY the lanes the monitor faulted
// and leaving every healthy, earned lane live. The thrashing tuner takes its own hands off
// exactly the one wheel that is shaking, and keeps driving with the rest. It is the loop
// governing itself, per-lane, with no operator reading a chip and deciding.
//
// WHAT IT DOES, PER LANE (bounded blast radius)
// ---------------------------------------------
//   • oscillating   → NEUTRALISE. weight → 1.0, the surgical self-heal. The only action
//                     that changes an applied weight. (No-op if the lane is already neutral,
//                     which is what makes the whole pass idempotent.)
//   • saturated_*   → HOLD AT BOUND. The lane is already pinned at the band edge; the
//                     governor refuses to widen the band on its own (that expands the safety
//                     envelope — a human call) and logs the held non-action.
//   • floor_masked  → RESPECT FLOOR. act_now is doing exactly what the floor is for; the
//                     governor keeps the floor and logs the masked overcall for a human.
//   • stable / settling / idle / healthy / absent → PASS THROUGH untouched. Good learning rides.
//
// GUARANTEES (verify-after, encoded HERE — not left to the caller)
// ---------------------------------------------------------------
//   IDEMPOTENT  — governing the governed policy again changes nothing (neutralise fires
//                 only on a non-neutral weight).
//   REVERSIBLE  — `snapshot` carries every pre-governance weight; `interventions` lists
//                 every change, so the original policy is reconstructable.
//   SAFE        — a neutralised lane lands at exactly 1.0; a safety-floored lane is never
//                 pushed below its floor. The asymmetry [[briefLeadPolicy]] encodes survives.
//   BOUNDED     — only lanes the verdict explicitly faulted are touched; every other lane is
//                 byte-identical (weight, direction, and all display fields).
//   FAIL-SAFE   — no verdict, an abstained verdict, or a null policy ⇒ the governor abstains
//                 and passes the policy through UNCHANGED. We never intervene on a loop we
//                 cannot currently assess.
//
// INTERNAL CALIBRATION — NEVER CLIENT-FACING
// ------------------------------------------
// What the governor did to our own tuning loop is agency machinery, the same family as
// [[briefLeadPolicy]]'s nudge and [[briefLeadPolicyHealth]]'s verdict. narrateLeadPolicyGovernance
// speaks only to the agency; its client branch is hard-wired to '' so the no-leak discipline
// lives in the module, not in a surface that has to remember it.
//
// PURE: a policy + a verdict in, a governed policy out. No DB, no clock-of-now, no network,
// no LLM, no mutation of the inputs, never throws. Trivially testable on plain literals —
// exactly like the rest of the family.
// ============================================================

// The one safety-critical triage lane — promotable, never demoted below neutral. Mirrors
// [[briefLeadPolicy]].SAFETY_FLOOR_LANES; kept local so the module stays self-contained.
const SAFETY_FLOOR_LANES = ['act_now']

// ── tiny pure guards (same idioms as the rest of the family) ─────────────────
const str = (x) => (x == null ? '' : String(x))
const finite = (v, d) => (Number.isFinite(v) ? v : d)

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

// The verdict's per-lane state, or '' when the verdict doesn't cover this lane.
function verdictLaneState(verdict, laneKey) {
  const lanes = verdict && verdict.lanes
  const e = lanes && typeof lanes === 'object' ? lanes[laneKey] : null
  return e && typeof e.state === 'string' ? e.state : ''
}

// Copy ONE policy lane into a NEW object — never mutate the input. direction prefers the
// lane's own field, falling back to the sign of the weight; display fields ride verbatim.
function cloneLane(e) {
  const weight = finite(e && e.weight, 1)
  const direction = (e && (e.direction === 'promote' || e.direction === 'demote' || e.direction === 'neutral'))
    ? e.direction
    : (weight > 1 ? 'promote' : weight < 1 ? 'demote' : 'neutral')
  return {
    weight,
    direction,
    adjusted: !!(e && e.adjusted),
    judged: e ? e.judged : undefined,
    hit_rate: e ? e.hit_rate : undefined,
    label: e ? e.label : undefined,
    reason: e ? e.reason : undefined,
    safetyFloored: !!(e && e.safetyFloored),
  }
}

// A NEW copy of a policy with cloned lanes — used on the fail-safe pass-through so a caller
// can never mutate our return into the original input. Top-level fields ride verbatim.
function clonePolicy(policy) {
  const lanes = {}
  for (const k of Object.keys(policy.lanes)) lanes[k] = cloneLane(policy.lanes[k])
  return {
    status: policy.status,
    neutral_rate: policy.neutral_rate,
    min_sample: policy.min_sample,
    bounds: policy.bounds && typeof policy.bounds === 'object' ? { ...policy.bounds } : policy.bounds,
    safety_floor_lanes: Array.isArray(policy.safety_floor_lanes) ? policy.safety_floor_lanes.slice() : policy.safety_floor_lanes,
    lanes,
    promoted: policy.promoted,
    demoted: policy.demoted,
    floored: policy.floored,
    adjusted_count: policy.adjusted_count,
  }
}

// The pre-governance weight/direction of every lane — the reversibility record.
function snapshotOf(policy) {
  const lanes = {}
  for (const k of Object.keys(policy.lanes)) {
    const e = policy.lanes[k] || {}
    lanes[k] = {
      weight: finite(e.weight, 1),
      direction: e.direction || 'neutral',
      adjusted: !!e.adjusted,
      safetyFloored: !!e.safetyFloored,
    }
  }
  return { lanes }
}

/**
 * governLeadPolicy(policy, verdict, opts) — surgically reconcile a lead policy with the
 * stability verdict that watches it. Pure; never throws; never mutates either input.
 *   policy  : a deriveLeadPolicy() result, or null.
 *   verdict : an assessLeadPolicyHealth() result, or null.
 *
 * Returns:
 *   { status:'corrected'|'advised'|'clean'|'abstained',
 *     verdict_status, source_status,
 *     governed: <a deriveLeadPolicy-shaped policy to APPLY, or null when policy was null>,
 *     interventions:[ { lane, action:'neutralize'|'hold_at_bound'|'respect_floor', state,
 *                       from_weight, to_weight, from_direction, to_direction, reason } ],
 *     snapshot:{ lanes:{ [lane]:{ weight, direction, adjusted, safetyFloored } } },
 *     counts:{ neutralized, held, floored_respected, passed } }
 *
 *   status — the GOVERNANCE verdict, DISTINCT from governed.status (the apply-gate policy
 *   status): 'corrected' a weight was reset; 'advised' only advisory holds were logged;
 *   'clean' nothing to do; 'abstained' could not assess → policy passed through untouched.
 */
function governLeadPolicy(policy, verdict, opts = {}) {
  const hasPolicy = !!(policy && policy.lanes && typeof policy.lanes === 'object')
  const verdictStatus = verdict && typeof verdict.status === 'string' ? verdict.status : null
  const sourceStatus = policy && typeof policy.status === 'string' ? policy.status : null

  // FAIL-SAFE: nothing to govern, or no trustworthy verdict ⇒ pass the policy through. We
  // never intervene on a loop we cannot currently assess (no/blank/abstained verdict).
  const cannotAssess = !verdict || !verdictStatus || verdictStatus === 'abstained'
  if (!hasPolicy || cannotAssess) {
    return {
      status: 'abstained',
      verdict_status: verdictStatus,
      source_status: sourceStatus,
      governed: hasPolicy ? clonePolicy(policy) : (policy || null),
      interventions: [],
      snapshot: hasPolicy ? snapshotOf(policy) : { lanes: {} },
      counts: { neutralized: 0, held: 0, floored_respected: 0, passed: hasPolicy ? Object.keys(policy.lanes).length : 0 },
    }
  }

  const floorLanes = Array.isArray(policy.safety_floor_lanes) ? policy.safety_floor_lanes.map(str) : SAFETY_FLOOR_LANES.slice()
  const lanes = {}
  const interventions = []
  const counts = { neutralized: 0, held: 0, floored_respected: 0, passed: 0 }

  for (const laneKey of Object.keys(policy.lanes)) {
    const src = cloneLane(policy.lanes[laneKey])
    const state = verdictLaneState(verdict, laneKey)

    if (state === 'oscillating' && src.weight !== 1) {
      // SURGICAL SELF-HEAL — reset just this thrashing lane to neutral. A safety-floored lane
      // landing at exactly 1.0 still honours its floor (≥1). This is the only weight change.
      const from_weight = src.weight
      const from_direction = src.direction
      src.weight = 1
      src.direction = 'neutral'
      src.adjusted = false
      src.reason = 'governed_oscillation'
      interventions.push({ lane: laneKey, action: 'neutralize', state, from_weight, to_weight: 1, from_direction, to_direction: 'neutral', reason: 'oscillation' })
      counts.neutralized++
    } else if (state === 'saturated_high' || state === 'saturated_low') {
      // HOLD AT BOUND — refuse to widen the band on our own (a human call); log the held
      // non-action. Weight is unchanged: it is already pinned at the edge by construction.
      interventions.push({ lane: laneKey, action: 'hold_at_bound', state, from_weight: src.weight, to_weight: src.weight, from_direction: src.direction, to_direction: src.direction, reason: 'saturation' })
      counts.held++
    } else if (state === 'floor_masked') {
      // RESPECT FLOOR — keep protecting the client exactly as designed; log the masked
      // overcall for a human to investigate. No weight change.
      interventions.push({ lane: laneKey, action: 'respect_floor', state, from_weight: src.weight, to_weight: src.weight, from_direction: src.direction, to_direction: src.direction, reason: 'floor_mask' })
      counts.floored_respected++
    } else {
      // PASS THROUGH — stable, settling, idle, healthy-tuned, an already-neutral oscillator,
      // or a lane the verdict never saw. Good learning rides untouched.
      counts.passed++
    }
    lanes[laneKey] = src
  }

  // Recompute the apply-gate rollups from the GOVERNED lanes so governed.status stays honest
  // after a surgical neutralise (if it removed the last adjusted lane, the policy goes idle).
  let promoted = 0, demoted = 0, floored = 0, adjusted = 0
  for (const k of Object.keys(lanes)) {
    const e = lanes[k]
    if (e.safetyFloored) floored++
    if (e.weight !== 1) { adjusted++; if (e.direction === 'promote') promoted++; else demoted++ }
  }
  // An ungraded source policy stays 'abstained'; a graded one is 'tuned' iff a lane still
  // applies, else 'idle'. Mirrors deriveLeadPolicy's own status grammar exactly.
  const governedStatus = sourceStatus === 'abstained' ? 'abstained' : (adjusted > 0 ? 'tuned' : 'idle')

  const governed = {
    status: governedStatus,
    neutral_rate: policy.neutral_rate,
    min_sample: policy.min_sample,
    bounds: policy.bounds && typeof policy.bounds === 'object' ? { ...policy.bounds } : policy.bounds,
    safety_floor_lanes: floorLanes.slice(),
    lanes,
    promoted,
    demoted,
    floored,
    adjusted_count: adjusted,
  }

  // GOVERNANCE verdict precedence: a real correction outranks an advisory-only hold, which
  // outranks a clean pass. ('corrected' implies ≥1 weight actually changed.)
  const status = counts.neutralized > 0 ? 'corrected' : (interventions.length > 0 ? 'advised' : 'clean')

  return {
    status,
    verdict_status: verdictStatus,
    source_status: sourceStatus,
    governed,
    interventions,
    snapshot: snapshotOf(policy),
    counts,
  }
}

/**
 * narrateLeadPolicyGovernance(result, opts) — ONE agency-only sentence about what the governor
 * DID this morning (distinct from the verdict's DIAGNOSIS, which [[briefLeadPolicyHealth]]
 * narrates). Speaks only when a weight was actually reset ('corrected'); the advisory holds are
 * the verdict narrator's story, not the surgeon's. Deterministic; names only the lanes it reset.
 *   CLIENT : '' always — governance of our own loop is internal calibration, never client-facing.
 *   AGENCY : e.g. "We've reset our lead-selection nudge on verify to neutral while it settles —
 *            the rest of the learned order stands."
 */
function narrateLeadPolicyGovernance(result, opts = {}) {
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  if (audience === 'client') return ''
  if (!result || result.status !== 'corrected' || !Array.isArray(result.interventions)) return ''

  const names = joinList(result.interventions.filter(i => i.action === 'neutralize').map(i => humanizeLane(i.lane)))
  if (!names) return ''
  // Only claim "the rest stands" when a learned order genuinely survives the reset.
  const tail = (result.governed && result.governed.status === 'tuned') ? ' — the rest of the learned order stands' : ''
  return `We've reset our lead-selection nudge on ${names} to neutral while it settles${tail}.`
}

module.exports = {
  governLeadPolicy,
  narrateLeadPolicyGovernance,
  humanizeLane,
  SAFETY_FLOOR_LANES,
}
