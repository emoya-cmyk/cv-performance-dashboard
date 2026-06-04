'use strict'
// Tests for lib/scopeNowcastAccuracy.js — intel-v14 D4 (step a): the nowcast grades itself.
// Covers: history-floor gating (none vs graded), a perfect replay scoring ~0% error, the
// AVERAGE error over multiple in-buffer checks, a pace miss producing the right sMAPE, the
// CRITICAL streak-break/overshoot case (a projection graded against a read that reversed —
// proving we don't silently drop the misses that matter most), the within-band hit rate,
// multi-metric aggregation, adverse-metric neutrality, leak-safety, determinism, fail-safe
// degradation, and the headline / error-metric units. Inputs flow through the REAL
// detectScopeTrends → projectScopeTrend pipeline, so the backtest is exercised end-to-end.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { gradeScopeNowcast, buildAccuracyHeadline, symPctError } = require('../lib/scopeNowcastAccuracy')

// {revenue:10000} → [{metric,current}] (the compact shape the FE buffers + the pipeline reads).
const snap = (obj) => Object.entries(obj).map(([metric, current]) => ({ metric, current }))
const hist = (...reads) => reads.map(snap)

// ── history-floor gating ─────────────────────────────────────────────────────
test('fewer than 4 reads cannot grade → status none', () => {
  const g = gradeScopeNowcast(hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }))
  assert.equal(g.status, 'none')
  assert.deepEqual(g.metrics, [])
  assert.equal(g.overall, null)
  assert.equal(g.headline, null)
  assert.equal(g.meta.reads, 3)
})

test('enough reads but no streak ever formed → status none', () => {
  const g = gradeScopeNowcast(hist({ revenue: 10000 }, { revenue: 10000 }, { revenue: 10000 }, { revenue: 10000 }))
  assert.equal(g.status, 'none')
  assert.equal(g.overall, null)
  assert.equal(g.meta.reads, 4)
})

// ── a perfect replay scores ~0% ───────────────────────────────────────────────
test('a constant-pace run projects exactly → 0% error, tight grade', () => {
  const g = gradeScopeNowcast(hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 13000 }))
  assert.equal(g.status, 'graded')
  assert.equal(g.overall.samples, 1)               // only the k=2 prefix is interior+gradeable
  assert.equal(g.overall.smape, 0)
  assert.equal(g.overall.accuracyPct, 100)
  assert.equal(g.overall.within, 100)
  assert.equal(g.overall.grade, 'tight')
  assert.equal(g.headline, 'Recent projections have landed within ~0% of actual — 1 check.')
  assert.equal(g.metrics.length, 1)
  assert.equal(g.metrics[0].metric, 'revenue')
  assert.equal(g.metrics[0].samples, 1)
  assert.equal(g.metrics[0].lastErrorPct, 0)
  assert.equal(g.meta.basis, 'one-step-backtest')
  assert.equal(g.meta.horizon, 1)
})

test('a longer constant-pace run grades every interior step', () => {
  const g = gradeScopeNowcast(hist(
    { revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 13000 }, { revenue: 14000 }))
  assert.equal(g.status, 'graded')
  assert.equal(g.overall.samples, 2)               // k=2 and k=3 both gradeable
  assert.equal(g.overall.smape, 0)
  assert.equal(g.metrics[0].samples, 2)
  assert.equal(g.headline, 'Recent projections have landed within ~0% of actual — 2 checks.')
})

// ── a pace miss → the right sMAPE ──────────────────────────────────────────────
test('a slowing run misses the projection → exact sMAPE + accuracy', () => {
  // [10k,11k,12k] projects 13000; actual lands at 12500. |13000−12500| ÷ 12750 = 3.92%.
  const g = gradeScopeNowcast(hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 12500 }))
  assert.equal(g.status, 'graded')
  assert.equal(g.overall.samples, 1)
  assert.equal(g.overall.smape, 3.92)
  assert.equal(g.overall.accuracyPct, 96.08)
  assert.equal(g.overall.within, 100)              // 3.92% ≤ 15% band → a hit
  assert.equal(g.overall.grade, 'tight')
  assert.equal(g.headline, 'Recent projections have landed within ~4% of actual — 1 check.')
  assert.equal(g.metrics[0].lastErrorPct, 3.92)
})

// ── the case that matters most: a streak that BREAKS is still graded ────────────
test('a projection is graded even when the streak reverses (overshoot is not dropped)', () => {
  // [10k,11k,12k] projects 13000; revenue instead FALLS to 11500 — the streak broke. We must
  // still read 11500 as the actual and score the overshoot, not silently skip the miss.
  const g = gradeScopeNowcast(hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 11500 }))
  assert.equal(g.status, 'graded')
  assert.equal(g.overall.samples, 1)               // the broken-streak read WAS graded
  assert.equal(g.overall.smape, 12.24)             // |13000−11500| ÷ 12250 = 12.24%
  assert.equal(g.overall.grade, 'fair')
  assert.equal(g.metrics[0].metric, 'revenue')
  assert.equal(g.metrics[0].lastErrorPct, 12.24)
})

// ── within-band hit rate over mixed checks ──────────────────────────────────────
test('within reflects the share of checks inside the band; grade tracks the average', () => {
  // k=2: project 13000, actual 13000 → 0% (hit). k=3: pace 1000 → project 14000, actual 20000
  // → 35.29% (miss vs 15% band). within = 1/2; sMAPE = 17.65 → 'fair'.
  const g = gradeScopeNowcast(hist(
    { revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 13000 }, { revenue: 20000 }))
  assert.equal(g.overall.samples, 2)
  assert.equal(g.overall.hits, 1)
  assert.equal(g.overall.within, 50)
  assert.equal(g.overall.smape, 17.65)
  assert.equal(g.overall.accuracyPct, 82.35)
  assert.equal(g.overall.grade, 'fair')
  assert.equal(g.metrics[0].lastErrorPct, 35.29)   // the most recent (k=3) miss
})

// ── multi-metric aggregation ────────────────────────────────────────────────────
test('two metrics on runs are graded independently and pooled', () => {
  const g = gradeScopeNowcast(hist(
    { revenue: 10000, leads: 50 },
    { revenue: 11000, leads: 55 },
    { revenue: 12000, leads: 60 },
    { revenue: 13000, leads: 62 }))   // revenue exact (→13000), leads misses (proj 65 vs 62)
  assert.equal(g.status, 'graded')
  assert.equal(g.overall.samples, 2)
  assert.equal(g.meta.gradedMetrics, 2)
  const rev = g.metrics.find((m) => m.metric === 'revenue')
  const led = g.metrics.find((m) => m.metric === 'leads')
  assert.equal(rev.smape, 0)
  assert.equal(led.smape, 4.72)                    // |65−62| ÷ 63.5 = 4.72%
  assert.equal(g.overall.smape, 2.36)              // (0 + 4.7244) ÷ 2
})

// ── adverse metric is graded the same (accuracy is polarity-neutral) ────────────
test('an adverse (good-down) metric on a run grades by precision, not polarity', () => {
  const g = gradeScopeNowcast(hist({ cpl: 40 }, { cpl: 45 }, { cpl: 50 }, { cpl: 55 }))
  assert.equal(g.status, 'graded')
  assert.equal(g.overall.samples, 1)
  assert.equal(g.overall.smape, 0)                 // pace 5 → project 55, actual 55
  assert.equal(g.metrics[0].metric, 'cpl')
})

// ── leak-safety + determinism ───────────────────────────────────────────────────
test('emitted grade carries no tenant identity', () => {
  const g = gradeScopeNowcast(hist(
    { revenue: 10000, cpl: 50 }, { revenue: 11000, cpl: 48 },
    { revenue: 12000, cpl: 46 }, { revenue: 13000, cpl: 44 }))
  const blob = JSON.stringify(g)
  for (const needle of ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!blob.includes(needle), `grade must not contain ${needle}`)
  }
})

test('same input → byte-identical output (deterministic)', () => {
  const h = hist({ revenue: 10000, leads: 50 }, { revenue: 11000, leads: 60 },
    { revenue: 12000, leads: 70 }, { revenue: 13000, leads: 78 })
  assert.deepEqual(gradeScopeNowcast(h), gradeScopeNowcast(h))
})

// ── fail-safe ────────────────────────────────────────────────────────────────────
test('malformed input never throws — degrades to status none', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, [], { reads: 3 }, [1, 2, 3, 4]]) {
    const g = gradeScopeNowcast(bad)
    assert.equal(g.status, 'none')
    assert.deepEqual(g.metrics, [])
    assert.equal(g.overall, null)
    assert.equal(g.headline, null)
  }
})

// ── units: headline + symmetric error ─────────────────────────────────────────────
test('buildAccuracyHeadline: count pluralization + the <1 / 0 distinction', () => {
  assert.equal(buildAccuracyHeadline(0, 0), null)
  assert.equal(buildAccuracyHeadline(1, 0), 'Recent projections have landed within ~0% of actual — 1 check.')
  assert.equal(buildAccuracyHeadline(5, 8.2), 'Recent projections have landed within ~8% of actual — 5 checks.')
  assert.equal(buildAccuracyHeadline(3, 0.4), 'Recent projections have landed within ~<1% of actual — 3 checks.')
})

test('symPctError: symmetric, scale-free, bounded to [0,200], zero-safe', () => {
  assert.ok(Math.abs(symPctError(13000, 12500) - 3.9215686) < 1e-6)
  assert.equal(symPctError(100, 100), 0)
  assert.equal(symPctError(0, 0), 0)               // both zero → perfect, not NaN
  assert.equal(symPctError(0, 10), 200)            // one zero → the bound, not Infinity
  assert.equal(symPctError(10, 0), 200)
})
