'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assessNowcastMomentum } = require('../lib/scopeNowcastMomentum')

// ── fixtures ────────────────────────────────────────────────────────────────
// Each projection carries `values` = the run's read sequence (oldest → newest). Momentum measures
// step magnitudes in cents and compares an early-half pace to a late-half pace.
//
//   accelerating ⟺ late pace ≥ (1 + band) × early pace   (default band 0.20 → ratio ≥ 1.20)
//   decelerating ⟺ late pace ≤ (1 − band) × early pace   (ratio ≤ 0.80)
//   steady       ⟺ otherwise

// accelerating, adverse (cpl rising, bad): deltas 10→20 ⇒ cents 1000,2000 ⇒ ratio 2.0
const P_ACC_ADVERSE = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [50, 60, 80] }
// accelerating, gain (revenue rising, good): deltas 500→1000 ⇒ cents 50000,100000 ⇒ ratio 2.0
const P_ACC_GAIN = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [10000, 10500, 11500] }
// accelerating, polarity unknown: deltas 10→30 ⇒ ratio 3.0
const P_ACC_NULL = { metric: 'sessions', metric_label: 'Sessions', direction: 'up', improving: null, values: [100, 110, 140] }
// decelerating, gain flattening (revenue rising but slowing): deltas 1000→500 ⇒ ratio 0.5
const P_DEC_GAIN = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [10000, 11000, 11500] }
// decelerating, adverse easing (cpl rising but slowing): deltas 20→10 ⇒ ratio 0.5
const P_DEC_ADVERSE = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [50, 70, 80] }
// decelerating, polarity unknown (falling, slowing): |Δ| 30→10 ⇒ ratio 0.333
const P_DEC_NULL = { metric: 'sessions', metric_label: 'Sessions', direction: 'down', improving: null, values: [200, 170, 160] }
// steady gain: deltas 500,500 ⇒ ratio 1.0
const P_STEADY = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [10000, 10500, 11000] }
// steady, distinct metric: deltas 2,2 ⇒ ratio 1.0
const P_STEADY_CPL = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [50, 52, 54] }
// accelerating across 3 steps (odd ⇒ halves overlap on the middle step):
//   cents 1000,2000,3000 ⇒ early=mean(1000,2000)=1500, late=mean(2000,3000)=2500 ⇒ ratio 1.667
const P_ACC_3STEP = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 130, 160] }
// accelerating across 4 steps (even ⇒ clean split, no overlap):
//   cents 1000,1000,2000,3000 ⇒ early=1000, late=mean(2000,3000)=2500 ⇒ ratio 2.5
const P_ACC_4STEP = { metric: 'leads', metric_label: 'Leads', direction: 'up', improving: true, values: [100, 110, 120, 140, 170] }
// ratio exactly 1.15 (cents 2000→2300): steady at the default band (20%), accelerating at band 10%
const P_RATIO_115 = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 120, 143] }
// run too short to measure curvature (only 1 step)
const P_SHORT = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [10000, 11000] }
// a non-finite read anywhere ⇒ not measurable
const P_NONFINITE = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [10000, 'x', 11500] }
// flat first step ⇒ early pace 0 ⇒ no defensible ratio base ⇒ excluded (cannot occur in a real run)
const P_FLAT_FIRST = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 100, 130] }

const nc = (projections) => ({ status: 'projected', projections })

const LEAK_TOKENS = ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId', '"7"']

// ── 1. accelerating, adverse ⇒ projection may UNDERSTATE ──────────────────────
test('accelerating adverse move ⇒ shape accelerating, note warns the projection may understate', () => {
  const r = assessNowcastMomentum(nc([P_ACC_ADVERSE]))
  assert.equal(r.status, 'assessed')
  assert.equal(r.shape, 'accelerating')
  assert.equal(r.assessedCount, 1)
  assert.equal(r.acceleratingCount, 1)
  assert.equal(r.deceleratingCount, 0)
  assert.equal(r.steadyCount, 0)
  assert.equal(r.decisive.metric, 'cpl')
  assert.equal(r.decisive.paceRatio, 2)
  assert.equal(r.decisive.paceChangePct, 100)
  assert.ok(r.note.includes('Cost per lead'))
  assert.ok(/accelerating/i.test(r.note))
  assert.ok(r.note.includes('may understate'))
})

// ── 2. accelerating, gain ⇒ momentum is COMPOUNDING ──────────────────────────
test('accelerating gain ⇒ note frames compounding momentum, not a caution', () => {
  const r = assessNowcastMomentum(nc([P_ACC_GAIN]))
  assert.equal(r.shape, 'accelerating')
  assert.equal(r.decisive.improving, true)
  assert.ok(r.note.includes('Revenue'))
  assert.ok(r.note.includes('compounding'))
  assert.ok(!r.note.includes('understate'))
})

// ── 3. accelerating, polarity unknown ⇒ neutral accelerating note ────────────
test('accelerating with null polarity ⇒ generic accelerating note (no over/understate claim)', () => {
  const r = assessNowcastMomentum(nc([P_ACC_NULL]))
  assert.equal(r.shape, 'accelerating')
  assert.equal(r.decisive.improving, null)
  assert.ok(/accelerating/i.test(r.note))
  assert.ok(!r.note.includes('understate'))
  assert.ok(!r.note.includes('compounding'))
})

// ── 4. decelerating, gain flattening ⇒ projection may OVERSTATE ──────────────
test('decelerating gain ⇒ shape decelerating, note warns the projection may overstate', () => {
  const r = assessNowcastMomentum(nc([P_DEC_GAIN]))
  assert.equal(r.shape, 'decelerating')
  assert.equal(r.deceleratingCount, 1)
  assert.equal(r.decisive.paceRatio, 0.5)
  assert.equal(r.decisive.paceChangePct, -50)
  assert.ok(r.note.includes('Revenue'))
  assert.ok(r.note.includes('flattening'))
  assert.ok(r.note.includes('may overstate'))
})

// ── 5. decelerating, adverse easing ⇒ leveling off ───────────────────────────
test('decelerating adverse move ⇒ note says the adverse move is easing / leveling off', () => {
  const r = assessNowcastMomentum(nc([P_DEC_ADVERSE]))
  assert.equal(r.shape, 'decelerating')
  assert.equal(r.decisive.improving, false)
  assert.ok(r.note.includes('Cost per lead'))
  assert.ok(r.note.includes('easing'))
  assert.ok(r.note.includes('leveling off'))
})

// ── 6. decelerating, polarity unknown ⇒ neutral decelerating note ────────────
test('decelerating with null polarity ⇒ generic decelerating note', () => {
  const r = assessNowcastMomentum(nc([P_DEC_NULL]))
  assert.equal(r.shape, 'decelerating')
  assert.equal(r.decisive.improving, null)
  assert.ok(/decelerating/i.test(r.note))
  assert.ok(!r.note.includes('overstate'))
  assert.ok(!r.note.includes('easing'))
})

// ── 7. steady ⇒ the straight line is WELL-FOUNDED ────────────────────────────
test('steady pace ⇒ shape steady, note affirms the linear projection is well-founded', () => {
  const r = assessNowcastMomentum(nc([P_STEADY]))
  assert.equal(r.shape, 'steady')
  assert.equal(r.steadyCount, 1)
  assert.equal(r.decisive.paceRatio, 1)
  assert.equal(r.decisive.paceChangePct, 0)
  assert.ok(r.note.includes('Revenue'))
  assert.ok(r.note.includes('holding steady'))
  assert.ok(r.note.includes('well-founded'))
})

// ── 8. odd step count ⇒ halves overlap on the middle step ────────────────────
test('3-step run ⇒ overlapping early/late halves measured correctly', () => {
  const r = assessNowcastMomentum(nc([P_ACC_3STEP]))
  assert.equal(r.shape, 'accelerating')
  assert.equal(r.decisive.steps, 3)
  assert.equal(r.decisive.earlyPaceCents, 1500) // mean(1000,2000)
  assert.equal(r.decisive.latePaceCents, 2500) // mean(2000,3000)
  assert.ok(Math.abs(r.decisive.paceRatio - 5 / 3) < 1e-9)
})

// ── 9. even step count ⇒ clean split, no overlap ─────────────────────────────
test('4-step run ⇒ clean (non-overlapping) early/late split', () => {
  const r = assessNowcastMomentum(nc([P_ACC_4STEP]))
  assert.equal(r.shape, 'accelerating')
  assert.equal(r.decisive.steps, 4)
  assert.equal(r.decisive.earlyPaceCents, 1000) // mean(1000,1000)
  assert.equal(r.decisive.latePaceCents, 2500) // mean(2000,3000)
  assert.equal(r.decisive.paceRatio, 2.5)
})

// ── 10. decisive = the SHARPEST bend, regardless of polarity ─────────────────
test('mixed basket ⇒ the sharpest bend sets the overall shape and is the headline mover', () => {
  const r = assessNowcastMomentum(nc([P_STEADY_CPL, P_ACC_GAIN])) // cpl steady (0%), revenue +100%
  assert.equal(r.assessedCount, 2)
  assert.equal(r.acceleratingCount, 1)
  assert.equal(r.steadyCount, 1)
  assert.equal(r.shape, 'accelerating')
  assert.equal(r.decisive.metric, 'revenue') // 100% bend > 0% bend
  assert.equal(r.biggestMove, r.decisive) // same move: sharpest bend is the headline
})

// ── 11. tie on |pace change| ⇒ the more salient (earlier) projection wins ─────
test('equal |pace change| ⇒ first (more salient) projection is decisive', () => {
  const ACC = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 120, 150] } // ratio 1.5 → +50%
  const DEC = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [100, 130, 145] } // ratio 0.5 → −50%
  const accFirst = assessNowcastMomentum(nc([ACC, DEC]))
  assert.equal(accFirst.decisive.metric, 'revenue')
  assert.equal(accFirst.shape, 'accelerating')
  const decFirst = assessNowcastMomentum(nc([DEC, ACC]))
  assert.equal(decFirst.decisive.metric, 'cpl')
  assert.equal(decFirst.shape, 'decelerating')
})

// ── 12. counts tally every measured shape ────────────────────────────────────
test('counts reflect each measured projection by shape', () => {
  const r = assessNowcastMomentum(nc([P_ACC_GAIN, P_DEC_ADVERSE, P_STEADY_CPL]))
  // three DISTINCT metrics: revenue (accel), cpl (dec)… wait — P_DEC_ADVERSE and P_STEADY_CPL share
  // metric 'cpl'; the first wins via dedup, so only revenue + cpl are measured.
  assert.equal(r.assessedCount, 2)
  assert.equal(r.acceleratingCount, 1)
  assert.equal(r.deceleratingCount, 1)
  assert.equal(r.steadyCount, 0)
})

// ── 13. band override changes the steady/bending threshold ───────────────────
test('opts.steadyBandPct overrides the band: ratio 1.15 is steady by default, accelerating at band 10', () => {
  const dflt = assessNowcastMomentum(nc([P_RATIO_115]))
  assert.equal(dflt.shape, 'steady')
  assert.equal(dflt.band, 20)
  const tight = assessNowcastMomentum(nc([P_RATIO_115]), { steadyBandPct: 10 })
  assert.equal(tight.shape, 'accelerating')
  assert.equal(tight.band, 10)
  // a non-positive / non-numeric override falls back to the default band
  assert.equal(assessNowcastMomentum(nc([P_RATIO_115]), { steadyBandPct: 0 }).band, 20)
  assert.equal(assessNowcastMomentum(nc([P_RATIO_115]), { steadyBandPct: 'x' }).band, 20)
})

// ── 14. dedup by metric id (first wins) ──────────────────────────────────────
test('duplicate metric id is measured once (first occurrence wins)', () => {
  // same metric 'revenue' but DECELERATING — if dedup picked the second, shape would flip to
  // decelerating; asserting accelerating proves the first occurrence won.
  const dupe = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [10000, 11000, 11500] }
  const r = assessNowcastMomentum(nc([P_ACC_GAIN, dupe]))
  assert.equal(r.assessedCount, 1)
  assert.equal(r.decisive.metric, 'revenue')
  assert.equal(r.shape, 'accelerating') // the FIRST (P_ACC_GAIN) defined it
})

// ── 15. no curvature-measurable projection ⇒ status none ─────────────────────
test('only too-short runs ⇒ status none / no-curvature', () => {
  const r = assessNowcastMomentum(nc([P_SHORT]))
  assert.equal(r.status, 'none')
  assert.equal(r.reason, 'no-curvature')
  assert.equal(r.shape, 'indeterminate')
  assert.equal(r.assessedCount, 0)
  assert.equal(r.decisive, null)
  assert.equal(r.note, null)
})

test('empty projections ⇒ status none / no-curvature', () => {
  const r = assessNowcastMomentum(nc([]))
  assert.equal(r.status, 'none')
  assert.equal(r.reason, 'no-curvature')
})

// ── 16. non-finite read ⇒ that projection is excluded ────────────────────────
test('a non-finite read makes a projection unmeasurable (excluded)', () => {
  assert.equal(assessNowcastMomentum(nc([P_NONFINITE])).reason, 'no-curvature')
  // …but a measurable sibling still carries the verdict
  const r = assessNowcastMomentum(nc([P_NONFINITE, P_ACC_GAIN]))
  assert.equal(r.assessedCount, 1)
  assert.equal(r.decisive.metric, 'revenue')
})

// ── 17. zero early pace ⇒ no ratio base ⇒ excluded ───────────────────────────
test('a flat first step (early pace 0) is excluded, never divides by zero', () => {
  assert.equal(assessNowcastMomentum(nc([P_FLAT_FIRST])).reason, 'no-curvature')
})

// ── 18. mixed measurable + unmeasurable ⇒ only the measurable counts ─────────
test('mixed run lengths ⇒ assessedCount counts only the curvature-measurable runs', () => {
  const r = assessNowcastMomentum(nc([P_SHORT, P_ACC_GAIN, P_NONFINITE]))
  assert.equal(r.assessedCount, 1)
  assert.equal(r.shape, 'accelerating')
})

// ── 19. internal consistency of the decisive descriptor ──────────────────────
test('decisive descriptor is internally consistent: ratio = late/early, steps = reads − 1', () => {
  const r = assessNowcastMomentum(nc([P_ACC_3STEP]))
  const d = r.decisive
  assert.equal(d.latePaceCents / d.earlyPaceCents, d.paceRatio)
  assert.equal(d.absPaceChangePct, Math.abs(d.paceChangePct))
  assert.equal(d.steps, P_ACC_3STEP.values.length - 1)
  assert.equal(r.decisive, r.biggestMove)
  assert.equal(r.meta.basis, 'run-curvature')
})

// ── 20. status none when the nowcast did not project ─────────────────────────
test('non-projected nowcast ⇒ status none / no-nowcast', () => {
  for (const ncObj of [{ status: 'trending' }, { status: 'idle' }, { status: 'projected' }]) {
    const r = assessNowcastMomentum(ncObj)
    if (ncObj.status === 'projected') {
      // projected but no projections array ⇒ falls through to no-curvature, not no-nowcast
      assert.equal(r.reason, 'no-curvature')
    } else {
      assert.equal(r.status, 'none')
      assert.equal(r.reason, 'no-nowcast')
    }
  }
})

// ── 21. fail-safe on malformed input ─────────────────────────────────────────
test('malformed input degrades to status none and never throws', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}, { status: 'projected', projections: 'nope' }]) {
    const r = assessNowcastMomentum(bad)
    assert.equal(r.status, 'none')
    assert.equal(r.shape, 'indeterminate')
    assert.equal(r.meta.basis, 'run-curvature')
  }
})

// ── 22. leak-safety: no tenant/scope identifier ever appears ─────────────────
test('serialized output carries no client/tenant identifier (agency == client surface)', () => {
  const r = assessNowcastMomentum(nc([P_ACC_ADVERSE, P_DEC_GAIN, P_STEADY, P_ACC_4STEP]))
  const json = JSON.stringify(r)
  for (const tok of LEAK_TOKENS) assert.ok(!json.includes(tok), `leaked token ${tok}`)
})

// ── 23. determinism: identical inputs ⇒ identical output ─────────────────────
test('pure + deterministic: two identical calls are deep-equal', () => {
  const args = nc([P_ACC_GAIN, P_DEC_ADVERSE, P_STEADY_CPL, P_ACC_4STEP])
  assert.deepEqual(assessNowcastMomentum(args), assessNowcastMomentum(args))
})
