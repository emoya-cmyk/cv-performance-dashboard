'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  applyEmphasisControl,
  narrateEmphasisControl,
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
  NEUTRAL_SCALE,
  SCALE_EPS,
} = require('../lib/briefEmphasisControl')
const { deriveBriefEmphasis } = require('../lib/briefEngagementLearning')
const { summarizeEmphasisEfficacy } = require('../lib/briefEmphasisEfficacy')

// deep-freeze helper — proves the module never mutates its inputs
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

// Mirror 19a's grade builder so we feed layer 21 REAL layer-19 decisions.
function graded(overrides = {}) {
  return { status: 'graded', helpful_rate: 0.6, label: 'fair', trend: 'steady', n: 12, ...overrides }
}

// A minimal, hand-built layer-20 recommendation — lets us probe each sign branch
// at exact scale values (1.25 / 0.5 / exactly 1.0 / ±eps) without reproducing 20's
// scoring internals. The end-to-end test below proves the real 20 shape flows too.
function eff(widen, tighten, extra = {}) {
  return {
    status: 'graded',
    recommendation: { widen_step_scale: widen, tighten_step_scale: tighten, verdict: 'v', reason: 'r' },
    ...extra,
  }
}

// ── REAL layer-19 decisions (computed once; sanity-pinned in the tests) ──────────
const EM_WIDEN = deriveBriefEmphasis(graded({ helpful_rate: 0.82, label: 'well_received', trend: 'steady' }))      // cap 4, +1
const EM_TIGHTEN1 = deriveBriefEmphasis(graded({ helpful_rate: 0.4, label: 'poorly_received', trend: 'steady' }))  // cap 2, −1
const EM_TIGHTEN2 = deriveBriefEmphasis(graded({ helpful_rate: 0.3, label: 'poorly_received', trend: 'declining' })) // cap 1, −2
const EM_IDLE = deriveBriefEmphasis(graded({ helpful_rate: 0.6, label: 'fair', trend: 'steady' }))                 // cap 3, 0
const EM_ABSTAIN = deriveBriefEmphasis({ status: 'insufficient' })                                                  // cap 3, 0
const EM_WELL_SLIPPING = deriveBriefEmphasis(graded({ helpful_rate: 0.78, label: 'well_received', trend: 'declining' })) // cap 3, 0 (slipping hold)

// The 20d-proven fixture: five sustained widens + flat controls → endorsed widen, scale 1.25.
const SUSTAINED_WIDEN_OBS = [
  { as_of: '2026-04-08', direction: 'widen', rate_before: 0.80, base_cap: 3, rate_after: 0.81, n_after: 12 },
  { as_of: '2026-04-09', direction: 'widen', rate_before: 0.81, base_cap: 3, rate_after: 0.80, n_after: 12 },
  { as_of: '2026-04-10', direction: 'widen', rate_before: 0.80, base_cap: 3, rate_after: 0.82, n_after: 12 },
  { as_of: '2026-04-11', direction: 'widen', rate_before: 0.82, base_cap: 3, rate_after: 0.81, n_after: 12 },
  { as_of: '2026-04-12', direction: 'widen', rate_before: 0.81, base_cap: 3, rate_after: 0.80, n_after: 12 },
  { as_of: '2026-04-13', direction: 'neutral', rate_before: 0.80, base_cap: 3, rate_after: 0.79, n_after: 12 },
  { as_of: '2026-04-14', direction: 'neutral', rate_before: 0.79, base_cap: 3, rate_after: 0.80, n_after: 12 },
  { as_of: '2026-04-15', direction: 'neutral', rate_before: 0.80, base_cap: 3, rate_after: 0.78, n_after: 12 },
]

// ════════════════════════════════════════════════════════════════════════════
// Group A — the sign-trust mapping: layer 20's verdict reshapes 19's flex MAGNITUDE
// ════════════════════════════════════════════════════════════════════════════

test('21a — endorsed widen LEANS IN: a +1 cap flex reaches one row further, toward the ceiling', () => {
  assert.equal(EM_WIDEN.also_cap, 4) // sanity: 19 widened base+1
  assert.equal(EM_WIDEN.delta, 1)
  const out = applyEmphasisControl(EM_WIDEN, eff(1.25, 1.0))
  assert.equal(out.also_cap, 5)
  assert.equal(out.delta, 2)
  assert.equal(out.direction, 'widen')
  assert.equal(out.status, 'tuned')
  assert.equal(out.controlled, true)
  assert.equal(out.control_move, 'lean_in')
  assert.equal(out.control_reason, 'efficacy_endorsed')
  assert.equal(out.base_step, 1)
  assert.equal(out.controlled_step, 2)
  assert.equal(out.step_scale, 1.25)
  assert.equal(out.emphasis_also_cap, 4)
  // rails carried through intact
  assert.equal(out.base_cap, 3)
  assert.equal(out.min_cap, 1)
  assert.equal(out.max_cap, 5)
})

test('21a — tempered widen EASES OFF: a widen that is not paying off collapses back to base', () => {
  const out = applyEmphasisControl(EM_WIDEN, eff(0.5, 1.0))
  assert.equal(out.also_cap, 3) // back to base — the widen is suppressed
  assert.equal(out.delta, 0)
  assert.equal(out.direction, 'neutral')
  assert.equal(out.status, 'idle')
  assert.equal(out.controlled, true)
  assert.equal(out.control_move, 'ease_off')
  assert.equal(out.control_reason, 'efficacy_tempered')
  assert.equal(out.controlled_step, 0)
  assert.equal(out.base_step, 1)
  assert.equal(out.step_scale, 0.5)
})

test('21a — endorsed tighten LEANS IN: a −1 tighten reaches one row deeper, toward the floor', () => {
  assert.equal(EM_TIGHTEN1.also_cap, 2) // sanity: 19 tightened base−1
  assert.equal(EM_TIGHTEN1.delta, -1)
  const out = applyEmphasisControl(EM_TIGHTEN1, eff(1.0, 1.25))
  assert.equal(out.also_cap, 1)
  assert.equal(out.delta, -2)
  assert.equal(out.direction, 'tighten')
  assert.equal(out.control_move, 'lean_in')
  assert.equal(out.controlled, true)
  assert.equal(out.controlled_step, 2)
  assert.equal(out.step_scale, 1.25)
})

test('21a — tempered tighten EASES OFF: a tighten that is not recovering attention relaxes to base', () => {
  const out = applyEmphasisControl(EM_TIGHTEN1, eff(1.0, 0.5))
  assert.equal(out.also_cap, 3) // relaxed back to base
  assert.equal(out.delta, 0)
  assert.equal(out.direction, 'neutral')
  assert.equal(out.status, 'idle')
  assert.equal(out.control_move, 'ease_off')
  assert.equal(out.controlled_step, 0)
})

test('21a — a hard (−2) tighten endorsed stays pinned at the MIN_CAP floor (never below)', () => {
  assert.equal(EM_TIGHTEN2.also_cap, 1) // sanity: 19 tightened base−2 to the floor
  assert.equal(EM_TIGHTEN2.delta, -2)
  const out = applyEmphasisControl(EM_TIGHTEN2, eff(1.0, 1.25))
  assert.equal(out.also_cap, 1) // step would be 3, but the floor holds at 1
  assert.equal(out.delta, -2)
  assert.equal(out.controlled_step, 3) // the intent is recorded honestly…
  assert.ok(out.also_cap >= out.min_cap) // …but the bound is never breached
  assert.equal(out.control_move, 'lean_in')
})

test('21a — a hard (−2) tighten tempered eases up one step, from the floor toward base', () => {
  const out = applyEmphasisControl(EM_TIGHTEN2, eff(1.0, 0.5))
  assert.equal(out.also_cap, 2) // base−1: one step softer than 19's −2
  assert.equal(out.delta, -1)
  assert.equal(out.control_move, 'ease_off')
  assert.equal(out.controlled_step, 1)
})

// ════════════════════════════════════════════════════════════════════════════
// Group B — honest abstention: the controller modulates an EXISTING flex, never invents one
// ════════════════════════════════════════════════════════════════════════════

test('21a — insufficient efficacy is a clean identity pass-through of 19\'s flex', () => {
  const e20 = { status: 'insufficient', recommendation: { widen_step_scale: 1.0, tighten_step_scale: 1.0, verdict: 'insufficient', reason: 'no_measured_outcomes' } }
  const out = applyEmphasisControl(EM_WIDEN, e20)
  assert.equal(out.also_cap, 4) // unchanged from 19
  assert.equal(out.delta, 1)
  assert.equal(out.direction, 'widen')
  assert.equal(out.status, 'tuned')
  assert.equal(out.controlled, false)
  assert.equal(out.control_move, 'none')
  assert.equal(out.control_reason, 'insufficient_efficacy')
  assert.equal(out.step_scale, null)
})

test('21a — null / non-graded efficacy is a clean identity pass-through', () => {
  for (const bad of [null, undefined, {}, { status: 'nope' }, 'x', 42]) {
    const out = applyEmphasisControl(EM_WIDEN, bad)
    assert.equal(out.also_cap, 4, `efficacy=${JSON.stringify(bad)}`)
    assert.equal(out.controlled, false)
    assert.equal(out.control_reason, 'insufficient_efficacy')
  }
})

test('21a — graded efficacy that says HOLD (scale exactly 1.0) leaves the flex untouched', () => {
  const out = applyEmphasisControl(EM_WIDEN, eff(NEUTRAL_SCALE, 1.0))
  assert.equal(out.also_cap, 4) // unchanged
  assert.equal(out.delta, 1)
  assert.equal(out.status, 'tuned') // 19's tuned decision still stands
  assert.equal(out.controlled, false) // …but the controller did not move it
  assert.equal(out.control_move, 'hold')
  assert.equal(out.control_reason, 'efficacy_neutral')
  assert.equal(out.step_scale, 1.0) // we DID measure — it just said hold (not null)
})

test('21a — a scale a hair off 1.0 (inside the dead-band) still HOLDS', () => {
  const justHigh = applyEmphasisControl(EM_WIDEN, eff(NEUTRAL_SCALE + SCALE_EPS / 2, 1.0))
  assert.equal(justHigh.control_move, 'hold')
  assert.equal(justHigh.also_cap, 4)
  const justLow = applyEmphasisControl(EM_WIDEN, eff(NEUTRAL_SCALE - SCALE_EPS / 2, 1.0))
  assert.equal(justLow.control_move, 'hold')
  assert.equal(justLow.also_cap, 4)
})

test('21a — when 19 held neutral (idle), there is no flex to scale — endorsement does NOT create one', () => {
  const out = applyEmphasisControl(EM_IDLE, eff(1.25, 1.25))
  assert.equal(out.also_cap, 3) // base — the controller never widens from a non-flex
  assert.equal(out.delta, 0)
  assert.equal(out.status, 'idle')
  assert.equal(out.controlled, false)
  assert.equal(out.control_move, 'none')
  assert.equal(out.control_reason, 'no_flex_to_scale')
})

test('21a — when 19 abstained (no track record), endorsement is still a no-op', () => {
  const out = applyEmphasisControl(EM_ABSTAIN, eff(1.25, 1.25))
  assert.equal(out.also_cap, 3)
  assert.equal(out.controlled, false)
  assert.equal(out.control_reason, 'no_flex_to_scale')
})

test('21a — well_received but SLIPPING: 19 held, and the controller respects that hold', () => {
  assert.equal(EM_WELL_SLIPPING.also_cap, 3) // sanity: the slipping hold zeroed the flex
  assert.equal(EM_WELL_SLIPPING.delta, 0)
  const out = applyEmphasisControl(EM_WELL_SLIPPING, eff(1.25, 1.0))
  assert.equal(out.also_cap, 3) // no lean-in onto a flex 19 declined to make
  assert.equal(out.controlled, false)
  assert.equal(out.control_reason, 'no_flex_to_scale')
})

// ════════════════════════════════════════════════════════════════════════════
// Group C — bounds & safety invariants (property-style over the real decision set)
// ════════════════════════════════════════════════════════════════════════════

test('21a — the controlled cap is ALWAYS within [min_cap, max_cap], for every decision × scale', () => {
  const decisions = [EM_WIDEN, EM_TIGHTEN1, EM_TIGHTEN2, EM_IDLE, EM_ABSTAIN, EM_WELL_SLIPPING]
  const scales = [0, 0.5, 0.999, 1.0, 1.001, 1.25, 5, -3, NaN]
  for (const d of decisions) {
    for (const s of scales) {
      const out = applyEmphasisControl(d, eff(s, s))
      assert.ok(
        out.also_cap >= out.min_cap && out.also_cap <= out.max_cap,
        `cap ${out.also_cap} out of [${out.min_cap}, ${out.max_cap}] for scale ${s}`
      )
      assert.equal(out.delta, out.also_cap - out.base_cap, `delta must equal cap−base for scale ${s}`)
      assert.ok(Number.isInteger(out.also_cap), 'cap must be an integer row count')
    }
  }
})

test('21a — leaning in never widens past MAX_CAP', () => {
  const atCeiling = { status: 'tuned', also_cap: 5, base_cap: 3, min_cap: 1, max_cap: 5, delta: 2, direction: 'widen' }
  const out = applyEmphasisControl(atCeiling, eff(1.25, 1.0))
  assert.equal(out.also_cap, 5) // already at MAX; lean-in cannot exceed it
  assert.ok(out.also_cap <= out.max_cap)
})

test('21a — leaning in never tightens below MIN_CAP', () => {
  const atFloor = { status: 'tuned', also_cap: 1, base_cap: 3, min_cap: 1, max_cap: 5, delta: -2, direction: 'tighten' }
  const out = applyEmphasisControl(atFloor, eff(1.0, 1.25))
  assert.equal(out.also_cap, 1) // already at MIN; lean-in cannot go below it
  assert.ok(out.also_cap >= out.min_cap)
})

// ════════════════════════════════════════════════════════════════════════════
// Group D — robustness: never throws, never mutates, tolerates the courtesy shape
// ════════════════════════════════════════════════════════════════════════════

test('21a — garbage inputs never throw; they abstain to the neutral base', () => {
  for (const [em, e20] of [
    [null, null],
    [undefined, undefined],
    ['nope', 'nope'],
    [42, []],
    [{}, {}],
    [{ also_cap: 'x', base_cap: 'y', min_cap: 'z', max_cap: 'q' }, { status: 'graded' }],
  ]) {
    let out
    assert.doesNotThrow(() => { out = applyEmphasisControl(em, e20) })
    assert.equal(out.base_cap, BASE_CAP)
    assert.equal(out.also_cap, BASE_CAP) // garbled in → guaranteed no-op at base
    assert.equal(out.controlled, false)
    assert.ok(out.also_cap >= out.min_cap && out.also_cap <= out.max_cap)
  }
})

test('21a — does not mutate either input (frozen emphasis + efficacy)', () => {
  const em = deepFreeze(deriveBriefEmphasis(graded({ helpful_rate: 0.82, label: 'well_received', trend: 'steady' })))
  const e20 = deepFreeze(eff(1.25, 1.0))
  assert.doesNotThrow(() => applyEmphasisControl(em, e20))
  assert.equal(em.also_cap, 4) // untouched
  assert.equal(e20.recommendation.widen_step_scale, 1.25)
})

test('21a — accepts the recommendation handed at top level (courtesy shape)', () => {
  const out = applyEmphasisControl(EM_WIDEN, { status: 'graded', widen_step_scale: 1.25, tighten_step_scale: 1.0 })
  assert.equal(out.also_cap, 5)
  assert.equal(out.control_move, 'lean_in')
  assert.equal(out.step_scale, 1.25)
})

// ════════════════════════════════════════════════════════════════════════════
// Group E — the loop closed on REAL upstream output (19 → 20 → 21)
// ════════════════════════════════════════════════════════════════════════════

test('21a — END TO END: a real well-received widen, with a real endorsed-widen efficacy, leans to the ceiling', () => {
  const em = deriveBriefEmphasis(graded({ helpful_rate: 0.82, label: 'well_received', trend: 'steady' }))
  const e20 = summarizeEmphasisEfficacy(SUSTAINED_WIDEN_OBS)
  // sanity: the two upstream layers produced what this test depends on
  assert.equal(em.also_cap, 4)
  assert.equal(em.direction, 'widen')
  assert.equal(e20.status, 'graded')
  assert.ok(e20.recommendation.widen_step_scale > NEUTRAL_SCALE)
  assert.equal(e20.recommendation.reason, 'widen_sustaining')

  const out = applyEmphasisControl(em, e20)
  assert.equal(out.also_cap, 5)
  assert.equal(out.delta, 2)
  assert.equal(out.direction, 'widen')
  assert.equal(out.controlled, true)
  assert.equal(out.control_move, 'lean_in')
  assert.equal(out.step_scale, e20.recommendation.widen_step_scale)
})

test('21a — END TO END: the same real widen, with an INSUFFICIENT real efficacy, passes through unscaled', () => {
  const em = deriveBriefEmphasis(graded({ helpful_rate: 0.82, label: 'well_received', trend: 'steady' }))
  const e20 = summarizeEmphasisEfficacy([])
  assert.equal(e20.status, 'insufficient')
  const out = applyEmphasisControl(em, e20)
  assert.equal(out.also_cap, 4) // identity — no measured outcomes, no modulation
  assert.equal(out.controlled, false)
  assert.equal(out.control_reason, 'insufficient_efficacy')
})

// ════════════════════════════════════════════════════════════════════════════
// Group F — narrateEmphasisControl: silent for the client, plain English for the agency
// ════════════════════════════════════════════════════════════════════════════

test('21a — narrateEmphasisControl is silent for the CLIENT unconditionally', () => {
  const leanIn = applyEmphasisControl(EM_WIDEN, eff(1.25, 1.0))
  const easeOff = applyEmphasisControl(EM_WIDEN, eff(0.5, 1.0))
  const hold = applyEmphasisControl(EM_WIDEN, eff(1.0, 1.0))
  const passthrough = applyEmphasisControl(EM_IDLE, eff(1.25, 1.25))
  for (const c of [leanIn, easeOff, hold, passthrough, null, 'nope', {}, { controlled: true, control_move: 'lean_in', also_cap: 5, emphasis_also_cap: 4, base_cap: 3 }]) {
    assert.equal(narrateEmphasisControl(c, { audience: 'client' }), '')
  }
})

test('21a — agency narration: a lean-in widen reads as plain English, no machine vocabulary', () => {
  const out = applyEmphasisControl(EM_WIDEN, eff(1.25, 1.0))
  const line = narrateEmphasisControl(out, { audience: 'agency' })
  assert.ok(line.length > 0)
  assert.match(line, /paying off/)
  assert.match(line, /leaning in further/)
  assert.match(line, /5 items, up from 4/)
  // never leaks the controller's machine vocabulary into agency prose
  assert.doesNotMatch(line, /step_scale|control_move|control_reason|efficacy_|also_cap|helpful_rate|widen_step_scale|tighten_step_scale/)
})

test('21a — agency narration: an ease-off widen reads as easing back to the essentials', () => {
  const out = applyEmphasisControl(EM_WIDEN, eff(0.5, 1.0))
  const line = narrateEmphasisControl(out, { audience: 'agency' })
  assert.match(line, /hasn't been paying off/)
  assert.match(line, /easing back toward the essentials/)
  assert.match(line, /3 items, instead of 4/)
})

test('21a — agency narration: a lean-in tighten reads as tightening one deeper (singular item at the floor)', () => {
  const out = applyEmphasisControl(EM_TIGHTEN1, eff(1.0, 1.25)) // cap 2 → 1
  const line = narrateEmphasisControl(out, { audience: 'agency' })
  assert.match(line, /recovering attention/)
  assert.match(line, /tightening one deeper/)
  assert.match(line, /1 item, down from 2/) // singular "item"
})

test('21a — agency narration: an ease-off tighten reads as holding a little more of the picture', () => {
  const out = applyEmphasisControl(EM_TIGHTEN1, eff(1.0, 0.5)) // cap 2 → 3
  const line = narrateEmphasisControl(out, { audience: 'agency' })
  assert.match(line, /hasn't been recovering attention/)
  assert.match(line, /holding a little more of the picture/)
  assert.match(line, /3 items, instead of 2/)
})

test('21a — agency narration is silent when the controller acted but the bounds absorbed it', () => {
  const atCeiling = { status: 'tuned', also_cap: 5, base_cap: 3, min_cap: 1, max_cap: 5, delta: 2, direction: 'widen' }
  const out = applyEmphasisControl(atCeiling, eff(1.25, 1.0))
  assert.equal(out.controlled, true)
  assert.equal(out.also_cap, out.emphasis_also_cap) // 5 == 5, nothing changed for the reader
  assert.equal(narrateEmphasisControl(out, { audience: 'agency' }), '')
})

test('21a — agency narration is silent on a pass-through and on a hold', () => {
  assert.equal(narrateEmphasisControl(applyEmphasisControl(EM_IDLE, eff(1.25, 1.25)), { audience: 'agency' }), '')
  assert.equal(narrateEmphasisControl(applyEmphasisControl(EM_WIDEN, eff(1.0, 1.0)), { audience: 'agency' }), '')
})
