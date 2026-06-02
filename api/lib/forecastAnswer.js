'use strict'

// ============================================================
// lib/forecastAnswer.js — the grounded FORWARD answer for the Ask box.
//
// Every layer the Ask box can reach today answers in the PAST tense: "what WAS
// revenue last week", "WHO moved it" (contribution.js), "WHY did the ratio shift"
// (ratioAttribution.js). The one question a sharp operator actually leads with —
// "what WILL it be?" — has had no answer surface, even though the machinery to
// answer it honestly has existed since intel-v2: forecast.js already projects a
// series forward with a trend-aware Holt model and a calibrated, self-tuning 80%
// prediction band, and trajectory.js already trusts that band to warn on health.
// This module is the missing adapter that turns that same projection into a
// plain-language answer about a BUSINESS METRIC ("revenue", "leads", …) rather
// than a health score.
//
// It is deliberately the metric-side twin of trajectory.js: trajectory projects a
// client's HEALTH SCORE forward and asks "does it cross a band floor, and when?";
// this projects a METRIC's weekly series forward and answers "what's the number,
// with what spread, and can we stand behind it?". Both wrap the identical
// forecast.js call with the identical inherited 80% band, so the whole layer
// speaks one language about the future — and inherits the same self-improvement:
// as the forecast-vs-actual loop (intel-v2 #4 / selftune.js) sharpens the bands,
// these answers sharpen with them, with no constant to hand-tune here.
//
// ACCURATE BY CONSTRUCTION — there is no LLM arithmetic anywhere. The projection,
// the band, and the per-week rate are all read straight off forecast.js; the
// narrator only copies those numbers into a sentence (grounded exactly like
// narrateRatio / narrateContribution). And it is HONEST BY CONSTRUCTION: a series
// too short to carry a trend, or one whose own recent past the model cannot even
// fit (one-step MAPE above MAX_MAPE), comes back trustworthy:false with a plain
// caveat the surfaces can render as "not enough history yet" / "too volatile to
// project" — never a false-precision number dressed up as a forecast.
//
// LEAK-SAFE: a metric's own weekly series is single-tenant by construction (one
// client's numbers, or the whole book's aggregate when unscoped) — there is no
// cross-client naming here, so a single answer is equally safe on the agency
// Intelligence page and on a client's /my-dashboard, exactly like pacing's
// per-client verdict.
//
// PURE: series in, answer out. No DB, no clock, no network, no LLM, no mutation of
// inputs (matching forecast.js / pacing.js / trajectory.js). The caller derives the
// weekly series (loadWeeklySeries) and passes the display formatter + label, so
// this module never reaches back into ask.js. Empty/garbage history → null (nothing
// to answer), never a throw.
// ============================================================

const { finite }   = require('./baselines')
const { forecast } = require('./forecast')

const DEFAULT_HORIZON = 4   // weeks ahead — matches forecast.js / trajectory.js defaults
const MAX_HORIZON     = 26  // never project further than half a year of weeks (bands explode)
const MIN_FIT_N       = 4   // fewer weekly points than this → no trustworthy claim (MAPE on 2–3
                            //   points overstates trust; the same gate trajectory.js uses for confidence)
const MAX_MAPE        = 40  // in-sample one-step error above this → the model can't fit its own
                            //   recent past, so we won't stand behind a forward number

const num   = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)
const r1    = (n) => Math.round(n * 10) / 10
const r2    = (n) => Math.round(n * 100) / 100

/**
 * forecastAnswer(metric, series, opts)
 *   metric : the metric key being projected (stored verbatim; not used to compute)
 *   series : that metric's weekly values, oldest → newest (numbers; caller-derived)
 *   opts   : { horizon = 4, alpha, beta, z, nonNeg = true, minFitN = 4, maxMape = 40 }
 *            alpha/beta/z thread straight into forecast.js (omit to inherit its tuned
 *            defaults + the 80% band the rest of the layer shows).
 *
 * Returns null only when the series has no finite point (nothing to answer).
 * Otherwise:
 *   {
 *     metric, horizon, method,            // method: 'holt' | 'naive' | 'none'
 *     n,                                  // finite weekly points used
 *     current,                            // last ACTUAL observation (the figure "now")
 *     trend_per_step,                     // signed per-week change (0 for naive), 2dp
 *     direction,                          // 'up' | 'down' | 'flat' (display tolerance applied)
 *     points: [{ step, point, lo, hi }],  // 1..horizon, nonNeg-clamped when nonNeg
 *     headline,                           // points at the asked horizon (the answer)
 *     mape,                               // in-sample one-step MAPE %, 1dp, or null
 *     confidence,                         // 1 − mape/100 gated at n ≥ minFitN, else null (2dp)
 *     trustworthy,                        // method 'holt' & n ≥ minFitN & mape ≤ maxMape
 *     caveat,                             // null | 'thin_history' | 'poor_fit'
 *   }
 *
 * `confidence` uses the SAME mapping as trajectory.js so the layer reports one trust
 * scale; `trustworthy` is the stricter gate the chat answer actually stands behind.
 */
function forecastAnswer(metric, series, opts = {}) {
  const horizon = clamp(Math.trunc(num(opts.horizon, DEFAULT_HORIZON)), 1, MAX_HORIZON)
  const nonNeg  = opts.nonNeg !== false                 // default true: every Ask metric is ≥ 0
  const minFitN = Math.max(1, Math.trunc(num(opts.minFitN, MIN_FIT_N)))
  const maxMape = num(opts.maxMape, MAX_MAPE)

  const v = finite(series)
  const n = v.length
  if (n === 0) return null                              // nothing to answer

  const current = v[n - 1]                              // last ACTUAL, not the smoothed level
  const fc = forecast(v, { horizon, alpha: opts.alpha, beta: opts.beta, z: opts.z, nonNeg })
  if (fc.method === 'none' || !fc.points.length) return null

  const points   = fc.points.map((p) => ({ step: p.step, point: p.point, lo: p.lo, hi: p.hi }))
  const headline = points[points.length - 1]

  const mape       = Number.isFinite(fc.mape) ? r1(fc.mape) : null
  const confidence = (mape != null && n >= minFitN) ? r2(clamp(1 - mape / 100, 0, 1)) : null

  // Direction by what a reader would SEE: a projected change under ~0.5% of the
  // current level over the whole horizon reads as flat, regardless of metric scale.
  const tol        = 0.005 * Math.max(1, Math.abs(current))
  const projChange = headline.point - current
  const direction  = projChange > tol ? 'up' : projChange < -tol ? 'down' : 'flat'

  // The trust gate the chat answer stands behind: a real trend (holt), enough
  // history to mean it, and a model that fits its own recent past acceptably.
  let trustworthy = false
  let caveat = null
  if (fc.method !== 'holt' || n < minFitN) {
    caveat = 'thin_history'
  } else if (mape == null || mape > maxMape) {
    caveat = 'poor_fit'
  } else {
    trustworthy = true
  }

  return {
    metric,
    horizon,
    method: fc.method,
    n,
    current,
    trend_per_step: r2(fc.trend),
    direction,
    points,
    headline,
    mape,
    confidence,
    trustworthy,
    caveat,
  }
}

// One grounded sentence — deterministic, no LLM. Every number is copied from the
// already-computed answer via the caller's formatter `fmt` (so it's grounded by
// construction, like narrateRatio). `label` + `fmt` come from the caller (ask.js
// METRICS) so this module never cycles back into ask.js.
//   trustworthy : "Revenue is trending up — projected at ~$132,000 next week
//                  (likely $120,000–$144,000), about +$6,000/week."
//   thin        : "Only 2 weeks of history — too little to project revenue confidently yet."
//   poor fit    : "Revenue has moved too erratically lately to project confidently."
function narrateForecast(answer, opts = {}) {
  if (!answer) return ''
  const label = opts.label || answer.metric
  const fmt   = typeof opts.fmt === 'function' ? opts.fmt : (x) => String(x)

  if (!answer.trustworthy) {
    if (answer.caveat === 'poor_fit') {
      return `${label} has moved too erratically lately to project confidently.`
    }
    const wk = answer.n === 1 ? 'week' : 'weeks'
    return `Only ${answer.n} ${wk} of history — too little to project ${label.toLowerCase()} confidently yet.`
  }

  const when = answer.horizon === 1 ? 'next week' : `in ${answer.horizon} weeks`
  const dir =
    answer.direction === 'up' ? 'trending up'
      : answer.direction === 'down' ? 'trending down'
        : 'holding steady'
  const h = answer.headline
  let s = `${label} is ${dir} — projected at ~${fmt(h.point)} ${when} (likely ${fmt(h.lo)}–${fmt(h.hi)})`
  if (answer.direction !== 'flat' && Math.abs(answer.trend_per_step) > 0) {
    const sign = answer.trend_per_step >= 0 ? '+' : '-'
    s += `, about ${sign}${fmt(Math.abs(answer.trend_per_step))}/week`
  }
  return s + '.'
}

module.exports = {
  forecastAnswer, narrateForecast,
  DEFAULT_HORIZON, MAX_HORIZON, MIN_FIT_N, MAX_MAPE,
}
