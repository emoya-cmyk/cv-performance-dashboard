'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  classifyEmphasisOutcome,
  tallyEmphasisEfficacy,
  controlRateOf,
  summarizeEmphasisEfficacy,
  narrateEmphasisEfficacy,
  efficacyOf,
  wilsonLower,
  medianOf,
  bandOf,
  stepScaleFor,
  scoreDirection,
  PRIOR_WEIGHT,
  NOTE_MIN_N,
  MIN_OUTCOME_VOTES,
  NOISE_BAND,
  STEP_SCALE_BASE,
  STEP_SCALE_MIN,
  STEP_SCALE_MAX,
} = require('../lib/briefEmphasisEfficacy')

// deep-freeze helper — proves the module never mutates its inputs
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

// ────────────────────────────────────────────────────────────────────────────
// classifyEmphasisOutcome — the per-decision scoring, with its asymmetric bets
// ────────────────────────────────────────────────────────────────────────────
test('20a — classifyEmphasisOutcome: widen succeeds when reception SUSTAINS (held or rose)', () => {
  // rose
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'widen', rate_before: 0.7, rate_after: 0.72, n_after: 10 }), {
    direction: 'widen',
    outcome: 'success',
    delta: 0.02,
  })
  // held within the noise band counts as sustained (delta -0.04 >= -0.05)
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'widen', rate_before: 0.7, rate_after: 0.66, n_after: 10 }), {
    direction: 'widen',
    outcome: 'success',
    delta: -0.04,
  })
  // a real drop is a failure (delta -0.2 < -0.05)
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'widen', rate_before: 0.8, rate_after: 0.6, n_after: 10 }), {
    direction: 'widen',
    outcome: 'failure',
    delta: -0.2,
  })
})

test('20a — classifyEmphasisOutcome: tighten succeeds only on a genuine RECOVERY (not a flat trim)', () => {
  // genuine rebound (delta +0.2 >= +0.05)
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'tighten', rate_before: 0.4, rate_after: 0.6, n_after: 10 }), {
    direction: 'tighten',
    outcome: 'success',
    delta: 0.2,
  })
  // barely moved → the trim did not recover reception (delta +0.02 < +0.05)
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'tighten', rate_before: 0.4, rate_after: 0.42, n_after: 10 }), {
    direction: 'tighten',
    outcome: 'failure',
    delta: 0.02,
  })
})

test('20a — classifyEmphasisOutcome: neutral mornings are the control (improved vs flat)', () => {
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'neutral', rate_before: 0.5, rate_after: 0.6, n_after: 10 }), {
    direction: 'neutral',
    outcome: 'improved',
    delta: 0.1,
  })
  assert.deepEqual(classifyEmphasisOutcome({ direction: 'neutral', rate_before: 0.5, rate_after: 0.51, n_after: 10 }), {
    direction: 'neutral',
    outcome: 'flat',
    delta: 0.01,
  })
})

test('20a — classifyEmphasisOutcome: abstains (pending) on thin votes, missing/out-of-range rates, unknown direction, junk', () => {
  // outcome not backed by enough votes
  assert.equal(
    classifyEmphasisOutcome({ direction: 'widen', rate_before: 0.7, rate_after: 0.72, n_after: MIN_OUTCOME_VOTES - 1 }).direction,
    'pending',
  )
  // missing rate_after
  assert.equal(classifyEmphasisOutcome({ direction: 'widen', rate_before: 0.7, rate_after: null, n_after: 10 }).direction, 'pending')
  // out-of-range rate
  assert.equal(classifyEmphasisOutcome({ direction: 'widen', rate_before: 1.4, rate_after: 0.7, n_after: 10 }).direction, 'pending')
  // unknown direction
  assert.equal(classifyEmphasisOutcome({ direction: 'sideways', rate_before: 0.5, rate_after: 0.6, n_after: 10 }).direction, 'pending')
  // junk never throws
  assert.equal(classifyEmphasisOutcome(null).direction, 'pending')
  assert.equal(classifyEmphasisOutcome(undefined).direction, 'pending')
  assert.equal(classifyEmphasisOutcome(42).direction, 'pending')
  assert.equal(classifyEmphasisOutcome([]).direction, 'pending')
  assert.equal(classifyEmphasisOutcome({}).direction, 'pending')
  const p = classifyEmphasisOutcome('nope')
  assert.deepEqual(p, { direction: 'pending', outcome: 'pending', delta: null })
})

// ────────────────────────────────────────────────────────────────────────────
// tally + control rate + shrinkage statistics
// ────────────────────────────────────────────────────────────────────────────
test('20a — tallyEmphasisEfficacy folds a mixed history into per-direction counts + control', () => {
  const obs = [
    { direction: 'widen', rate_before: 0.7, rate_after: 0.72, n_after: 10 }, // success
    { direction: 'widen', rate_before: 0.8, rate_after: 0.6, n_after: 10 }, // failure
    { direction: 'tighten', rate_before: 0.4, rate_after: 0.6, n_after: 10 }, // success
    { direction: 'neutral', rate_before: 0.5, rate_after: 0.6, n_after: 10 }, // improved
    { direction: 'neutral', rate_before: 0.5, rate_after: 0.5, n_after: 10 }, // flat
    { direction: 'widen', rate_before: 0.7, rate_after: 0.72, n_after: 1 }, // pending (thin) — ignored
  ]
  const t = tallyEmphasisEfficacy(obs)
  assert.equal(t.widen.successes, 1)
  assert.equal(t.widen.failures, 1)
  assert.equal(t.tighten.successes, 1)
  assert.equal(t.tighten.failures, 0)
  assert.equal(t.control.improved, 1)
  assert.equal(t.control.total, 2)
  // controlRateOf = improved/total
  assert.equal(controlRateOf(t.control), 0.5)
  assert.equal(controlRateOf({ improved: 0, total: 0 }), null)
  assert.equal(controlRateOf(null), null)
})

test('20a — shrinkage / Wilson / median / band match the efficacy.js house style', () => {
  // Beta-Bernoulli mean: (s + mean*K)/(n+K)
  assert.equal(efficacyOf(1, 5, 0.5, PRIOR_WEIGHT), 0.333) // 4/12
  assert.equal(efficacyOf(8, 0, 0.5, PRIOR_WEIGHT), 0.786) // 11/14
  assert.equal(efficacyOf(0, 0, 0.5, PRIOR_WEIGHT), 0.5) // no data → prior
  assert.equal(efficacyOf(3, 3, 0.5, PRIOR_WEIGHT), 0.5) // 6/12
  // Wilson 95% lower bound
  assert.equal(wilsonLower(8, 0), 0.676)
  assert.equal(wilsonLower(0, 0), 0)
  // median
  assert.equal(medianOf([0.1, 0.2, 0.3]), 0.2)
  assert.equal(medianOf([0.1, 0.2, 0.3, 0.4]), 0.25)
  assert.equal(medianOf([]), null)
  assert.equal(medianOf('nope'), null)
  // band edges
  assert.equal(bandOf(0.7), 'high')
  assert.equal(bandOf(0.66), 'high')
  assert.equal(bandOf(0.5), 'moderate')
  assert.equal(bandOf(0.4), 'moderate')
  assert.equal(bandOf(0.3), 'low')
  assert.equal(bandOf(null), 'unknown')
})

// ────────────────────────────────────────────────────────────────────────────
// summarize — the three earned verdicts, with exact learned step-scales
// ────────────────────────────────────────────────────────────────────────────
test('20a — summarize TEMPERS a widen that underperforms the control, and the agency hears why', () => {
  const obs = [
    // control: 3 improved of 6 → 0.5 baseline
    ...Array.from({ length: 3 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.6, n_after: 10 })),
    ...Array.from({ length: 3 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.5, n_after: 10 })),
    // widen: 1 sustained of 6 → efficacy 0.333, lift -0.167 → temper
    { direction: 'widen', rate_before: 0.7, rate_after: 0.72, n_after: 10 }, // success
    ...Array.from({ length: 5 }, () => ({ direction: 'widen', rate_before: 0.8, rate_after: 0.55, n_after: 10 })), // failures
  ]
  const s = summarizeEmphasisEfficacy(obs)
  assert.equal(s.status, 'graded')
  assert.equal(s.control_rate, 0.5)
  assert.equal(s.control_n, 6)
  assert.equal(s.prior, 0.5)
  assert.equal(s.directions.widen.n, 6)
  assert.equal(s.directions.widen.successes, 1)
  assert.equal(s.directions.widen.efficacy, 0.333)
  assert.equal(s.directions.widen.lift, -0.167)
  assert.equal(s.directions.tighten.n, 0)
  assert.equal(s.recommendation.verdict, 'tempered')
  assert.equal(s.recommendation.reason, 'widen_overserving')
  assert.equal(s.recommendation.widen_step_scale, 0.833) // clamp(1 - 0.167)
  assert.equal(s.recommendation.tighten_step_scale, STEP_SCALE_BASE) // no tighten evidence → unchanged
  assert.equal(
    narrateEmphasisEfficacy(s),
    "Widening hasn't paid off — when the brief carried more, reception sustained only 33% of the time (1 of 6), vs 50% when the brief held steady, so the loop is easing off (step ×0.833).",
  )
})

test('20a — summarize ENDORSES a tighten that beats the control with confidence (Wilson lower)', () => {
  const obs = [
    ...Array.from({ length: 3 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.6, n_after: 10 })),
    ...Array.from({ length: 3 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.5, n_after: 10 })),
    // tighten: 8 recoveries of 8 → efficacy 0.786, Wilson lower 0.676, lower_lift +0.176 → endorse
    ...Array.from({ length: 8 }, () => ({ direction: 'tighten', rate_before: 0.4, rate_after: 0.6, n_after: 10 })),
  ]
  const s = summarizeEmphasisEfficacy(obs)
  assert.equal(s.status, 'graded')
  assert.equal(s.directions.tighten.n, 8)
  assert.equal(s.directions.tighten.efficacy, 0.786)
  assert.equal(s.directions.tighten.lower, 0.676)
  assert.equal(s.directions.tighten.lower_lift, 0.176)
  assert.equal(s.recommendation.verdict, 'endorsed')
  assert.equal(s.recommendation.reason, 'tighten_recovering')
  assert.equal(s.recommendation.tighten_step_scale, 1.176) // clamp(1 + 0.176) within [1, 1.25]
  assert.equal(s.recommendation.widen_step_scale, STEP_SCALE_BASE)
  assert.equal(
    narrateEmphasisEfficacy(s),
    'Tightening is working — reception recovered 79% of the time after a trim (8 of 8), vs 50% when the brief held steady, so the loop is leaning in (step ×1.176).',
  )
})

test('20a — summarize holds STEADY when a direction performs in line with the control', () => {
  const obs = [
    ...Array.from({ length: 3 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.6, n_after: 10 })),
    ...Array.from({ length: 3 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.5, n_after: 10 })),
    // widen: 3 of 6 sustained → efficacy 0.5, lift 0 → steady
    ...Array.from({ length: 3 }, () => ({ direction: 'widen', rate_before: 0.7, rate_after: 0.74, n_after: 10 })),
    ...Array.from({ length: 3 }, () => ({ direction: 'widen', rate_before: 0.8, rate_after: 0.55, n_after: 10 })),
  ]
  const s = summarizeEmphasisEfficacy(obs)
  assert.equal(s.status, 'graded')
  assert.equal(s.directions.widen.efficacy, 0.5)
  assert.equal(s.directions.widen.lift, 0)
  assert.equal(s.recommendation.verdict, 'steady')
  assert.equal(s.recommendation.reason, 'in_line_with_control')
  assert.equal(s.recommendation.widen_step_scale, STEP_SCALE_BASE)
  assert.equal(
    narrateEmphasisEfficacy(s),
    'The reception loop is holding its calibration — widening and tightening are performing in line with holding steady, so the steps are unchanged.',
  )
})

test('20a — with no neutral control, the prior falls back to the pooled decided rate (control_rate null)', () => {
  const obs = [
    ...Array.from({ length: 2 }, () => ({ direction: 'widen', rate_before: 0.7, rate_after: 0.74, n_after: 10 })), // success
    ...Array.from({ length: 2 }, () => ({ direction: 'widen', rate_before: 0.8, rate_after: 0.55, n_after: 10 })), // failure
    ...Array.from({ length: 2 }, () => ({ direction: 'tighten', rate_before: 0.4, rate_after: 0.6, n_after: 10 })), // success
    ...Array.from({ length: 2 }, () => ({ direction: 'tighten', rate_before: 0.4, rate_after: 0.41, n_after: 10 })), // failure
  ]
  const s = summarizeEmphasisEfficacy(obs)
  assert.equal(s.control_rate, null)
  assert.equal(s.control_n, 0)
  assert.equal(s.prior, 0.5) // pooled 4/8
  assert.equal(s.recommendation.verdict, 'steady')
  // control-null narration omits the "vs X% when the brief held steady" clause
  assert.equal(narrateEmphasisEfficacy(s).includes('vs'), false)
})

// ────────────────────────────────────────────────────────────────────────────
// thin history + insufficient — honest abstention
// ────────────────────────────────────────────────────────────────────────────
test('20a — graded-but-thin history yields an honest insufficient verdict and a silent narrator', () => {
  const obs = [
    { direction: 'widen', rate_before: 0.7, rate_after: 0.74, n_after: 10 }, // success
    { direction: 'widen', rate_before: 0.8, rate_after: 0.55, n_after: 10 }, // failure
  ]
  const s = summarizeEmphasisEfficacy(obs)
  assert.equal(s.status, 'graded') // there IS a measured outcome…
  assert.ok(s.directions.widen.n < NOTE_MIN_N) // …but not enough to tune on
  assert.equal(s.recommendation.verdict, 'insufficient')
  assert.equal(s.recommendation.reason, 'thin_history')
  assert.equal(s.recommendation.widen_step_scale, STEP_SCALE_BASE)
  assert.equal(narrateEmphasisEfficacy(s), '') // silent until a direction earns NOTE_MIN_N
})

test('20a — no measurable outcomes → insufficient, base scales, silent', () => {
  for (const empty of [[], [null, 42, 'x', {}], [{ direction: 'widen', rate_before: 0.7, rate_after: 0.7, n_after: 1 }]]) {
    const s = summarizeEmphasisEfficacy(empty)
    assert.equal(s.status, 'insufficient')
    assert.equal(s.n, 0)
    assert.equal(s.recommendation.verdict, 'insufficient')
    assert.equal(s.recommendation.reason, 'no_measured_outcomes')
    assert.equal(s.recommendation.widen_step_scale, STEP_SCALE_BASE)
    assert.equal(s.recommendation.tighten_step_scale, STEP_SCALE_BASE)
    assert.equal(narrateEmphasisEfficacy(s), '')
  }
})

// ────────────────────────────────────────────────────────────────────────────
// stepScaleFor — the bounded knob, directly
// ────────────────────────────────────────────────────────────────────────────
test('20a — stepScaleFor is bounded, asymmetric, and abstains on thin evidence', () => {
  // thin evidence → unchanged
  assert.deepEqual(stepScaleFor({ n: 3, lift: -0.5, lower_lift: -0.5 }), { scale: STEP_SCALE_BASE, move: 'insufficient' })
  // deep underperformance is floored at STEP_SCALE_MIN (never zeroed out)
  assert.deepEqual(stepScaleFor({ n: 10, lift: -0.9, lower_lift: -0.9 }), { scale: STEP_SCALE_MIN, move: 'temper' })
  // strong confident overperformance is capped at STEP_SCALE_MAX
  assert.deepEqual(stepScaleFor({ n: 10, lift: 0.9, lower_lift: 0.9 }), { scale: STEP_SCALE_MAX, move: 'endorse' })
  // positive point lift but NOT confident (lower_lift below band) → no boost
  assert.deepEqual(stepScaleFor({ n: 10, lift: 0.2, lower_lift: 0.01 }), { scale: STEP_SCALE_BASE, move: 'steady' })
  assert.ok(typeof scoreDirection({ successes: 2, failures: 2, deltas: [0.1, -0.1] }, 0.5, PRIOR_WEIGHT).median_delta === 'number')
})

// ────────────────────────────────────────────────────────────────────────────
// client silence — UNCONDITIONAL, across every verdict
// ────────────────────────────────────────────────────────────────────────────
test('20a — narrateEmphasisEfficacy is silent for the CLIENT across every verdict', () => {
  const tempered = summarizeEmphasisEfficacy([
    ...Array.from({ length: 6 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.5, n_after: 10 })),
    ...Array.from({ length: 6 }, () => ({ direction: 'widen', rate_before: 0.8, rate_after: 0.55, n_after: 10 })),
  ])
  const endorsed = summarizeEmphasisEfficacy([
    ...Array.from({ length: 6 }, () => ({ direction: 'neutral', rate_before: 0.5, rate_after: 0.5, n_after: 10 })),
    ...Array.from({ length: 8 }, () => ({ direction: 'tighten', rate_before: 0.4, rate_after: 0.6, n_after: 10 })),
  ])
  for (const s of [tempered, endorsed]) {
    assert.notEqual(narrateEmphasisEfficacy(s, { audience: 'agency' }), '') // agency hears it
    assert.equal(narrateEmphasisEfficacy(s, { audience: 'client' }), '') // client never does
  }
})

// ────────────────────────────────────────────────────────────────────────────
// purity, idempotence, total tolerance of junk — the standing contract
// ────────────────────────────────────────────────────────────────────────────
test('20a — pure + idempotent: frozen inputs, identical repeated output, no mutation', () => {
  const obs = deepFreeze([
    { direction: 'neutral', rate_before: 0.5, rate_after: 0.6, n_after: 10 },
    { direction: 'widen', rate_before: 0.7, rate_after: 0.72, n_after: 10 },
    { direction: 'tighten', rate_before: 0.4, rate_after: 0.6, n_after: 10 },
  ])
  const opts = deepFreeze({ priorWeight: PRIOR_WEIGHT })
  const a = summarizeEmphasisEfficacy(obs, opts)
  const b = summarizeEmphasisEfficacy(obs, opts)
  assert.deepEqual(a, b) // deterministic
})

test('20a — never throws on junk arguments', () => {
  for (const junk of [null, undefined, 42, 'foo', {}, [null], [42, 'x'], { directions: 1 }]) {
    assert.doesNotThrow(() => summarizeEmphasisEfficacy(junk))
    assert.doesNotThrow(() => narrateEmphasisEfficacy(junk))
    assert.doesNotThrow(() => narrateEmphasisEfficacy(junk, { audience: 'client' }))
    assert.doesNotThrow(() => tallyEmphasisEfficacy(junk))
    assert.doesNotThrow(() => classifyEmphasisOutcome(junk))
  }
  // a malformed summary still narrates to '' rather than throwing
  assert.equal(narrateEmphasisEfficacy({ status: 'graded' }), '')
  assert.equal(narrateEmphasisEfficacy({ status: 'insufficient' }), '')
})

test('20a — NOISE_BAND boundary is treated as sustained for widen, not-recovered for tighten', () => {
  // exactly -NOISE_BAND: widen sustained (>=), tighten would be failure
  assert.equal(classifyEmphasisOutcome({ direction: 'widen', rate_before: 0.7, rate_after: 0.65, n_after: 10 }).outcome, 'success')
  // exactly +NOISE_BAND: tighten recovered (>=)
  assert.equal(
    classifyEmphasisOutcome({ direction: 'tighten', rate_before: 0.4, rate_after: 0.45, n_after: 10 }).outcome,
    'success',
  )
  // confirm the constant is the value the tests assume
  assert.equal(NOISE_BAND, 0.05)
})
