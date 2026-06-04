'use strict'
// Tests for lib/scopeNowcastBand.js — intel-v14 D5 (step a): the nowcast calibrates its own band.
// Covers: gating (no projection / ungraded accuracy → none), the END-TO-END tight band through
// the REAL detectScopeTrends → projectScopeTrend → gradeScopeNowcast pipeline (the band half-width
// IS the measured sMAPE), the overall-basis fallback when a metric was never individually graded,
// the non-negative FLOOR on a known engine metric, the >±200% CAP (raw sMAPE preserved, drawn
// width clamped), the opts.maxHalfPct override, an UNKNOWN metric left unfloored, leak-safety,
// determinism, fail-safe degradation, and the non-finite-projection skip.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { detectScopeTrends } = require('../lib/scopeTrend')
const { projectScopeTrend } = require('../lib/scopeNowcast')
const { gradeScopeNowcast } = require('../lib/scopeNowcastAccuracy')
const { calibrateNowcastBand } = require('../lib/scopeNowcastBand')

// {revenue:10000} → [{metric,current}] (the compact shape the FE buffers + the pipeline reads).
const snap = (obj) => Object.entries(obj).map(([metric, current]) => ({ metric, current }))
const hist = (...reads) => reads.map(snap)
const round2 = (n) => Math.round(n * 100) / 100

// ── gating ────────────────────────────────────────────────────────────────────
test('no projection → status none', () => {
  const nowcast = { status: 'none', projections: [] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'revenue', smape: 5, samples: 1 }], overall: { smape: 5, samples: 1 } }
  const b = calibrateNowcastBand(nowcast, accuracy, {})
  assert.equal(b.status, 'none')
  assert.deepEqual(b.bands, [])
  assert.equal(b.meta.calibrated, 0)
})

test('accuracy missing or not graded → status none', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'revenue', projected: 1000 }] }
  for (const acc of [null, undefined, { status: 'none', metrics: [], overall: null }, { status: 'graded', metrics: [], overall: null }]) {
    const b = calibrateNowcastBand(nowcast, acc, {})
    assert.equal(b.status, 'none', `acc=${JSON.stringify(acc)}`)
    assert.deepEqual(b.bands, [])
  }
})

// ── the headline case: a measured band through the REAL pipeline ──────────────────
test('end-to-end — the band half-width equals the metric’s own measured sMAPE', () => {
  // [10k,11k,12k,12.5k] live-projects revenue to 13333.33 (avg step 833.33 over the run); the
  // one-step backtest grades the [10k,11k,12k]→13000 vs-actual-12500 miss at sMAPE 3.92%. The band
  // is therefore ±3.92% about 13333.33 → $12,811–$13,856. Honest precision, drawn from the record.
  const h = hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 12500 })
  const trend = detectScopeTrends(h, {})
  const nowcast = projectScopeTrend(trend, { horizon: 1 })
  const accuracy = gradeScopeNowcast(h, {})
  assert.equal(accuracy.status, 'graded')
  assert.equal(accuracy.overall.smape, 3.92)

  const band = calibrateNowcastBand(nowcast, accuracy, {})
  assert.equal(band.status, 'calibrated')
  assert.equal(band.bands.length, 1)
  const b = band.bands[0]
  assert.equal(b.metric, 'revenue')
  assert.equal(b.metric_label, 'Revenue')
  assert.equal(b.basis, 'metric')              // graded individually → its own error, not the pool
  assert.equal(b.samples, 1)
  assert.equal(b.halfPct, 3.92)                // raw measured sMAPE
  assert.equal(b.drawnHalfPct, 3.92)           // un-capped here
  assert.equal(b.floored, false)
  assert.equal(b.projected, 13333.33)
  assert.equal(b.projectedCents, 1333333)
  assert.equal(b.lo, 12810.67)                 // round2(13333.33… × 0.9608)
  assert.equal(b.hi, 13856)                    // round2(13333.33… × 1.0392)
  assert.equal(b.loCents, 1281067)
  assert.equal(b.hiCents, 1385600)
  assert.equal(b.loLabel, '$12,811')           // rendered through the shared formatValue oracle
  assert.equal(b.hiLabel, '$13,856')
  assert.equal(b.rangeLabel, '$12,811–$13,856')
  assert.ok(b.lo < b.projected && b.projected < b.hi)   // a real interval straddling the point
  assert.equal(band.meta.basis, 'measured-smape')
  assert.equal(band.meta.calibrated, 1)
  assert.equal(band.meta.maxHalfPct, 200)
})

// ── overall-basis fallback ──────────────────────────────────────────────────────
test('a metric never individually graded borrows the pooled overall sMAPE', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'leads', metric_label: 'Leads', projected: 100 }] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'revenue', smape: 5, samples: 3 }], overall: { smape: 10, samples: 2 } }
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  assert.equal(band.status, 'calibrated')
  const b = band.bands[0]
  assert.equal(b.metric, 'leads')
  assert.equal(b.basis, 'overall')             // no own grade → pooled
  assert.equal(b.halfPct, 10)
  assert.equal(b.drawnHalfPct, 10)
  assert.equal(b.samples, 2)                   // pooled sample count
  assert.equal(b.lo, 90)
  assert.equal(b.hi, 110)
  assert.equal(b.floored, false)
})

// ── the non-negative floor on a known engine metric ───────────────────────────────
test('a wide band on a known metric floors the low end at 0', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'revenue', projected: 1000 }] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'revenue', smape: 150, samples: 1 }], overall: { smape: 150, samples: 1 } }
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  const b = band.bands[0]
  assert.equal(b.halfPct, 150)
  assert.equal(b.drawnHalfPct, 150)            // ≤200, drawn in full
  assert.equal(b.lo, 0)                        // 1000×(1−1.5) = −500 → floored to 0
  assert.equal(b.floored, true)
  assert.equal(b.hi, 2500)                     // 1000×2.5
})

// ── the cap: a >±200% width is clamped, the raw sMAPE preserved ────────────────────
test('an off-scale sMAPE is capped to maxHalfPct while the raw value is kept', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'revenue', projected: 1000 }] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'revenue', smape: 250, samples: 1 }], overall: { smape: 250, samples: 1 } }
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  const b = band.bands[0]
  assert.equal(b.halfPct, 250)                 // raw measured error, preserved for honesty
  assert.equal(b.drawnHalfPct, 200)            // clamped to the ±200% draw ceiling
  assert.equal(b.lo, 0)                        // 1000×(1−2) = −1000 → floored
  assert.equal(b.floored, true)
  assert.equal(b.hi, 3000)                     // 1000×3
})

// ── opts.maxHalfPct override ───────────────────────────────────────────────────────
test('opts.maxHalfPct narrows the drawn band without rewriting the measured sMAPE', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'revenue', projected: 1000 }] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'revenue', smape: 150, samples: 1 }], overall: { smape: 150, samples: 1 } }
  const band = calibrateNowcastBand(nowcast, accuracy, { maxHalfPct: 50 })
  const b = band.bands[0]
  assert.equal(b.halfPct, 150)                 // measured error unchanged
  assert.equal(b.drawnHalfPct, 50)             // capped by the override
  assert.equal(b.lo, 500)                      // 1000×0.5
  assert.equal(b.hi, 1500)                     // 1000×1.5
  assert.equal(b.floored, false)
  assert.equal(band.meta.maxHalfPct, 50)
})

// ── an unknown metric has no non-negative domain → not floored ─────────────────────
test('an unknown metric is left unfloored (its domain is unknown)', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'made_up_metric', metric_label: 'Made Up', projected: 1000 }] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'made_up_metric', smape: 150, samples: 1 }], overall: { smape: 150, samples: 1 } }
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  const b = band.bands[0]
  assert.equal(b.lo, -500)                     // 1000×(1−1.5), NOT floored
  assert.equal(b.floored, false)
  assert.equal(b.hi, 2500)
  assert.equal(b.loLabel, '-500')              // unknown metric → bare rounded number, no currency
})

// ── a non-finite projection is skipped, finite siblings still banded ───────────────
test('a projection with a non-finite projected value is skipped', () => {
  const nowcast = { status: 'projected', projections: [
    { metric: 'revenue', projected: Infinity },
    { metric: 'leads', metric_label: 'Leads', projected: 100 },
  ] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'leads', smape: 10, samples: 1 }], overall: { smape: 10, samples: 1 } }
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  assert.equal(band.status, 'calibrated')
  assert.equal(band.bands.length, 1)
  assert.equal(band.bands[0].metric, 'leads')
})

// ── leak-safety + determinism ───────────────────────────────────────────────────
test('emitted band carries no tenant identity', () => {
  const h = hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 12500 })
  const trend = detectScopeTrends(h, {})
  const nowcast = projectScopeTrend(trend, { horizon: 1 })
  const accuracy = gradeScopeNowcast(h, {})
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  const blob = JSON.stringify(band)
  for (const needle of ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!blob.includes(needle), `band must not contain ${needle}`)
  }
})

test('same input → byte-identical output (deterministic)', () => {
  const nowcast = { status: 'projected', projections: [{ metric: 'revenue', projected: 1000 }, { metric: 'leads', metric_label: 'Leads', projected: 50 }] }
  const accuracy = { status: 'graded', metrics: [{ metric: 'revenue', smape: 8, samples: 2 }], overall: { smape: 12, samples: 2 } }
  assert.deepEqual(calibrateNowcastBand(nowcast, accuracy, {}), calibrateNowcastBand(nowcast, accuracy, {}))
})

// ── fail-safe ────────────────────────────────────────────────────────────────────
test('malformed input never throws — degrades to status none', () => {
  const okNowcast = { status: 'projected', projections: [{ metric: 'revenue', projected: 1000 }] }
  const okAcc = { status: 'graded', metrics: [{ metric: 'revenue', smape: 5, samples: 1 }], overall: { smape: 5, samples: 1 } }
  for (const bad of [null, undefined, 42, 'nope', {}, [], { projections: 3 }, NaN]) {
    const a = calibrateNowcastBand(bad, okAcc, {})
    assert.equal(a.status, 'none')
    assert.deepEqual(a.bands, [])
    const b = calibrateNowcastBand(okNowcast, bad, {})
    assert.equal(b.status, 'none')
    assert.deepEqual(b.bands, [])
  }
  // both junk, and junk opts → still none, still no throw
  assert.equal(calibrateNowcastBand('x', 'y', 'z').status, 'none')
  assert.equal(calibrateNowcastBand(okNowcast, okAcc, 42).status, 'calibrated')   // bad opts ignored
})
