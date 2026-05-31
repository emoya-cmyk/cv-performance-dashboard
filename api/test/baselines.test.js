// ============================================================
// test/baselines.test.js — the self-calibrating statistics core.
//
// lib/baselines.js is the foundation of the autonomous intelligence layer: it
// decides what counts as "unusual" for each client from that client's OWN
// history instead of a hard-coded ±15%. These tests pin the math (median, MAD,
// robust z, trend slope, EWMA, severity buckets) and the one composite the
// engine calls, summarizeSeries(), including its can-never-throw contract on
// empty / short / garbage input. Pure functions — no DB, no HTTP, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  mean, stddev, median, mad, robustStats, robustZ,
  linregSlope, ewma, classifyZ, direction, summarizeSeries,
  MAD_TO_SIGMA,
} = require('../lib/baselines')

// ---- basic descriptive stats -----------------------------------------------

test('mean / median / stddev / mad: known inputs', () => {
  assert.equal(mean([2, 4, 6]), 4)
  assert.equal(median([3, 1, 2]), 2)            // odd length
  assert.equal(median([4, 1, 3, 2]), 2.5)       // even length → average of middles
  assert.equal(stddev([2, 4, 6]), 2)            // var = 8/2 = 4 → σ = 2
  assert.equal(mad([1, 2, 3, 4, 5]), 1)         // |devs| from median 3 = [2,1,0,1,2] → median 1
})

test('degenerate inputs never throw and return 0', () => {
  for (const fn of [mean, stddev, median, mad]) {
    assert.equal(fn([]), 0)
    assert.equal(fn(null), 0)
    assert.equal(fn(undefined), 0)
  }
  assert.equal(stddev([5]), 0)                  // need ≥2 points for spread
})

test('finite-only: nulls, NaN and strings are ignored, not coerced to 0', () => {
  // If junk were coerced to 0, the mean would be dragged down to 2; filtering
  // keeps it at 4 over the three real values.
  assert.equal(mean([4, null, 4, 'x', 4, NaN, undefined]), 4)
  assert.equal(median([10, null, 20, 'nope']), 15)
})

// ---- robust profile + z ----------------------------------------------------

test('robustStats: robustStd is 1.4826*MAD, with σ fallback when MAD is 0', () => {
  const s = robustStats([1, 2, 3, 4, 5])
  assert.equal(s.n, 5)
  assert.equal(s.median, 3)
  assert.equal(s.mad, 1)
  assert.ok(Math.abs(s.robustStd - MAD_TO_SIGMA) < 1e-9)

  // [10,10,10,10,40] → median 10, MAD 0, so the band falls back to σ (>0).
  const f = robustStats([10, 10, 10, 10, 40])
  assert.equal(f.mad, 0)
  assert.ok(f.robustStd > 0)
  assert.equal(f.robustStd, f.std)
})

test('robustZ: spikes score high, flat history is unflaggable, direction-aware', () => {
  const s = robustStats([100, 110, 90, 105, 95])      // median 100, MAD 5 → band ≈7.41
  assert.ok(robustZ(300, s) > 10, 'a 3x spike is many robust-σ out')
  assert.ok(robustZ(100, s) === 0 || Math.abs(robustZ(100, s)) < 0.5)
  assert.ok(robustZ(50, s) < 0, 'below the median → negative z')

  // A perfectly flat history has no spread → z pinned to 0, never Infinity/NaN.
  const flat = robustStats([7, 7, 7, 7, 7])
  assert.equal(robustZ(999, flat), 0)
  assert.ok(Number.isFinite(robustZ(999, flat)))
})

// ---- trend + smoothing -----------------------------------------------------

test('linregSlope: sign tracks the trend, flat is 0', () => {
  assert.ok(linregSlope([1, 2, 3, 4, 5]) > 0)
  assert.ok(linregSlope([5, 4, 3, 2, 1]) < 0)
  assert.equal(linregSlope([3, 3, 3, 3]), 0)
  assert.equal(linregSlope([3]), 0)               // need ≥2 points
  // A clean +10/step ramp has slope exactly 10.
  assert.ok(Math.abs(linregSlope([0, 10, 20, 30]) - 10) < 1e-9)
})

test('ewma: weights the most recent period most, stays within range', () => {
  const v = [10, 10, 10, 100]
  const e = ewma(v, 0.5)
  assert.ok(e > 10 && e < 100, 'pulled toward the latest spike but not all the way')
  assert.ok(e > ewma(v, 0.1), 'higher alpha reacts harder to the recent jump')
  assert.equal(ewma([42]), 42)
  assert.equal(ewma([]), 0)
})

// ---- severity buckets ------------------------------------------------------

test('classifyZ: warning at |z|≥2, critical at |z|≥3, symmetric, else null', () => {
  assert.equal(classifyZ(1.9), null)
  assert.equal(classifyZ(2), 'warning')
  assert.equal(classifyZ(-2.5), 'warning')
  assert.equal(classifyZ(3), 'critical')
  assert.equal(classifyZ(-4), 'critical')
  assert.equal(classifyZ(0), null)
  // custom thresholds are honoured
  assert.equal(classifyZ(1.5, { warn: 1, crit: 2 }), 'warning')
})

test('direction maps sign to up/down/flat', () => {
  assert.equal(direction(5), 'up')
  assert.equal(direction(-5), 'down')
  assert.equal(direction(0), 'flat')
})

// ---- summarizeSeries: the engine entry point -------------------------------

const HISTORY = [100, 110, 90, 105, 95].map(revenue => ({ revenue }))

test('summarizeSeries: a clear spike is flagged, up, with a finite z', () => {
  const series = [...HISTORY, { revenue: 300 }]
  const [r] = summarizeSeries(series, ['revenue'])
  assert.equal(r.metric, 'revenue')
  assert.equal(r.severity, 'critical')
  assert.equal(r.direction, 'up')
  assert.equal(r.reason, 'anomaly')
  assert.equal(r.baseline, 100)
  assert.equal(r.latest, 300)
  assert.ok(Number.isFinite(r.z) && r.z > 3)
})

test('summarizeSeries: a latest within the band is quiet (null severity)', () => {
  const series = [...HISTORY, { revenue: 102 }]
  const [r] = summarizeSeries(series, ['revenue'])
  assert.equal(r.severity, null)
  assert.equal(r.reason, 'within_band')
})

test('summarizeSeries: short history is not judged, it is reported as such', () => {
  const series = [{ revenue: 10 }, { revenue: 12 }, { revenue: 900 }]  // history len 2 < minN 4
  const [r] = summarizeSeries(series, ['revenue'])
  assert.equal(r.severity, null)
  assert.equal(r.reason, 'insufficient_history')
  assert.equal(r.n, 2)
})

test('summarizeSeries: a metric absent everywhere is no_data, not a crash', () => {
  const [r] = summarizeSeries(HISTORY, ['leads'])
  assert.equal(r.severity, null)
  assert.equal(r.reason, 'no_data')
  assert.equal(r.n, 0)
})

test('summarizeSeries: critical sorts ahead of warning ahead of quiet', () => {
  // Each metric needs a NOISY history so its spread (MAD/σ) is non-zero and the
  // latest point is actually measurable — a perfectly flat history has no band
  // and is unflaggable by design. Tuned so:
  //   leads   → latest 5000 vs band ≈1.48  → |z|≈3339  → critical
  //   spend   → latest 1037 vs band ≈14.8  → |z|≈2.5   → warning
  //   revenue → latest 101  vs band ≈0.71  → |z|≈1.4   → quiet (null)
  const series = [
    { revenue: 100, leads: 48,   spend: 980  },
    { revenue: 101, leads: 52,   spend: 1020 },
    { revenue: 99,  leads: 49,   spend: 990  },
    { revenue: 100, leads: 51,   spend: 1010 },
    { revenue: 100, leads: 50,   spend: 1000 },
    { revenue: 101, leads: 5000, spend: 1037 },
  ]
  const res = summarizeSeries(series, ['revenue', 'leads', 'spend'])
  assert.equal(res[0].metric, 'leads')               // biggest deviation first
  assert.equal(res[0].severity, 'critical')
  // the three severities are all represented and strictly ordered
  assert.deepEqual(res.map(r => r.metric), ['leads', 'spend', 'revenue'])
  assert.equal(res[1].severity, 'warning')
  assert.equal(res[2].severity, null)
  // ordering is non-increasing in severity rank
  const rank = { critical: 2, warning: 1 }
  for (let i = 1; i < res.length; i++) {
    assert.ok((rank[res[i - 1].severity] || 0) >= (rank[res[i].severity] || 0))
  }
})

test('summarizeSeries: never throws on empty / garbage input', () => {
  assert.doesNotThrow(() => summarizeSeries([], ['revenue']))
  assert.doesNotThrow(() => summarizeSeries(null, null))
  assert.doesNotThrow(() => summarizeSeries(undefined, ['revenue']))
  assert.deepEqual(summarizeSeries([], []), [])
})
