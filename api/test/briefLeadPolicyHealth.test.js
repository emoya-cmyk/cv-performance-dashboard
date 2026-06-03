'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  assessLeadPolicyHealth,
  shouldRevertToNeutral,
  narrateLeadPolicyHealth,
  humanizeLane,
  DEFAULT_WINDOW,
  DEFAULT_OSCILLATION_FLIPS,
} = require('../lib/briefLeadPolicyHealth')

// ── tiny helpers (briefLeadPolicy-test house style) ──────────────────────────
// one lane cell as deriveLeadPolicy emits it; the monitor reads only weight/direction/safetyFloored.
const lane = (weight, direction, floored = false) => ({
  weight,
  direction: direction || (weight > 1 ? 'promote' : weight < 1 ? 'demote' : 'neutral'),
  adjusted: weight !== 1,
  safetyFloored: !!floored,
})
// one deriveLeadPolicy-shaped snapshot. as_of, when given, rides alongside lanes (the
// { as_of, ...policy } shape the monitor normalises).
const snap = (lanes, as_of) => ({
  status: 'tuned', neutral_rate: 0.5, min_sample: 4,
  bounds: { min: 0.8, max: 1.2 }, safety_floor_lanes: ['act_now'],
  lanes,
  ...(as_of ? { as_of } : {}),
})
// freeze a structure so any accidental input mutation throws (purity proof).
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) }
  return o
}

// ============================================================
// abstention — one snapshot is not a trend
// ============================================================

test('assess: empty / non-array history abstains', () => {
  for (const h of [[], undefined, null, 'nope', 42]) {
    const v = assessLeadPolicyHealth(h)
    assert.equal(v.status, 'abstained')
    assert.equal(v.recommended_action, 'none')
    assert.deepEqual(v.lanes, {})
    assert.equal(v.counts.active, 0)
    assert.equal(v.verdict_reason, 'abstained:thin_history')
  }
})

test('assess: a single usable snapshot still abstains (minHistory 2)', () => {
  const v = assessLeadPolicyHealth([snap({ verify: lane(1.1, 'promote') })])
  assert.equal(v.status, 'abstained')
  assert.equal(v.history_len, 1)
})

test('assess: unusable elements are skipped, not counted', () => {
  // two garbage entries + one real → still below minHistory → abstain.
  const v = assessLeadPolicyHealth([null, { nope: true }, snap({ verify: lane(1.1, 'promote') })])
  assert.equal(v.status, 'abstained')
  assert.equal(v.history_len, 1)
})

// ============================================================
// stable / settling / idle — the healthy band
// ============================================================

test('assess: a lane converged at one weight reads stable → trust', () => {
  const h = [
    snap({ tailwind: lane(1.1, 'promote') }),
    snap({ tailwind: lane(1.1, 'promote') }),
    snap({ tailwind: lane(1.1, 'promote') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.status, 'stable')
  assert.equal(v.recommended_action, 'trust')
  assert.equal(v.verdict_reason, 'converged')
  assert.equal(v.lanes.tailwind.state, 'stable')
  assert.equal(v.lanes.tailwind.spread, 0)
  assert.equal(v.counts.stable, 1)
  assert.equal(v.counts.active, 1)
  assert.equal(shouldRevertToNeutral(v), false)
})

test('assess: a lane still drifting (spread > epsilon) reads settling → hold', () => {
  const h = [
    snap({ tailwind: lane(1.02, 'promote') }),
    snap({ tailwind: lane(1.06, 'promote') }),
    snap({ tailwind: lane(1.10, 'promote') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.status, 'settling')
  assert.equal(v.recommended_action, 'hold')
  assert.equal(v.lanes.tailwind.state, 'settling')
  assert.ok(v.lanes.tailwind.spread > 0.02)
  // settling is no-news: agency narration is silent.
  assert.equal(narrateLeadPolicyHealth(v, { audience: 'agency' }), '')
})

test('assess: a lane held at neutral the whole window is idle, not stable', () => {
  const h = [
    snap({ verify: lane(1, 'neutral') }),
    snap({ verify: lane(1, 'neutral') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.lanes.verify.state, 'idle')
  assert.equal(v.counts.idle, 1)
  assert.equal(v.counts.active, 0)
  assert.equal(v.status, 'idle')
  assert.equal(v.recommended_action, 'none')
  assert.equal(narrateLeadPolicyHealth(v, { audience: 'agency' }), '')
})

// ============================================================
// oscillation — the loop chasing noise → self-healing revert
// ============================================================

test('assess: a lane flipping promote↔demote reads oscillating → revert_to_neutral', () => {
  const h = [
    snap({ verify: lane(1.1, 'promote') }),
    snap({ verify: lane(0.9, 'demote') }),
    snap({ verify: lane(1.1, 'promote') }),
    snap({ verify: lane(0.9, 'demote') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.lanes.verify.state, 'oscillating')
  assert.equal(v.lanes.verify.flips, 3)
  assert.equal(v.status, 'unstable')
  assert.equal(v.recommended_action, 'revert_to_neutral')
  assert.ok(v.verdict_reason.startsWith('oscillation:verify'))
  assert.equal(shouldRevertToNeutral(v), true)
})

test('assess: a single reversal is a correction, not an oscillation', () => {
  // promote → demote is ONE flip; needs DEFAULT_OSCILLATION_FLIPS (2) to read unstable.
  assert.equal(DEFAULT_OSCILLATION_FLIPS, 2)
  const h = [
    snap({ verify: lane(1.1, 'promote') }),
    snap({ verify: lane(0.9, 'demote') }),
    snap({ verify: lane(0.9, 'demote') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.notEqual(v.lanes.verify.state, 'oscillating')
  assert.equal(shouldRevertToNeutral(v), false)
})

// ============================================================
// saturation — the band has run out of room → widen_bounds
// ============================================================

test('assess: a weight pinned at the ceiling reads saturated_high → widen_bounds', () => {
  const h = [
    snap({ tailwind: lane(1.1, 'promote') }),
    snap({ tailwind: lane(1.2, 'promote') }),
    snap({ tailwind: lane(1.2, 'promote') }),
    snap({ tailwind: lane(1.2, 'promote') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.lanes.tailwind.state, 'saturated_high')
  assert.equal(v.lanes.tailwind.high_run, 3)
  assert.equal(v.status, 'constrained')
  assert.equal(v.recommended_action, 'widen_bounds')
  assert.equal(shouldRevertToNeutral(v), false)
})

test('assess: a weight pinned at the floor reads saturated_low → widen_bounds', () => {
  const h = [
    snap({ worth_a_look: lane(0.9, 'demote') }),
    snap({ worth_a_look: lane(0.8, 'demote') }),
    snap({ worth_a_look: lane(0.8, 'demote') }),
    snap({ worth_a_look: lane(0.8, 'demote') }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.lanes.worth_a_look.state, 'saturated_low')
  assert.equal(v.lanes.worth_a_look.low_run, 3)
  assert.equal(v.status, 'constrained')
  assert.equal(v.recommended_action, 'widen_bounds')
})

test('assess: coming OFF the bound on the newest morning is not saturation', () => {
  const h = [
    snap({ tailwind: lane(1.2, 'promote') }),
    snap({ tailwind: lane(1.2, 'promote') }),
    snap({ tailwind: lane(1.2, 'promote') }),
    snap({ tailwind: lane(1.15, 'promote') }), // newest dipped off the ceiling
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.lanes.tailwind.high_run, 0)
  assert.notEqual(v.lanes.tailwind.state, 'saturated_high')
})

// ============================================================
// floor-masking — the safety valve hiding a standing overcall → investigate_floor
// ============================================================

test('assess: act_now floored morning after morning reads floor_masked → investigate_floor', () => {
  const h = [
    snap({ act_now: lane(1, 'neutral', true) }),
    snap({ act_now: lane(1, 'neutral', true) }),
    snap({ act_now: lane(1, 'neutral', true) }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.lanes.act_now.state, 'floor_masked')
  assert.equal(v.lanes.act_now.mask_runs, 3)
  assert.equal(v.status, 'flagged')
  assert.equal(v.recommended_action, 'investigate_floor')
  assert.equal(v.verdict_reason, 'floor_mask:act_now')
  // floor-masking is a concern, NOT instability — the loop itself is not reverted.
  assert.equal(shouldRevertToNeutral(v), false)
})

// ============================================================
// precedence — most urgent concern wins the single action
// ============================================================

test('assess: oscillation outranks a concurrent floor-mask (revert wins, mask still counted)', () => {
  const h = [
    snap({ verify: lane(1.1, 'promote'), act_now: lane(1, 'neutral', true) }),
    snap({ verify: lane(0.9, 'demote'), act_now: lane(1, 'neutral', true) }),
    snap({ verify: lane(1.1, 'promote'), act_now: lane(1, 'neutral', true) }),
    snap({ verify: lane(0.9, 'demote'), act_now: lane(1, 'neutral', true) }),
  ]
  const v = assessLeadPolicyHealth(h)
  assert.equal(v.status, 'unstable')
  assert.equal(v.recommended_action, 'revert_to_neutral')
  assert.equal(v.counts.oscillating, 1)
  assert.equal(v.counts.masked, 1)
  assert.equal(shouldRevertToNeutral(v), true)
})

// ============================================================
// no-leak discipline — narration is agency-only
// ============================================================

test('narrate: the client branch is hard-wired to "" for every status', () => {
  const histories = {
    unstable: [snap({ verify: lane(1.1, 'promote') }), snap({ verify: lane(0.9, 'demote') }), snap({ verify: lane(1.1, 'promote') }), snap({ verify: lane(0.9, 'demote') })],
    constrained: [snap({ tailwind: lane(1.2, 'promote') }), snap({ tailwind: lane(1.2, 'promote') }), snap({ tailwind: lane(1.2, 'promote') })],
    flagged: [snap({ act_now: lane(1, 'neutral', true) }), snap({ act_now: lane(1, 'neutral', true) }), snap({ act_now: lane(1, 'neutral', true) })],
    stable: [snap({ tailwind: lane(1.1, 'promote') }), snap({ tailwind: lane(1.1, 'promote') })],
  }
  for (const h of Object.values(histories)) {
    const v = assessLeadPolicyHealth(h)
    assert.equal(narrateLeadPolicyHealth(v, { audience: 'client' }), '', `status ${v.status} must be silent to the client`)
  }
  // default audience is agency, never client.
  assert.equal(narrateLeadPolicyHealth(null, { audience: 'client' }), '')
})

test('narrate: agency hears a specific, lane-named sentence for each concern', () => {
  const unstable = assessLeadPolicyHealth([snap({ verify: lane(1.1, 'promote') }), snap({ verify: lane(0.9, 'demote') }), snap({ verify: lane(1.1, 'promote') }), snap({ verify: lane(0.9, 'demote') })])
  const sU = narrateLeadPolicyHealth(unstable, { audience: 'agency' })
  assert.match(sU, /oscillating on verify/)
  assert.match(sU, /neutral lead order/)

  const constrained = assessLeadPolicyHealth([snap({ tailwind: lane(1.1, 'promote') }), snap({ tailwind: lane(1.2, 'promote') }), snap({ tailwind: lane(1.2, 'promote') }), snap({ tailwind: lane(1.2, 'promote') })])
  const sC = narrateLeadPolicyHealth(constrained, { audience: 'agency' })
  assert.match(sC, /pinned tailwind at its ceiling/)
  assert.match(sC, /±20% band may be too tight/)
  assert.match(sC, /for 3 mornings/)

  const flagged = assessLeadPolicyHealth([snap({ act_now: lane(1, 'neutral', true) }), snap({ act_now: lane(1, 'neutral', true) }), snap({ act_now: lane(1, 'neutral', true) })])
  const sF = narrateLeadPolicyHealth(flagged, { audience: 'agency' })
  assert.match(sF, /safety floor has caught act now/)
  assert.match(sF, /worth a look/)

  const stable = assessLeadPolicyHealth([snap({ tailwind: lane(1.1, 'promote') }), snap({ tailwind: lane(1.1, 'promote') })])
  assert.match(narrateLeadPolicyHealth(stable, { audience: 'agency' }), /settled/)
})

// ============================================================
// windowing, thresholds, carried fields, purity
// ============================================================

test('assess: window looks only at the most-recent snapshots', () => {
  // older half oscillates, recent two are steady.
  const h = [
    snap({ verify: lane(0.9, 'demote') }),
    snap({ verify: lane(1.1, 'promote') }),
    snap({ verify: lane(0.9, 'demote') }),
    snap({ verify: lane(1.1, 'promote') }),
    snap({ verify: lane(1.1, 'promote') }),
    snap({ verify: lane(1.1, 'promote') }),
  ]
  assert.equal(assessLeadPolicyHealth(h, { window: DEFAULT_WINDOW }).status, 'unstable') // full view: thrash
  assert.equal(assessLeadPolicyHealth(h, { window: 2 }).status, 'stable')                // recent view: settled
})

test('assess: custom thresholds are honoured', () => {
  const flip3 = [snap({ verify: lane(1.1, 'promote') }), snap({ verify: lane(0.9, 'demote') }), snap({ verify: lane(1.1, 'promote') }), snap({ verify: lane(0.9, 'demote') })]
  // raising the flip bar above the observed 3 reversals stops it reading as oscillation.
  assert.notEqual(assessLeadPolicyHealth(flip3, { oscillationFlips: 4 }).lanes.verify.state, 'oscillating')

  const run2 = [snap({ tailwind: lane(1.2, 'promote') }), snap({ tailwind: lane(1.2, 'promote') })]
  // lowering the saturation bar catches a 2-morning pin.
  assert.equal(assessLeadPolicyHealth(run2, { saturationRuns: 2 }).lanes.tailwind.state, 'saturated_high')
})

test('assess: as_of and bounds are carried from the newest snapshot', () => {
  const v = assessLeadPolicyHealth([
    snap({ tailwind: lane(1.1, 'promote') }, '2026-05-01'),
    snap({ tailwind: lane(1.1, 'promote') }, '2026-05-08'),
  ])
  assert.equal(v.as_of, '2026-05-08')
  assert.deepEqual(v.bounds, { min: 0.8, max: 1.2 })
  assert.equal(v.window_used, 2)
  assert.equal(v.history_len, 2)
})

test('assess: accepts the { as_of, policy } wrapper shape', () => {
  const v = assessLeadPolicyHealth([
    { as_of: '2026-05-01', policy: snap({ tailwind: lane(1.1, 'promote') }) },
    { as_of: '2026-05-08', policy: snap({ tailwind: lane(1.1, 'promote') }) },
  ])
  assert.equal(v.status, 'stable')
  assert.equal(v.as_of, '2026-05-08')
})

test('assess: per-lane series aligns to the window with nulls for gaps', () => {
  const v = assessLeadPolicyHealth([
    snap({ a: lane(1.1, 'promote') }),
    snap({ b: lane(0.9, 'demote') }),
  ])
  assert.deepEqual(v.lanes.a.series, [1.1, null])
  assert.deepEqual(v.lanes.b.series, [null, 0.9])
  assert.equal(v.lanes.a.present, 1)
})

test('assess: is pure — frozen input, identical repeated output, no mutation', () => {
  const h = deepFreeze([
    snap({ verify: lane(1.1, 'promote'), act_now: lane(1, 'neutral', true) }),
    snap({ verify: lane(0.9, 'demote'), act_now: lane(1, 'neutral', true) }),
    snap({ verify: lane(1.1, 'promote'), act_now: lane(1, 'neutral', true) }),
  ])
  const a = assessLeadPolicyHealth(h)
  const b = assessLeadPolicyHealth(h)
  assert.deepEqual(a, b)
})

test('shouldRevertToNeutral: true only for an oscillation verdict', () => {
  assert.equal(shouldRevertToNeutral(null), false)
  assert.equal(shouldRevertToNeutral({ recommended_action: 'trust' }), false)
  assert.equal(shouldRevertToNeutral({ recommended_action: 'widen_bounds' }), false)
  assert.equal(shouldRevertToNeutral({ recommended_action: 'investigate_floor' }), false)
  assert.equal(shouldRevertToNeutral({ recommended_action: 'revert_to_neutral' }), true)
})

test('humanizeLane: underscores to spaces, lowercased', () => {
  assert.equal(humanizeLane('worth_a_look'), 'worth a look')
  assert.equal(humanizeLane('act_now'), 'act now')
})
