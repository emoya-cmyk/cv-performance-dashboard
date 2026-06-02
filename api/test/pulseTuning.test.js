'use strict'

// Tests for lib/pulseTuning.js — the feedback edge that closes the Daily Pulse loop:
// it reads pulseAccuracy's precision and returns the {warn, crit} the live dayPulse
// should use next, so a sensor that has PROVEN out earns a lighter trigger and a noisy
// one is held to a higher bar. The contract:
//   • CONTROLLER: factor = clamp(1 − GAIN·(precision − TARGET), MIN, MAX), applied to
//     BOTH warn and crit so the 2:3 shape is preserved; TARGET is the 'proven' floor
//     (0.70) so a sensor must climb ABOVE it to earn any loosening;
//   • MONOTONIC: higher precision ⇒ strictly lower factor ⇒ lower band ⇒ fires sooner;
//   • CENTERED: precision exactly TARGET ⇒ factor 1, direction 'neutral', band unchanged;
//   • BOUNDED: hard clamp [0.75, 1.5] — a pure safety rail that never binds for the
//     default GAIN but guarantees the band can't collapse or balloon under opts abuse;
//   • HONEST BY ABSTENTION: no track record (missing / not 'graded' / precision null /
//     NaN) ⇒ status:'default', factor 1, the CANONICAL band (2/3) returned unchanged —
//     provably a no-op against the live sensor;
//   • NON-CIRCULAR (by contract, enforced at the wiring layer): the precision handed in
//     is measured at the canonical band; this module's tuned band is for the live sensor
//     only and is never fed back into the audit — so the unit's job is just a stable,
//     bounded, monotonic map, which is what these tests pin;
//   • RATIO INVARIANT: warn/base_warn === crit/base_crit === factor (only sensitivity
//     shifts, never the warning/critical split);
//   • narratePulseTuning: one grounded agency sentence whose % is straight off `factor`;
//     '' for default/neutral/missing AND always for a client audience (tuning is internal
//     calibration — the client sees only its effect, never the machinery);
//   • PURE: a grade literal in, a band + descriptor out; never mutates, never throws.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  tunePulseThresholds,
  narratePulseTuning,
  BASE_WARN,
  BASE_CRIT,
  TARGET_PRECISION,
  GAIN,
  MIN_FACTOR,
  MAX_FACTOR,
} = require('../lib/pulseTuning')

// Build the slice of a pulseAccuracy grade this module actually reads. Mirrors the real
// return shape (status/precision/label) so a field rename upstream would break here too.
const gradedAcc = (precision, label = null) => ({ status: 'graded', precision, label })

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

// ----------------------------------------------------------------------------
// Canonical-band sanity
// ----------------------------------------------------------------------------
test('BASE_WARN/BASE_CRIT are the canonical 2/3 band (one definition, from baselines)', () => {
  assert.equal(BASE_WARN, 2)
  assert.equal(BASE_CRIT, 3)
  assert.equal(TARGET_PRECISION, 0.7)
  assert.equal(GAIN, 0.5)
  assert.equal(MIN_FACTOR, 0.75)
  assert.equal(MAX_FACTOR, 1.5)
})

// ----------------------------------------------------------------------------
// Abstention: no track record → the canonical band, unchanged (the no-op guarantee)
// ----------------------------------------------------------------------------
for (const [name, acc] of [
  ['null', null],
  ['undefined', undefined],
  ['insufficient status', { status: 'insufficient', precision: null }],
  ['graded but precision null', { status: 'graded', precision: null }],
  ['graded but precision NaN', { status: 'graded', precision: NaN }],
  ['graded but precision undefined', { status: 'graded' }],
]) {
  test(`abstains to the canonical band when acc is ${name}`, () => {
    const t = tunePulseThresholds(acc)
    assert.equal(t.status, 'default')
    assert.equal(t.reason, 'no_track_record')
    assert.equal(t.warn, BASE_WARN, 'warn unchanged')
    assert.equal(t.crit, BASE_CRIT, 'crit unchanged')
    assert.equal(t.base_warn, BASE_WARN)
    assert.equal(t.base_crit, BASE_CRIT)
    assert.equal(t.factor, 1)
    assert.equal(t.direction, 'neutral')
    assert.equal(t.precision, null)
    assert.equal(t.label, null)
  })
}

// ----------------------------------------------------------------------------
// Centered at the proven floor: exactly TARGET → neutral, band unchanged
// ----------------------------------------------------------------------------
test('precision exactly at TARGET (0.70) is neutral — band unchanged but status tuned', () => {
  const t = tunePulseThresholds(gradedAcc(0.7, 'proven'))
  assert.equal(t.status, 'tuned')
  assert.equal(t.factor, 1)
  assert.equal(t.direction, 'neutral')
  assert.equal(t.warn, BASE_WARN)
  assert.equal(t.crit, BASE_CRIT)
  assert.equal(t.precision, 0.7)
  assert.equal(t.label, 'proven')
})

// ----------------------------------------------------------------------------
// Sensitize above the floor: lower band, earned a lighter trigger
// ----------------------------------------------------------------------------
test('precision 0.80 → factor 0.95, band 1.9/2.85, direction sensitize', () => {
  const t = tunePulseThresholds(gradedAcc(0.8, 'proven'))
  assert.equal(t.status, 'tuned')
  assert.equal(t.factor, 0.95) // 1 − 0.5·(0.80 − 0.70)
  assert.equal(t.warn, 1.9)
  assert.equal(t.crit, 2.85)
  assert.equal(t.direction, 'sensitize')
})

test('precision 1.00 → factor 0.85, band 1.7/2.55 (max real loosening under default GAIN)', () => {
  const t = tunePulseThresholds(gradedAcc(1, 'proven'))
  assert.equal(t.factor, 0.85)
  assert.equal(t.warn, 1.7)
  assert.equal(t.crit, 2.55)
  assert.equal(t.direction, 'sensitize')
  assert.ok(t.factor > MIN_FACTOR, 'the clamp floor is a guardrail, not hit in practice')
})

// ----------------------------------------------------------------------------
// Tighten below the floor: higher band, more movement required
// ----------------------------------------------------------------------------
test('precision 0.50 → factor 1.1, band 2.2/3.3, direction tighten', () => {
  const t = tunePulseThresholds(gradedAcc(0.5, 'developing'))
  assert.equal(t.factor, 1.1)
  assert.equal(t.warn, 2.2)
  assert.equal(t.crit, 3.3)
  assert.equal(t.direction, 'tighten')
})

test('precision 0.00 → factor 1.35, band 2.7/4.05 (max real tightening under default GAIN)', () => {
  const t = tunePulseThresholds(gradedAcc(0, 'learning'))
  assert.equal(t.factor, 1.35)
  assert.equal(t.warn, 2.7)
  assert.equal(t.crit, 4.05)
  assert.equal(t.direction, 'tighten')
  assert.ok(t.factor < MAX_FACTOR, 'the clamp ceiling is a guardrail, not hit in practice')
})

// ----------------------------------------------------------------------------
// Monotonic: higher precision ⇒ strictly lower factor (and lower band)
// ----------------------------------------------------------------------------
test('factor is strictly decreasing in precision across a sweep', () => {
  const sweep = [0, 0.2, 0.4, 0.6, 0.7, 0.8, 1]
  const factors = sweep.map((p) => tunePulseThresholds(gradedAcc(p)).factor)
  for (let i = 1; i < factors.length; i++) {
    assert.ok(factors[i] < factors[i - 1], `factor(${sweep[i]})=${factors[i]} should be < factor(${sweep[i - 1]})=${factors[i - 1]}`)
  }
  // and the band moves with it
  const bands = sweep.map((p) => tunePulseThresholds(gradedAcc(p)).warn)
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i] < bands[i - 1], 'warn tracks factor')
  }
})

// ----------------------------------------------------------------------------
// Ratio invariant: the 2:3 warning/critical split is preserved at every precision
// ----------------------------------------------------------------------------
test('warn/base_warn === crit/base_crit === factor (only sensitivity shifts)', () => {
  for (const p of [0, 0.3, 0.5, 0.7, 0.85, 1]) {
    const t = tunePulseThresholds(gradedAcc(p))
    assert.ok(approx(t.warn / t.base_warn, t.factor, 1e-6), `warn ratio @${p}`)
    assert.ok(approx(t.crit / t.base_crit, t.factor, 1e-6), `crit ratio @${p}`)
    assert.ok(t.warn > 0 && t.crit > 0, 'band stays positive')
    assert.ok(t.warn < t.crit, 'warning stays below critical')
  }
})

// ----------------------------------------------------------------------------
// Clamp guardrails: a pathological gain can't collapse or balloon the band
// ----------------------------------------------------------------------------
test('extreme gain + perfect precision clamps to MIN_FACTOR (band still positive, warn<crit)', () => {
  const t = tunePulseThresholds(gradedAcc(1), { gain: 10 }) // raw = 1 − 10·0.3 = −2
  assert.equal(t.factor, MIN_FACTOR)
  assert.equal(t.warn, 1.5)
  assert.equal(t.crit, 2.25)
  assert.ok(t.warn > 0 && t.warn < t.crit)
  assert.equal(t.direction, 'sensitize')
})

test('extreme gain + zero precision clamps to MAX_FACTOR', () => {
  const t = tunePulseThresholds(gradedAcc(0), { gain: 10 }) // raw = 1 − 10·(−0.7) = 8
  assert.equal(t.factor, MAX_FACTOR)
  assert.equal(t.warn, 3)
  assert.equal(t.crit, 4.5)
  assert.equal(t.direction, 'tighten')
})

// ----------------------------------------------------------------------------
// Defensive precision clamp: out-of-range precision is pinned to [0,1]
// ----------------------------------------------------------------------------
test('precision > 1 is treated as 1 (factor 0.85); precision < 0 is treated as 0 (factor 1.35)', () => {
  assert.equal(tunePulseThresholds(gradedAcc(1.5)).factor, 0.85)
  assert.equal(tunePulseThresholds(gradedAcc(-0.5)).factor, 1.35)
})

// ----------------------------------------------------------------------------
// Label echo: the (5) chain vocabulary rides through unchanged
// ----------------------------------------------------------------------------
test('label echoes acc.label so the surface vocabulary matches accuracyLabel', () => {
  assert.equal(tunePulseThresholds(gradedAcc(0.9, 'proven')).label, 'proven')
  assert.equal(tunePulseThresholds(gradedAcc(0.55, 'developing')).label, 'developing')
  assert.equal(tunePulseThresholds(gradedAcc(0.2, 'learning')).label, 'learning')
  assert.equal(tunePulseThresholds(gradedAcc(0.9)).label, null) // missing upstream label → null
})

// ----------------------------------------------------------------------------
// opts overrides: custom canonical band, target, and gain
// ----------------------------------------------------------------------------
test('baseWarn/baseCrit override scales the tuned band from a custom canonical band', () => {
  const t = tunePulseThresholds(gradedAcc(0.8), { baseWarn: 1.5, baseCrit: 2.5 }) // factor 0.95
  assert.equal(t.base_warn, 1.5)
  assert.equal(t.base_crit, 2.5)
  assert.equal(t.warn, 1.425) // 1.5 · 0.95
  assert.equal(t.crit, 2.375) // 2.5 · 0.95
  assert.ok(approx(t.warn / t.base_warn, 0.95, 1e-6))
})

test('target override moves the neutral point', () => {
  // with target 0.5, a precision of exactly 0.5 is neutral …
  const neutral = tunePulseThresholds(gradedAcc(0.5), { target: 0.5 })
  assert.equal(neutral.factor, 1)
  assert.equal(neutral.direction, 'neutral')
  // … and 0.6 now earns loosening (it would have tightened against the 0.70 default)
  const sens = tunePulseThresholds(gradedAcc(0.6), { target: 0.5 })
  assert.equal(sens.factor, 0.95) // 1 − 0.5·(0.6 − 0.5)
  assert.equal(sens.direction, 'sensitize')
})

test('gain override changes aggressiveness but stays bounded', () => {
  const gentle = tunePulseThresholds(gradedAcc(1), { gain: 0.1 }) // 1 − 0.1·0.3 = 0.97
  assert.equal(gentle.factor, 0.97)
  // a sharp gain drives the raw factor below the safety floor (1 − 1·0.3 = 0.70),
  // so MIN_FACTOR (0.75) clamps it — aggressiveness is bounded, never unbounded
  const sharp = tunePulseThresholds(gradedAcc(1), { gain: 1 })
  assert.equal(sharp.factor, 0.75)
})

// ----------------------------------------------------------------------------
// narratePulseTuning
// ----------------------------------------------------------------------------
test('narratePulseTuning: sensitize sentence carries the right %, label, and earned framing', () => {
  const t = tunePulseThresholds(gradedAcc(0.8, 'proven')) // factor 0.95 → 5%
  const s = narratePulseTuning(t, { label: 'Leads' })
  assert.match(s, /^Leads early-warnings here have proven out/)
  assert.match(s, /about 5% less movement/)
  assert.match(s, /earned a lighter trigger/)
})

test('narratePulseTuning: tighten sentence carries the right %, and the fewer-false-alarms framing', () => {
  const t = tunePulseThresholds(gradedAcc(0.5, 'developing')) // factor 1.1 → 10%
  const s = narratePulseTuning(t, { label: 'Spend' })
  assert.match(s, /^Spend early-warnings here have been mixed/)
  assert.match(s, /about 10% more movement/)
  assert.match(s, /fewer false alarms/)
})

test('narratePulseTuning: silent for default, neutral, missing, and sub-1% moves', () => {
  assert.equal(narratePulseTuning(tunePulseThresholds(null)), '') // default
  assert.equal(narratePulseTuning(tunePulseThresholds(gradedAcc(0.7))), '') // neutral
  assert.equal(narratePulseTuning(null), '')
  assert.equal(narratePulseTuning(undefined), '')
  // sub-1% move (custom tiny gain) rounds to nothing worth a sentence, even though tuned
  const tiny = tunePulseThresholds(gradedAcc(1), { gain: 0.01 }) // factor 0.997 → 0.3%
  assert.equal(tiny.direction, 'sensitize')
  assert.equal(narratePulseTuning(tiny), '')
})

test('narratePulseTuning: ALWAYS silent for a client audience (internal calibration)', () => {
  const t = tunePulseThresholds(gradedAcc(0.8, 'proven')) // a real sensitize adjustment
  assert.notEqual(narratePulseTuning(t, { label: 'Leads' }), '', 'agency hears it')
  assert.equal(narratePulseTuning(t, { label: 'Leads', audience: 'client' }), '', 'client never does')
})

test('narratePulseTuning: default label is generic when none supplied', () => {
  const t = tunePulseThresholds(gradedAcc(0.8))
  assert.match(narratePulseTuning(t), /^These early-warnings here have proven out/)
})

// ----------------------------------------------------------------------------
// Purity: the input grade is never mutated
// ----------------------------------------------------------------------------
test('does not mutate the grade it is handed', () => {
  const acc = gradedAcc(0.8, 'proven')
  const snapshot = JSON.stringify(acc)
  tunePulseThresholds(acc)
  assert.equal(JSON.stringify(acc), snapshot)
})
