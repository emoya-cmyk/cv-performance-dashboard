'use strict'

// ============================================================
// lib/briefLeadPolicyRemediation.js — the remediator: turn the auditor's "this lane
// keeps churning, escalate it" into the CONCRETE, bounded, reversible structural fix —
// staged for one agency click, never auto-applied, never touching the safety floor.
//
// THE GAP THIS CLOSES
// -------------------
// The lead-policy autonomy stack now runs a full loop without a human in the path —
// except for the last rung:
//   • [[briefLeadPolicy]]         TUNES the front page (a bounded per-lane nudge).   (ACT)
//   • [[briefLeadPolicyHealth]]   WATCHES that loop, hands back a stability verdict.  (SENSE)
//   • [[briefLeadPolicyGovernor]] ACTS on the verdict — neutralises only the lanes    (ACT)
//                                 that thrashed; idempotent, reversible, bounded.
//   • [[briefLeadPolicyAudit]]    AUDITS the governor's own track record and, when a   (LEARN)
//                                 lane's safe daily reset keeps coming back, recommends
//                                 ESCALATION — naming the churning lanes.
// But that recommendation had no consumer. The auditor could say "escalate verify" and the
// loop would just… say it again tomorrow. The escalate signal named a problem and stopped.
// The reason the per-morning neutralise can't fix a churning lane is structural: neutralise
// resets the APPLIED weight back to 1.0 for one morning, but it never changes the KNOBS that
// re-derive that weight from a noisy hit-rate the next morning — so the wobble is mechanically
// guaranteed to return. Breaking the cycle needs a change to the derivation itself, and that
// is exactly the move the governor is forbidden (by design) to make on its own.
//
// This module is the REMEDIATOR — the ADJUST rung. It reads the auditor's escalation plus the
// CURRENT policy and, for each churning lane, computes the least-aggressive structural change
// that would actually still the loop, as a staged PROPOSAL the agency applies with one click:
//   • widen_neutral_band — give the lane a per-lane dead-band so small hit-rate wobbles around
//                          neutral stop producing weight changes at all. It still adapts to a
//                          big, sustained signal; it stops chasing noise. The gentlest fix.
//   • tighten_bounds     — narrow the lane's [min,max] toward 1.0 so even when it does move, the
//                          swing can't carry as far. Shrinks the amplitude, not the wobble.
//   • pin_neutral        — take the lane out of adaptation entirely, hold it at 1.0. The most
//                          decisive fix, and the one the auditor's narration already names.
//
// THE SELF-IMPROVING LADDER
// -------------------------
// The remedy is not picked from a fixed table — it ESCALATES by what has already been TRIED and
// proven insufficient, read straight off the policy's own per-lane overrides:
//   no override yet            → widen_neutral_band   (try the gentlest thing first)
//   already has a dead-band    → tighten_bounds       (gentle wasn't enough — go one rung up)
//   already has tight bounds   → pin_neutral          (still churning — take it out of the loop)
//   already pinned & STILL churning → abstain ('at_ceiling') — we have spent every safe structural
//                              move; widening blast radius further is a human judgement call.
// So each morning a churn persists, the staged remedy deepens by exactly one bounded step until
// the lane is pinned, and if a pinned lane somehow still churns the loop hands itself to a human
// rather than inventing a more aggressive move. That is LEARN→ADJUST closing on itself: the
// system gets MORE decisive only when its cheaper move is demonstrably not working.
//
// SAFETY ASYMMETRY — THE FLOOR IS NEVER REMEDIATED
// ------------------------------------------------
// A safety-floored lane (act_now) is promotable but never demoted below weight 1 — because
// under-serving a real emergency is far worse than over-serving a quiet one. Every structural
// remedy here (dead-band, tightened bounds, pin) can SUPPRESS a promotion, so applying any of
// them to the floored lane would re-introduce exactly the risk the floor exists to remove. The
// remediator therefore ABSTAINS on any safety-floored lane outright — reason 'safety_floored' —
// and surfaces it for human eyes instead of ever proposing a structural change to it.
//
// STAGED, NEVER AUTO-APPLIED
// --------------------------
// This module PROPOSES; it does not mutate the policy. Widening the intervention's blast radius
// past a bounded daily reset — changing how the loop derives, not just resetting one output —
// is a judgement call, so the proposal is staged for the agency and applied by an explicit
// click. Every proposal carries its `from` (the exact current knob) alongside its `to`, so
// applying it is one step and reverting it is one step: bounded AND reversible by construction.
//
// INTERNAL — NEVER CLIENT-FACING
// ------------------------------
// How our own auto-corrector is being re-tuned is the deepest agency telemetry in the stack,
// the same family as the governor's reset and the auditor's verdict. narrateLeadPolicyRemediation
// speaks only to the agency; its client branch is hard-wired to '' so the no-leak discipline
// lives in the module, not in a surface that has to remember it.
//
// PURE: an audit + a policy in, a proposal out. No DB, no clock-of-now, no network, no LLM, no
// mutation of the inputs, never throws. Trivially testable on plain literals — like the family.
// ============================================================

const { shouldEscalateGovernance, humanizeLane } = require('./briefLeadPolicyAudit')
const { SAFETY_FLOOR_LANES, DEFAULT_MIN_WEIGHT, DEFAULT_MAX_WEIGHT } = require('./briefLeadPolicy')

// One bounded step of dead-band to grant a churning lane the first time we widen it. A lane whose
// hit-rate jitters by less than this around the neutral rate stops producing any nudge at all —
// enough to absorb day-to-day noise, far short of deafening the lane to a real, sustained signal.
const DEFAULT_BAND_STEP = 0.1
// A hard ceiling on the dead-band no proposal will ever cross. The ladder escalates to a different
// remedy after one widen, so a single lane never reaches this in practice — it is a guard against
// pathological inputs (a policy that already claims an enormous band), not a normal operating point.
const DEFAULT_BAND_MAX = 0.25
// One bounded step of bound-tightening: raise min toward 1.0 by this, lower max toward 1.0 by this.
// {0.8,1.2} → {0.9,1.1} on the first tighten — the swing a moved lane can take shrinks by half.
const DEFAULT_BOUND_STEP = 0.1
// The tightest a lane's bounds may ever be squeezed. Past this the band around neutral is so thin
// that "tightened" and "pinned" are indistinguishable — so at this point the ladder is meant to
// have already escalated to an explicit pin instead of degenerating the bounds to a point.
const DEFAULT_BOUND_FLOOR = { min: 0.95, max: 1.05 }

// ── tiny pure guards (same idioms as the rest of the family) ─────────────────
const str = (x) => (x == null ? '' : String(x))
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const round = (x, p = 4) => { const f = 10 ** p; return Math.round((Number(x) || 0) * f) / f }

// Join a short list of phrases with serial commas — deterministic, agency one-liner only.
function joinList(xs) {
  const a = xs.filter(Boolean)
  if (a.length <= 1) return a[0] || ''
  if (a.length === 2) return `${a[0]} and ${a[1]}`
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
}

// The set of lanes the policy currently treats as safety-floored — read off the policy when it
// carries its own list (deriveLeadPolicy stamps safety_floor_lanes), else the module default.
// A floored lane is never remediated; resolving this first keeps that guarantee in one place.
function floorLanesOf(policy) {
  const fromPolicy = policy && Array.isArray(policy.safety_floor_lanes) ? policy.safety_floor_lanes.filter(x => typeof x === 'string') : null
  return fromPolicy && fromPolicy.length ? fromPolicy : SAFETY_FLOOR_LANES
}

// The per-lane override the policy already carries for `lane`, normalised to a plain object.
// A fresh deriveLeadPolicy() output has no lane_overrides, so this is {} until a prior
// remediation has been applied — which is exactly what makes the ladder escalate over mornings.
function overrideOf(policy, lane) {
  const all = policy && policy.lane_overrides && typeof policy.lane_overrides === 'object' ? policy.lane_overrides : null
  const ov = all && all[lane] && typeof all[lane] === 'object' ? all[lane] : null
  return ov || {}
}

// The lane's current bounds: its own override if it has been tightened before, else the policy's
// global bounds, else the family defaults. The `from` of a tighten proposal, and the basis the
// next tighten step narrows from — so successive tightenings compound correctly and stay bounded.
function boundsOf(policy, ov) {
  const b = ov.bounds && typeof ov.bounds === 'object' ? ov.bounds : (policy && policy.bounds && typeof policy.bounds === 'object' ? policy.bounds : null)
  const min = num(b && b.min, DEFAULT_MIN_WEIGHT)
  const max = num(b && b.max, DEFAULT_MAX_WEIGHT)
  return { min, max }
}

// Pick the one bounded remedy for a churning lane, escalating by what is already in place. Returns
// a proposal { lane, remedy, severity, from, to, reversible, rationale } — or null when the lane
// is already pinned and still churning (caller records that as an 'at_ceiling' abstention). PURE.
function remedyFor(lane, severity, policy, opts) {
  const bandStep = num(opts.bandStep, DEFAULT_BAND_STEP)
  const bandMax = num(opts.bandMax, DEFAULT_BAND_MAX)
  const boundStep = num(opts.boundStep, DEFAULT_BOUND_STEP)
  const floor = (opts.boundFloor && typeof opts.boundFloor === 'object') ? opts.boundFloor : DEFAULT_BOUND_FLOOR
  const ov = overrideOf(policy, lane)
  const n = severity

  // Already pinned and STILL churning — every safe structural move is spent. Hand off, don't invent.
  if (ov.pinned === true) return null

  // Rung 3 — a tightened band already in place and the lane is still fighting: take it out of the loop.
  if (ov.bounds && typeof ov.bounds === 'object') {
    return {
      lane,
      remedy: 'pin_neutral',
      severity: n,
      from: { pinned: false },
      to: { pinned: true },
      reversible: true,
      rationale: `tightened bounds still churning after ${n} ${n === 1 ? 'morning' : 'mornings'} — pin the lane to neutral and stop tuning it`,
    }
  }

  // Rung 2 — a dead-band already in place and the lane is still fighting: narrow the swing it can take.
  const curBand = num(ov.neutral_band, 0)
  if (curBand > 0) {
    const cur = boundsOf(policy, ov)
    const toMin = Math.min(round(cur.min + boundStep), num(floor.min, DEFAULT_BOUND_FLOOR.min))
    const toMax = Math.max(round(cur.max - boundStep), num(floor.max, DEFAULT_BOUND_FLOOR.max))
    return {
      lane,
      remedy: 'tighten_bounds',
      severity: n,
      from: { bounds: { min: round(cur.min), max: round(cur.max) } },
      to: { bounds: { min: toMin, max: toMax } },
      reversible: true,
      rationale: `dead-band not enough after ${n} ${n === 1 ? 'morning' : 'mornings'} — tighten its weight bounds toward neutral`,
    }
  }

  // Rung 1 — nothing tried yet: the gentlest move, a per-lane dead-band that absorbs noise.
  const toBand = round(Math.min(curBand + bandStep, bandMax))
  return {
    lane,
    remedy: 'widen_neutral_band',
    severity: n,
    from: { neutral_band: round(curBand) },
    to: { neutral_band: toBand },
    reversible: true,
    rationale: `re-reset for ${n} ${n === 1 ? 'morning' : 'mornings'} running — widen its dead-band so day-to-day noise stops moving it`,
  }
}

/**
 * proposeLeadPolicyRemediation(audit, policy, opts) — the ADJUST rung. Reads the auditor's
 * escalation and the current policy, and for each churning lane stages the least-aggressive
 * bounded, reversible structural fix that would still the loop — never auto-applied, never
 * touching the safety floor. PURE: audit + policy in, proposal out; never mutates; never throws.
 *
 * Returns:
 *   {
 *     status: 'remediation_proposed' | 'steady' | 'abstained',
 *     proposals: [{ lane, remedy, severity, from, to, reversible, rationale }],  // severity-desc
 *     abstained_lanes: [{ lane, reason: 'safety_floored' | 'at_ceiling' }],
 *     lanes_considered: [lane,…],
 *     as_of,                      // passed through from the audit it acts on
 *     remediation_reason,         // compact machine tag, mirrors the audit/governor style
 *   }
 *
 * Status semantics:
 *   abstained             — the audit itself is unusable or abstained: nothing to act on.
 *   steady                — the audit is usable but not escalating, OR the only churning lanes are
 *                           safety-floored / already at ceiling: no structural move to stage.
 *   remediation_proposed  — at least one bounded, reversible structural fix is staged.
 */
function proposeLeadPolicyRemediation(audit, policy, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const pol = policy && typeof policy === 'object' ? policy : {}

  // Unusable / abstained upstream → we abstain too. An audit that could not judge gives us nothing
  // to remediate, and a fabricated proposal off a non-judgement would be exactly the overclaim the
  // whole family is built to avoid.
  if (!audit || typeof audit !== 'object' || audit.status === 'abstained') {
    return { status: 'abstained', proposals: [], abstained_lanes: [], lanes_considered: [], as_of: audit && audit.as_of != null ? str(audit.as_of) : null, remediation_reason: 'abstained' }
  }

  const as_of = audit.as_of != null ? str(audit.as_of) : null

  // Not escalating → nothing churning the safe reset can't reach. Steady, by the auditor's own call.
  if (!shouldEscalateGovernance(audit)) {
    return { status: 'steady', proposals: [], abstained_lanes: [], lanes_considered: [], as_of, remediation_reason: 'steady:no_escalation' }
  }

  // The churning lanes are the auditor's named escalation set — the single contract between the two
  // layers (shouldEscalateGovernance + recommendation.lanes), deduped and stably ordered for output.
  const named = audit.recommendation && Array.isArray(audit.recommendation.lanes) ? audit.recommendation.lanes : []
  const lanesConsidered = []
  for (const l of named) { const k = str(l); if (k && !lanesConsidered.includes(k)) lanesConsidered.push(k) }

  const floor = floorLanesOf(pol)
  const proposals = []
  const abstained = []

  for (const lane of lanesConsidered) {
    // The safety floor is never remediated — a dead-band / tighter bounds / pin could all suppress a
    // promotion, and under-serving a real emergency is the one failure this stack refuses to risk.
    if (floor.includes(lane)) { abstained.push({ lane, reason: 'safety_floored' }); continue }

    // Severity = how long it has been churning right now, straight off the audit's per-lane record.
    const la = (audit.lanes && audit.lanes[lane] && typeof audit.lanes[lane] === 'object') ? audit.lanes[lane] : {}
    const severity = posInt(la.current_run, posInt(la.max_run, 1))

    const p = remedyFor(lane, severity, pol, o)
    if (p) proposals.push(p)
    else abstained.push({ lane, reason: 'at_ceiling' }) // already pinned and still churning — human call
  }

  // Most severe first (longest standing churn), lane name as a stable tiebreak — deterministic order
  // so the narrator's headline and any UI list agree run to run.
  proposals.sort((a, b) => (b.severity - a.severity) || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))

  const status = proposals.length > 0 ? 'remediation_proposed' : 'steady'
  const reason = proposals.length > 0
    ? `proposed:${proposals.map(p => `${p.lane}=${p.remedy}`).join(',')}`
    : (abstained.length > 0 ? `steady:all_abstained` : 'steady:no_lanes')

  return { status, proposals, abstained_lanes: abstained, lanes_considered: lanesConsidered, as_of, remediation_reason: reason }
}

/**
 * shouldStageRemediation(remediation) — the one hook a caller consults to learn whether there is a
 * concrete structural fix waiting for an agency click. True ONLY when a proposal was staged. Pure.
 */
function shouldStageRemediation(remediation) {
  return !!(remediation && remediation.status === 'remediation_proposed' && Array.isArray(remediation.proposals) && remediation.proposals.length > 0)
}

// The plain-language move each remedy makes, for the agency one-liner. Internal vocabulary stays
// out of it — this is the only place a remedy is spoken rather than tagged.
const REMEDY_PHRASE = {
  widen_neutral_band: "widen its dead-band so day-to-day noise stops moving it",
  tighten_bounds: "tighten its weight bounds so the swing can't carry as far",
  pin_neutral: 'pin it to neutral and stop tuning it',
}

/**
 * narrateLeadPolicyRemediation(remediation, opts) — ONE agency-only sentence naming the staged fix.
 *   CLIENT : '' always — how our auto-tuner is being re-tuned is the deepest internal calibration.
 *   AGENCY : speaks ONLY when a remediation is proposed; silent ('') for steady and abstained — a
 *            loop that needs no structural fix is not news. Leads with the most severe lane's remedy.
 */
function narrateLeadPolicyRemediation(remediation, opts = {}) {
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  if (audience === 'client') return ''
  if (!remediation || remediation.status !== 'remediation_proposed') return ''
  const ps = Array.isArray(remediation.proposals) ? remediation.proposals : []
  if (!ps.length) return ''
  const top = ps[0]
  const phrase = REMEDY_PHRASE[top.remedy] || 'take a closer look at it'
  const more = ps.length - 1
  const tail = more > 0 ? ` (plus ${more} other lane${more === 1 ? '' : 's'} flagged)` : ''
  return `Our lead-selection auto-tuner keeps fighting ${humanizeLane(top.lane)}${tail} — recommend we ${phrase}; staged for one click and fully reversible.`
}

module.exports = {
  proposeLeadPolicyRemediation,
  shouldStageRemediation,
  narrateLeadPolicyRemediation,
  humanizeLane,
  DEFAULT_BAND_STEP,
  DEFAULT_BAND_MAX,
  DEFAULT_BOUND_STEP,
  DEFAULT_BOUND_FLOOR,
}
