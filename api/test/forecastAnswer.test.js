'use strict'

// Tests for lib/forecastAnswer.js — the grounded FORWARD answer behind the Ask
// box ("what will revenue be next week?"). The contract under test:
//   • a clean trend projects forward with the right direction, per-week rate, and
//     an 80% band, and is trustworthy;
//   • the trust gate is honest — too little history → 'thin_history', a model that
//     can't fit its own recent past → 'poor_fit', both trustworthy:false;
//   • confidence mirrors trajectory.js (1 − mape/100), null below MIN_FIT_N;
//   • horizon is clamped, nonNeg clamps the band/point at 0 (every metric is ≥ 0);
//   • empty/garbage history → null, and inputs are never mutated (pure);
//   • narrateForecast copies the computed numbers verbatim (grounded by construction).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  forecastAnswer, narrateForecast,
  DEFAULT_HORIZON, MAX_HORIZON, MIN_FIT_N, MAX_MAPE,
} = require('../lib/forecastAnswer')

// echo formatter: wraps the raw number so a narration assertion proves the number
// was COPIED from the answer (grounded), not re-derived.
const echo = (x) => '«' + x + '»'
// a money-ish formatter for human-readable narration assertions
const money = (x) => '$' + Math.round(x)

// ── a clean upward trend: trustworthy, direction up, real per-week rate ─────────
test('clean upward trend → trustworthy up-forecast with band and per-week rate', () => {
  const series = [100, 110, 120, 130, 140, 150, 160, 170] // +10/week, 8 weeks
  const a = forecastAnswer('revenue', series)             // default horizon 4
  assert.ok(a, 'should produce an answer')
  assert.equal(a.metric, 'revenue')
  assert.equal(a.method, 'holt')
  assert.equal(a.n, 8)
  assert.equal(a.horizon, DEFAULT_HORIZON)
  assert.equal(a.current, 170)                            // last ACTUAL observation
  assert.equal(a.direction, 'up')
  assert.equal(a.trustworthy, true)
  assert.equal(a.caveat, null)
  // projection extends beyond the last actual, with a sane per-week slope (~+10)
  assert.equal(a.points.length, 4)
  assert.equal(a.headline.step, 4)
  assert.ok(a.headline.point > a.current, 'projects upward past current')
  assert.ok(a.trend_per_step >= 8 && a.trend_per_step <= 12, `slope ~10, got ${a.trend_per_step}`)
  // an 80% band that brackets the point and (this far out) is non-degenerate-friendly
  assert.ok(a.headline.lo <= a.headline.point && a.headline.point <= a.headline.hi)
  // a near-perfect line fits its own past → high confidence, low MAPE
  assert.ok(a.mape != null && a.mape <= MAX_MAPE)
  assert.ok(a.confidence != null && a.confidence >= 0.8, `confidence ~1, got ${a.confidence}`)
})

// ── confidence mirrors trajectory.js exactly ────────────────────────────────────
test('confidence equals 1 − mape/100 (2dp), the same mapping trajectory.js uses', () => {
  const a = forecastAnswer('leads', [20, 24, 23, 27, 30, 33, 35, 38])
  assert.ok(a.mape != null)
  const expected = Math.round((1 - a.mape / 100) * 100) / 100
  assert.equal(a.confidence, expected)
})

// ── a flat series reads as flat (display tolerance), still trustworthy ──────────
test('flat series → direction flat, trustworthy, no per-week clause in narration', () => {
  const a = forecastAnswer('revenue', [100, 100, 100, 100, 100, 100])
  assert.equal(a.direction, 'flat')
  assert.equal(a.trustworthy, true)
  const s = narrateForecast(a, { label: 'Revenue', fmt: money })
  assert.ok(s.includes('holding steady'), s)
  assert.ok(!s.includes('/week'), 'flat answer omits the per-week rate')
})

// ── a clean downward trend ──────────────────────────────────────────────────────
test('clean downward trend → direction down, negative slope', () => {
  const a = forecastAnswer('revenue', [200, 180, 160, 140, 120, 100])
  assert.equal(a.direction, 'down')
  assert.equal(a.trustworthy, true)
  assert.ok(a.trend_per_step < 0, 'negative per-week slope')
  assert.ok(a.headline.point < a.current, 'projects below current')
})

// ── HONEST: too little history → thin_history, never a confident number ─────────
test('fewer than MIN_FIT_N weeks → trustworthy:false, caveat thin_history, confidence null', () => {
  const a = forecastAnswer('revenue', [100, 120, 150]) // 3 < 4
  assert.equal(a.method, 'holt')                        // a line CAN be drawn …
  assert.equal(a.trustworthy, false)                    // … but we won't stand behind it
  assert.equal(a.caveat, 'thin_history')
  assert.equal(a.confidence, null)                      // gated below MIN_FIT_N
  assert.equal(a.n, 3)
  assert.equal(MIN_FIT_N, 4)
})

test('a single week → naive method, thin_history, flat band', () => {
  const a = forecastAnswer('revenue', [100])
  assert.equal(a.method, 'naive')
  assert.equal(a.trustworthy, false)
  assert.equal(a.caveat, 'thin_history')
  assert.equal(a.current, 100)
  assert.equal(a.headline.lo, a.headline.point)         // no residuals → zero band
  assert.equal(a.headline.hi, a.headline.point)
})

// ── HONEST: a model that can't fit its own recent past → poor_fit ───────────────
test('wildly volatile series → trustworthy:false, caveat poor_fit (MAPE over the ceiling)', () => {
  const a = forecastAnswer('revenue', [100, 10, 100, 10, 100, 10, 100, 10])
  assert.equal(a.method, 'holt')
  assert.equal(a.n, 8)                                  // enough history …
  assert.ok(a.mape > MAX_MAPE, `MAPE should exceed ${MAX_MAPE}, got ${a.mape}`)
  assert.equal(a.trustworthy, false)                    // … but the fit is hopeless
  assert.equal(a.caveat, 'poor_fit')
})

// ── horizon is clamped both ways ────────────────────────────────────────────────
test('horizon clamps to [1, MAX_HORIZON]', () => {
  const series = [10, 20, 30, 40, 50, 60]
  assert.equal(forecastAnswer('leads', series, { horizon: 1 }).points.length, 1)
  assert.equal(forecastAnswer('leads', series, { horizon: 0 }).points.length, 1)   // ≥ 1
  assert.equal(forecastAnswer('leads', series, { horizon: -5 }).points.length, 1)
  const big = forecastAnswer('leads', series, { horizon: 999 })
  assert.equal(big.points.length, MAX_HORIZON)
  assert.equal(big.horizon, MAX_HORIZON)
  assert.equal(big.headline.step, MAX_HORIZON)
})

// ── nonNeg: every Ask metric is ≥ 0; a crashing trend clamps the floor at 0 ──────
test('nonNeg clamps a negative projection (and its band) to 0 by default', () => {
  const a = forecastAnswer('leads', [50, 40, 30, 20, 10], { horizon: 4 }) // would go negative
  assert.equal(a.direction, 'down')
  assert.equal(a.headline.point, 0, 'point floored at 0')
  assert.equal(a.headline.lo, 0, 'band floor at 0')
  // opting out lets it go negative (proves the flag threads through to forecast.js)
  const raw = forecastAnswer('leads', [50, 40, 30, 20, 10], { horizon: 4, nonNeg: false })
  assert.ok(raw.headline.point < 0, 'without nonNeg the line is allowed to cross 0')
})

// ── null / empty / garbage → null (nothing to answer), and never throws ─────────
test('empty or non-finite history → null', () => {
  assert.equal(forecastAnswer('revenue', []), null)
  assert.equal(forecastAnswer('revenue', null), null)
  assert.equal(forecastAnswer('revenue', undefined), null)
  assert.equal(forecastAnswer('revenue', [NaN, Infinity, null, '']), null)
  assert.equal(forecastAnswer('revenue', ['a', 'b']), null)   // non-numeric strings dropped
})

// ── PURE: inputs are not mutated ────────────────────────────────────────────────
test('does not mutate the input series', () => {
  const series = [100, 110, 120, 130, 140]
  const copy = series.slice()
  forecastAnswer('revenue', series, { horizon: 6 })
  assert.deepEqual(series, copy)
})

// ── grounded narration: every number copied verbatim from the answer ────────────
test('narrateForecast copies headline.point/lo/hi and trend verbatim (grounded)', () => {
  const a = forecastAnswer('revenue', [100, 110, 120, 130, 140, 150, 160, 170])
  const s = narrateForecast(a, { label: 'Revenue', fmt: echo })
  const h = a.headline
  const expected =
    `Revenue is trending up — projected at ~«${h.point}» in 4 weeks `
    + `(likely «${h.lo}»–«${h.hi}»), about +«${Math.abs(a.trend_per_step)}»/week.`
  assert.equal(s, expected)
})

test('narrateForecast says "next week" at horizon 1', () => {
  const a = forecastAnswer('revenue', [100, 110, 120, 130, 140, 150], { horizon: 1 })
  const s = narrateForecast(a, { label: 'Revenue', fmt: money })
  assert.ok(s.includes('next week'), s)
  assert.ok(!s.includes('in 1 weeks'), 'reads naturally, not "in 1 weeks"')
})

// ── grounded narration: the honest caveats read as plain English ────────────────
test('narrateForecast renders thin_history and poor_fit caveats literally', () => {
  const thin = forecastAnswer('revenue', [100, 120, 150])
  assert.equal(
    narrateForecast(thin, { label: 'Revenue', fmt: money }),
    'Only 3 weeks of history — too little to project revenue confidently yet.',
  )
  const one = forecastAnswer('revenue', [100])
  assert.equal(
    narrateForecast(one, { label: 'Revenue', fmt: money }),
    'Only 1 week of history — too little to project revenue confidently yet.', // singular
  )
  const poor = forecastAnswer('revenue', [100, 10, 100, 10, 100, 10, 100, 10])
  assert.equal(
    narrateForecast(poor, { label: 'Revenue', fmt: money }),
    'Revenue has moved too erratically lately to project confidently.',
  )
})

test('narrateForecast is empty for a null answer', () => {
  assert.equal(narrateForecast(null), '')
  assert.equal(narrateForecast(forecastAnswer('revenue', [])), '')
})
