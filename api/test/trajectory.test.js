// ============================================================
// test/trajectory.test.js — "which still-green client is heading for trouble?"
//
// lib/trajectory.js projects a client's SERIES of past health scores forward with
// forecast.js's Holt model and asks health.js's own band cutoffs one question: does
// this trajectory fall THROUGH the floor of the band the client sits in today, and
// when? These tests pin, on hand-traced linear ramps, the exact crossing ETAs and the
// from/to bands; prove the two honesty grades ('likely' = the central forecast crosses,
// 'possible' = only the calibrated band edge does, with eta_worst ≤ eta); prove the
// confidence gate stays null until enough history exists; prove an already-critical or
// improving client is never flagged; and prove the roster's most-urgent-first ordering.
// Degenerate / thin / garbage history never throws and yields a quiet no-op. Pure: the
// same scores always yield the same verdict. No DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  classifyTrajectory, rankEarlyWarnings,
  DEFAULT_HORIZON, DEFAULT_FLAT, MIN_HISTORY, MIN_FIT_N,
} = require('../lib/trajectory')

// the documented band floors (health.js BAND_CUTOFFS), hardcoded here the way
// health.test.js hardcodes its band edges — the test is the independent check.
const CUTOFF = { healthy: 85, watch: 65, at_risk: 40, critical: 0 }

// a client group for the roster
const grp = (client_id, scores, client_name = client_id) => ({ client_id, client_name, scores })

// ---- degenerate / garbage: a quiet, crossing-free no-op, never a throw ---------

test('classifyTrajectory: empty / null / garbage history → a method:none no-op', () => {
  for (const input of [[], null, undefined, 42, 'x', { nope: true }, [NaN, 'a', null, '']]) {
    const v = classifyTrajectory(input)
    assert.equal(v.method, 'none')
    assert.equal(v.crossing, null)
    assert.equal(v.direction, 'stable')
    assert.equal(v.band_change, 'none')
    assert.equal(v.confidence, null)
    assert.equal(v.current, null)        // nothing usable → no current score
    assert.equal(v.current_band, null)
  }
})

test('classifyTrajectory: a single score is a flat, no-crossing verdict (a line needs a past)', () => {
  const v = classifyTrajectory([72])
  assert.equal(v.method, 'naive')
  assert.equal(v.n, 1)
  assert.equal(v.current, 72)
  assert.equal(v.current_band, 'watch')
  assert.equal(v.direction, 'stable')
  assert.equal(v.crossing, null)         // n < MIN_HISTORY
  assert.equal(v.confidence, null)       // n < MIN_FIT_N
})

test('classifyTrajectory: two scores still below MIN_HISTORY → no crossing claim yet', () => {
  const v = classifyTrajectory([80, 60])   // a steep drop, but only two points
  assert.equal(v.method, 'holt')
  assert.equal(v.n, 2)
  assert.ok(MIN_HISTORY > 2)
  assert.equal(v.crossing, null)
  assert.equal(v.direction, 'deteriorating')
})

// ---- exact crossings on clean linear ramps -------------------------------------

test('classifyTrajectory: a watch client sliding 5/wk crosses into at_risk at step 3 (likely)', () => {
  // [95,90,85,80,75]: Holt recovers level 75, trend −5, residuals 0 → a clean line.
  // path 70,65,60,55 — first point below the watch floor (65) is step 3.
  const v = classifyTrajectory([95, 90, 85, 80, 75])
  assert.equal(v.method, 'holt')
  assert.equal(v.current, 75)
  assert.equal(v.current_band, 'watch')
  assert.equal(v.trend, -5)
  assert.equal(v.direction, 'deteriorating')
  assert.equal(v.projected, 55)               // step-4 central point
  assert.equal(v.projected_band, 'at_risk')
  assert.equal(v.band_change, 'downgrade')
  assert.equal(v.confidence, 1)               // MAPE 0 on a perfect line, n ≥ MIN_FIT_N
  assert.deepEqual(v.crossing, {
    from_band: 'watch', to_band: 'at_risk', cutoff: 65,
    eta: 3, eta_worst: 3, kind: 'likely',
  })
})

test('classifyTrajectory: an at_risk client falling 8/wk crosses into critical at step 2', () => {
  // [80,72,64,56,48]: level 48, trend −8. path 40,32,24,16 — first BELOW 40 is step 2.
  const v = classifyTrajectory([80, 72, 64, 56, 48])
  assert.equal(v.current, 48)
  assert.equal(v.current_band, 'at_risk')
  assert.equal(v.trend, -8)
  assert.equal(v.crossing.from_band, 'at_risk')
  assert.equal(v.crossing.to_band, 'critical')
  assert.equal(v.crossing.cutoff, 40)
  assert.equal(v.crossing.eta, 2)
  assert.equal(v.crossing.eta_worst, 2)
  assert.equal(v.crossing.kind, 'likely')
})

test('classifyTrajectory: an improving ramp is an upgrade, never a crossing', () => {
  const v = classifyTrajectory([40, 50, 60, 70, 80]) // level 80, trend +10
  assert.equal(v.direction, 'improving')
  assert.equal(v.crossing, null)
  assert.equal(v.band_change, 'upgrade')
  assert.equal(v.projected_band, 'healthy')           // 80 + 4·10 → clamped 100
  assert.equal(v.confidence, 1)
})

test('classifyTrajectory: a perfectly flat series is stable with no crossing and no band change', () => {
  const v = classifyTrajectory([95, 95, 95, 95, 95])
  assert.equal(v.trend, 0)
  assert.equal(v.direction, 'stable')
  assert.equal(v.crossing, null)
  assert.equal(v.band_change, 'none')
  assert.equal(v.projected, 95)
  assert.equal(v.confidence, 1)
})

test('classifyTrajectory: an already-critical client has no lower floor → never a crossing', () => {
  const v = classifyTrajectory([30, 25, 20, 15, 10]) // critical band, floor 0
  assert.equal(v.current_band, 'critical')
  assert.equal(v.direction, 'deteriorating')
  assert.equal(v.crossing, null)                      // nowhere worse to fall — triage's job
})

// ---- the 'possible' grade: only the calibrated band edge threatens the floor ----

test("classifyTrajectory: a non-declining central path whose band dips under the floor is 'possible'", () => {
  // [70,80,70,70,70,70]: an early spike leaves Holt's central level ABOVE the watch
  // floor with a non-negative trend (central path never reaches 65 within 4 steps), but
  // the spike inflates the residual band so its lower edge crosses 65 → a hedge, not a claim.
  const v = classifyTrajectory([70, 80, 70, 70, 70, 70])
  assert.ok(v.crossing, 'the band edge reaches the floor, so a crossing is reported')
  assert.equal(v.crossing.kind, 'possible')
  assert.equal(v.crossing.eta, null)                  // the CENTRAL line never crosses in-horizon
  assert.ok(v.crossing.eta_worst >= 1 && v.crossing.eta_worst <= DEFAULT_HORIZON)
  assert.equal(v.crossing.from_band, 'watch')
})

// ---- confidence is gated on enough history, independent of the crossing ---------

test('classifyTrajectory: a crossing can fire while confidence is still null (too few points)', () => {
  // [80,70,60]: n = 3 ≥ MIN_HISTORY (crossing allowed) but < MIN_FIT_N (confidence withheld).
  assert.equal(MIN_HISTORY, 3)
  assert.equal(MIN_FIT_N, 4)
  const v = classifyTrajectory([80, 70, 60]) // at_risk (60), level 60 trend −10 → crosses 40 at step 3
  assert.equal(v.n, 3)
  assert.ok(v.crossing, 'three points is enough to warn')
  assert.equal(v.crossing.cutoff, 40)
  assert.equal(v.crossing.eta, 3)
  assert.equal(v.confidence, null, 'but not enough to claim a confidence number')
})

// ---- structural invariants that must hold for ANY input ------------------------

test('classifyTrajectory: every verdict obeys the crossing invariants', () => {
  const series = [
    [95, 90, 85, 80, 75], [80, 72, 64, 56, 48], [40, 50, 60, 70, 80],
    [95, 95, 95, 95, 95], [30, 25, 20, 15, 10], [72, 70, 72, 70, 72, 70],
    [70, 80, 70, 70, 70, 70], [80, 70, 60], [80, 60], [72], [],
    [60, 61, 59, 80, 40, 70, 55, 62], [50, 48, 47, 49, 46, 44],
  ]
  for (const s of series) {
    const v = classifyTrajectory(s)
    assert.ok(['improving', 'stable', 'deteriorating'].includes(v.direction))
    assert.ok(v.confidence === null || (v.confidence >= 0 && v.confidence <= 1))
    if (!v.crossing) continue
    const c = v.crossing
    // a crossing only ever falls FROM the current band, THROUGH that band's exact floor
    assert.equal(c.from_band, v.current_band)
    assert.equal(c.cutoff, CUTOFF[v.current_band])
    assert.ok(CUTOFF[c.to_band] < c.cutoff, 'destination is a strictly lower band')
    // the grade is exactly "did the CENTRAL line cross?"
    assert.equal(c.kind === 'likely', c.eta !== null)
    // the pessimistic ETA always exists and is the earliest (≤ central), within horizon
    assert.ok(c.eta_worst >= 1 && c.eta_worst <= v.horizon)
    if (c.eta !== null) assert.ok(c.eta_worst <= c.eta && c.eta <= v.horizon)
  }
})

test('classifyTrajectory: pure — the same scores yield an identical verdict', () => {
  const s = [92, 88, 81, 77, 70, 66]
  assert.deepEqual(classifyTrajectory(s), classifyTrajectory(s))
})

test('classifyTrajectory: input array is never mutated', () => {
  const s = [95, 90, 85, 80, 75]
  const copy = s.slice()
  classifyTrajectory(s)
  assert.deepEqual(s, copy)
})

// ---- the early-warning roster --------------------------------------------------

test('rankEarlyWarnings: flags only the sliding clients, most-urgent-first', () => {
  const roster = rankEarlyWarnings([
    grp('improving', [40, 50, 60, 70, 80]),          // getting better → excluded
    grp('falling-watch', [95, 90, 85, 80, 75]),      // likely, crosses step 3 (eta_worst 3)
    grp('stable', [95, 95, 95, 95, 95]),             // flat → excluded
    grp('cliff', [80, 72, 64, 56, 48]),              // likely, crosses step 2 (eta_worst 2)
    grp('already-critical', [30, 25, 20, 15, 10]),   // no lower floor → excluded
    grp('drifter', [72, 70, 72, 70, 72, 70]),        // possible (band-only) → after the likelies
  ])
  // real (central) crossings first, soonest first within that; band-only maybe last.
  assert.deepEqual(roster.map((r) => r.client_id), ['cliff', 'falling-watch', 'drifter'])
  assert.equal(roster.length, 3)
  // entries are enriched with the full trajectory verdict + identity
  assert.equal(roster[0].client_name, 'cliff')
  assert.equal(roster[0].current_band, 'at_risk')
  assert.equal(roster[0].crossing.to_band, 'critical')
  assert.ok('projected_band' in roster[0] && 'confidence' in roster[0])
})

test('rankEarlyWarnings: a healthy book and bad input both yield an empty roster', () => {
  assert.deepEqual(rankEarlyWarnings([]), [])
  assert.deepEqual(rankEarlyWarnings(null), [])
  assert.deepEqual(rankEarlyWarnings([grp('a', [95, 95, 95, 95]), grp('b', [88, 90, 92, 94])]), [])
  // null members and absent scores are skipped, never thrown on
  assert.deepEqual(rankEarlyWarnings([null, {}, grp('c', [])]), [])
})

test('rankEarlyWarnings: pure — the same portfolio yields an identical roster', () => {
  const groups = [grp('cliff', [80, 72, 64, 56, 48]), grp('watch', [95, 90, 85, 80, 75])]
  assert.deepEqual(rankEarlyWarnings(groups), rankEarlyWarnings(groups))
})

// ---- the exported thresholds are the documented ones ---------------------------

test('constants: documented defaults', () => {
  assert.equal(DEFAULT_HORIZON, 4)
  assert.equal(DEFAULT_FLAT, 0.5)
  assert.equal(MIN_HISTORY, 3)
  assert.equal(MIN_FIT_N, 4)
})
