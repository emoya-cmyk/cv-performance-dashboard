'use strict'

// ============================================================================
// briefEmphasisControl — intel-v9 layer 21: the controller that closes the loop.
// ----------------------------------------------------------------------------
// The OUTWARD intelligence stack, in four rungs:
//   18  briefEngagement        — a human grades the brief (the reception signal).
//   19  briefEngagementLearning — ACTS on the grade: reception → a ±1 cap flex on
//                                 the supporting-cast breadth (widen / hold / tighten).
//   20  briefEmphasisEfficacy   — MEASURES whether 19's flexes actually worked:
//                                 did widening SUSTAIN reception? did tightening
//                                 RECOVER it? It emits a bounded step-scale per
//                                 direction (widen_step_scale / tighten_step_scale)
//                                 in [STEP_SCALE_MIN .. STEP_SCALE_MAX], centred on
//                                 1.0 — >1 means "that flex is paying off, lean in",
//                                 <1 means "it isn't, ease off", ==1 means "hold".
//   21  briefEmphasisControl    — THIS module. It applies 20's learned step-scale
//                                 back into the MAGNITUDE of 19's flex, so the system
//                                 doesn't just react to reception once and measure it
//                                 forever — it lets the measurement re-shape the next
//                                 reaction. reception → flex (19) → efficacy (20) →
//                                 scaled flex (21). The second-order loop, closed.
//
// WHY a step COUNT, not a fractional multiply.
//   Layer 19's flex is an INTEGER cap delta (±1, occasionally −2): the supporting
//   cast is a row count, you can't show 4.25 rows. Multiplying a ±1 step by a
//   fractional scale in [0.5, 1.25] and rounding is a no-op (round(1.25)=1,
//   round(0.5)=1) — it would silently erase the whole loop. So layer 21 does NOT
//   scale the integer; it reads layer 20's SIGN and adjusts the step COUNT by a unit:
//       scale > 1  (endorse) → lean in  → step + 1   (reach one row further)
//       scale < 1  (temper)  → ease off → step − 1   (pull one row back; 0 = suppress)
//       scale ==1  (steady / insufficient / unmeasured direction) → hold (identity)
//   The learned scale decides the DIRECTION of the adjustment; the controller applies
//   it as one gentle, bounded step — mirroring 19's own "one step per signal, never a
//   silencer" discipline. The continuous scale is preserved verbatim in `step_scale`
//   for agency transparency, but never drives a fractional cap.
//
// SAFETY — leaning in is EARNED twice, easing off is always free.
//   A lean-in widen (cap → base+2, up to MAX_CAP) fires only when BOTH (a) reception
//   is currently well_received (19 chose to widen) AND (b) past widening was MEASURED
//   to sustain reception (20 endorsed). That double gate is exactly layer 19's
//   "widening must be earned" rule, now earned by OUTCOME, not just by level. Easing
//   off needs no such proof — the cap only ever shrinks toward base, never below the
//   MIN_CAP floor, so the headline + at least one supporting row always survive.
//   These two signals are independent (reception NOW vs the measured outcome of PAST
//   flexes), so leaning in is justified by genuinely new information — never circular.
//
// CONTRACT (the pure-module discipline shared with layers 10–20):
//   data in → a bounded, re-clamped cap policy out. No DB, clock, network, LLM, or
//   mutation; never throws; honest-by-abstention (no flex to scale, or no measured
//   efficacy → identity pass-through of 19's decision); the narrator returns '' for
//   audience:'client' UNCONDITIONALLY — the reader never learns their attention is
//   being tuned, let alone tuned by a second-order loop.
// ============================================================================

// Re-use layer 19's rails verbatim so the two stay in lockstep — if 19's bounds
// ever move, 21 moves with them, no second source of truth.
const { BASE_CAP, MIN_CAP, MAX_CAP } = require('./briefEngagementLearning')

// The controller's unit adjustment — one row, never a silencer (mirrors 19's ±1).
const LEAN_STEP = 1
const EASE_STEP = 1
// Layer 20 centres its step-scale on this; >it endorses, <it tempers, ==it holds.
const NEUTRAL_SCALE = 1.0
// A dead-band around the neutral scale to absorb float noise from layer 20's round3.
const SCALE_EPS = 0.001

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
function sign(n) { return n > 0 ? 1 : n < 0 ? -1 : 0 }

// A positive integer or a default — tolerant of strings, floats, junk, missing.
function posIntOr(raw, dflt) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : dflt
}

// Read layer 20's recommendation defensively — accept the full summary OR, as a
// courtesy, the recommendation object handed in directly.
function recOf(efficacy) {
  if (!efficacy || typeof efficacy !== 'object') return null
  const rec = efficacy.recommendation
  if (rec && typeof rec === 'object') return rec
  if ('widen_step_scale' in efficacy || 'tighten_step_scale' in efficacy) return efficacy
  return null
}

// The learned step-scale for the direction 19 actually flexed. Unmeasurable /
// missing → the neutral scale (→ the controller holds, identity pass-through).
function scaleFor(direction, rec) {
  if (!rec) return NEUTRAL_SCALE
  const raw = direction === 'widen' ? rec.widen_step_scale
    : direction === 'tighten' ? rec.tighten_step_scale
      : NEUTRAL_SCALE
  const n = Number(raw)
  return Number.isFinite(n) ? n : NEUTRAL_SCALE
}

/**
 * applyEmphasisControl(emphasis, efficacy, opts) — scale layer 19's reception-driven
 * cap flex by layer 20's learned efficacy, returning a re-clamped cap policy of the
 * SAME shape as layer 19's decision (a superset: 19's fields, overwritten with the
 * controlled cap/delta/direction/status, plus controller provenance). The briefing
 * assembly consumes `.also_cap` exactly as it consumes 19's.
 *
 * @param {object} emphasis  layer 19's deriveBriefEmphasis result
 *                           { status, also_cap, base_cap, min_cap, max_cap, delta,
 *                             direction, helpful_rate, label, trend, n, reason }
 * @param {object} efficacy  layer 20's summarizeEmphasisEfficacy result
 *                           { status, recommendation:{ widen_step_scale,
 *                             tighten_step_scale, verdict, reason }, ... }
 * @param {object} [opts]    reserved; no clock/IO is ever read.
 * @returns {object} controlled cap policy (see fields below). Never throws.
 */
function applyEmphasisControl(emphasis, efficacy, opts = {}) {
  const e = emphasis && typeof emphasis === 'object' ? emphasis : {}
  const base = posIntOr(e.base_cap, BASE_CAP)
  // Keep the rails sane even if a caller hands in a crossed/garbled pair.
  const lo = Math.min(posIntOr(e.min_cap, MIN_CAP), base)
  const hi = Math.max(posIntOr(e.max_cap, MAX_CAP), base)
  // 19's pre-control cap, defensively clamped into the rails.
  const preCap = clamp(posIntOr(e.also_cap, base), lo, hi)
  const preDelta = preCap - base
  const preDir = preDelta > 0 ? 'widen' : preDelta < 0 ? 'tighten' : 'neutral'

  // The shared carry-through of 19's read-only context onto every return shape.
  const ctx = {
    base_cap: base,
    min_cap: lo,
    max_cap: hi,
    emphasis_also_cap: preCap,
    helpful_rate: e.helpful_rate != null ? e.helpful_rate : null,
    label: e.label || null,
    trend: e.trend || null,
    n: posIntOr(e.n, 0),
    emphasis_reason: e.reason || null,
  }

  // A clean identity pass-through, used wherever there is nothing to modulate.
  const passthrough = (controlReason) => ({
    status: preDelta === 0 ? 'idle' : 'tuned',
    also_cap: preCap,
    delta: preDelta,
    direction: preDir,
    controlled: false,
    control_move: 'none',
    control_reason: controlReason,
    step_scale: null,
    base_step: Math.abs(preDelta),
    controlled_step: Math.abs(preDelta),
    ...ctx,
  })

  // (1) Layer 19 held neutral (idle) or never spoke (abstained) → no flex exists to
  //     scale. The controller has nothing to do; pass 19's (non-)decision through.
  if (preDelta === 0) return passthrough('no_flex_to_scale')

  // (2) No measured efficacy yet → honest abstention. Layer 19's flex stands intact;
  //     we never invent a modulation from an absent or non-graded measurement.
  const graded = efficacy && typeof efficacy === 'object' && efficacy.status === 'graded'
  const rec = recOf(efficacy)
  if (!graded || !rec) return passthrough('insufficient_efficacy')

  // (3) Modulate. Trust layer 20's SIGN for the direction 19 flexed.
  const scale = scaleFor(preDir, rec)
  let move = 'hold'
  let step = Math.abs(preDelta)
  if (scale > NEUTRAL_SCALE + SCALE_EPS) {
    move = 'lean_in'
    step = Math.abs(preDelta) + LEAN_STEP
  } else if (scale < NEUTRAL_SCALE - SCALE_EPS) {
    move = 'ease_off'
    step = Math.max(0, Math.abs(preDelta) - EASE_STEP)
  }

  const ctrlDelta = sign(preDelta) * step
  const cap = clamp(base + ctrlDelta, lo, hi)
  const realDelta = cap - base
  const direction = realDelta > 0 ? 'widen' : realDelta < 0 ? 'tighten' : 'neutral'
  const status = realDelta === 0 ? 'idle' : 'tuned'

  return {
    status,
    also_cap: cap,
    delta: realDelta,
    direction,
    controlled: move !== 'hold',
    control_move: move,
    control_reason:
      move === 'lean_in' ? 'efficacy_endorsed'
        : move === 'ease_off' ? 'efficacy_tempered'
          : 'efficacy_neutral',
    step_scale: Number.isFinite(scale) ? scale : null,
    base_step: Math.abs(preDelta),
    controlled_step: step,
    ...ctx,
  }
}

const itemWord = (n) => (n === 1 ? 'item' : 'items')

/**
 * narrateEmphasisControl(ctrl, opts) — one plain-English line for the AGENCY only.
 *   - audience:'client' → '' UNCONDITIONALLY (load-bearing; never leak the controller).
 *   - not controlled, or the rails absorbed the move (cap unchanged) → '' (nothing earned saying).
 * Plain English only — no machine vocabulary (no step_scale / control_* tokens) ever
 * appears in the sentence, so it can ride the agency surface without tripping the
 * leak guards that 21d will install.
 */
function narrateEmphasisControl(ctrl, opts = {}) {
  if (opts && opts.audience === 'client') return ''
  if (!ctrl || typeof ctrl !== 'object') return ''
  if (!ctrl.controlled) return ''
  const cap = ctrl.also_cap
  const pre = ctrl.emphasis_also_cap
  if (cap === pre) return '' // controller acted, but the bounds absorbed it — say nothing.

  // The flex 19 originally chose (lean/ease only modulate its magnitude).
  const wasWiden = pre > ctrl.base_cap

  if (ctrl.control_move === 'lean_in') {
    return wasWiden
      ? `Widening the brief has been paying off, so it's leaning in further — ${cap} ${itemWord(cap)}, up from ${pre}.`
      : `Trimming the brief has been recovering attention, so it's tightening one deeper — ${cap} ${itemWord(cap)}, down from ${pre}.`
  }
  if (ctrl.control_move === 'ease_off') {
    return wasWiden
      ? `Widening the brief hasn't been paying off, so it's easing back toward the essentials — ${cap} ${itemWord(cap)}, instead of ${pre}.`
      : `Trimming the brief hasn't been recovering attention, so it's holding a little more of the picture — ${cap} ${itemWord(cap)}, instead of ${pre}.`
  }
  return ''
}

module.exports = {
  applyEmphasisControl,
  narrateEmphasisControl,
  // constants exposed for layer-21b reuse and direct testing
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
  LEAN_STEP,
  EASE_STEP,
  NEUTRAL_SCALE,
  SCALE_EPS,
}
