'use strict'

// ============================================================
// lib/pulseTuning.js — close the loop: let a proven sensor earn a lighter trigger.
//
// THE GAP THIS CLOSES
// -------------------
// The Daily Pulse chain is, until here, a one-way pipeline: [[dayPulse]] detects an
// intra-week move, [[pulseDiagnose]] explains it, [[pulseReliability]] grades whether
// it persists, [[pulseTriage]] ranks it, and [[pulseAccuracy]] audits — after the fact
// — whether the mid-week warning actually CALLED the completed week. That audit is a
// credibility number nobody reads back INTO the sensor. So every client's pulse fires
// on the SAME fixed |z| band (warn 2 / crit 3) forever, no matter how good or bad its
// own track record has proven: a sensor whose warnings have called the week right 9
// times out of 10 is held to the exact same trigger as one that cries wolf two-thirds
// of the time. That is the missing feedback edge — the thing that turns a static
// detector into a system that gets BETTER at each client without anyone touching a
// dial. This module is that edge: it reads pulseAccuracy's precision and returns the
// {warn, crit} the live sensor should use next — a touch more sensitive where warnings
// have proven out (buy earlier head-start, the FP cost is low because precision is
// high), a touch more conservative where they have been mixed (spend less of the
// client's attention on noise). Self-improving, grounded, no human-set knob, no model.
//
// THE ONE DISCIPLINE THAT KEEPS THIS HONEST (NON-CIRCULAR)
// -------------------------------------------------------
// A naive feedback loop eats itself: if you lower the trigger AND then measure
// precision through the lowered trigger, the measurement drifts with the knob and the
// controller chases its own tail (loosen → more fires → precision computed against the
// looser bar → loosen again …). We forbid that by construction. pulseAccuracy is ALWAYS
// run at the CANONICAL band (the engine calls it with no warn/crit → classifyZ's
// defaults), so precision is an UNBIASED thermometer of "when we warned at the standard
// definition of unusual, how often was the week really bad." This module's OUTPUT — the
// tuned band — is applied ONLY to the live sensor's display firing, NEVER fed back into
// the audit. Input independent of output ⇒ a stable controller, like a thermostat that
// reads an unbiased thermometer rather than one warmed by its own heater. The wiring
// layer (getClientPulse) owns that separation; this pure function simply never assumes
// its result was used to compute the precision it was handed.
//
// BOUNDED, MONOTONIC, CENTERED AT THE PROVEN FLOOR
// ------------------------------------------------
// factor = clamp(1 − GAIN·(precision − TARGET), MIN_FACTOR, MAX_FACTOR), applied to
// BOTH warn and crit so the 2:3 shape (and thus the warning/critical split) is
// preserved — only the overall sensitivity shifts. TARGET is the 'proven' floor (0.70,
// the same boundary accuracyLabel uses), so a sensor exactly at the floor sits neutral
// and must climb ABOVE it to earn any loosening. Monotonic decreasing in precision:
// higher precision ⇒ lower factor ⇒ lower band ⇒ fires sooner. With GAIN 0.5 and
// precision ∈ [0,1] the law lives in [0.85, 1.35]; the clamp band [0.75, 1.5] is a pure
// safety rail that never actually binds for valid precision — it only guards against a
// pathological opts override and guarantees the band can never collapse to "fire on
// everything" or balloon to "never fire."
//
// HONEST BY ABSTENTION. No track record (acc missing / not 'graded' / precision null)
// ⇒ status:'default', factor 1, the canonical band returned unchanged — we never tune
// on noise, exactly as pulseAccuracy abstains below minFires and dayPulse below
// minWindows. The default path is byte-identical to passing no tuning at all, so the
// live sensor is provably unchanged for every client that hasn't earned an adjustment.
//
// ONE DEFINITION OF THE CANONICAL BAND. BASE_WARN/BASE_CRIT come from baselines'
// DEFAULT_WARN/DEFAULT_CRIT (the same constants classifyZ falls back to), so "canonical"
// here and "canonical" in the live sensor can never drift apart.
//
// PURE: a grade object in, a band + descriptor out. No DB, no clock, no network, no LLM,
// no mutation, never throws. Reasons only over the numbers on the grade, so it stays
// trivially testable on plain literals — exactly like the rest of the pulse family.
// ============================================================

const { DEFAULT_WARN, DEFAULT_CRIT } = require('./baselines')

// The canonical band the live sensor uses absent any tuning — re-exported from
// baselines so there is ONE source of truth for "warn at 2σ, crit at 3σ."
const BASE_WARN = DEFAULT_WARN // 2
const BASE_CRIT = DEFAULT_CRIT // 3

// Controller constants. TARGET is the 'proven' floor (accuracyLabel's 0.70): at/below
// it a sensor earns no loosening. GAIN sets how hard the band moves per unit of
// precision gap. MIN/MAX_FACTOR are hard safety rails (never bind for precision∈[0,1]
// under GAIN 0.5, but guarantee sanity against opts overrides).
const TARGET_PRECISION = 0.7
const GAIN = 0.5
const MIN_FACTOR = 0.75 // at most 25% MORE sensitive (lower band)
const MAX_FACTOR = 1.5 //  at most 50% MORE conservative (higher band)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
// Round to keep the band deterministic and display-clean (kills float noise like
// 0.30000000004); the comparisons in classifyZ are >=, so exact float is functionally
// irrelevant — this is purely for stable tests and tidy numbers.
const round = (x, dp) => {
  const f = 10 ** dp
  return Math.round(x * f) / f
}

/**
 * tunePulseThresholds(acc, opts)
 *   acc  : a pulseAccuracy grade (the object getClientPulse already computes at the
 *          CANONICAL band). Only acc.status === 'graded' with a finite acc.precision
 *          produces an adjustment; anything else abstains to the canonical band.
 *   opts : { baseWarn=2, baseCrit=3, target=0.70, gain=0.5, minFactor=0.75, maxFactor=1.5 }
 *          — all optional; the defaults are the documented controller. baseWarn/baseCrit
 *          let a caller pin a different canonical band (the live sensor's own warn/crit)
 *          so the tuned band scales from exactly what the sensor would otherwise use.
 *
 * Returns (never throws):
 *   { status:'tuned'|'default', warn, crit, base_warn, base_crit,
 *     factor, direction:'sensitize'|'tighten'|'neutral', precision, label, reason }
 *   • 'default' — no track record (reason:'no_track_record'); warn/crit === base,
 *      factor 1, direction 'neutral', precision/label null. Byte-identical to no tuning.
 *   • 'tuned'   — factor = clamp(1 − gain·(precision − target)); warn/crit = base·factor
 *      (rounded); direction is 'sensitize' (factor<1, earned a lighter trigger),
 *      'tighten' (factor>1, needs more movement), or 'neutral' (factor===1). label
 *      echoes acc.label (proven/developing/learning) so the surface vocabulary matches
 *      the (5) chain exactly.
 *   Invariant: warn/base_warn === crit/base_crit === factor (the 2:3 shape is preserved).
 */
function tunePulseThresholds(acc, opts = {}) {
  const baseWarn = Number.isFinite(opts.baseWarn) && opts.baseWarn > 0 ? opts.baseWarn : BASE_WARN
  const baseCrit = Number.isFinite(opts.baseCrit) && opts.baseCrit > 0 ? opts.baseCrit : BASE_CRIT
  const target = Number.isFinite(opts.target) && opts.target > 0 && opts.target <= 1 ? opts.target : TARGET_PRECISION
  const gain = Number.isFinite(opts.gain) && opts.gain >= 0 ? opts.gain : GAIN
  const minF = Number.isFinite(opts.minFactor) && opts.minFactor > 0 ? opts.minFactor : MIN_FACTOR
  const maxF = Number.isFinite(opts.maxFactor) && opts.maxFactor >= minF ? opts.maxFactor : MAX_FACTOR

  // Abstain: no earned track record → return the canonical band unchanged. This path is
  // provably a no-op against the live sensor (warn/crit === the defaults it already uses).
  if (!acc || acc.status !== 'graded' || acc.precision == null || !Number.isFinite(acc.precision)) {
    return {
      status: 'default',
      warn: baseWarn,
      crit: baseCrit,
      base_warn: baseWarn,
      base_crit: baseCrit,
      factor: 1,
      direction: 'neutral',
      precision: null,
      label: null,
      reason: 'no_track_record',
    }
  }

  // Defensive clamp of precision into [0,1] before the law — pulseAccuracy already
  // guarantees this, but the controller must stay sane on any input it's handed.
  const p = clamp(acc.precision, 0, 1)
  const factor = round(clamp(1 - gain * (p - target), minF, maxF), 4)
  const direction = factor < 1 ? 'sensitize' : factor > 1 ? 'tighten' : 'neutral'

  return {
    status: 'tuned',
    warn: round(baseWarn * factor, 3),
    crit: round(baseCrit * factor, 3),
    base_warn: baseWarn,
    base_crit: baseCrit,
    factor,
    direction,
    precision: p,
    label: acc.label != null ? acc.label : null,
    reason: 'tuned',
  }
}

// One grounded sentence describing an APPLIED adjustment — AGENCY-ONLY, deterministic,
// no LLM. The percent is straight off `factor` (|1 − factor|·100), so the sentence can
// never disagree with the band it explains. Returns '' for the default/neutral/missing
// case (nothing was changed → nothing to say) and ALWAYS for a client audience: tuning
// is internal calibration; the client sees only its EFFECT (an earlier warning, or
// fewer false alarms), never the machinery — exactly as narratePulseAccuracy refuses to
// volunteer a weak record to a client.
//   sensitize : "Leads early-warnings here have proven out, so the sensor now trips on about 15% less movement — it's earned a lighter trigger."
//   tighten   : "Spend early-warnings here have been mixed, so the sensor now needs about 20% more movement before it speaks — fewer false alarms."
function narratePulseTuning(tune, opts = {}) {
  if (opts.audience === 'client') return ''
  if (!tune || tune.status !== 'tuned' || tune.direction === 'neutral') return ''
  const label = opts.label || 'These'
  const pct = Math.round(Math.abs(1 - tune.factor) * 100)
  if (pct < 1) return '' // a sub-1% move rounds to nothing worth a sentence
  if (tune.direction === 'sensitize') {
    return `${label} early-warnings here have proven out, so the sensor now trips on about ${pct}% less movement — it's earned a lighter trigger.`
  }
  return `${label} early-warnings here have been mixed, so the sensor now needs about ${pct}% more movement before it speaks — fewer false alarms.`
}

module.exports = {
  tunePulseThresholds,
  narratePulseTuning,
  BASE_WARN,
  BASE_CRIT,
  TARGET_PRECISION,
  GAIN,
  MIN_FACTOR,
  MAX_FACTOR,
}
