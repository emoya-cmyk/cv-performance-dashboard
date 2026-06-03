'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  proposeLeadPolicyRemediation,
  shouldStageRemediation,
  narrateLeadPolicyRemediation,
  humanizeLane,
  DEFAULT_BAND_STEP,
  DEFAULT_BAND_MAX,
  DEFAULT_BOUND_STEP,
  DEFAULT_BOUND_FLOOR,
} = require('../lib/briefLeadPolicyRemediation')

// The remediator's upstream is the REAL auditor's output — so every audit fixture below is built
// by running auditLeadPolicyGovernance over governor-shaped mornings, never hand-faked. That keeps
// these tests honest to the contract: if the auditor ever changes the shape of recommendation.lanes
// or lanes[].current_run, the remediator tests break here rather than drifting silently.
const { auditLeadPolicyGovernance } = require('../lib/briefLeadPolicyAudit')

// A minimal governor morning: a 'neutralize' correction on each named lane (the only action the
// auditor counts as a correction), wrapped with its as_of. Empty lanes → a clean, no-correction day.
const gov = (lanes) => ({ status: lanes.length ? 'corrected' : 'clean', interventions: lanes.map(l => ({ lane: l, action: 'neutralize' })) })
const morning = (as_of, lanes) => ({ as_of, governance: gov(lanes) })

// ── REAL audit fixtures ──────────────────────────────────────────────────────
// verify neutralised 4 consecutive mornings → current_run 4 → recurring → churning, escalate verify.
const churnVerify = auditLeadPolicyGovernance([
  morning('2026-05-30', ['verify']),
  morning('2026-05-31', ['verify']),
  morning('2026-06-01', ['verify']),
  morning('2026-06-02', ['verify']),
])
// act_now neutralised 4 mornings → churning, escalate act_now (defensive: the floor should never
// actually oscillate, but if the auditor names it the remediator must refuse to touch it).
const churnActNow = auditLeadPolicyGovernance([
  morning('2026-05-30', ['act_now']),
  morning('2026-05-31', ['act_now']),
  morning('2026-06-01', ['act_now']),
  morning('2026-06-02', ['act_now']),
])
// verify run 4, worth_a_look run 3 — two churning lanes at different severities.
const churnTwo = auditLeadPolicyGovernance([
  morning('2026-05-30', ['verify']),
  morning('2026-05-31', ['verify', 'worth_a_look']),
  morning('2026-06-01', ['verify', 'worth_a_look']),
  morning('2026-06-02', ['verify', 'worth_a_look']),
])
// monitor + verify both run 3 — equal severity, to exercise the stable lane-name tiebreak.
const churnTie = auditLeadPolicyGovernance([
  morning('2026-05-31', ['monitor', 'verify']),
  morning('2026-06-01', ['monitor', 'verify']),
  morning('2026-06-02', ['monitor', 'verify']),
])
// worth_a_look run 5, verify run 3 — different severities, to pair with a policy that makes them
// take DIFFERENT remedies (so the cross-remedy severity sort is exercised).
const churnMixed = auditLeadPolicyGovernance([
  morning('2026-05-29', ['worth_a_look']),
  morning('2026-05-30', ['worth_a_look']),
  morning('2026-05-31', ['verify', 'worth_a_look']),
  morning('2026-06-01', ['verify', 'worth_a_look']),
  morning('2026-06-02', ['verify', 'worth_a_look']),
])
// Corrections that took: verify reset 3 mornings then rode free on the 4th → resolved, NOT churning.
const effective = auditLeadPolicyGovernance([
  morning('2026-05-30', ['verify']),
  morning('2026-05-31', ['verify']),
  morning('2026-06-01', ['verify']),
  morning('2026-06-02', []),
])
// No corrections at all → quiet, not escalating.
const calm = auditLeadPolicyGovernance([
  morning('2026-06-01', []),
  morning('2026-06-02', []),
])
// One morning only → below the auditor's min-history floor → abstained.
const tooShort = auditLeadPolicyGovernance([morning('2026-06-02', ['verify'])])

// ── policies (only the knobs the remediator reads matter: bounds, safety_floor_lanes, lane_overrides) ──
const P0 = { status: 'tuned', neutral_rate: 0.5, bounds: { min: 0.8, max: 1.2 }, safety_floor_lanes: ['act_now'], lanes: {} }
const P_band = { ...P0, lane_overrides: { verify: { neutral_band: 0.1 } } }                 // rung 2 → tighten
const P_bounds = { ...P0, lane_overrides: { verify: { bounds: { min: 0.9, max: 1.1 } } } }  // rung 3 → pin
const P_pinned = { ...P0, lane_overrides: { verify: { pinned: true } } }                    // ceiling → abstain
const P_tightGlobal = { ...P0, bounds: { min: 0.9, max: 1.1 }, lane_overrides: { verify: { neutral_band: 0.1 } } } // tighten clamps to floor

const REMEDIES = ['widen_neutral_band', 'tighten_bounds', 'pin_neutral']

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o)) deepFreeze(o[k])
  }
  return o
}

// ─────────────────────────────────────────────────────────────────────────────

test('the audit fixtures actually carry the contract the remediator reads (sanity) (17a)', () => {
  assert.strictEqual(churnVerify.status, 'churning')
  assert.deepStrictEqual(churnVerify.recommendation, { action: 'escalate', lanes: ['verify'] })
  assert.strictEqual(churnVerify.lanes.verify.current_run, 4)
  assert.strictEqual(effective.recommendation.action, 'none')
  assert.strictEqual(calm.recommendation.action, 'none')
  assert.strictEqual(tooShort.status, 'abstained')
})

test('the four roll-up statuses land from real auditor output paired with the right policy (17a)', () => {
  // churning + a policy with room to act → a fix is staged.
  const proposed = proposeLeadPolicyRemediation(churnVerify, P0)
  assert.strictEqual(proposed.status, 'remediation_proposed')
  assert.strictEqual(proposed.proposals.length, 1)
  assert.strictEqual(proposed.as_of, '2026-06-02')

  // churning but the lane is already pinned → nothing left to safely do → steady (at ceiling).
  const ceiling = proposeLeadPolicyRemediation(churnVerify, P_pinned)
  assert.strictEqual(ceiling.status, 'steady')
  assert.deepStrictEqual(ceiling.proposals, [])
  assert.deepStrictEqual(ceiling.abstained_lanes, [{ lane: 'verify', reason: 'at_ceiling' }])

  // not escalating (corrections took) → steady, by the auditor's own call.
  assert.strictEqual(proposeLeadPolicyRemediation(effective, P0).status, 'steady')
  assert.strictEqual(proposeLeadPolicyRemediation(calm, P0).status, 'steady')

  // the audit itself couldn't judge → we abstain too.
  assert.strictEqual(proposeLeadPolicyRemediation(tooShort, P0).status, 'abstained')
})

test('the ladder escalates by what is already in place: widen → tighten → pin → at_ceiling (17a)', () => {
  // Rung 1 — nothing tried yet → the gentlest move, a fresh dead-band.
  const widen = proposeLeadPolicyRemediation(churnVerify, P0).proposals[0]
  assert.strictEqual(widen.remedy, 'widen_neutral_band')
  assert.strictEqual(widen.lane, 'verify')
  assert.deepStrictEqual(widen.from, { neutral_band: 0 })
  assert.deepStrictEqual(widen.to, { neutral_band: 0.1 })

  // Rung 2 — a dead-band already present → tighten the bounds (from the policy's GLOBAL bounds).
  const tighten = proposeLeadPolicyRemediation(churnVerify, P_band).proposals[0]
  assert.strictEqual(tighten.remedy, 'tighten_bounds')
  assert.deepStrictEqual(tighten.from, { bounds: { min: 0.8, max: 1.2 } })
  assert.deepStrictEqual(tighten.to, { bounds: { min: 0.9, max: 1.1 } })

  // Rung 3 — tightened bounds already present → pin the lane out of the loop.
  const pin = proposeLeadPolicyRemediation(churnVerify, P_bounds).proposals[0]
  assert.strictEqual(pin.remedy, 'pin_neutral')
  assert.deepStrictEqual(pin.from, { pinned: false })
  assert.deepStrictEqual(pin.to, { pinned: true })

  // Ceiling — already pinned and STILL churning → no proposal, surfaced for a human.
  const ceiling = proposeLeadPolicyRemediation(churnVerify, P_pinned)
  assert.deepStrictEqual(ceiling.proposals, [])
  assert.deepStrictEqual(ceiling.abstained_lanes, [{ lane: 'verify', reason: 'at_ceiling' }])
})

test('tighten clamps to the bound floor and never inverts (17a)', () => {
  const tighten = proposeLeadPolicyRemediation(churnVerify, P_tightGlobal).proposals[0]
  assert.strictEqual(tighten.remedy, 'tighten_bounds')
  // from the already-narrow global {0.9,1.1}, one more step would hit {1.0,1.0}; the floor stops it.
  assert.deepStrictEqual(tighten.to, { bounds: { min: 0.95, max: 1.05 } })
  assert.ok(tighten.to.bounds.min < 1 && tighten.to.bounds.max > 1, 'bounds must still straddle neutral, never invert')
  assert.deepStrictEqual(tighten.to.bounds, DEFAULT_BOUND_FLOOR)
})

test('the dead-band widen is capped at BAND_MAX even under an oversized step (17a)', () => {
  const widen = proposeLeadPolicyRemediation(churnVerify, P0, { bandStep: 1.0 }).proposals[0]
  assert.strictEqual(widen.remedy, 'widen_neutral_band')
  assert.deepStrictEqual(widen.to, { neutral_band: DEFAULT_BAND_MAX })
})

test('the safety floor is NEVER remediated — act_now is abstained, not proposed (17a)', () => {
  const res = proposeLeadPolicyRemediation(churnActNow, P0)
  assert.strictEqual(res.status, 'steady')
  assert.deepStrictEqual(res.proposals, [])
  assert.deepStrictEqual(res.abstained_lanes, [{ lane: 'act_now', reason: 'safety_floored' }])

  // a policy may declare its OWN floor set — the remediator honours it, not just the module default.
  const customFloor = { ...P0, safety_floor_lanes: ['verify', 'act_now'] }
  const res2 = proposeLeadPolicyRemediation(churnVerify, customFloor)
  assert.strictEqual(res2.status, 'steady')
  assert.deepStrictEqual(res2.abstained_lanes, [{ lane: 'verify', reason: 'safety_floored' }])
})

test('multiple churning lanes sort most-severe-first with a stable lane-name tiebreak (17a)', () => {
  const two = proposeLeadPolicyRemediation(churnTwo, P0)
  assert.strictEqual(two.proposals.length, 2)
  assert.deepStrictEqual(two.proposals.map(p => p.lane), ['verify', 'worth_a_look']) // 4 before 3
  assert.deepStrictEqual(two.proposals.map(p => p.severity), [4, 3])

  // equal severity → ascending lane name; and 'monitor' is treated as an ordinary churning lane.
  const tie = proposeLeadPolicyRemediation(churnTie, P0)
  assert.deepStrictEqual(tie.proposals.map(p => p.lane), ['monitor', 'verify'])
  assert.deepStrictEqual(tie.proposals.map(p => p.severity), [3, 3])
})

test('mixed remedies still sort by severity across remedy types (17a)', () => {
  // worth_a_look (run 5, no override → widen) must outrank verify (run 3, has band → tighten).
  const res = proposeLeadPolicyRemediation(churnMixed, P_band)
  assert.deepStrictEqual(res.proposals.map(p => [p.lane, p.remedy, p.severity]), [
    ['worth_a_look', 'widen_neutral_band', 5],
    ['verify', 'tighten_bounds', 3],
  ])
})

test('every proposal is reversible and well-formed (17a)', () => {
  const all = [
    ...proposeLeadPolicyRemediation(churnMixed, P_band).proposals,
    proposeLeadPolicyRemediation(churnVerify, P_bounds).proposals[0], // a pin, to cover that shape
  ]
  for (const p of all) {
    assert.ok(typeof p.lane === 'string' && p.lane, 'lane is a non-empty string')
    assert.ok(REMEDIES.includes(p.remedy), `remedy ${p.remedy} is one of the three`)
    assert.ok(Number.isInteger(p.severity) && p.severity > 0, 'severity is a positive integer')
    assert.ok(p.from && typeof p.from === 'object', 'carries a from')
    assert.ok(p.to && typeof p.to === 'object', 'carries a to')
    assert.strictEqual(p.reversible, true)
    assert.notDeepStrictEqual(p.from, p.to, 'from and to actually differ')
    assert.ok(typeof p.rationale === 'string' && p.rationale.length > 0, 'has a rationale')
  }
})

test('shouldStageRemediation is true only when a fix is staged (17a)', () => {
  assert.strictEqual(shouldStageRemediation(proposeLeadPolicyRemediation(churnVerify, P0)), true)
  assert.strictEqual(shouldStageRemediation(proposeLeadPolicyRemediation(churnVerify, P_pinned)), false) // steady
  assert.strictEqual(shouldStageRemediation(proposeLeadPolicyRemediation(effective, P0)), false)         // steady
  assert.strictEqual(shouldStageRemediation(proposeLeadPolicyRemediation(tooShort, P0)), false)          // abstained
  assert.strictEqual(shouldStageRemediation(null), false)
  assert.strictEqual(shouldStageRemediation({ status: 'remediation_proposed', proposals: [] }), false)   // no proposals
})

test('narrateLeadPolicyRemediation is silent for the CLIENT across every status (17a)', () => {
  const cases = [
    proposeLeadPolicyRemediation(churnVerify, P0),     // remediation_proposed
    proposeLeadPolicyRemediation(churnVerify, P_pinned), // steady (ceiling)
    proposeLeadPolicyRemediation(effective, P0),        // steady
    proposeLeadPolicyRemediation(tooShort, P0),         // abstained
  ]
  for (const r of cases) assert.strictEqual(narrateLeadPolicyRemediation(r, { audience: 'client' }), '')
})

test('narrateLeadPolicyRemediation speaks to the AGENCY only when a fix is staged (17a)', () => {
  // proposed → names the top lane + its remedy phrase, and counts the rest.
  const mixed = proposeLeadPolicyRemediation(churnMixed, P_band)
  const line = narrateLeadPolicyRemediation(mixed, { audience: 'agency' })
  assert.ok(line.length > 0)
  assert.ok(line.includes(humanizeLane('worth_a_look')), 'names the most-severe lane')
  assert.ok(line.includes('dead-band'), 'speaks the top remedy (widen)')
  assert.ok(line.includes('plus 1 other lane flagged'), 'counts the remaining lanes')
  assert.ok(line.includes('reversible'), 'reassures it is reversible')

  // single proposal → no "(plus N…)" tail.
  const one = narrateLeadPolicyRemediation(proposeLeadPolicyRemediation(churnVerify, P0), { audience: 'agency' })
  assert.ok(one.includes(humanizeLane('verify')))
  assert.ok(!one.includes('plus'), 'no plus-tail for a single lane')

  // steady & abstained → silent even to the agency (a loop that needs no fix is not news).
  assert.strictEqual(narrateLeadPolicyRemediation(proposeLeadPolicyRemediation(churnVerify, P_pinned), { audience: 'agency' }), '')
  assert.strictEqual(narrateLeadPolicyRemediation(proposeLeadPolicyRemediation(effective, P0), { audience: 'agency' }), '')
  assert.strictEqual(narrateLeadPolicyRemediation(proposeLeadPolicyRemediation(tooShort, P0), { audience: 'agency' }), '')
  // default audience is agency (no opts) — proposed still speaks.
  assert.ok(narrateLeadPolicyRemediation(mixed).length > 0)
})

test('pure: never throws on malformed input and never mutates its inputs (17a)', () => {
  assert.doesNotThrow(() => proposeLeadPolicyRemediation(null, null))
  assert.doesNotThrow(() => proposeLeadPolicyRemediation(undefined, undefined))
  assert.doesNotThrow(() => proposeLeadPolicyRemediation({}, {}))
  assert.doesNotThrow(() => proposeLeadPolicyRemediation({ status: 'churning' }, {}))
  assert.doesNotThrow(() => proposeLeadPolicyRemediation(churnVerify, 'garbage'))
  assert.doesNotThrow(() => proposeLeadPolicyRemediation(churnVerify, { lane_overrides: 'bad', bounds: 'bad', safety_floor_lanes: 'bad' }))
  // malformed inputs still abstain/steady cleanly rather than crashing.
  assert.strictEqual(proposeLeadPolicyRemediation(null, null).status, 'abstained')
  assert.strictEqual(proposeLeadPolicyRemediation({ status: 'churning' }, {}).status, 'steady') // escalate-less → steady

  // deep-frozen inputs prove non-mutation: a frozen write would throw under 'use strict'.
  const frozenAudit = deepFreeze(auditLeadPolicyGovernance([
    morning('2026-05-30', ['verify']),
    morning('2026-05-31', ['verify']),
    morning('2026-06-01', ['verify']),
    morning('2026-06-02', ['verify']),
  ]))
  const frozenPolicy = deepFreeze({ ...P0, lane_overrides: { verify: { neutral_band: 0.1 } } })
  let res
  assert.doesNotThrow(() => { res = proposeLeadPolicyRemediation(frozenAudit, frozenPolicy) })
  assert.strictEqual(res.proposals[0].remedy, 'tighten_bounds')
})

test('exported tuning constants are the documented safe steps (17a)', () => {
  assert.strictEqual(DEFAULT_BAND_STEP, 0.1)
  assert.strictEqual(DEFAULT_BAND_MAX, 0.25)
  assert.strictEqual(DEFAULT_BOUND_STEP, 0.1)
  assert.deepStrictEqual(DEFAULT_BOUND_FLOOR, { min: 0.95, max: 1.05 })
})
