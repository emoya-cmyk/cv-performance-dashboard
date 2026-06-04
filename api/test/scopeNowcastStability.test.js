'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assessNowcastStability } = require('../lib/scopeNowcastStability')
const { assessNowcastMomentum } = require('../lib/scopeNowcastMomentum')

// ── fixtures ────────────────────────────────────────────────────────────────
// Each projection carries `values` = the run's read sequence (oldest → newest). Stability measures
// the dispersion of the step magnitudes (in cents) relative to their mean — the coefficient of
// variation, CV = stdev/mean (population stdev, ÷n) — and classifies the run:
//
//   smooth   ⟺ CV ≤ smoothMaxCv   (default 0.25)
//   choppy   ⟺ CV ≥ choppyMinCv   (default 0.60)
//   variable ⟺ otherwise
//
// It requires ≥4 reads (≥3 steps); on a 2-step run CV is a monotone function of D10's pace ratio, so
// D11 stays silent there rather than re-stating momentum.

// smooth gain: 3 steps, mags 1000,1000,1000 ⇒ mean 1000, stdev 0, CV 0
const P_SMOOTH = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 120, 130] }
// smooth adverse, distinct metric: 3 steps, mags 500,500,500 ⇒ CV 0 (cpl rising evenly)
const P_SMOOTH_CPL = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [50, 55, 60, 65] }
// choppy gain: 4 steps, mags 1000,9000,1000,9000 ⇒ mean 5000, stdev 4000, CV 0.8.
//   NOTE: D10 reads this STEADY (early mean = late mean = 5000, ratio 1.0) — the orthogonality proof.
const P_CHOPPY = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 200, 210, 300] }
// choppy adverse: 4 steps, mags 1000,9000,1000,9000 ⇒ CV 0.8 (cpl rising in jumps) — to prove the
//   note is direction-NEUTRAL (same wording as the choppy gain).
const P_CHOPPY_ADVERSE = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [50, 60, 150, 160, 250] }
// variable gain: 4 steps, mags 1000,2000,1000,2000 ⇒ mean 1500, stdev 500, CV = 1/3 ≈ 0.333
const P_VARIABLE = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 130, 140, 160] }
// variable, distinct metric: 4 steps, mags 500,1000,500,1000 ⇒ mean 750, stdev 250, CV = 1/3
const P_VARIABLE_CPL = { metric: 'cpl', metric_label: 'Cost per lead', direction: 'up', improving: false, values: [50, 55, 65, 70, 80] }
// variable at the MINIMUM length: exactly 3 steps, mags 1000,2000,1500 ⇒ mean 1500, stdev ≈408.25,
//   CV ≈ 0.2722 (just above smoothMax 0.25 ⇒ variable)
const P_VARIABLE_3STEP = { metric: 'leads', metric_label: 'Leads', direction: 'up', improving: true, values: [100, 110, 130, 145] }
// accelerating BUT smooth: 4 steps, mags 1000,1100,1300,1400 ⇒ D10 ratio 1350/1050 ≈ 1.286 (accel),
//   D11 mean 1200, stdev ≈158.1, CV ≈ 0.132 (smooth) — orthogonality the OTHER way.
const P_ACC_BUT_SMOOTH = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 121, 134, 148] }
// two steps only (3 reads): below the ≥3-step floor ⇒ NOT measurable (would only re-state D10)
const P_TWO_STEP = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 130] }
// one step only (2 reads): not measurable
const P_SHORT = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110] }
// a non-finite read anywhere ⇒ not measurable (length is fine: 4 reads)
const P_NONFINITE = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 'x', 130] }
// all-equal reads ⇒ every step 0 ⇒ zero mean step ⇒ excluded (cannot occur in a real run; guarded)
const P_FLAT = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 100, 100, 100] }
// choppy run scaled ×10 ⇒ identical CV (scale invariance): mags 10000,90000,10000,90000 ⇒ CV 0.8
const P_CHOPPY_X10 = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [1000, 1100, 2000, 2100, 3000] }

const nc = (projections) => ({ status: 'projected', projections })

const LEAK_TOKENS = ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId', '"7"']

// ── 1. smooth ⇒ the single projected number is on FIRM FOOTING ────────────────
test('smooth run ⇒ level smooth, note affirms the projection rests on firm footing', () => {
  const r = assessNowcastStability(nc([P_SMOOTH]))
  assert.equal(r.status, 'assessed')
  assert.equal(r.level, 'smooth')
  assert.equal(r.assessedCount, 1)
  assert.equal(r.smoothCount, 1)
  assert.equal(r.variableCount, 0)
  assert.equal(r.choppyCount, 0)
  assert.equal(r.decisive.metric, 'revenue')
  assert.equal(r.decisive.cv, 0)
  assert.equal(r.decisive.cvPct, 0)
  assert.equal(r.smoothMaxCv, 0.25)
  assert.equal(r.choppyMinCv, 0.6)
  assert.ok(r.note.includes('Revenue'))
  assert.ok(r.note.includes('evenly sized'))
  assert.ok(r.note.includes('firm footing'))
})

// ── 2. choppy ⇒ read the projection as a ROUGH CENTER, not a target ──────────
test('choppy run ⇒ level choppy, note warns to read the projection as a rough center', () => {
  const r = assessNowcastStability(nc([P_CHOPPY]))
  assert.equal(r.level, 'choppy')
  assert.equal(r.choppyCount, 1)
  assert.equal(r.decisive.cv, 0.8)
  assert.equal(r.decisive.cvPct, 80)
  assert.equal(r.decisive.steps, 4)
  assert.ok(r.note.includes('Revenue'))
  assert.ok(r.note.includes('uneven'))
  assert.ok(r.note.includes('rough center'))
})

// ── 3. variable ⇒ reasonable but NOT PINPOINT ────────────────────────────────
test('variable run ⇒ level variable, note says reasonable but not pinpoint', () => {
  const r = assessNowcastStability(nc([P_VARIABLE]))
  assert.equal(r.level, 'variable')
  assert.equal(r.variableCount, 1)
  assert.ok(Math.abs(r.decisive.cv - 1 / 3) < 1e-9)
  assert.ok(r.note.includes('Revenue'))
  assert.ok(r.note.includes('vary in size'))
  assert.ok(r.note.includes('not pinpoint'))
})

// ── 4. polarity-NEUTRAL: a choppy adverse move reads the same as a choppy gain ─
test('jitter is direction-neutral ⇒ choppy adverse note matches choppy gain (no good/bad framing)', () => {
  const gain = assessNowcastStability(nc([P_CHOPPY]))
  const adverse = assessNowcastStability(nc([P_CHOPPY_ADVERSE]))
  assert.equal(gain.level, 'choppy')
  assert.equal(adverse.level, 'choppy')
  assert.equal(adverse.decisive.improving, false)
  // same reliability wording on both polarities…
  assert.ok(adverse.note.includes('uneven'))
  assert.ok(adverse.note.includes('rough center'))
  // …and NONE of D10's polarity-branched vocabulary leaks in.
  for (const word of ['compounding', 'understate', 'overstate', 'easing', 'leveling']) {
    assert.ok(!gain.note.includes(word), `smoothness note must not say "${word}"`)
    assert.ok(!adverse.note.includes(word), `smoothness note must not say "${word}"`)
  }
})

// ── 5. smooth with null polarity ⇒ still a clean smooth note ──────────────────
test('smooth run with unknown polarity ⇒ smooth note (polarity plays no role)', () => {
  const p = { metric: 'sessions', metric_label: 'Sessions', direction: 'up', improving: null, values: [100, 110, 120, 130] }
  const r = assessNowcastStability(nc([p]))
  assert.equal(r.level, 'smooth')
  assert.equal(r.decisive.improving, null)
  assert.ok(r.note.includes('firm footing'))
})

// ── 6. measurable at the MINIMUM length (exactly 3 steps) ─────────────────────
test('a 3-step run is measurable (the ≥3-step floor is inclusive)', () => {
  const r = assessNowcastStability(nc([P_VARIABLE_3STEP]))
  assert.equal(r.status, 'assessed')
  assert.equal(r.decisive.steps, 3)
  assert.equal(r.level, 'variable')
  assert.ok(r.decisive.cv > 0.25 && r.decisive.cv < 0.6)
})

// ── 7. ORTHOGONALITY vs D10 — the whole reason D11 exists ─────────────────────
test('D11 is independent of D10: choppy where D10 is steady, smooth where D10 accelerates', () => {
  // +1000,+9000,+1000,+9000 cents: identical early/late pace ⇒ D10 STEADY, but huge scatter ⇒ D11 CHOPPY
  const mo1 = assessNowcastMomentum(nc([P_CHOPPY]))
  const st1 = assessNowcastStability(nc([P_CHOPPY]))
  assert.equal(mo1.shape, 'steady')
  assert.equal(st1.level, 'choppy')

  // gently ramping pace with tight scatter ⇒ D10 ACCELERATING, but evenly sized ⇒ D11 SMOOTH
  const mo2 = assessNowcastMomentum(nc([P_ACC_BUT_SMOOTH]))
  const st2 = assessNowcastStability(nc([P_ACC_BUT_SMOOTH]))
  assert.equal(mo2.shape, 'accelerating')
  assert.equal(st2.level, 'smooth')
})

// ── 8. decisive = the JUMPIEST run (highest CV) sets the level + is the headline ─
test('mixed basket ⇒ the jumpiest run sets the overall level and is the headline mover', () => {
  const r = assessNowcastStability(nc([P_SMOOTH_CPL, P_CHOPPY])) // cpl smooth (CV 0), revenue choppy (CV 0.8)
  assert.equal(r.assessedCount, 2)
  assert.equal(r.smoothCount, 1)
  assert.equal(r.choppyCount, 1)
  assert.equal(r.level, 'choppy')
  assert.equal(r.decisive.metric, 'revenue') // 0.8 CV > 0 CV
  assert.equal(r.jumpiest, r.decisive) // same move: the jumpiest run is the headline
})

// ── 9. tie on CV ⇒ the more salient (earlier) projection wins ─────────────────
test('equal CV ⇒ first (more salient) projection is decisive', () => {
  // P_VARIABLE (revenue) and P_VARIABLE_CPL (cpl) both have CV = 1/3
  const revFirst = assessNowcastStability(nc([P_VARIABLE, P_VARIABLE_CPL]))
  assert.equal(revFirst.decisive.metric, 'revenue')
  const cplFirst = assessNowcastStability(nc([P_VARIABLE_CPL, P_VARIABLE]))
  assert.equal(cplFirst.decisive.metric, 'cpl')
})

// ── 10. counts tally every measured level ─────────────────────────────────────
test('counts reflect each measured projection by level', () => {
  const r = assessNowcastStability(nc([P_SMOOTH, P_VARIABLE_CPL, P_VARIABLE_3STEP]))
  // three DISTINCT metrics: revenue (smooth), cpl (variable), leads (variable)
  assert.equal(r.assessedCount, 3)
  assert.equal(r.smoothCount, 1)
  assert.equal(r.variableCount, 2)
  assert.equal(r.choppyCount, 0)
  assert.equal(r.level, 'variable') // jumpiest is one of the variable runs
})

// ── 11. band overrides shift the smooth/choppy thresholds ─────────────────────
test('opts.smoothMaxCv / opts.choppyMinCv override the bands; an inverted override falls back', () => {
  const dflt = assessNowcastStability(nc([P_VARIABLE])) // CV 1/3
  assert.equal(dflt.level, 'variable')
  assert.equal(dflt.smoothMaxCv, 0.25)
  assert.equal(dflt.choppyMinCv, 0.6)
  // lower the choppy floor under 1/3 ⇒ now choppy
  const choppyNow = assessNowcastStability(nc([P_VARIABLE]), { choppyMinCv: 0.3 })
  assert.equal(choppyNow.level, 'choppy')
  assert.equal(choppyNow.choppyMinCv, 0.3)
  // raise the smooth ceiling above 1/3 ⇒ now smooth
  const smoothNow = assessNowcastStability(nc([P_VARIABLE]), { smoothMaxCv: 0.4 })
  assert.equal(smoothNow.level, 'smooth')
  assert.equal(smoothNow.smoothMaxCv, 0.4)
  // inverted thresholds (smoothMax ≥ choppyMin) revert BOTH to defaults
  const inverted = assessNowcastStability(nc([P_VARIABLE]), { smoothMaxCv: 0.7 })
  assert.equal(inverted.smoothMaxCv, 0.25)
  assert.equal(inverted.choppyMinCv, 0.6)
  assert.equal(inverted.level, 'variable')
  // non-positive / non-numeric overrides fall back to defaults
  assert.equal(assessNowcastStability(nc([P_VARIABLE]), { smoothMaxCv: 0 }).smoothMaxCv, 0.25)
  assert.equal(assessNowcastStability(nc([P_VARIABLE]), { choppyMinCv: 'x' }).choppyMinCv, 0.6)
})

// ── 12. dedup by metric id (first wins) ───────────────────────────────────────
test('duplicate metric id is measured once (first occurrence wins)', () => {
  // same metric 'revenue' but the second is CHOPPY — if dedup picked the second, level would flip;
  // asserting smooth proves the first (P_SMOOTH) occurrence won.
  const dupe = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, values: [100, 110, 200, 210, 300] }
  const r = assessNowcastStability(nc([P_SMOOTH, dupe]))
  assert.equal(r.assessedCount, 1)
  assert.equal(r.decisive.metric, 'revenue')
  assert.equal(r.level, 'smooth')
})

// ── 13. a 2-step run is NOT measurable ⇒ D11 stays silent (no re-stating D10) ──
test('a 2-step run is below the floor ⇒ status none / no-dispersion', () => {
  const r = assessNowcastStability(nc([P_TWO_STEP]))
  assert.equal(r.status, 'none')
  assert.equal(r.reason, 'no-dispersion')
  assert.equal(r.level, 'indeterminate')
  assert.equal(r.assessedCount, 0)
  assert.equal(r.decisive, null)
  assert.equal(r.jumpiest, null)
  assert.equal(r.note, null)
})

// ── 14. a 1-step run is not measurable ─────────────────────────────────────────
test('only too-short runs ⇒ status none / no-dispersion', () => {
  assert.equal(assessNowcastStability(nc([P_SHORT])).reason, 'no-dispersion')
  assert.equal(assessNowcastStability(nc([])).reason, 'no-dispersion')
})

// ── 15. non-finite read ⇒ that projection is excluded ─────────────────────────
test('a non-finite read makes a projection unmeasurable (excluded)', () => {
  assert.equal(assessNowcastStability(nc([P_NONFINITE])).reason, 'no-dispersion')
  // …but a measurable sibling still carries the verdict
  const r = assessNowcastStability(nc([P_NONFINITE, P_CHOPPY]))
  assert.equal(r.assessedCount, 1)
  assert.equal(r.decisive.metric, 'revenue')
  assert.equal(r.level, 'choppy')
})

// ── 16. zero mean step ⇒ excluded, never divides by zero ──────────────────────
test('an all-flat run (mean step 0) is excluded, never divides by zero', () => {
  assert.equal(assessNowcastStability(nc([P_FLAT])).reason, 'no-dispersion')
})

// ── 17. mixed measurable + unmeasurable ⇒ only the measurable counts ──────────
test('mixed run lengths ⇒ assessedCount counts only the dispersion-measurable runs', () => {
  const r = assessNowcastStability(nc([P_TWO_STEP, P_CHOPPY, P_NONFINITE]))
  assert.equal(r.assessedCount, 1)
  assert.equal(r.level, 'choppy')
})

// ── 18. CV is scale-invariant ⇒ a run ×10 reads the same level ────────────────
test('CV is scale-invariant: the same run scaled ×10 yields an identical CV and level', () => {
  const a = assessNowcastStability(nc([P_CHOPPY]))
  const b = assessNowcastStability(nc([P_CHOPPY_X10]))
  assert.equal(a.decisive.cv, b.decisive.cv)
  assert.equal(a.level, b.level)
  assert.equal(b.decisive.cv, 0.8)
})

// ── 19. internal consistency of the decisive descriptor ───────────────────────
test('decisive descriptor is internally consistent: CV = stdev/mean, cvPct = CV×100, steps = reads − 1', () => {
  const r = assessNowcastStability(nc([P_VARIABLE]))
  const d = r.decisive
  assert.ok(Math.abs(d.cv - d.stdevStepCents / d.meanStepCents) < 1e-12)
  assert.equal(d.cvPct, d.cv * 100)
  assert.equal(d.steps, P_VARIABLE.values.length - 1)
  assert.equal(r.decisive, r.jumpiest)
  assert.equal(r.meta.basis, 'step-dispersion')
})

// ── 20. status none when the nowcast did not project ──────────────────────────
test('non-projected nowcast ⇒ status none / no-nowcast', () => {
  for (const ncObj of [{ status: 'trending' }, { status: 'idle' }, { status: 'projected' }]) {
    const r = assessNowcastStability(ncObj)
    if (ncObj.status === 'projected') {
      // projected but no projections array ⇒ falls through to no-dispersion, not no-nowcast
      assert.equal(r.reason, 'no-dispersion')
    } else {
      assert.equal(r.status, 'none')
      assert.equal(r.reason, 'no-nowcast')
    }
  }
})

// ── 21. fail-safe on malformed input ──────────────────────────────────────────
test('malformed input degrades to status none and never throws', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}, { status: 'projected', projections: 'nope' }]) {
    const r = assessNowcastStability(bad)
    assert.equal(r.status, 'none')
    assert.equal(r.level, 'indeterminate')
    assert.equal(r.meta.basis, 'step-dispersion')
  }
})

// ── 22. leak-safety: no tenant/scope identifier ever appears ──────────────────
test('serialized output carries no client/tenant identifier (agency == client surface)', () => {
  const r = assessNowcastStability(nc([P_SMOOTH, P_CHOPPY, P_VARIABLE_CPL, P_VARIABLE_3STEP]))
  const json = JSON.stringify(r)
  for (const tok of LEAK_TOKENS) assert.ok(!json.includes(tok), `leaked token ${tok}`)
})

// ── 23. determinism: identical inputs ⇒ identical output ──────────────────────
test('pure + deterministic: two identical calls are deep-equal', () => {
  const args = nc([P_SMOOTH, P_CHOPPY, P_VARIABLE_CPL, P_VARIABLE_3STEP])
  assert.deepEqual(assessNowcastStability(args), assessNowcastStability(args))
})
