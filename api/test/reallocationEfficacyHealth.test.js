'use strict'

// ============================================================================
// test/reallocationEfficacyHealth.test.js — intel-v10 Layer 26a unit tests.
// Proves the reallocation-calibration watchdog (lib/reallocationEfficacyHealth.js)
// classifies the Layer-25 calibration FACTOR series correctly across every state,
// honours the precedence order, tolerates the three input shapes, stays pure, and
// keeps the narrator silent to clients UNCONDITIONALLY. This is the pure-module half
// of the cadence (26a); 26b wires the verdict + gatedFactor() into the engine, 26c
// surfaces it on the agency Intelligence view, 26d proves none of it reaches a client.
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  assessReallocationEfficacyHealth,
  narrateReallocationEfficacyHealth,
  shouldDistrustCalibration,
  gatedFactor,
  CAL_MIN,
  CAL_MAX,
  NEUTRAL,
  DEFAULT_WINDOW,
  DEFAULT_OSCILLATION_FLIPS,
  DEFAULT_SATURATION_RUNS,
  DEFAULT_SETTLED_RUN,
  DEFAULT_MIN_HISTORY,
  DEFAULT_CRED_FLOOR,
  VALID_DIRS,
} = require('../lib/reallocationEfficacyHealth')

// A bare Layer-25 calibrationOf() result. Extra fields (hit_rate, mean_confidence,
// basis) are deliberately present to prove the watchdog ignores everything but
// factor / credibility / n / as_of.
function cal(factor, credibility = 0.8, as_of = null, n = 10) {
  return {
    factor,
    credibility,
    n,
    as_of,
    hit_rate: 0.5,
    mean_confidence: 0.5,
    basis: 'synthetic test row',
  }
}

// Build an oldest→newest series of bare results with a shared credibility.
function series(factors, credibility = 0.8) {
  return factors.map((f, i) => cal(f, credibility, `2026-05-${String(10 + i).padStart(2, '0')}`))
}

const FORBIDDEN_NARRATION = /factor|calibration|\bcpo\b|flip|vindicat|refut|hit_rate|credibility|saturat|oscillat|distrust|review_bounds|await_evidence|stability_score/i

// ---------------------------------------------------------------------------
// Constants are sane and the band is the Layer-25 band.
// ---------------------------------------------------------------------------
test('26a — exported constants match the Layer-25 clamp band and the precedence knobs', () => {
  assert.equal(CAL_MIN, 0.5)
  assert.equal(CAL_MAX, 1.2)
  assert.equal(NEUTRAL, 1)
  assert.equal(DEFAULT_WINDOW, 6)
  assert.equal(DEFAULT_OSCILLATION_FLIPS, 2)
  assert.equal(DEFAULT_SATURATION_RUNS, 3)
  assert.equal(DEFAULT_SETTLED_RUN, 2)
  assert.equal(DEFAULT_MIN_HISTORY, 2)
  assert.equal(DEFAULT_CRED_FLOOR, 0.25)
  assert.deepEqual(VALID_DIRS, ['embolden', 'damp', 'hold'])
})

// ---------------------------------------------------------------------------
// (0) ABSTAINED — too little history to judge a control loop's stability.
// ---------------------------------------------------------------------------
test('26a — abstains below minHistory: empty, single, and all-unusable inputs', () => {
  for (const input of [[], [cal(0.9)], null, undefined, 'nope', 42, {}]) {
    const v = assessReallocationEfficacyHealth(input)
    assert.equal(v.status, 'abstained', `input ${JSON.stringify(input)} should abstain`)
    assert.equal(v.recommended_action, 'none')
    assert.equal(v.verdict_reason, 'insufficient_history')
    assert.deepEqual(v.bounds, { min: 0.5, max: 1.2, neutral: 1 })
  }
})

test('26a — entries with no usable factor are dropped before the count', () => {
  // Two junk entries + one real factor = 1 usable → still abstains (minHistory 2).
  const v = assessReallocationEfficacyHealth([{ credibility: 0.9 }, { factor: 'NaN' }, cal(0.8)])
  assert.equal(v.status, 'abstained')
  assert.equal(v.history_len, 1) // only the one real factor survived normalization
})

// ---------------------------------------------------------------------------
// (1) UNSTABLE — hunting. The load-bearing self-healing signal.
// ---------------------------------------------------------------------------
test('26a — a factor swinging up/down/up is hunting → unstable/distrust', () => {
  const v = assessReallocationEfficacyHealth(series([1.0, 1.15, 0.85, 1.15]))
  assert.equal(v.status, 'unstable')
  assert.equal(v.recommended_action, 'distrust')
  assert.equal(v.verdict_reason, 'calibration_hunting')
  assert.equal(v.calibration.flips, 2)
  assert.ok(shouldDistrustCalibration(v), 'hunting must trip the engine self-heal hook')
})

test('26a — hunting OUTRANKS a rail: thrash that ends pinned still reads unstable', () => {
  // 0.5 → 1.2 → 0.5 → 1.2 : steps up,down,up = 2 flips; ends on the 1.2 ceiling.
  const v = assessReallocationEfficacyHealth(series([0.5, 1.2, 0.5, 1.2]))
  assert.equal(v.status, 'unstable', 'thrash must win over the trailing rail')
  assert.equal(v.calibration.flips, 2)
  assert.equal(v.calibration.high_run, 1) // it IS on the ceiling, but thrash dominates
})

test('26a — a single direction change is NOT yet hunting (one flip < threshold)', () => {
  // up then down = 1 flip < 2 → not unstable; still moving → settling.
  const v = assessReallocationEfficacyHealth(series([1.0, 1.1, 0.9]))
  assert.equal(v.calibration.flips, 1)
  assert.notEqual(v.status, 'unstable')
})

// ---------------------------------------------------------------------------
// (2) CONSTRAINED — pinned at a genuine clamp rail. Advisory.
// ---------------------------------------------------------------------------
test('26a — a factor crushed against the embolden ceiling → constrained/pinned_high', () => {
  const v = assessReallocationEfficacyHealth(series([1.0, 1.2, 1.2, 1.2]))
  assert.equal(v.status, 'constrained')
  assert.equal(v.recommended_action, 'review_bounds')
  assert.equal(v.verdict_reason, 'pinned_high')
  assert.equal(v.calibration.high_run, 3)
  assert.equal(v.calibration.flips, 0)
})

test('26a — a factor crushed against the damp floor → constrained/pinned_low', () => {
  const v = assessReallocationEfficacyHealth(series([1.0, 0.5, 0.5, 0.5]))
  assert.equal(v.status, 'constrained')
  assert.equal(v.verdict_reason, 'pinned_low')
  assert.equal(v.calibration.low_run, 3)
})

test('26a — pinned OUTRANKS starved: a rail with thin evidence still reads constrained', () => {
  // factor pinned high but credibility near zero — pinned is checked first.
  const v = assessReallocationEfficacyHealth(series([1.2, 1.2, 1.2], 0.05))
  assert.equal(v.status, 'constrained')
  assert.equal(v.verdict_reason, 'pinned_high')
})

test('26a — a 2-run rail under the 3-run threshold is NOT yet constrained', () => {
  const v = assessReallocationEfficacyHealth(series([1.0, 1.2, 1.2]))
  assert.equal(v.calibration.high_run, 2)
  assert.notEqual(v.status, 'constrained')
})

// ---------------------------------------------------------------------------
// (3) STARVED — quiet for lack of resolved trials, not confirmed calibration.
// ---------------------------------------------------------------------------
test('26a — a near-neutral factor with thin credibility → starved/await_evidence', () => {
  const v = assessReallocationEfficacyHealth(series([1.0, 1.0, 1.0], 0.1))
  assert.equal(v.status, 'starved')
  assert.equal(v.recommended_action, 'await_evidence')
  assert.equal(v.verdict_reason, 'starved_of_trials')
  assert.ok(v.calibration.mean_credibility < DEFAULT_CRED_FLOOR)
})

test('26a — starved OUTRANKS converged: a flat factor with no evidence is not "trusted"', () => {
  // Flat at neutral (settledRun would be 3) but mean credibility below floor.
  const v = assessReallocationEfficacyHealth(series([1.0, 1.0, 1.0], 0.1))
  assert.equal(v.status, 'starved', 'must not be reported as stable/trust on thin evidence')
  assert.notEqual(v.recommended_action, 'trust')
})

// ---------------------------------------------------------------------------
// (4) STABLE — converged with adequate evidence.
// ---------------------------------------------------------------------------
test('26a — a steady non-neutral correction with good evidence → stable/trust', () => {
  const v = assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8], 0.8))
  assert.equal(v.status, 'stable')
  assert.equal(v.recommended_action, 'trust')
  assert.equal(v.verdict_reason, 'calibration_converged')
  assert.equal(v.calibration.settled_run, 3)
  assert.equal(v.calibration.last_factor, 0.8)
  assert.equal(v.calibration.last_direction, 'damp')
})

test('26a — well-calibrated at neutral with good evidence reads stable, NOT starved/idle', () => {
  // factor genuinely 1.0 because hit_rate matched assigned confidence, cred high.
  const v = assessReallocationEfficacyHealth(series([1.0, 1.0, 1.0], 0.7))
  assert.equal(v.status, 'stable')
  assert.equal(v.recommended_action, 'trust')
  assert.equal(v.calibration.engaged, false) // never departed neutral...
  assert.ok(v.calibration.mean_credibility >= DEFAULT_CRED_FLOOR) // ...but evidence is real
})

test('26a — the two-snapshot minimum, settled, reads stable (boundary of minHistory)', () => {
  const v = assessReallocationEfficacyHealth(series([0.9, 0.9], 0.6))
  assert.equal(v.status, 'stable')
  assert.equal(v.calibration.settled_run, 2)
})

// ---------------------------------------------------------------------------
// (5) SETTLING — engaged, still moving, none of the above.
// ---------------------------------------------------------------------------
test('26a — a monotone ramp that has not settled → settling/hold', () => {
  const v = assessReallocationEfficacyHealth(series([1.0, 0.9, 0.8], 0.6))
  assert.equal(v.status, 'settling')
  assert.equal(v.recommended_action, 'hold')
  assert.equal(v.verdict_reason, 'calibration_settling')
  assert.equal(v.calibration.flips, 0) // steady direction, just not yet flat
  assert.equal(v.calibration.engaged, true)
})

// ---------------------------------------------------------------------------
// Windowing — only the trailing `window` snapshots decide the verdict.
// ---------------------------------------------------------------------------
test('26a — a thrashing prefix is forgotten once a calm tail fills the window', () => {
  // Long hunting history, then three flat-at-0.8 runs; window=3 sees only the calm tail.
  const hist = series([0.5, 1.2, 0.5, 1.2, 0.8, 0.8, 0.8], 0.8)
  const v = assessReallocationEfficacyHealth(hist, { window: 3 })
  assert.equal(v.status, 'stable')
  assert.equal(v.window_used, 3)
  assert.equal(v.history_len, 7) // full usable history is still reported
  assert.equal(v.calibration.series.length, 3) // but only the window is judged
})

test('26a — a calm prefix does not rescue a thrashing tail inside the window', () => {
  // A 4-wide window is the minimum that can hold two flips (3 steps); the calm
  // [0.8, 0.8] head is dropped, the thrashing 0.5/1.2/0.5/1.2 tail decides.
  const hist = series([0.8, 0.8, 0.5, 1.2, 0.5, 1.2], 0.8)
  const v = assessReallocationEfficacyHealth(hist, { window: 4 }) // tail 0.5,1.2,0.5,1.2
  assert.equal(v.status, 'unstable')
  assert.equal(v.calibration.flips, 2)
})

// ---------------------------------------------------------------------------
// Input-shape tolerance — bare / wrapped / spread all judged identically.
// ---------------------------------------------------------------------------
test('26a — the three calibration shapes yield the same verdict', () => {
  const factors = [0.7, 0.7, 0.7]
  const dates = ['2026-05-10', '2026-05-11', '2026-05-12']
  const bare = factors.map((f, i) => cal(f, 0.8, dates[i]))
  const wrapped = factors.map((f, i) => ({ as_of: dates[i], calibration: cal(f, 0.8) }))
  // The real Layer-25 calibrationOf() is clockless and carries no as_of — the engine
  // attaches it as a sibling. Strip the test helper's placeholder so the sibling wins
  // (and we don't self-clobber as_of with the spread order).
  const spread = factors.map((f, i) => {
    const { as_of, ...rest } = cal(f, 0.8) // eslint-disable-line no-unused-vars
    return { as_of: dates[i], ...rest }
  })

  const vb = assessReallocationEfficacyHealth(bare)
  const vw = assessReallocationEfficacyHealth(wrapped)
  const vs = assessReallocationEfficacyHealth(spread)

  assert.equal(vb.status, 'stable')
  assert.equal(vw.status, vb.status)
  assert.equal(vs.status, vb.status)
  // as_of propagates from whichever shape carried it
  assert.equal(vb.as_of, '2026-05-12')
  assert.equal(vw.as_of, '2026-05-12')
  assert.equal(vs.as_of, '2026-05-12')
})

test('26a — out-of-band factors are clamped into the legal rail before judging', () => {
  // Raw 1.9 / -3 get clamped to 1.2 / 0.5; three at the ceiling → pinned_high.
  const v = assessReallocationEfficacyHealth(series([1.9, 1.9, 1.9], 0.8))
  assert.equal(v.calibration.last_factor, 1.2)
  assert.equal(v.status, 'constrained')
  assert.equal(v.verdict_reason, 'pinned_high')
})

// ---------------------------------------------------------------------------
// Verdict envelope — every field present, series detail well-formed.
// ---------------------------------------------------------------------------
test('26a — the verdict envelope carries every documented field', () => {
  const v = assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8], 0.8))
  for (const k of ['status', 'recommended_action', 'as_of', 'window_used', 'history_len',
    'bounds', 'stability_score', 'calibration', 'verdict_reason']) {
    assert.ok(k in v, `verdict must carry "${k}"`)
  }
  for (const k of ['flips', 'high_run', 'low_run', 'settled_run', 'engaged',
    'mean_credibility', 'last_factor', 'last_direction', 'series']) {
    assert.ok(k in v.calibration, `calibration must carry "${k}"`)
  }
  for (const s of v.calibration.series) {
    assert.deepEqual(Object.keys(s).sort(), ['as_of', 'credibility', 'dir', 'factor'])
    assert.ok(VALID_DIRS.includes(s.dir))
  }
})

test('26a — stability_score is bounded and orders thrash/starved below converged', () => {
  const converged = assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8], 0.9))
  const thrash = assessReallocationEfficacyHealth(series([0.5, 1.2, 0.5, 1.2], 0.9))
  const starved = assessReallocationEfficacyHealth(series([1.0, 1.0, 1.0], 0.1))
  for (const v of [converged, thrash, starved]) {
    assert.ok(v.stability_score >= 0 && v.stability_score <= 1, 'score in [0,1]')
  }
  assert.ok(thrash.stability_score < converged.stability_score, 'thrash less stable than converged')
  assert.ok(starved.stability_score < converged.stability_score, 'starved less stable than converged')
})

// ---------------------------------------------------------------------------
// Option overrides — knobs honoured; junk falls back to defaults.
// ---------------------------------------------------------------------------
test('26a — custom thresholds change the verdict; junk opts fall back to defaults', () => {
  const s = series([1.0, 1.2, 1.2], 0.8) // high_run 2
  // Lower the saturation threshold to 2 → now constrained.
  assert.equal(assessReallocationEfficacyHealth(s, { saturationRuns: 2 }).status, 'constrained')
  // Junk opts → default 3 → not constrained.
  assert.notEqual(assessReallocationEfficacyHealth(s, { saturationRuns: 'lots' }).status, 'constrained')

  // Raise minHistory above the supplied length → abstain.
  assert.equal(assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8]), { minHistory: 9 }).status, 'abstained')

  // A custom credibility floor can pull a moderate-evidence window into starved.
  const mod = series([1.0, 1.0, 1.0], 0.4)
  assert.notEqual(assessReallocationEfficacyHealth(mod).status, 'starved') // 0.4 ≥ 0.25 default
  assert.equal(assessReallocationEfficacyHealth(mod, { credFloor: 0.5 }).status, 'starved')
})

// ---------------------------------------------------------------------------
// Purity — deterministic, non-mutating, total (never throws).
// ---------------------------------------------------------------------------
test('26a — same input yields a deep-equal verdict (deterministic)', () => {
  const s = series([1.0, 0.9, 0.95, 0.9], 0.7)
  assert.deepEqual(assessReallocationEfficacyHealth(s), assessReallocationEfficacyHealth(s))
})

test('26a — inputs are never mutated', () => {
  const s = series([1.0, 0.9, 0.8], 0.6)
  const before = JSON.stringify(s)
  assessReallocationEfficacyHealth(s, { window: 2 })
  assert.equal(JSON.stringify(s), before)
})

test('26a — never throws on adversarial junk', () => {
  const junk = [
    null, undefined, NaN, Infinity, -Infinity, 'str', 0, {}, [],
    { factor: null }, { factor: 'x' }, { factor: {} }, { calibration: null },
    { calibration: { factor: NaN } }, { as_of: 5, calibration: { factor: 0.8 } },
    [[[]]], { factor: 1.0, credibility: 'high', n: 'many' },
  ]
  assert.doesNotThrow(() => assessReallocationEfficacyHealth(junk))
  assert.doesNotThrow(() => assessReallocationEfficacyHealth(junk, { window: 'x', oscillationFlips: -4 }))
})

// ---------------------------------------------------------------------------
// Engine hooks — shouldDistrustCalibration / gatedFactor.
// ---------------------------------------------------------------------------
test('26a — shouldDistrustCalibration is true ONLY for the hunting verdict', () => {
  const unstable = assessReallocationEfficacyHealth(series([0.5, 1.2, 0.5, 1.2], 0.9))
  const stable = assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8], 0.8))
  const constrained = assessReallocationEfficacyHealth(series([1.2, 1.2, 1.2], 0.9))
  const starved = assessReallocationEfficacyHealth(series([1.0, 1.0, 1.0], 0.1))
  const settling = assessReallocationEfficacyHealth(series([1.0, 0.9, 0.8], 0.6))
  const abstained = assessReallocationEfficacyHealth([cal(0.9)])

  assert.equal(shouldDistrustCalibration(unstable), true)
  for (const v of [stable, constrained, starved, settling, abstained]) {
    assert.equal(shouldDistrustCalibration(v), false, `${v.status} must not trip distrust`)
  }
  assert.equal(shouldDistrustCalibration(null), false)
  assert.equal(shouldDistrustCalibration({}), false)
})

test('26a — gatedFactor benches a hunting calibration to neutral, else clamps the raw factor', () => {
  const unstable = assessReallocationEfficacyHealth(series([0.5, 1.2, 0.5, 1.2], 0.9))
  const stable = assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8], 0.8))

  // Hunting → neutral 1.0 regardless of the raw factor handed in.
  assert.equal(gatedFactor(unstable, 0.6), NEUTRAL)
  assert.equal(gatedFactor(unstable, 1.2), NEUTRAL)

  // Otherwise the raw factor, clamped into the legal band.
  assert.equal(gatedFactor(stable, 0.85), 0.85)
  assert.equal(gatedFactor(stable, 1.9), CAL_MAX) // clamp ceiling
  assert.equal(gatedFactor(stable, -3), CAL_MIN) // clamp floor

  // Junk raw factor or missing verdict → safe neutral no-op.
  assert.equal(gatedFactor(stable, 'nope'), NEUTRAL)
  assert.equal(gatedFactor(stable, null), NEUTRAL)
  assert.equal(gatedFactor(null, 0.9), 0.9) // no verdict ⇒ not distrusted ⇒ clamp raw
})

// ---------------------------------------------------------------------------
// Narrator — agency-only plain English; UNCONDITIONAL client silence.
// ---------------------------------------------------------------------------
test('26a — the narrator returns "" for audience:client on EVERY status', () => {
  const samples = [
    series([0.5, 1.2, 0.5, 1.2], 0.9), // unstable
    series([1.2, 1.2, 1.2], 0.9),       // constrained
    series([1.0, 1.0, 1.0], 0.1),       // starved
    series([0.8, 0.8, 0.8], 0.8),       // stable
    series([1.0, 0.9, 0.8], 0.6),       // settling
    [cal(0.9)],                          // abstained
  ]
  for (const s of samples) {
    const v = assessReallocationEfficacyHealth(s)
    assert.equal(narrateReallocationEfficacyHealth(v, { audience: 'client' }), '',
      `client narration for ${v.status} must be empty`)
  }
})

test('26a — the agency narrator speaks for the four actionable states, silent otherwise', () => {
  const unstable = assessReallocationEfficacyHealth(series([0.5, 1.2, 0.5, 1.2], 0.9))
  const high = assessReallocationEfficacyHealth(series([1.2, 1.2, 1.2], 0.9))
  const low = assessReallocationEfficacyHealth(series([0.5, 0.5, 0.5], 0.9))
  const starved = assessReallocationEfficacyHealth(series([1.0, 1.0, 1.0], 0.1))
  const stable = assessReallocationEfficacyHealth(series([0.8, 0.8, 0.8], 0.8))
  const settling = assessReallocationEfficacyHealth(series([1.0, 0.9, 0.8], 0.6))
  const abstained = assessReallocationEfficacyHealth([cal(0.9)])

  for (const v of [unstable, high, low, starved, stable]) {
    const line = narrateReallocationEfficacyHealth(v)
    assert.ok(line.length > 0, `${v.status} should produce agency prose`)
    assert.ok(!FORBIDDEN_NARRATION.test(line),
      `agency prose for ${v.status} must carry no machine vocabulary: "${line}"`)
  }
  assert.equal(narrateReallocationEfficacyHealth(settling), '')
  assert.equal(narrateReallocationEfficacyHealth(abstained), '')

  // pinned_high and pinned_low produce DISTINCT prose (cautious vs assertive limit).
  assert.notEqual(narrateReallocationEfficacyHealth(high), narrateReallocationEfficacyHealth(low))
})

test('26a — the narrator tolerates a missing/garbage verdict', () => {
  assert.equal(narrateReallocationEfficacyHealth(null), '')
  assert.equal(narrateReallocationEfficacyHealth(undefined, { audience: 'client' }), '')
  assert.equal(narrateReallocationEfficacyHealth({ status: 'who_knows' }), '')
  assert.equal(narrateReallocationEfficacyHealth('nope'), '')
})
