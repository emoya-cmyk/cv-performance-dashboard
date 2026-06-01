'use strict'

// ============================================================
// lib/selftune.js — the self-improving half of the intelligence layer.
//
// baselines.js asks "is the latest week unusual?", forecast.js asks "where does
// this month LAND?" — this module asks the question that makes the system get
// BETTER on its own: "how good have our projections actually BEEN for this
// client, and how should that change what we do next?"
//
// The market is the teacher. Every month-end projection the engine publishes is
// recorded; once the month closes we know the real total, so we can grade the
// projection three ways at once (the model-vs-market-vs-constant scoreboard):
//   • the Holt projection      — our model
//   • the naive MTD run-rate   — the "market" / pacing baseline it must beat
//   • the realized actual      — the ground truth
// From a client's graded track record we derive a TRUST score, and from trust we
// derive that client's own forecast gates (tighter when we've earned it, wider
// when the client is too noisy to trust) plus a bias-correction factor that
// nudges future projections toward where this client's projections have actually
// landed. Nobody tunes a threshold by hand; the data does it.
//
// Pure functions only — no DB, no clock, no LLM — exactly like forecast.js and
// baselines.js. lib/insights.js owns the DB: it records each projection, grades
// the closed ones, and feeds the graded rows back through here. Never throws;
// degenerate input yields a neutral (no-op) calibration.
//
// Convention: errors here are FRACTIONS, not percentages — 0.25 means 25% off.
// (forecast.js#mapeOf returns a percent; this module stays in ratio space so it
// composes directly with the engine's pct-of-goal ratios.)
// ============================================================

// ── tuning constants (the only "magic numbers", all in one place) ────────────
const SAMPLES_MIN   = 2      // < 2 graded months → not enough to trust → stay neutral
const MAPE_FLOOR    = 0.5    // a 50%-off average projection == zero skill
const TRUST_SKILL_W = 0.6    // trust = 60% accuracy + 40% head-to-head win-rate
const CONF_FULL     = 4      // bias correction reaches full strength at 4 samples

// Forecast gate endpoints. Trust interpolates between the WIDE end (noisy client,
// only shout on a confident miss) and the TIGHT end (trustworthy client, warn
// earlier). The engine defaults (0.9 / 0.7) live between these by design.
const WARN_WIDE = 0.85, WARN_TIGHT = 0.92
const CRIT_WIDE = 0.60, CRIT_TIGHT = 0.75

// Projection bias-correction clamp — one freak month can't wreck future numbers.
const BIAS_MIN = 0.5, BIAS_MAX = 1.5

// Neutral gates = the engine's own defaults, so a low-sample calibration is a
// behavioral no-op (identical to passing no calibration at all).
const FC_WARN_DEFAULT = 0.9
const FC_CRIT_DEFAULT = 0.7

// Prediction-interval constants. Once a client has a realized track record the
// learned mape IS the honest half-width of a forecast band — no hand-set width
// anywhere. mape is a MEAN-ABSOLUTE error; for a roughly-normal error
// E|X| = σ·√(2/π), so σ = mape·√(π/2). An 80% two-sided interval is ± z·σ with
// z = Z_80. (forecast.js carries the same Z_80 for its in-sample residual band;
// kept independently here so intervalFor stays pure with no cross-module import.)
const Z_80         = 1.2816                  // 80% two-sided standard-normal quantile
const MAE_TO_SIGMA = Math.sqrt(Math.PI / 2)  // ≈ 1.2533 — mean-abs-error → σ

// ── tiny helpers ─────────────────────────────────────────────────────────────
const clamp   = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const clamp01 = x => clamp(x, 0, 1)
const lerp    = (a, b, t) => a + (b - a) * t
const round3  = x => Math.round(Number(x) * 1000) / 1000
const round4  = x => Math.round(Number(x) * 10000) / 10000

// Strict numeric coercion: a real, finite number — numeric strings (NUMERIC
// columns arrive as strings from node-postgres) are allowed, but null /
// undefined / '' / booleans are NOT silently zero, they're "no value". This is
// load-bearing: Number(null) === 0 would otherwise let an UNGRADEABLE month
// (abs_pct_error null — actual was 0 or missing) masquerade as a perfect
// zero-error sample, inflating trust and wrongly tightening the forecast gates.
function numOf(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Mean of the genuinely-numeric entries; null when none qualify.
function avg(xs) {
  let sum = 0, n = 0
  for (const x of (Array.isArray(xs) ? xs : [])) {
    const v = numOf(x)
    if (v != null) { sum += v; n++ }
  }
  return n ? sum / n : null
}

// ── grading one projection against its realized actual ───────────────────────

// Absolute percentage error as a fraction: |projected − actual| / |actual|.
// null when actual is missing or zero (the percentage is undefined there) or
// projected is non-finite.
function absPctError(projected, actual) {
  const p = numOf(projected), a = numOf(actual)
  if (p == null || a == null || a === 0) return null
  return Math.abs(p - a) / Math.abs(a)
}

// Signed percentage error: (projected − actual) / actual. Positive == we
// OVER-projected (predicted more than reality), negative == under-projected.
function signedPctError(projected, actual) {
  const p = numOf(projected), a = numOf(actual)
  if (p == null || a == null || a === 0) return null
  return (p - a) / a
}

// Grade a single closed projection. Returns the model error, the naive baseline
// error, the signed bias, and whether the model beat (or tied) naive. A tie
// counts as a model win — the smarter method shouldn't be penalised for matching
// the simple one. Any field is null when its inputs make it undefined.
function gradeOne({ projected, naive, actual, target } = {}) {
  const ape  = absPctError(projected, actual)
  const nape = absPctError(naive, actual)
  const bias = signedPctError(projected, actual)
  const model_won = (ape != null && nape != null) ? ape <= nape : null
  return { abs_pct_error: ape, naive_abs_pct_error: nape, bias, model_won }
}

// ── aggregating a client's graded history → a scoreboard ─────────────────────

// Roll a client's (per-metric) graded rows into a track record. Only rows with a
// finite abs_pct_error count toward `samples`; the other aggregates skip their
// own nulls independently. Returns null-ish fields when nothing is gradeable.
function scoreboardOf(grades) {
  const rows = (Array.isArray(grades) ? grades : [])
    .filter(g => g && numOf(g.abs_pct_error) != null)
  const samples = rows.length
  if (!samples) return { samples: 0, mape: null, naive_mape: null, win_rate: null, bias: null }

  return {
    samples,
    mape:       avg(rows.map(g => g.abs_pct_error)),
    naive_mape: avg(rows.map(g => g.naive_abs_pct_error)),
    bias:       avg(rows.map(g => g.bias)),
    // win_rate over only the rows where the head-to-head was decidable.
    win_rate:   avg(rows.filter(g => g.model_won != null).map(g => (g.model_won ? 1 : 0))),
  }
}

// ── scoreboard → this client's own calibration ───────────────────────────────

// Turn a realized track record into the per-(client,metric) knobs the engine
// reads back: forecast warn/crit gates, a projection bias-correction factor, and
// the trust score behind them. Below SAMPLES_MIN we have not earned an opinion →
// return the engine's neutral defaults (a pure no-op vs passing no calibration).
function calibrationFor(scoreboard) {
  const sb = scoreboard || {}
  const samples = Number(sb.samples) || 0

  if (samples < SAMPLES_MIN) {
    return {
      trust: 0.5, samples,
      warn_ratio: FC_WARN_DEFAULT, crit_ratio: FC_CRIT_DEFAULT,
      bias_factor: 1, mape: sb.mape == null ? null : round4(sb.mape),
    }
  }

  const mape  = Number(sb.mape)
  const skill = clamp01(1 - (Number.isFinite(mape) ? mape : MAPE_FLOOR) / MAPE_FLOOR)
  const win   = sb.win_rate == null ? 0.5 : clamp01(Number(sb.win_rate))
  const trust = clamp01(TRUST_SKILL_W * skill + (1 - TRUST_SKILL_W) * win)

  // Tighter gates as trust rises: a trustworthy projection earns an earlier alarm;
  // a noisy one must miss harder before we cry wolf.
  const warn_ratio = round3(lerp(WARN_WIDE, WARN_TIGHT, trust))
  const crit_ratio = round3(lerp(CRIT_WIDE, CRIT_TIGHT, trust))

  // Bias correction: if this client's projections run hot (bias > 0), pull future
  // projections down toward where they've actually landed (and vice-versa). The
  // exact unbiased factor is 1/(1+bias); shrink it toward 1 until we have enough
  // samples to trust it, then clamp so a single outlier can't blow up a number.
  let bias_factor = 1
  const bias = Number(sb.bias)
  if (Number.isFinite(bias)) {
    const raw    = (1 + bias) > 0 ? 1 / (1 + bias) : BIAS_MAX
    const conf   = clamp01(samples / CONF_FULL)
    const shrunk = 1 + (raw - 1) * conf
    bias_factor  = round3(clamp(shrunk, BIAS_MIN, BIAS_MAX))
  }

  return {
    trust: round3(trust), samples,
    warn_ratio, crit_ratio, bias_factor,
    mape: Number.isFinite(mape) ? round4(mape) : null,
  }
}

// ── calibration → a visible prediction interval ──────────────────────────────

// The VISIBLE half of the self-tuning loop. calibrationFor() learns a client's
// realized, out-of-sample forecast error (mape); here that SAME mape sizes the
// band the dashboard shows around a projection — so the interval tightens as a
// client earns accuracy and widens when they're noisy, with no hand-tuned width
// anywhere. This closes the loop: grade a projection → learn mape → mape sizes the
// band on the next projection.
//
// `point` is the published (already bias-corrected) projection; `cal` is the
// client's calibration row — it needs `mape` (fraction) and `samples`. Below
// SAMPLES_MIN graded months, or without a finite positive mape, we have NOT earned
// an interval → return null and the caller shows a clean point. That null path is
// the keystone no-op: a fresh forecast's evidence is byte-identical to before this
// function existed (same discipline as the precision chip below n>0).
//
// mape is a MEAN-absolute error → σ = mape·√(π/2); the 80% half-width is
// rel = z·σ as a fraction of the point. `lo` floors at 0 — a month-end total can't
// be negative. Centering on the bias-corrected point while sizing from the RAW mape
// (which graded the pre-correction projection) is mildly conservative: the
// systematic component is already removed, so the band can only be a touch wide —
// the safe direction for a prediction interval.
function intervalFor(point, cal = {}, { z = Z_80 } = {}) {
  const pt   = numOf(point)
  const mape = numOf(cal && cal.mape)
  const n    = Number(cal && cal.samples) || 0
  if (pt == null || mape == null || !(mape > 0) || n < SAMPLES_MIN) return null

  const rel = z * MAE_TO_SIGMA * mape
  return {
    lo:      Math.max(0, round3(pt * (1 - rel))),
    hi:      round3(pt * (1 + rel)),
    rel:     round4(rel),
    mape:    round4(mape),
    z,
    level:   0.80,
    samples: n,
    basis:   'realized',
  }
}

module.exports = {
  absPctError, signedPctError, gradeOne, scoreboardOf, calibrationFor, intervalFor,
  SAMPLES_MIN, MAPE_FLOOR, TRUST_SKILL_W, CONF_FULL,
  WARN_WIDE, WARN_TIGHT, CRIT_WIDE, CRIT_TIGHT, BIAS_MIN, BIAS_MAX,
  FC_WARN_DEFAULT, FC_CRIT_DEFAULT, Z_80, MAE_TO_SIGMA,
}
