'use strict'
// Tests for lib/scopeNowcast.js — intel-v14 D3 (step a): live nowcast off the streak.
// Covers: status gating (none vs projected), AVERAGE-step pace (not the noisy last step),
// polarity-correct phrasing + byte-identical magnitudes (REAL minus sign), the non-negative
// floor (clamped), the horizon clamp + pluralization, multi-metric salience order,
// leak-safety, determinism, and fail-safe degradation. Inputs are produced by the REAL
// detectScopeTrends so the trend → nowcast pipeline is exercised end-to-end.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { detectScopeTrends } = require('../lib/scopeTrend')
const { projectScopeTrend, buildNowcastHeadline } = require('../lib/scopeNowcast')

// {revenue:10000} → [{metric,current}] (the compact shape the FE buffers via snapOf).
const snap = (obj) => Object.entries(obj).map(([metric, current]) => ({ metric, current }))
const trendOf = (...reads) => detectScopeTrends(reads.map(snap))

// ── status gating ────────────────────────────────────────────────────────────
test('a non-trending payload projects nothing → status none', () => {
  const flat = detectScopeTrends([snap({ revenue: 10000 }), snap({ revenue: 10000 })])
  const n = projectScopeTrend(flat)
  assert.equal(n.status, 'none')
  assert.deepEqual(n.projections, [])
  assert.equal(n.headline, null)
  assert.equal(n.meta.projectedCount, 0)
})

test('clean revenue up-run → projects one avg step ahead with the right shape + headline', () => {
  const trend = trendOf({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 })
  const n = projectScopeTrend(trend)
  assert.equal(n.status, 'projected')
  assert.equal(n.projections.length, 1)
  const p = n.projections[0]
  assert.equal(p.metric, 'revenue')
  assert.equal(p.metric_label, 'Revenue')
  assert.equal(p.direction, 'up')
  assert.equal(p.improving, true)            // revenue up is good
  assert.equal(p.horizon, 1)
  assert.equal(p.current, 12000)             // launch point = run's latest value
  assert.equal(p.pace, 1000)                 // delta 2000 ÷ 2 steps
  assert.equal(p.projected, 13000)           // 12000 + 1000
  assert.equal(p.projectedDelta, 1000)
  assert.equal(p.clamped, false)
  assert.deepEqual(p.values, [10000, 11000, 12000])
  assert.equal(p.headline, 'At this pace, revenue reaches ~$13,000 next update (+$1,000).')
  assert.equal(n.headline, p.headline)
  assert.equal(n.meta.horizon, 1)
  assert.equal(n.meta.basis, 'avg-step')
})

// ── pace is the average step, never the noisiest last step ──────────────────────
test('pace is the AVERAGE step, not the last step', () => {
  // +900 then +100 → last step is 100, but the defensible pace is 1000 ÷ 2 = 500.
  const trend = trendOf({ revenue: 10000 }, { revenue: 10900 }, { revenue: 11000 })
  const p = projectScopeTrend(trend).projections[0]
  assert.equal(p.pace, 500)                  // (11000 − 10000) ÷ 2, NOT the last step (100)
  assert.equal(p.projected, 11500)
})

// ── polarity-correct phrasing + byte-identical magnitudes ───────────────────────
test('adverse metric on a run → improving:false, "worth a look" tail, +$ magnitude', () => {
  const trend = trendOf({ cpl: 40 }, { cpl: 45 }, { cpl: 50 })
  const p = projectScopeTrend(trend).projections[0]
  assert.equal(p.metric, 'cpl')
  assert.equal(p.improving, false)           // cpl up is bad
  assert.equal(p.pace, 5)                     // 10 ÷ 2
  assert.equal(p.projected, 55)
  assert.equal(p.headline, 'At this pace, cost per lead reaches ~$55 next update (+$5) — worth a look.')
})

test('adverse metric easing → improving:true, REAL minus sign, no tail', () => {
  const trend = trendOf({ cpl: 50 }, { cpl: 45 }, { cpl: 40 })
  const p = projectScopeTrend(trend).projections[0]
  assert.equal(p.improving, true)            // cpl down is good
  assert.equal(p.projected, 35)              // 40 + (−5)
  assert.equal(p.headline, 'At this pace, cost per lead reaches ~$35 next update (−$5).')
  assert.ok(p.headline.includes('−'), 'uses the real minus sign')
  assert.ok(!p.headline.includes('-$'), 'no ASCII hyphen before the magnitude')
})

// ── non-negative floor ──────────────────────────────────────────────────────────
test('a down-run on a non-negative metric is floored at 0 → clamped when it would go negative', () => {
  // exactly-to-zero is NOT clamped (0 is a valid floor value):
  const onZero = trendOf({ cpl: 36 }, { cpl: 24 }, { cpl: 12 })   // avg −12 → 12 − 12 = 0
  const a = projectScopeTrend(onZero).projections[0]
  assert.equal(a.pace, -12)
  assert.equal(a.projected, 0)
  assert.equal(a.clamped, false)
  // steeper run that overshoots below zero IS clamped, and projectedDelta tracks the floor:
  const belowZero = trendOf({ cpl: 30 }, { cpl: 18 }, { cpl: 6 })  // avg −12 → 6 − 12 = −6
  const b = projectScopeTrend(belowZero).projections[0]
  assert.equal(b.projected, 0)               // floored from −6
  assert.equal(b.clamped, true)
  assert.equal(b.projectedDelta, -6)         // 0 − 6
})

// ── unknown metric (defensive path) ─────────────────────────────────────────────
test('unknown metric → improving:null, bare-number magnitude, no nudge, unclamped', () => {
  const trend = detectScopeTrends([
    [{ metric: 'mrr', current: 3000 }],
    [{ metric: 'mrr', current: 2500 }],
    [{ metric: 'mrr', current: 2000 }],
  ])
  const p = projectScopeTrend(trend).projections[0]
  assert.equal(p.metric, 'mrr')
  assert.equal(p.metric_label, 'mrr')        // falls back to the raw id
  assert.equal(p.improving, null)
  assert.equal(p.pace, -500)
  assert.equal(p.projected, 1500)            // unknown domain → NOT floored at 0
  assert.equal(p.clamped, false)
  assert.equal(p.headline, 'At this pace, mrr reaches ~1500 next update (−500).')
  assert.ok(!p.headline.includes('worth a look'), 'no good/bad claim for an unknown metric')
})

// ── horizon clamp + pluralization ───────────────────────────────────────────────
test('horizon is clamped to 1..3 and pluralized in the headline', () => {
  const trend = trendOf({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 })
  const p3 = projectScopeTrend(trend, { horizon: 3 }).projections[0]
  assert.equal(p3.horizon, 3)
  assert.equal(p3.projected, 15000)          // 12000 + 1000 × 3
  assert.equal(p3.headline, 'At this pace, revenue reaches ~$15,000 in 3 updates (+$3,000).')
  // out-of-range / non-integer horizons clamp into [1,3] (non-int → default 1):
  assert.equal(projectScopeTrend(trend, { horizon: 99 }).projections[0].horizon, 3)
  assert.equal(projectScopeTrend(trend, { horizon: 0 }).projections[0].horizon, 1)
  assert.equal(projectScopeTrend(trend, { horizon: 2.5 }).projections[0].horizon, 1)
})

// ── salience ────────────────────────────────────────────────────────────────────
test('multiple trends keep the trend module salience order; headline = most salient', () => {
  const trend = trendOf(
    { leads: 50 },                            // revenue not yet in view
    { revenue: 10000, leads: 55 },
    { revenue: 11000, leads: 60 },
    { revenue: 12000, leads: 65 },
  )
  const n = projectScopeTrend(trend)
  assert.equal(n.projections.length, 2)
  assert.equal(n.projections[0].metric, 'leads')    // 3-step run first…
  assert.equal(n.projections[1].metric, 'revenue')  // …2-step run second
  assert.equal(n.headline, n.projections[0].headline)
  assert.equal(n.meta.projectedCount, 2)
})

// ── leak-safety + determinism ─────────────────────────────────────────────────
test('emitted payload carries no tenant identity', () => {
  const trend = trendOf({ revenue: 10000, cpl: 50 }, { revenue: 11000, cpl: 48 }, { revenue: 12000, cpl: 46 })
  const blob = JSON.stringify(projectScopeTrend(trend))
  for (const needle of ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!blob.includes(needle), `payload must not contain ${needle}`)
  }
})

test('same input → byte-identical output (deterministic)', () => {
  const trend = trendOf({ revenue: 10000, leads: 50 }, { revenue: 11000, leads: 60 }, { revenue: 12000, leads: 70 })
  assert.deepEqual(projectScopeTrend(trend), projectScopeTrend(trend))
})

// ── fail-safe + headline unit ───────────────────────────────────────────────────
test('malformed input never throws — degrades to status none', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, [], { trends: null }, { trends: [null, 7, {}] }]) {
    const n = projectScopeTrend(bad)
    assert.equal(n.status, 'none')
    assert.deepEqual(n.projections, [])
    assert.equal(n.headline, null)
  }
})

test('buildNowcastHeadline: horizon 1 reads "next update"; improving:false adds the nudge', () => {
  const h = buildNowcastHeadline({
    metric: 'revenue', metric_label: 'Revenue', improving: false, horizon: 1, projected: 9000, projectedDelta: -1000,
  })
  assert.equal(h, 'At this pace, revenue reaches ~$9,000 next update (−$1,000) — worth a look.')
})
