'use strict'

// ============================================================================
// lib/reallocationEfficacyHealth.js — the reallocation-calibration watchdog (PURE).
// intel-v10 layer 26: the stability monitor that polices Layer 25's feedback loop.
// ----------------------------------------------------------------------------
// The budget-reallocation stack closed its loop across layers 24–25: Layer 24
// (channelEfficiency) PROPOSES a small reversible budget shift toward the cheaper
// channel; Layer 25 (reallocationEfficacy) reads those proposals back against what
// the cost-per-outcome gap ACTUALLY did over the following weeks, and emits the one
// knob the engine consumes — a confidence CALIBRATION factor ∈ [0.5, 1.2] that DAMPS
// (factor < 1) or EMBOLDENS (> 1) the confidence a new proposal carries. A closed
// control loop can do exactly one thing a plain grader cannot: it can go UNSTABLE.
//
// Two failure modes only become legible across TIME, never from one run's factor:
//   • HUNTING — the factor chases noise in the realized gaps: damp, then embolden,
//     then damp again, swinging run-to-run without ever settling. A proposer whose
//     confidence is yanked up and down every week is worse than one left alone. This
//     is the load-bearing, SELF-HEALING signal: 26b hands it to the engine, which
//     takes the calibration's hands off the wheel — falls back to a NEUTRAL 1.0 (no
//     adjustment) — until the thrash settles. The self-calibration of Layer 25 is
//     only safe to ship BECAUSE this watchdog can veto it when it misbehaves.
//   • PINNED — the factor sits crushed against a clamp rail (the 0.5 damp floor or
//     the 1.2 embolden ceiling) for a trailing run. The loop is straining to push
//     further than the clamp allows: the proposer is CHRONICALLY mis-calibrated
//     (its stated confidence is persistently too high → pinned low, or too low →
//     pinned high). Advisory, not self-healing: the agency may want to retune the
//     proposer's confidence model or widen the rail. Surfaced, never auto-applied.
//
// A third state is specific to THIS loop (it has no analog in the cap-based control
// watchdog of layer 22): STARVED. Layer 25's factor shrinks toward a neutral 1.0 by
// credibility n/(n+K), so a factor sitting at ~1.0 is ambiguous — it can mean "well
// calibrated, nothing to correct" (plenty of decided trials, hit_rate matched the
// assigned confidence) OR "no evidence yet" (almost no decided trials, the factor was
// shrunk to neutral, not confirmed there). Credibility disambiguates: a window whose
// mean credibility is below a floor is STARVED — the loop is honestly quiet for lack
// of resolved bets, NOT because it confirmed good calibration. Advisory; the engine
// keeps applying the ~1.0 factor (already a behavioral no-op), and the agency learns
// the proposer simply isn't producing gradeable trials fast enough to tune on.
//
// States, most→least urgent (abstention gates everything):
//   unstable    flips ≥ oscillationFlips           → action 'distrust'      (self-heal)
//   constrained trailing rail run ≥ saturationRuns  → action 'review_bounds' (advisory)
//   starved     window mean credibility < credFloor → action 'await_evidence'(advisory)
//   stable      settled flat ≥ settledRun w/ cred   → action 'trust'
//   settling    engaged, still moving, none above   → action 'hold'
//   abstained   < minHistory usable snapshots       → action 'none'
// Precedence mirrors layer 14/22: hunting outranks a rail (a thrashing loop is the
// bigger problem); a chronic rail outranks starvation and convergence (a pinned knob
// is worth surfacing even when evidence is thin or the loop has otherwise settled);
// starvation outranks convergence (a flat factor with no evidence is NOT "converged",
// it is un-tested — we must not tell the engine to trust it).
//
// CONTRACT (the pure-module discipline shared with layers 10–25): a HISTORY of Layer
// 25 calibrations in → a bounded health verdict out. No DB, clock, network, LLM, or
// mutation of inputs; never throws; honest-by-abstention. AGENCY-ONLY, like all of
// Layer 24/25: a budget-shift calibration's stability is an internal media-buying
// instrument, never a client scoreboard line. The narrator returns '' for
// audience:'client' UNCONDITIONALLY, and Layer 26d proves no field here ever reaches
// a client payload or brief pack. PURE: same history → same verdict, factor, order.
// ============================================================================

// Re-use Layer 25's clamp rails verbatim so the grader and its watchdog share one
// source of truth for what "pinned" means (mirrors layer 22 importing the cap rails).
const { CAL_MIN, CAL_MAX } = require('./reallocationEfficacy')

const NEUTRAL = 1 // the factor value that means "apply no confidence adjustment"

// How many recent runs to weigh. Older history is context, not verdict.
const DEFAULT_WINDOW = 6
// Directional flips (embolden-step ↔ damp-step) within the window that mean "hunting".
const DEFAULT_OSCILLATION_FLIPS = 2
// Trailing runs pinned at a clamp rail that mean "saturated / constrained".
const DEFAULT_SATURATION_RUNS = 3
// Trailing runs of an unchanged factor that mean "converged / settled".
const DEFAULT_SETTLED_RUN = 2
// Fewer usable snapshots than this → abstain (stability is undefined too early).
const DEFAULT_MIN_HISTORY = 2
// Window mean credibility below this → starved (factor sits near neutral for lack of
// evidence, not because good calibration was confirmed). 0.25 ≈ n=2 decided at K=6.
const DEFAULT_CRED_FLOOR = 0.25

// A factor this far from neutral counts as a real correction (matches Layer 25's own
// 0.98 / 1.02 damp/embolden basis band — below it, the loop is effectively neutral).
const MOVE_EPS = 0.02
// A run-to-run change this small is "no move" (skipped in the flip count); a factor
// within this of a rail is "pinned" (round3 tolerance, same scale as MOVE_EPS).
const STEP_EPS = 0.02
const RAIL_EPS = 0.02

const VALID_DIRS = ['embolden', 'damp', 'hold']

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v) => clamp(v, 0, 1)
const round3 = (x) => Math.round(Number(x) * 1000) / 1000
const str = (v) => (typeof v === 'string' ? v : '')

// A non-negative integer tally from anything; junk → 0.
function countOf(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// A finite number or null — never coerces missing/junk to 0 (that would invent a factor).
function numOrNull(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// A positive integer or a default — tolerant of strings, floats, junk, missing.
function posIntOr(raw, dflt) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : dflt
}

// A finite number in [lo,hi] or a default — for the credibility floor knob.
function fracOr(raw, dflt) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt
}

// Normalize ONE history entry into the minimal calibration track we judge, or null if
// it carries no usable factor. Accepts three shapes, defensively (mirrors layer 22):
//   • a bare calibrationOf() result        (factor at top level)
//   • a { as_of, calibration } wrapper      (the result nested under .calibration)
//   • a { as_of, ...calibration } spread     (result fields + an as_of sibling)
function normCalibration(raw) {
  if (!raw || typeof raw !== 'object') return null
  let asOf = str(raw.as_of)
  let c = raw
  if (raw.calibration && typeof raw.calibration === 'object') {
    c = raw.calibration
    if (!asOf) asOf = str(c.as_of)
  }
  const factorRaw = numOrNull(c.factor)
  if (factorRaw == null) return null // no factor → unusable (a genuine gap)

  // Defensive: clamp into the legal band even though Layer 25 already clamps there.
  const factor = round3(clamp(factorRaw, CAL_MIN, CAL_MAX))
  const credibility = clamp01(numOrNull(c.credibility) == null ? 0 : numOrNull(c.credibility))
  const n = countOf(c.n)

  const dir =
    factor > NEUTRAL + MOVE_EPS ? 'embolden' :
    factor < NEUTRAL - MOVE_EPS ? 'damp' : 'hold'

  return { as_of: asOf || null, factor, credibility, n, dir }
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

// Hunting detector: derive each run-to-run STEP's direction from the factor deltas
// (a step smaller than STEP_EPS is "no move" and is skipped, exactly as layer 22 skips
// neutral control moves), then count adjacent unequal step directions. A factor going
// up, down, up → 2 flips; steadily rising → 0; one step → 0. Returns { flips, dirSteps }
// where dirSteps is the count of real (non-flat) steps the flips are drawn from.
function countFactorFlips(series) {
  const steps = []
  for (let i = 1; i < series.length; i++) {
    const d = series[i].factor - series[i - 1].factor
    if (d > STEP_EPS) steps.push('up')
    else if (d < -STEP_EPS) steps.push('down')
    // |d| <= STEP_EPS → flat, skipped
  }
  let flips = 0
  for (let i = 1; i < steps.length; i++) if (steps[i] !== steps[i - 1]) flips++
  return { flips, dirSteps: steps.length }
}

function meanOf(list) {
  const xs = (Array.isArray(list) ? list : []).filter((d) => Number.isFinite(d))
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/**
 * assessReallocationEfficacyHealth(history, opts) — judge the stability of the Layer
 * 25 calibration loop across a HISTORY of its emitted factors. Pure: data in → verdict
 * out, never throws, never mutates, honest-by-abstention.
 *
 * @param {Array} history  Layer 25 calibrationOf() results, oldest→newest, in any of
 *                         the three shapes normCalibration() accepts.
 * @param {object} [opts]  { window, oscillationFlips, saturationRuns, settledRun,
 *                           minHistory, credFloor } — positive integers (credFloor a
 *                           [0,1] fraction); bad values fall back to the DEFAULT_*s.
 * @returns {object} verdict:
 *   { status, recommended_action, as_of, window_used, history_len,
 *     bounds:{min,max,neutral}, stability_score,
 *     calibration:{ flips, high_run, low_run, settled_run, engaged,
 *                   mean_credibility, last_factor, last_direction,
 *                   series:[{as_of,factor,dir,credibility}, ...] },
 *     verdict_reason }
 */
function assessReallocationEfficacyHealth(history, opts = {}) {
  const window = posIntOr(opts.window, DEFAULT_WINDOW)
  const oscThresh = posIntOr(opts.oscillationFlips, DEFAULT_OSCILLATION_FLIPS)
  const satRuns = posIntOr(opts.saturationRuns, DEFAULT_SATURATION_RUNS)
  const settledNeed = posIntOr(opts.settledRun, DEFAULT_SETTLED_RUN)
  const minHistory = posIntOr(opts.minHistory, DEFAULT_MIN_HISTORY)
  const credFloor = fracOr(opts.credFloor, DEFAULT_CRED_FLOOR)

  const arr = Array.isArray(history) ? history : []
  const normAll = arr.map(normCalibration).filter(Boolean)
  const series = normAll.slice(-window) // trailing window, oldest→newest
  const n = series.length
  const last = n ? series[n - 1] : null

  const bounds = { min: CAL_MIN, max: CAL_MAX, neutral: NEUTRAL }

  const { flips, dirSteps } = countFactorFlips(series)
  // A rail counts only at a GENUINE clamp bound (CAL_MIN / CAL_MAX are both away from
  // neutral by construction, so unlike the cap watchdog there is no degenerate
  // base==rail case to guard — but we keep the threshold explicit for clarity).
  const highRun = trailingRun(series, (s) => s.factor >= CAL_MAX - RAIL_EPS)
  const lowRun = trailingRun(series, (s) => s.factor <= CAL_MIN + RAIL_EPS)
  const settledRun = last ? trailingRun(series, (s) => Math.abs(s.factor - last.factor) <= STEP_EPS) : 0
  const engaged = series.some((s) => Math.abs(s.factor - NEUTRAL) > MOVE_EPS)
  const meanCred = round3(meanOf(series.map((s) => s.credibility)))

  // A transparent [0,1] trust score for the UI: credibility-weighted, knocked down by
  // thrash (flip rate) and by sitting on a rail. NOT the verdict (the status is) — a
  // convenience that moves the right way (thrash/starved low, converged high).
  const flipRate = dirSteps > 1 ? clamp01(flips / (dirSteps - 1)) : 0
  const pinnedNow = !!last && (last.factor >= CAL_MAX - RAIL_EPS || last.factor <= CAL_MIN + RAIL_EPS)
  const stabilityScore = round3(clamp01(meanCred * (1 - flipRate)) * (pinnedNow ? 0.6 : 1))

  const calibration = {
    flips,
    high_run: highRun,
    low_run: lowRun,
    settled_run: settledRun,
    engaged,
    mean_credibility: meanCred,
    last_factor: last ? last.factor : null,
    last_direction: last ? last.dir : null,
    series: series.map((s) => ({ as_of: s.as_of, factor: s.factor, dir: s.dir, credibility: s.credibility })),
  }

  const verdict = (status, action, reason) => ({
    status,
    recommended_action: action,
    as_of: last ? last.as_of : null,
    window_used: window,
    history_len: normAll.length,
    bounds,
    stability_score: stabilityScore,
    calibration,
    verdict_reason: reason,
  })

  // (0) Too little to judge a control loop's stability — honest silence.
  if (n < minHistory) return verdict('abstained', 'none', 'insufficient_history')
  // (1) HUNTING — the load-bearing, self-healing signal. Most urgent.
  if (flips >= oscThresh) return verdict('unstable', 'distrust', 'calibration_hunting')
  // (2) PINNED at a genuine clamp rail — advisory. Outranks starvation and convergence.
  if (highRun >= satRuns) return verdict('constrained', 'review_bounds', 'pinned_high')
  if (lowRun >= satRuns) return verdict('constrained', 'review_bounds', 'pinned_low')
  // (3) STARVED — quiet for lack of resolved trials, not for confirmed calibration.
  if (meanCred < credFloor) return verdict('starved', 'await_evidence', 'starved_of_trials')
  // (4) Settled flat with adequate evidence → converged; still moving → settling.
  if (settledRun >= settledNeed) return verdict('stable', 'trust', 'calibration_converged')
  return verdict('settling', 'hold', 'calibration_settling')
}

const runs = (n) => `${n} ${n === 1 ? 'run' : 'runs'}`

/**
 * narrateReallocationEfficacyHealth(verdict, opts) — one plain-English line for the
 * AGENCY only. Speaks for the four states worth a word (unstable / constrained /
 * starved / stable); silent for settling / abstained (nothing earned saying yet).
 *   - audience:'client' → '' UNCONDITIONALLY (load-bearing; a client must never learn
 *     budget-shift confidence is auto-tuned, let alone that the tuner is policed).
 * Plain English only — no machine vocabulary (no factor / calibration / cpo / damp /
 * embolden / flip tokens) ever reaches the sentence, so it rides the agency surface
 * without tripping the Layer 26d client leak guards.
 */
function narrateReallocationEfficacyHealth(verdict, opts = {}) {
  if (opts && opts.audience === 'client') return ''
  if (!verdict || typeof verdict !== 'object') return ''
  const c = verdict.calibration || {}

  switch (verdict.status) {
    case 'unstable':
      return "The confidence tuning on budget-shift tests has been swinging between cautious and assertive without settling — it's being held steady at neutral until it stops thrashing."
    case 'constrained':
      return verdict.verdict_reason === 'pinned_low'
        ? `Budget-shift confidence has been pinned at its most cautious limit for ${runs(c.low_run)} running — the proposer's stated confidence looks set too high.`
        : `Budget-shift confidence has been pinned at its most assertive limit for ${runs(c.high_run)} running — the bets keep beating their stated confidence, so the limit may be worth raising.`
    case 'starved':
      return 'There are not yet enough resolved budget-shift tests to tune confidence with — the loop is holding neutral until more bets land.'
    case 'stable':
      return 'The confidence tuning on budget-shift tests has settled into a steady setting.'
    default:
      return '' // settling / abstained → silent
  }
}

/**
 * shouldDistrustCalibration(verdict) — the engine hook (consumed in 26b). True ONLY for
 * the hunting verdict, where the calibration should be temporarily benched in favour of
 * a neutral 1.0 (no confidence adjustment) until the thrash settles.
 */
function shouldDistrustCalibration(verdict) {
  return !!verdict && typeof verdict === 'object' && verdict.recommended_action === 'distrust'
}

/**
 * gatedFactor(verdict, rawFactor) — the safe factor the engine should actually apply,
 * given the watchdog's verdict and Layer 25's raw factor. Returns a NEUTRAL 1.0 when
 * the calibration is hunting (benched), otherwise the raw factor clamped into the legal
 * band. Pure, bounded, total: junk rawFactor or no verdict → neutral 1.0 (a no-op the
 * engine can multiply through blindly). This is the one line that makes Layer 25's
 * self-calibration safe to ship — it can be vetoed the instant it misbehaves.
 */
function gatedFactor(verdict, rawFactor) {
  if (shouldDistrustCalibration(verdict)) return NEUTRAL
  const f = numOrNull(rawFactor)
  if (f == null) return NEUTRAL
  return round3(clamp(f, CAL_MIN, CAL_MAX))
}

module.exports = {
  assessReallocationEfficacyHealth,
  narrateReallocationEfficacyHealth,
  shouldDistrustCalibration,
  gatedFactor,
  // constants exposed for layer-26b reuse and direct testing
  CAL_MIN,
  CAL_MAX,
  NEUTRAL,
  DEFAULT_WINDOW,
  DEFAULT_OSCILLATION_FLIPS,
  DEFAULT_SATURATION_RUNS,
  DEFAULT_SETTLED_RUN,
  DEFAULT_MIN_HISTORY,
  DEFAULT_CRED_FLOOR,
  VALID_DIRS,
}
