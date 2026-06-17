'use strict'

// ============================================================
// lib/forecast.js — deterministic forward projection for the autonomous
// intelligence layer.
//
// baselines.js answers "is the LATEST week unusual vs the past?" — this module
// answers the forward question: "given the trend, where does this metric LAND?"
// That is what turns the dashboard from a rear-view mirror into something that
// warns a client BEFORE they miss the month, not after.
//
// Method: Holt's linear exponential smoothing (double exponential smoothing) —
// a level term and a trend term, each updated with its own smoothing weight.
// It is deterministic, cheap, trend-aware, and — unlike a raw least-squares line
// — weights recent weeks more heavily, so a business that just turned a corner
// is projected from its new trajectory rather than dragged by ancient history.
//
// Honesty by construction: every point forecast ships with a prediction band
// derived from the model's OWN in-sample one-step errors (resStd·√h), and a fit
// quality (MAPE) the caller can show or gate on. A wide band or poor MAPE is the
// signal "don't trust this projection yet" — which the self-tuning loop
// (increment 4) will later read back to grade itself.
//
// Pure functions only — no DB, no HTTP, no LLM — exactly like baselines.js and
// metricsCore.js. Never throws; degenerate input yields a quiet {method:'none'}.
// ============================================================

const { finite, mean, stddev } = require('./baselines')

// Default smoothing weights. alpha (level) > beta (trend): react to the latest
// level fairly quickly, but let the trend turn more slowly so one noisy week
// does not whip the projected slope around.
const DEFAULT_ALPHA = 0.5
const DEFAULT_BETA  = 0.3
// 1.2816 ≈ the 80% two-sided normal quantile — an honest "likely range" band
// without pretending to 95% precision we have not earned on a dozen weeks.
const Z_80 = 1.2816

// Mean absolute percentage error of one-step forecasts vs actuals. Skips the
// seeded first point (no forecast exists for it) and any zero actual (the % is
// undefined there). Returns null when nothing is gradeable.
function mapeOf(actual, fitted) {
  let sum = 0, cnt = 0
  for (let i = 1; i < actual.length; i++) {
    const a = actual[i]
    if (!Number.isFinite(a) || a === 0) continue
    sum += Math.abs((a - fitted[i]) / a)
    cnt++
  }
  return cnt ? (sum / cnt) * 100 : null
}

// Fit Holt's linear model over a chronological (oldest → newest) value series.
// Returns the final {level, trend}, the in-sample one-step forecasts + residuals
// (for the band and for later grading), and the fit MAPE.
function holt(values, { alpha = DEFAULT_ALPHA, beta = DEFAULT_BETA } = {}) {
  const v = finite(values)
  const n = v.length
  if (n === 0) return { n: 0, level: 0, trend: 0, fitted: [], residuals: [], mape: null, method: 'none' }
  if (n === 1) return { n: 1, level: v[0], trend: 0, fitted: [v[0]], residuals: [0], mape: null, method: 'naive' }

  let level = v[0]
  let trend = v[1] - v[0]                  // seed the trend from the first step
  const fitted    = [v[0]]                 // no genuine forecast exists for v[0]
  const residuals = [0]

  for (let i = 1; i < n; i++) {
    const oneStep = level + trend          // forecast of v[i] BEFORE we see it
    fitted.push(oneStep)
    residuals.push(v[i] - oneStep)
    const prevLevel = level
    level = alpha * v[i] + (1 - alpha) * (level + trend)
    trend = beta * (level - prevLevel) + (1 - beta) * trend
  }
  return { n, level, trend, fitted, residuals, mape: mapeOf(v, fitted), method: 'holt' }
}

// h-step-ahead point forecast from a fitted level + trend.
function projectN(h, level, trend) {
  return Number(level) + h * Number(trend)
}

// Project `horizon` steps ahead with a growing prediction band. Each point is
// {step, point, lo, hi}; the band widens as √h because errors compound the
// further out we guess. `nonNeg` clamps the band floor (and point) at 0 for
// metrics that cannot go negative (revenue, leads, …) so we never show a
// nonsensical "projected −$300".
function forecast(values, { horizon = 4, alpha, beta, z = Z_80, nonNeg = false } = {}) {
  const fit = holt(values, { alpha, beta })
  if (fit.method === 'none') {
    return { method: 'none', horizon, level: 0, trend: 0, perStep: 0, mape: null, resStd: 0, points: [] }
  }
  const resStd = stddev(fit.residuals.slice(1))   // one-step error scale (skip seed)
  const points = []
  for (let h = 1; h <= horizon; h++) {
    let point = projectN(h, fit.level, fit.trend)
    const band = z * resStd * Math.sqrt(h)
    let lo = point - band
    let hi = point + band
    if (nonNeg) { point = Math.max(0, point); lo = Math.max(0, lo); hi = Math.max(0, hi) }
    points.push({ step: h, point, lo, hi })
  }
  return {
    method: fit.method, horizon,
    level: fit.level, trend: fit.trend, perStep: fit.trend,
    mape: fit.mape, resStd, points,
  }
}

// Periods until a metric at `level`, moving `trend` per period, reaches `target`.
//   0    → already at/above target
//   null → not improving (trend ≤ 0) so it never gets there on the current trend
// Whole periods (ceil): you cannot half-arrive.
function etaToTarget(level, trend, target) {
  const L = Number(level), T = Number(trend), G = Number(target)
  if (![L, T, G].every(Number.isFinite)) return null
  if (L >= G) return 0
  if (T <= 0) return null
  return Math.ceil((G - L) / T)
}

// Trend-aware projection of where the CURRENT calendar month lands.
//
// Naive pacing assumes the rest of the month repeats the month-to-date average
// rate. This instead values the remaining days at the Holt-projected weekly rate
// (level + trend, clamped ≥ 0) — so a client who is behind month-to-date but
// accelerating is projected to recover, and one who is on-pace but decelerating
// is projected to fall short. That divergence is the whole point: it catches a
// miss while there is still time to act.
//
//   values      : the weekly metric series (oldest → newest) for the trend fit
//   mtd         : actual accumulated so far this month
//   daysElapsed : days of the month already counted in `mtd`
//   daysInMonth : calendar length of the month
//   target      : the month's goal (optional; pctOfTarget is null without it)
function monthEndProjection({ values, mtd, daysElapsed, daysInMonth, target, alpha, beta }) {
  const fit = holt(values, { alpha, beta })
  const trendWeekly  = Math.max(0, fit.level + fit.trend)        // projected typical upcoming week
  const remainingDays = Math.max(0, Number(daysInMonth) - Number(daysElapsed))
  const projectedRemaining = trendWeekly * (remainingDays / 7)
  const mtdNum = Number(mtd) || 0
  const projectedTotal = mtdNum + projectedRemaining
  const tgt = Number(target)
  const pctOfTarget = Number.isFinite(tgt) && tgt > 0 ? projectedTotal / tgt : null
  return {
    method: fit.method,
    projectedTotal,
    projectedRemaining,
    trendWeekly,
    mtd: mtdNum,
    target: Number.isFinite(tgt) ? tgt : null,
    pctOfTarget,
    remainingDays,
    mape: fit.mape,
  }
}

module.exports = {
  holt, forecast, projectN, etaToTarget, monthEndProjection, mapeOf,
  DEFAULT_ALPHA, DEFAULT_BETA, Z_80,
}
