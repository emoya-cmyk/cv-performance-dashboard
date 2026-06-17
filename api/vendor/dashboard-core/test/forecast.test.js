// ============================================================
// test/forecast.test.js — the deterministic forward-projection engine.
//
// lib/forecast.js is the forward-looking half of the intelligence layer: Holt's
// linear method (level + trend), an honest prediction band from the model's own
// in-sample errors, a goal ETA, and a trend-aware month-end landing projection.
// These tests pin the smoothing recursion against hand-traced values, the band
// growth + non-negative clamp, and — the whole reason the module exists — that a
// client who is behind month-to-date but ACCELERATING is projected to land
// higher than naive pacing would ever say. Pure functions: no DB, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  holt, forecast, projectN, etaToTarget, monthEndProjection, mapeOf,
} = require('..')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)

// ---- Holt fit --------------------------------------------------------------

test('holt: a clean linear ramp is recovered exactly (level, trend, zero error)', () => {
  const f = holt([10, 20, 30, 40, 50])
  assert.equal(f.method, 'holt')
  assert.equal(f.n, 5)
  approx(f.level, 50)
  approx(f.trend, 10)
  assert.equal(f.mape, 0)                       // every one-step forecast is exact
  assert.equal(f.fitted.length, 5)
  assert.equal(f.residuals.length, 5)
  assert.deepEqual(f.fitted, [10, 20, 30, 40, 50])
})

test('holt: degenerate inputs are quiet, never thrown', () => {
  assert.equal(holt([]).method, 'none')
  assert.equal(holt(null).method, 'none')
  assert.equal(holt(undefined).method, 'none')
  const one = holt([42])
  assert.equal(one.method, 'naive')
  approx(one.level, 42)
  approx(one.trend, 0)
  assert.equal(one.mape, null)
})

test('holt: missing weeks (null / blank / strings) are skipped, not counted as 0', () => {
  // The junk collapses to the same clean ramp → identical fit. If blanks were
  // coerced to 0 the trend would be wrecked.
  const f = holt([10, null, 20, 'x', 30, '', 40, 50])
  approx(f.level, 50)
  approx(f.trend, 10)
  assert.equal(f.mape, 0)
})

// ---- projection + band -----------------------------------------------------

test('projectN: h-step point forecast is level + h·trend', () => {
  approx(projectN(3, 50, 10), 80)
  approx(projectN(1, 50, 10), 60)
})

test('forecast: a perfect ramp projects forward with a zero-width band', () => {
  const out = forecast([10, 20, 30, 40, 50], { horizon: 3 })
  assert.equal(out.points.length, 3)
  approx(out.resStd, 0)                          // no in-sample error → no band
  assert.deepEqual(out.points.map(p => p.point), [60, 70, 80])
  for (const p of out.points) approx(p.lo, p.point), approx(p.hi, p.point)
})

test('forecast: the band widens the further out we guess', () => {
  // A noisy series has non-zero residuals → a real band that grows as √h.
  const out = forecast([10, 12, 9, 13, 11, 14], { horizon: 4 })
  assert.ok(out.resStd > 0)
  const width = out.points.map(p => p.hi - p.lo)
  for (let i = 1; i < width.length; i++) {
    assert.ok(width[i] > width[i - 1], `band must grow: ${width[i]} > ${width[i - 1]}`)
  }
})

test('forecast: nonNeg clamps a declining projection at zero', () => {
  const raw     = forecast([100, 80, 60, 40, 20], { horizon: 5 })
  const clamped = forecast([100, 80, 60, 40, 20], { horizon: 5, nonNeg: true })
  assert.ok(raw.points[1].point < 0, 'unclamped projection does go negative')
  for (const p of clamped.points) {
    assert.ok(p.point >= 0 && p.lo >= 0 && p.hi >= 0, 'clamped projection floors at 0')
  }
})

// ---- goal ETA --------------------------------------------------------------

test('etaToTarget: already-there / reachable / unreachable / garbage', () => {
  assert.equal(etaToTarget(100, 0, 50), 0)       // already at/above target
  assert.equal(etaToTarget(50, 10, 100), 5)      // (100-50)/10
  assert.equal(etaToTarget(55, 10, 100), 5)      // ceil(4.5) — whole periods only
  assert.equal(etaToTarget(50, 0, 100), null)    // flat → never gets there
  assert.equal(etaToTarget(50, -5, 100), null)   // declining → never
  assert.equal(etaToTarget('x', 10, 100), null)  // garbage in → null, not NaN
})

// ---- month-end landing (the headline behaviour) ----------------------------

test('monthEndProjection: behind month-to-date but accelerating → projected ABOVE naive pacing', () => {
  // Accelerating weekly series. Naive pacing (mtd / fracElapsed) would say 400;
  // the trend-aware projection values the rest of the month at the rising rate.
  const p = monthEndProjection({
    values: [100, 150, 200, 300], mtd: 200,
    daysElapsed: 14, daysInMonth: 28, target: 900,
  })
  approx(p.trendWeekly, 332.5)                   // Holt level+trend, clamped ≥0
  approx(p.projectedRemaining, 665)              // 332.5 × (14/7)
  approx(p.projectedTotal, 865)                  // 200 + 665
  const naive = 200 / (14 / 28)                  // = 400
  assert.ok(p.projectedTotal > naive, 'acceleration is projected forward, not averaged away')
  approx(p.pctOfTarget, 865 / 900)
})

test('monthEndProjection: a collapsing metric clamps the forward rate at zero', () => {
  const p = monthEndProjection({
    values: [300, 200, 100, 50], mtd: 300,
    daysElapsed: 14, daysInMonth: 28, target: 1000,
  })
  approx(p.trendWeekly, 0)                        // level+trend < 0 → clamped
  approx(p.projectedTotal, 300)                   // adds ~nothing more this month
  assert.ok(p.pctOfTarget < 0.31)
})

test('monthEndProjection: no target → pctOfTarget is null, still projects a total', () => {
  const p = monthEndProjection({
    values: [10, 20, 30, 40], mtd: 50, daysElapsed: 7, daysInMonth: 28,
  })
  assert.equal(p.pctOfTarget, null)
  assert.equal(p.target, null)
  assert.ok(p.projectedTotal > 50)
})

test('monthEndProjection / mapeOf never throw on empty or garbage input', () => {
  assert.doesNotThrow(() => monthEndProjection({}))
  assert.doesNotThrow(() => monthEndProjection({ values: null, mtd: 'x' }))
  assert.equal(mapeOf([5], [5]), null)           // nothing gradeable
})
