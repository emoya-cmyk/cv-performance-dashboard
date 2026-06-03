'use strict'

// ============================================================================
// briefEmphasisControlTuning — intel-v9 layer 23: the controller's gain schedule.
// ----------------------------------------------------------------------------
// The OUTWARD intelligence stack closed its second-order loop at 21 and grew a
// watchdog at 22:
//   18  briefEngagement          — a human grades the brief (reception in).
//   19  briefEngagementLearning  — reception → a ±1 breadth flex.
//   20  briefEmphasisEfficacy    — did the flex work? → a step-scale per direction.
//   21  briefEmphasisControl     — re-shape the NEXT flex's magnitude from that.
//   22  briefEmphasisControlHealth — watch the controller over ONE window; when it
//                                 HUNTS (oscillates lean_in↔ease_off) raise a 'damp'
//                                 self-heal that benches the controller for THAT
//                                 morning in favour of layer 19's un-modulated cap.
//
// Layer 22 is a CIRCUIT-BREAKER: acute, reactive, per-window. It trips when the
// controller is thrashing right now and resets the moment the thrash stops. What it
// cannot do is LEARN. A controller whose aggression is wrong for a given portfolio
// will trip the breaker, settle, be handed the wheel again at full authority, thrash
// again, trip again — flapping forever, the breaker firing on a metronome while no
// one narrows the thing that keeps over-correcting. That recurring-trip PATTERN is
// the missing feedback edge — the same gap pulseTuning closes for the pulse sensor,
// one rung up the same ladder.
//
// THIS module is that edge: a GAIN SCHEDULE over the controller. It reads a HISTORY
// of layer-22 verdicts (the breaker's own trip log) and decides how much AUTHORITY
// the controller should keep — how far from base it may push the breadth cap at all.
//   • Hunted just now (the latest verdict is 'unstable')  → NARROW the authority:
//     halve the controller's reach on a single fresh hunt, freeze it at base on a
//     second consecutive one. A controller that can swing less far hunts with less
//     amplitude; at zero reach it is pinned to base and cannot oscillate.
//   • Proven steady again ('stable'/converged for restoreRun mornings, no recent
//     hunt) → RESTORE full reach. The loop earned its range back.
//   • Recovered but unproven (hunting stopped, but not yet converged long enough)
//     → HOLD at reduced authority until it proves out. This is the hysteresis band.
//   • Never hunted → full authority, untouched. Distrust is earned, never assumed.
//
// 22 vs 23, why BOTH: 22 says "you're thrashing this morning, hands off the wheel
// today"; 23 says "you've thrashed REPEATEDLY across mornings, so your steering range
// is narrowed until you prove you can hold a line." A breaker (22) and a gain
// schedule (23) compose — 23 watches the pattern of 22's trips and structurally
// detunes the controller so it stops tripping the breaker in the first place. The
// system learns to be LESS aggressive exactly where aggression has repeatedly failed,
// with no human touching a dial.
//
// THE DISCIPLINE THAT KEEPS THIS HONEST (bounded, hysteretic, no meta-hunt)
// ------------------------------------------------------------------------
// A naive authority tuner just moves the instability up a level: reduce reach → the
// hunt stops → the governor reports stable → restore reach → the aggressive controller
// is back → it hunts → reduce … the AUTHORITY now oscillates with the same period the
// cap used to. We forbid the FAST version of that by construction, two ways:
//   (1) ASYMMETRY — reduce on a SINGLE fresh hunt, restore only after restoreRun
//       CONVERGED mornings. Reduce-fast / restore-slow, exactly mirroring layer 21's
//       own "easing off is free, leaning in is earned" and layer 19's "widening must
//       be earned." Cutting power is always cheap; handing it back is proven.
//   (2) GENUINE DAMPING, not masking — a narrowed reach really does bound the swing
//       amplitude (the controller physically cannot push as far), so a quiet governor
//       under reduced authority reflects a calmer loop, not a hidden one.
// A slow residual cycle (period ≥ restoreRun+1) can still exist if a portfolio's
// stable operating point is genuinely full-authority-unstable; that is self-limiting
// (the loop spends most mornings at reduced authority = stable) and acceptable for a
// gain schedule. We are honest about it rather than pretending it away. A future
// refinement could restore one notch at a time instead of straight to full; this
// module restores in one step to stay STATELESS over 22's verdicts (it never needs to
// read its own prior output), matching the pure-function purity of every sibling.
//
// DEFAULT IS A PROVABLE NO-OP. No usable history, or a controller that has never hunted
// → status 'default', full reach, effective_bounds === the structural rails. Wiring
// this in (23b) is then byte-identical to not wiring it at all for every portfolio that
// hasn't earned a reduction — the same honest-by-abstention floor as 20/21/22 and the
// same "default path is provably unchanged" guarantee as pulseTuning.
//
// CONTRACT (the pure-module discipline shared with layers 10–22):
//   data in → a bounded authority verdict out. No DB, clock, network, LLM, or
//   mutation; never throws; honest-by-abstention; the narrator returns '' for
//   audience:'client' UNCONDITIONALLY — a client never learns the brief's breadth is
//   auto-tuned, that the tuner is policed, or that the police are themselves scheduling
//   the tuner's authority. This verdict is ENDPOINT-ONLY, like 22's: it rides no pack;
//   the only trace a self-heal ever leaves on a serialized brief is a different cap
//   integer (layer 19's projection), never this machinery.
// ============================================================================

// Re-use layer 19/21/22's rails verbatim so all four loops share one source of truth —
// if 19's bounds move, 23 moves with them, no second definition of "the rails."
const { BASE_CAP, MIN_CAP, MAX_CAP } = require('./briefEngagementLearning')

// How many recent governor verdicts to weigh. Older trips are context, not verdict.
const DEFAULT_WINDOW = 6
// Converged ('stable') mornings, with no fresher hunt, that earn full authority back.
// Mirrors layer 22's DEFAULT_SETTLED_RUN (2): the cap must already be flat that long to
// be 'stable' at all, so requiring 2 such verdicts to RESTORE is a sensible second gate.
const DEFAULT_RESTORE_RUN = 2
// Fewer usable governor verdicts than this → abstain (a gain schedule needs a track
// record; one trip log entry says nothing about a recurring pattern). Mirrors 22.
const DEFAULT_MIN_HISTORY = 2

// The governor's status vocabulary (layer 22). An entry is "usable" iff its status is
// one of these — a junk array can never fabricate an authority change.
const GOVERNOR_STATUSES = ['unstable', 'constrained', 'stable', 'settling', 'idle', 'abstained']

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
function str(v) { return typeof v === 'string' ? v : '' }

// A positive integer or a default — tolerant of strings, floats, junk, missing.
function posIntOr(raw, dflt) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : dflt
}

// A finite integer cap or null — never coerces missing/junk to 0 (that would invent a rail).
function intOrNull(raw) {
  if (raw == null || raw === '') return null
  const n = Math.round(Number(raw))
  return Number.isFinite(n) ? n : null
}

// Normalize ONE governor history entry into the minimal stability track we judge, or
// null if it carries no recognizable governor status. Accepts three shapes, defensively:
//   • a bare assessEmphasisControlHealth() verdict (status/bounds at top level)
//   • a { as_of, verdict } wrapper               (verdict nested under .verdict)
//   • a { as_of, ...verdict } spread             (verdict fields + an as_of sibling)
function normVerdict(raw) {
  if (!raw || typeof raw !== 'object') return null
  let v = raw
  let asOf = str(raw.as_of)
  if (raw.verdict && typeof raw.verdict === 'object') {
    v = raw.verdict
    if (!asOf) asOf = str(v.as_of)
  }
  const status = str(v.status)
  if (!GOVERNOR_STATUSES.includes(status)) return null // not a governor verdict → unusable

  // Pull the structural rails the governor was judging against, defensively.
  const b = v.bounds && typeof v.bounds === 'object' ? v.bounds : {}
  const base = posIntOr(b.base, BASE_CAP)
  const lo = Math.min(posIntOr(b.min, MIN_CAP), base)
  const hi = Math.max(posIntOr(b.max, MAX_CAP), base)

  return {
    as_of: asOf || str(v.as_of) || null,
    status,
    reason: str(v.verdict_reason) || null,
    base,
    lo,
    hi,
  }
}

// Trailing run from newest backward while pred holds; a miss stops it.
function trailingRun(series, pred) {
  let run = 0
  for (let i = series.length - 1; i >= 0; i--) {
    if (pred(series[i])) run++
    else break
  }
  return run
}

// Map an authority reach to its effective breadth-cap rails, clamped into the structural
// rails so a short arm is never pushed past its real bound (reach bites the long arm).
function reachToBounds(reach, base, lo, hi) {
  return {
    min: Math.max(lo, base - reach),
    max: Math.min(hi, base + reach),
    base,
  }
}

// A human label for a reach: pinned to base (frozen), full structural range (full),
// or somewhere between (reduced). With a degenerate rail (maxReach 0) everything is
// structurally 'frozen' and there is simply nothing to tune.
function authorityLabel(reach, maxReach) {
  if (maxReach <= 0 || reach <= 0) return 'frozen'
  if (reach >= maxReach) return 'full'
  return 'reduced'
}

/**
 * tuneEmphasisControlAuthority(history, opts) — schedule the layer-21 controller's
 * authority from a HISTORY of layer-22 governor verdicts. Pure: data in → verdict out,
 * never throws, never mutates, honest-by-abstention (full authority until the controller
 * earns distrust).
 *
 * @param {Array} history  layer-22 assessEmphasisControlHealth() verdicts, oldest→newest,
 *                          in any of the three shapes normVerdict() accepts.
 * @param {object} [opts]  { window, restoreRun, minHistory } — all positive integers;
 *                          bad values fall back to the DEFAULT_* constants.
 * @returns {object} verdict:
 *   { status, recommended_action, reach, max_reach, authority,
 *     effective_bounds:{min,max,base}, bounds:{min,max,base},
 *     window_used, history_len, as_of,
 *     governor:{ last_status, last_reason, trailing_unstable, trailing_stable,
 *                hunt_count, saw_hunting, statuses:[...] },
 *     reason }
 *   status            ∈ default | detuned | holding | restored
 *   recommended_action∈ none | reduce_authority | hold_authority | restore_authority
 *   reason            ∈ insufficient_history | no_intervention | hunting_active
 *                       | awaiting_stability | stability_proven
 */
function tuneEmphasisControlAuthority(history, opts = {}) {
  const window = posIntOr(opts.window, DEFAULT_WINDOW)
  const restoreRun = posIntOr(opts.restoreRun, DEFAULT_RESTORE_RUN)
  const minHistory = posIntOr(opts.minHistory, DEFAULT_MIN_HISTORY)

  const arr = Array.isArray(history) ? history : []
  const normAll = arr.map(normVerdict).filter(Boolean)
  const series = normAll.slice(-window) // trailing window, oldest→newest
  const n = series.length
  const last = n ? series[n - 1] : null

  // Structural rails come from the newest usable verdict (mirrors how 22 reads its last
  // entry's bounds); absent any, fall back to layer 19's canonical rails.
  const base = last ? last.base : BASE_CAP
  const lo = last ? last.lo : MIN_CAP
  const hi = last ? last.hi : MAX_CAP
  const maxReach = Math.max(0, Math.max(base - lo, hi - base))
  const structRails = { min: lo, max: hi, base }

  const trailingUnstable = trailingRun(series, (s) => s.status === 'unstable')
  const trailingStable = trailingRun(series, (s) => s.status === 'stable')
  const huntCount = series.reduce((acc, s) => acc + (s.status === 'unstable' ? 1 : 0), 0)
  const sawHunting = huntCount > 0

  const governor = {
    last_status: last ? last.status : null,
    last_reason: last ? last.reason : null,
    trailing_unstable: trailingUnstable,
    trailing_stable: trailingStable,
    hunt_count: huntCount,
    saw_hunting: sawHunting,
    statuses: series.map((s) => s.status),
  }

  const verdict = (status, action, reach, reason) => {
    const r = clamp(Math.round(reach), 0, maxReach)
    return {
      status,
      recommended_action: action,
      reach: r,
      max_reach: maxReach,
      authority: authorityLabel(r, maxReach),
      effective_bounds: reachToBounds(r, base, lo, hi),
      bounds: structRails,
      window_used: window,
      history_len: normAll.length,
      as_of: last ? last.as_of : null,
      governor,
      reason,
    }
  }

  // (0) Too little of a track record to schedule a gain — honest silence, full authority.
  if (n < minHistory) return verdict('default', 'none', maxReach, 'insufficient_history')
  // (1) ACTIVELY HUNTING — cut authority now. One fresh hunt halves the reach; a second
  //     consecutive one freezes the controller at base. Most urgent, reduce-fast.
  if (trailingUnstable >= 1) {
    return verdict('detuned', 'reduce_authority', maxReach - trailingUnstable, 'hunting_active')
  }
  // (2) RECOVERED & PROVEN — the loop hunted earlier but has since CONVERGED for
  //     restoreRun mornings. Authority earned back in full. Restore-slow.
  if (sawHunting && trailingStable >= restoreRun) {
    return verdict('restored', 'restore_authority', maxReach, 'stability_proven')
  }
  // (3) RECOVERING — hunting stopped, but not yet proven converged. Hold the reduced
  //     authority (one notch below full) until it proves out. The hysteresis band.
  if (sawHunting) {
    return verdict('holding', 'hold_authority', maxReach - 1, 'awaiting_stability')
  }
  // (4) NEVER HUNTED in the window — the controller has earned no distrust. Full authority,
  //     a provable no-op against an un-tuned controller.
  return verdict('default', 'none', maxReach, 'no_intervention')
}

const mornings = (n) => `${n} ${n === 1 ? 'morning' : 'mornings'}`

/**
 * narrateEmphasisControlTuning(tune, opts) — one plain-English line for the AGENCY only.
 * Speaks only for the two states that changed the controller's range (detuned / restored);
 * silent for holding / default (nothing earned saying yet).
 *   - audience:'client' → '' UNCONDITIONALLY (load-bearing; the reader must never learn
 *     the breadth is tuned, policed, OR that the police schedule the tuner's authority).
 * Plain English only — no machine vocabulary (no reach / authority / detuned / damp /
 * hunting tokens) ever reaches the sentence, so it rides the agency surface without
 * tripping the client leak guards.
 */
function narrateEmphasisControlTuning(tune, opts = {}) {
  if (opts && opts.audience === 'client') return ''
  if (!tune || typeof tune !== 'object') return ''

  switch (tune.status) {
    case 'detuned':
      return tune.reach <= 0
        ? "The brief's breadth tuning kept over-correcting, so it's been held to a single steady setting until it stops swinging."
        : "The brief's breadth tuning has been over-correcting, so the range it's allowed to move has been narrowed to settle it down."
    case 'restored':
      return "The brief's breadth tuning has proven steady again, so its full range has been handed back."
    default:
      return '' // holding / default → silent
  }
}

/**
 * controlAuthorityRails(tune) — the engine hook (consumed in 23b). Returns the rails the
 * layer-21 controller should be clamped to: the tuned effective_bounds when authority has
 * been reduced, or null when there is nothing to constrain (missing/garbage tune, or a
 * 'default' full-authority verdict). null is the explicit "use the structural rails as-is"
 * signal, keeping the wiring a provable no-op on the default path.
 *
 * @returns {object|null} { min, max, base, reach, frozen } or null
 */
function controlAuthorityRails(tune) {
  if (!tune || typeof tune !== 'object') return null
  if (tune.status !== 'detuned' && tune.status !== 'holding') return null // full authority → no constraint
  const b = tune.effective_bounds
  if (!b || typeof b !== 'object') return null
  return {
    min: b.min,
    max: b.max,
    base: b.base,
    reach: tune.reach,
    frozen: tune.reach === 0,
  }
}

/**
 * shouldReduceControlAuthority(tune) — true iff the tuner is currently holding the
 * controller below its full structural range (detuned or holding). The boolean parallel
 * of shouldDampControl, for an engine that only needs the yes/no.
 */
function shouldReduceControlAuthority(tune) {
  return !!tune && typeof tune === 'object' && (tune.status === 'detuned' || tune.status === 'holding')
}

module.exports = {
  tuneEmphasisControlAuthority,
  narrateEmphasisControlTuning,
  controlAuthorityRails,
  shouldReduceControlAuthority,
  // constants exposed for layer-23b reuse and direct testing
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
  DEFAULT_WINDOW,
  DEFAULT_RESTORE_RUN,
  DEFAULT_MIN_HISTORY,
  GOVERNOR_STATUSES,
}
