'use strict'

// ============================================================================
// briefEmphasisControlHealth — intel-v9 layer 22: the controller's watchdog.
// ----------------------------------------------------------------------------
// The OUTWARD intelligence stack closed its second-order loop at layer 21: a
// human grades the brief (18) → reception drives a ±1 breadth flex (19) →
// efficacy measures whether the flex worked (20) → a controller re-shapes the
// NEXT flex's magnitude from that measurement (21). A closed control loop can
// do exactly one new thing a plain reactor cannot: it can go UNSTABLE. A
// controller that over-corrects will HUNT — lean in, over-shoot, ease off,
// under-shoot, lean in again — swinging the brief's breadth back and forth
// without ever settling. It can also SATURATE — pin the breadth at a rail and
// keep pushing into a wall it can't move. Neither failure is visible from any
// single morning's decision; both are only legible across TIME.
//
// THIS module is the governor that watches the controller over time and judges
// its stability — the direct sibling of layer 14 (briefLeadPolicyHealth), which
// does the same job for the lead-weight loop. It reads a HISTORY of layer-21
// decisions as a single portfolio-level track (the controller is ONE signal,
// unlike 14's per-lane weights) and classifies it:
//
//   HUNTING      the control MOVE oscillates lean_in ↔ ease_off ≥ oscillationFlips
//                times in the window → status 'unstable', action 'damp'. This is
//                the load-bearing, SELF-HEALING signal: 22b hands it to the engine,
//                which takes the controller's hands off the wheel (falls back to
//                layer 19's un-modulated cap) until the thrash settles. hold/none
//                are neutral — skipped in the flip count, exactly as 14 skips
//                neutral weights — so a controller that adjusts once and rests is
//                never mistaken for one that hunts.
//   SATURATED    the controlled cap sits pinned at a genuine rail (max_cap, with
//                max_cap>base, or min_cap, with min_cap<base) for a trailing run
//                ≥ saturationRuns → status 'constrained', action 'review_bounds'.
//                Advisory, not self-healing: the breadth knob is maxed and the
//                agency may want to move the limit. Detected on the cap itself, so
//                it surfaces whether the controller or layer 19 drove it to the wall.
//   CONVERGED    the controller engaged (acted in the window) and the cap has since
//                settled flat for ≥ settledRun mornings → status 'stable',
//                action 'trust'. The loop found a steady setting; leave it be.
//   SETTLING     engaged and still moving, but neither hunting nor pinned → status
//                'settling', action 'hold'. Mid-search; don't intervene yet.
//   IDLE         the controller never engaged in the window (every morning hold/none)
//                → status 'idle', action 'none'. The tuner is hands-off.
//   ABSTAINED    fewer than minHistory usable snapshots → status 'abstained',
//                action 'none'. Honest silence; a control loop's stability is
//                undefined on one data point.
//
// Precedence, most→least urgent (mirrors 14): hunting → saturation → idle →
// converged → settling, with abstention gating everything. Hunting outranks a
// momentary rail touch (a misbehaving controller is the bigger problem); a chronic
// rail outranks both idle and converged (a pinned knob is worth surfacing even when
// the controller itself is quiet or has otherwise settled).
//
// CONTRACT (the pure-module discipline shared with layers 10–21):
//   data in → a bounded health verdict out. No DB, clock, network, LLM, or
//   mutation; never throws; honest-by-abstention; the narrator returns '' for
//   audience:'client' UNCONDITIONALLY — a client never learns the brief's breadth
//   is auto-tuned, let alone that the tuner is being policed for stability.
// ============================================================================

// Re-use layer 19/21's rails verbatim so all three loops share one source of truth.
const { BASE_CAP, MIN_CAP, MAX_CAP } = require('./briefEngagementLearning')

// How many recent mornings to weigh. Older history is context, not verdict.
const DEFAULT_WINDOW = 6
// Directional flips (lean_in↔ease_off) within the window that mean "hunting".
const DEFAULT_OSCILLATION_FLIPS = 2
// Trailing mornings pinned at a rail that mean "saturated / constrained".
const DEFAULT_SATURATION_RUNS = 3
// Trailing mornings of an unchanged cap that mean "converged / settled".
const DEFAULT_SETTLED_RUN = 2
// Fewer usable snapshots than this → abstain (stability is undefined too early).
const DEFAULT_MIN_HISTORY = 2

const VALID_MOVES = ['lean_in', 'ease_off', 'hold', 'none']
const VALID_DIRS = ['widen', 'tighten', 'neutral']

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
function str(v) { return typeof v === 'string' ? v : '' }

// A positive integer or a default — tolerant of strings, floats, junk, missing.
function posIntOr(raw, dflt) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : dflt
}

// A finite number or null — never coerces missing/junk to 0 (that would invent a cap).
function numOrNull(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// Normalize ONE history entry into the minimal control track we judge, or null if
// it carries no usable controlled cap. Accepts three shapes, defensively:
//   • a bare applyEmphasisControl() result   (control fields at top level)
//   • a { as_of, control } wrapper           (the result nested under .control)
//   • a { as_of, ...control } spread          (result fields + an as_of sibling)
function normControl(raw) {
  if (!raw || typeof raw !== 'object') return null
  let asOf = str(raw.as_of)
  let c = raw
  if (raw.control && typeof raw.control === 'object') {
    c = raw.control
    if (!asOf) asOf = str(c.as_of)
  }
  const capRaw = numOrNull(c.also_cap)
  if (capRaw == null) return null // no controlled cap → unusable (a genuine gap)

  const base = posIntOr(c.base_cap, BASE_CAP)
  const lo = Math.min(posIntOr(c.min_cap, MIN_CAP), base)
  const hi = Math.max(posIntOr(c.max_cap, MAX_CAP), base)
  const cap = clamp(Math.round(capRaw), lo, hi)

  let move = str(c.control_move)
  if (!VALID_MOVES.includes(move)) move = 'none'

  let dir = str(c.direction)
  if (!VALID_DIRS.includes(dir)) {
    dir = cap > base ? 'widen' : cap < base ? 'tighten' : 'neutral'
  }

  return { as_of: asOf || null, move, cap, base, lo, hi, dir }
}

// Trailing run from newest backward while pred holds; a gap or a miss stops it.
function trailingRun(series, pred) {
  let run = 0
  for (let i = series.length - 1; i >= 0; i--) {
    if (pred(series[i])) run++
    else break
  }
  return run
}

// Hunting detector: of the directional moves only (lean_in / ease_off — holds and
// nones are skipped, like 14 skips neutral weights), count adjacent unequal pairs.
// [lean_in, ease_off, lean_in] → 2 flips; [lean_in, lean_in] → 0; one move → 0.
function countMoveFlips(series) {
  const dirs = series.map((s) => s.move).filter((m) => m === 'lean_in' || m === 'ease_off')
  let flips = 0
  for (let i = 1; i < dirs.length; i++) {
    if (dirs[i] !== dirs[i - 1]) flips++
  }
  return flips
}

/**
 * assessEmphasisControlHealth(history, opts) — judge the stability of the layer-21
 * controller across a HISTORY of its decisions. Pure: data in → verdict out, never
 * throws, never mutates, honest-by-abstention.
 *
 * @param {Array} history  layer-21 applyEmphasisControl() results, oldest→newest,
 *                         in any of the three shapes normControl() accepts.
 * @param {object} [opts]  { window, oscillationFlips, saturationRuns, settledRun,
 *                           minHistory } — all positive integers; bad values fall
 *                           back to the DEFAULT_* constants.
 * @returns {object} verdict:
 *   { status, recommended_action, as_of, window_used, history_len,
 *     bounds:{min,max,base},
 *     control:{ flips, high_run, low_run, settled_run, engaged,
 *               moves:{lean_in,ease_off,hold,none},
 *               last_move, last_cap, last_direction,
 *               series:[{as_of,move,cap,dir}, ...] },
 *     verdict_reason }
 */
function assessEmphasisControlHealth(history, opts = {}) {
  const window = posIntOr(opts.window, DEFAULT_WINDOW)
  const oscThresh = posIntOr(opts.oscillationFlips, DEFAULT_OSCILLATION_FLIPS)
  const satRuns = posIntOr(opts.saturationRuns, DEFAULT_SATURATION_RUNS)
  const settledNeed = posIntOr(opts.settledRun, DEFAULT_SETTLED_RUN)
  const minHistory = posIntOr(opts.minHistory, DEFAULT_MIN_HISTORY)

  const arr = Array.isArray(history) ? history : []
  const normAll = arr.map(normControl).filter(Boolean)
  const series = normAll.slice(-window) // trailing window, oldest→newest
  const n = series.length
  const last = n ? series[n - 1] : null

  const bounds = last
    ? { min: last.lo, max: last.hi, base: last.base }
    : { min: MIN_CAP, max: MAX_CAP, base: BASE_CAP }

  const moves = { lean_in: 0, ease_off: 0, hold: 0, none: 0 }
  series.forEach((s) => { moves[s.move] = (moves[s.move] || 0) + 1 })

  const flips = countMoveFlips(series)
  // A rail counts only when it is a GENUINE bound away from base — guards against a
  // degenerate min==base or max==base making every morning look saturated.
  const highRun = trailingRun(series, (s) => s.hi > s.base && s.cap >= s.hi)
  const lowRun = trailingRun(series, (s) => s.lo < s.base && s.cap <= s.lo)
  const settledRun = last ? trailingRun(series, (s) => s.cap === last.cap) : 0
  const engaged = moves.lean_in + moves.ease_off > 0

  const control = {
    flips,
    high_run: highRun,
    low_run: lowRun,
    settled_run: settledRun,
    engaged,
    moves,
    last_move: last ? last.move : null,
    last_cap: last ? last.cap : null,
    last_direction: last ? last.dir : null,
    series: series.map((s) => ({ as_of: s.as_of, move: s.move, cap: s.cap, dir: s.dir })),
  }

  const verdict = (status, action, reason) => ({
    status,
    recommended_action: action,
    as_of: last ? last.as_of : null,
    window_used: window,
    history_len: normAll.length,
    bounds,
    control,
    verdict_reason: reason,
  })

  // (0) Too little to judge a control loop's stability — honest silence.
  if (n < minHistory) return verdict('abstained', 'none', 'insufficient_history')
  // (1) HUNTING — the load-bearing, self-healing signal. Most urgent.
  if (flips >= oscThresh) return verdict('unstable', 'damp', 'control_hunting')
  // (2) SATURATED at a genuine rail — advisory. Outranks idle and converged.
  if (highRun >= satRuns) return verdict('constrained', 'review_bounds', 'pinned_high')
  if (lowRun >= satRuns) return verdict('constrained', 'review_bounds', 'pinned_low')
  // (3) The controller has been hands-off this whole window — nothing to grade.
  if (!engaged) return verdict('idle', 'none', 'controller_quiet')
  // (4) Engaged and settled flat → converged; engaged and still moving → settling.
  if (settledRun >= settledNeed) return verdict('stable', 'trust', 'control_converged')
  return verdict('settling', 'hold', 'control_settling')
}

const mornings = (n) => `${n} ${n === 1 ? 'morning' : 'mornings'}`

/**
 * narrateEmphasisControlHealth(verdict, opts) — one plain-English line for the
 * AGENCY only. Speaks for the three states worth a word (unstable / constrained /
 * stable); silent for settling / idle / abstained (nothing earned saying yet).
 *   - audience:'client' → '' UNCONDITIONALLY (load-bearing; the reader must never
 *     learn the brief's breadth is tuned, let alone that the tuner is being policed).
 * Plain English only — no machine vocabulary (no damp / saturate / flip / lean_in
 * tokens) ever reaches the sentence, so it rides the agency surface without tripping
 * the client leak guards.
 */
function narrateEmphasisControlHealth(verdict, opts = {}) {
  if (opts && opts.audience === 'client') return ''
  if (!verdict || typeof verdict !== 'object') return ''
  const c = verdict.control || {}

  switch (verdict.status) {
    case 'unstable':
      return "The brief's breadth tuning has been swinging wider then leaner back and forth — it's being steadied back to a single reliable setting."
    case 'constrained':
      return verdict.verdict_reason === 'pinned_low'
        ? `The brief has sat at its leanest for ${mornings(c.low_run)} running — it can't be trimmed any further within the current limits.`
        : `The brief has sat at its widest for ${mornings(c.high_run)} running — it may be worth raising the breadth limit.`
    case 'stable':
      return "The brief's breadth tuning has settled into a steady setting."
    default:
      return '' // settling / idle / abstained → silent
  }
}

/**
 * shouldDampControl(verdict) — the engine hook (consumed in 22b). True ONLY for the
 * hunting verdict, where the controller should be temporarily benched in favour of
 * layer 19's un-modulated cap until the thrash settles.
 */
function shouldDampControl(verdict) {
  return !!verdict && typeof verdict === 'object' && verdict.recommended_action === 'damp'
}

module.exports = {
  assessEmphasisControlHealth,
  narrateEmphasisControlHealth,
  shouldDampControl,
  // constants exposed for layer-22b reuse and direct testing
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
  DEFAULT_WINDOW,
  DEFAULT_OSCILLATION_FLIPS,
  DEFAULT_SATURATION_RUNS,
  DEFAULT_SETTLED_RUN,
  DEFAULT_MIN_HISTORY,
}
