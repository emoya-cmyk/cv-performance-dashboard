'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  rawLaneWeight,
  deriveLeadPolicy,
  applyLeadPolicy,
  narrateLeadPolicy,
  humanizeLane,
  SAFETY_FLOOR_LANES,
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
} = require('../lib/briefLeadPolicy')

// ── tiny helpers (briefImpact-test house style) ──────────────────────────────
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

// a by_lane bucket as briefImpact emits it; deriveLeadPolicy reads only judged/hit_rate/label.
const bkt = (hit_rate, extra = {}) => {
  const hits = Math.round(hit_rate * 10)
  return { sample: 10, judged: 10, hits, misses: 10 - hits, unknown: 0, hit_rate, label: null, ...extra }
}
// a bucket too thin to grade (judged < DEFAULT_MIN_SAMPLE = 4).
const thin = (extra = {}) => ({ sample: 2, judged: 2, hits: 2, misses: 0, unknown: 0, hit_rate: 1, label: 'earned', ...extra })

const graded   = (by_lane) => ({ status: 'graded', by_lane })
const ungraded = (by_lane = {}) => ({ status: 'insufficient', by_lane })

// ============================================================
// rawLaneWeight — the bounded, endpoint-pinned magnitude map
// ============================================================

test('rawLaneWeight: a thin bucket abstains to neutral (weight 1, insufficient_sample)', () => {
  const r = rawLaneWeight(thin())
  assert.equal(r.weight, 1)
  assert.equal(r.adjusted, false)
  assert.equal(r.reason, 'insufficient_sample')
  assert.equal(r.direction, 'neutral')
})

test('rawLaneWeight: a null/non-finite hit_rate abstains to neutral even with sample', () => {
  const r = rawLaneWeight({ judged: 10, hit_rate: null, label: null })
  assert.equal(r.weight, 1)
  assert.equal(r.reason, 'insufficient_sample')
})

test('rawLaneWeight: a perfect record pins the max-weight endpoint', () => {
  const r = rawLaneWeight(bkt(1.0))
  assert.equal(r.weight, DEFAULT_MAX_WEIGHT) // exactly 1.2 (clamp returns the bound)
  assert.equal(r.direction, 'promote')
  assert.equal(r.reason, 'promoted')
  assert.equal(r.adjusted, true)
})

test('rawLaneWeight: the neutral rate maps to exactly no nudge', () => {
  const r = rawLaneWeight(bkt(0.5))
  assert.equal(r.weight, 1)
  assert.equal(r.direction, 'neutral')
  assert.equal(r.reason, 'neutral')
  assert.equal(r.adjusted, false)
})

test('rawLaneWeight: a never-held record pins the min-weight endpoint', () => {
  const r = rawLaneWeight(bkt(0.0))
  assert.equal(r.weight, DEFAULT_MIN_WEIGHT) // exactly 0.8
  assert.equal(r.direction, 'demote')
  assert.equal(r.reason, 'demoted')
})

test('rawLaneWeight: weight is piecewise-linear and continuous in the hit rate', () => {
  near(rawLaneWeight(bkt(0.8)).weight, 1.12) // 1 + (0.8-0.5)*((1.2-1)/(1-0.5))
  near(rawLaneWeight(bkt(0.6)).weight, 1.04)
  near(rawLaneWeight(bkt(0.3)).weight, 0.92) // 1 - (0.5-0.3)*((1-0.8)/0.5)
  near(rawLaneWeight(bkt(0.2)).weight, 0.88)
})

test('rawLaneWeight: out-of-range hit rates are clamped to the bounds (defensive)', () => {
  assert.equal(rawLaneWeight(bkt(9)).weight, DEFAULT_MAX_WEIGHT)
  assert.equal(rawLaneWeight(bkt(-9)).weight, DEFAULT_MIN_WEIGHT)
})

test('rawLaneWeight: custom bounds widen the nudge symmetrically', () => {
  assert.equal(rawLaneWeight(bkt(1.0), { maxWeight: 1.5 }).weight, 1.5)
  assert.equal(rawLaneWeight(bkt(0.0), { minWeight: 0.6 }).weight, 0.6)
})

test('rawLaneWeight: a custom neutral rate re-centres the no-nudge point', () => {
  // neutral 0.7 ⇒ a 0.7 record is neutral, below it demotes.
  assert.equal(rawLaneWeight(bkt(0.7), { neutralRate: 0.7 }).weight, 1)
  assert.ok(rawLaneWeight(bkt(0.5), { neutralRate: 0.7 }).weight < 1)
})

test('rawLaneWeight: never throws on a garbage bucket', () => {
  for (const junk of [null, undefined, {}, { judged: 'x' }, { hit_rate: 'y', judged: 9 }, 42]) {
    const r = rawLaneWeight(junk)
    assert.equal(r.weight, 1)
  }
})

// ============================================================
// deriveLeadPolicy — grade → per-lane policy, with the safety floor
// ============================================================

test('deriveLeadPolicy: an un-graded grade abstains — every lane neutral', () => {
  const p = deriveLeadPolicy(ungraded({ act_now: bkt(1.0), verify: bkt(0.1) }))
  assert.equal(p.status, 'abstained')
  assert.equal(p.adjusted_count, 0)
  for (const k of Object.keys(p.lanes)) {
    assert.equal(p.lanes[k].weight, 1)
    assert.equal(p.lanes[k].reason, 'abstained')
  }
})

test('deriveLeadPolicy: not-graded junk abstains with an empty lane set (no throw)', () => {
  for (const junk of [null, undefined, {}, { status: 'insufficient' }, ungraded()]) {
    const p = deriveLeadPolicy(junk)
    assert.equal(p.status, 'abstained')
    assert.deepEqual(p.lanes, {})
  }
})

test('deriveLeadPolicy: graded-but-laneless is idle, not abstained (the distinction holds)', () => {
  // 'graded' means the corpus was gradeable; with no by_lane to act on there is simply
  // nothing to tune → 'idle'. Only a NOT-graded grade abstains. Neither throws.
  for (const junk of [{ status: 'graded' }, { status: 'graded', by_lane: 'x' }, { status: 'graded', by_lane: null }]) {
    const p = deriveLeadPolicy(junk)
    assert.equal(p.status, 'idle')
    assert.deepEqual(p.lanes, {})
  }
})

test('deriveLeadPolicy: graded-but-all-thin is idle (nothing crossed sample)', () => {
  const p = deriveLeadPolicy(graded({ verify: thin(), monitor: thin() }))
  assert.equal(p.status, 'idle')
  assert.equal(p.adjusted_count, 0)
  assert.equal(p.lanes.verify.weight, 1)
  assert.equal(p.lanes.verify.reason, 'insufficient_sample')
})

test('deriveLeadPolicy: a graded mix tunes — promote/demote counts are exact', () => {
  const p = deriveLeadPolicy(graded({
    tailwind: bkt(0.9),   // promote
    verify:   bkt(0.2),   // demote
    monitor:  bkt(0.5),   // neutral
    worth_a_look: thin(), // abstain (thin)
  }))
  assert.equal(p.status, 'tuned')
  assert.equal(p.promoted, 1)
  assert.equal(p.demoted, 1)
  assert.equal(p.adjusted_count, 2)
  assert.ok(p.lanes.tailwind.weight > 1)
  assert.ok(p.lanes.verify.weight < 1)
  assert.equal(p.lanes.monitor.weight, 1)
  assert.equal(p.lanes.worth_a_look.weight, 1)
})

test('deriveLeadPolicy: SAFETY FLOOR — an overcalled act_now is never demoted', () => {
  const p = deriveLeadPolicy(graded({ act_now: bkt(0.1), verify: bkt(0.9) }))
  const a = p.lanes.act_now
  assert.equal(a.weight, 1, 'act_now floored to neutral, never below')
  assert.equal(a.safetyFloored, true)
  assert.equal(a.reason, 'safety_floored')
  assert.equal(a.direction, 'neutral')
  assert.equal(a.adjusted, false)
  assert.equal(p.floored, 1)
  // its real (un-acted-on) record is still reported honestly:
  near(a.hit_rate, 0.1)
  assert.equal(a.judged, 10)
  // the other lane still tunes, so the policy as a whole is 'tuned'.
  assert.equal(p.status, 'tuned')
  assert.ok(p.lanes.verify.weight > 1)
})

test('deriveLeadPolicy: the floor is one-way — a strong act_now IS promoted', () => {
  const p = deriveLeadPolicy(graded({ act_now: bkt(1.0) }))
  const a = p.lanes.act_now
  assert.equal(a.weight, DEFAULT_MAX_WEIGHT)
  assert.equal(a.safetyFloored, false)
  assert.equal(a.direction, 'promote')
  assert.equal(p.promoted, 1)
  assert.equal(p.floored, 0)
})

test('deriveLeadPolicy: a non-safety lane is freely demoted', () => {
  const p = deriveLeadPolicy(graded({ verify: bkt(0.0) }))
  assert.equal(p.lanes.verify.weight, DEFAULT_MIN_WEIGHT)
  assert.equal(p.lanes.verify.safetyFloored, false)
  assert.equal(p.demoted, 1)
})

test('deriveLeadPolicy: custom safetyFloorLanes can protect another lane', () => {
  const p = deriveLeadPolicy(graded({ verify: bkt(0.1) }), { safetyFloorLanes: ['verify'] })
  assert.equal(p.lanes.verify.weight, 1)
  assert.equal(p.lanes.verify.safetyFloored, true)
  assert.deepEqual(p.safety_floor_lanes, ['verify'])
})

test('deriveLeadPolicy: echoes its calibration knobs for the surface to show', () => {
  const p = deriveLeadPolicy(graded({ monitor: bkt(0.5) }))
  assert.equal(p.min_sample, 4)
  assert.equal(p.neutral_rate, 0.5)
  assert.deepEqual(p.bounds, { min: DEFAULT_MIN_WEIGHT, max: DEFAULT_MAX_WEIGHT })
  assert.deepEqual(p.safety_floor_lanes, SAFETY_FLOOR_LANES)
})

test('deriveLeadPolicy: weights are always within [min,max] across the whole grade', () => {
  const p = deriveLeadPolicy(graded({
    a: bkt(1.0), b: bkt(0.0), c: bkt(0.73), d: bkt(0.27), act_now: bkt(0.05),
  }))
  for (const k of Object.keys(p.lanes)) {
    const w = p.lanes[k].weight
    assert.ok(w >= DEFAULT_MIN_WEIGHT - 1e-9 && w <= DEFAULT_MAX_WEIGHT + 1e-9, `${k}=${w} in band`)
  }
})

// ============================================================
// applyLeadPolicy — pure, stable, safety-pinned re-rank
// ============================================================

test('applyLeadPolicy: re-ranks lead candidates by weighted score', () => {
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(1.0) })) // tailwind weight 1.2
  const out = applyLeadPolicy(
    [{ id: 'v', lane: 'verify', score: 100 }, { id: 't', lane: 'tailwind', score: 95 }],
    pol
  )
  assert.equal(out[0].id, 't')              // 95*1.2 = 114 > 100
  assert.equal(out[0].base_score, 95)
  near(out[0].lead_weight, 1.2)
  near(out[0].score, 114)
})

test('applyLeadPolicy: a protected act_now ALWAYS leads, even on a far lower base score', () => {
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(1.0) }))
  const out = applyLeadPolicy(
    [{ id: 't', lane: 'tailwind', score: 1000 }, { id: 'a', lane: 'act_now', score: 1 }],
    pol
  )
  assert.equal(out[0].id, 'a') // a learned tailwind promotion can never bury a live emergency
})

test('applyLeadPolicy: protectLanes:[] opts out — pure weighted order', () => {
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(1.0) }))
  const out = applyLeadPolicy(
    [{ id: 't', lane: 'tailwind', score: 1000 }, { id: 'a', lane: 'act_now', score: 1 }],
    pol,
    { protectLanes: [] }
  )
  assert.equal(out[0].id, 't')
})

test('applyLeadPolicy: a null policy is a safe identity (weights 1) but still protects act_now', () => {
  const out = applyLeadPolicy(
    [{ id: 'x', lane: 'verify', score: 99 }, { id: 'a', lane: 'act_now', score: 1 }],
    null
  )
  assert.equal(out[0].id, 'a')
  assert.equal(out[1].id, 'x')
  near(out[1].score, 99) // base preserved when no policy applies
})

test('applyLeadPolicy: ties are stable — equal weighted scores keep input order', () => {
  const out = applyLeadPolicy(
    [{ id: 'a', lane: 'monitor', score: 50 }, { id: 'b', lane: 'monitor', score: 50 }],
    null
  )
  assert.deepEqual(out.map(c => c.id), ['a', 'b'])
})

test('applyLeadPolicy: preserves the candidate count and never invents/drops one', () => {
  const input = [
    { id: '1', lane: 'verify', score: 10 },
    { id: '2', lane: 'tailwind', score: 9 },
    { id: '3', lane: 'monitor', score: 8 },
  ]
  const out = applyLeadPolicy(input, deriveLeadPolicy(graded({ tailwind: bkt(1.0) })))
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(c => c.id).sort(), ['1', '2', '3'])
})

test('applyLeadPolicy: does NOT mutate the input array or its objects', () => {
  const input = [{ id: 't', lane: 'tailwind', score: 95 }, { id: 'v', lane: 'verify', score: 100 }]
  const before = JSON.stringify(input)
  applyLeadPolicy(input, deriveLeadPolicy(graded({ tailwind: bkt(1.0) })))
  assert.equal(JSON.stringify(input), before)
})

test('applyLeadPolicy: junk in → safe [] out; a missing score is treated as 0', () => {
  assert.deepEqual(applyLeadPolicy(null, null), [])
  assert.deepEqual(applyLeadPolicy('nope', null), [])
  const out = applyLeadPolicy([{ id: 'n', lane: 'verify' }], null)
  assert.equal(out[0].base_score, 0)
  assert.equal(out[0].score, 0)
})

test('applyLeadPolicy: honours a custom scoreKey', () => {
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(1.0) }))
  const out = applyLeadPolicy(
    [{ id: 'v', lane: 'verify', rank: 100 }, { id: 't', lane: 'tailwind', rank: 95 }],
    pol,
    { scoreKey: 'rank' }
  )
  assert.equal(out[0].id, 't')
  near(out[0].rank, 114)
})

// ============================================================
// narrateLeadPolicy — agency-only, never overclaims
// ============================================================

test('narrateLeadPolicy: the CLIENT branch is always empty (internal calibration)', () => {
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(1.0), verify: bkt(0.1) }))
  assert.equal(narrateLeadPolicy(pol, { audience: 'client' }), '')
})

test('narrateLeadPolicy: agency says nothing until the policy is tuned', () => {
  assert.equal(narrateLeadPolicy(deriveLeadPolicy(ungraded()), { audience: 'agency' }), '')
  assert.equal(narrateLeadPolicy(deriveLeadPolicy(graded({ verify: thin() })), { audience: 'agency' }), '')
  assert.equal(narrateLeadPolicy(null, { audience: 'agency' }), '')
})

test('narrateLeadPolicy: a tuned policy names promoted and eased-off lanes, humanized', () => {
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(0.9), worth_a_look: bkt(0.1) }))
  const s = narrateLeadPolicy(pol, { audience: 'agency' })
  assert.match(s, /lead more with tailwind/)
  assert.match(s, /ease off worth a look/) // underscores humanized
  assert.match(s, /track record/)
})

test('narrateLeadPolicy: promote-only omits the ease-off clause', () => {
  const s = narrateLeadPolicy(deriveLeadPolicy(graded({ tailwind: bkt(0.9) })), { audience: 'agency' })
  assert.match(s, /lead more with tailwind/)
  assert.ok(!/ease off/.test(s))
})

test('narrateLeadPolicy: never names a lane that did not actually move', () => {
  // monitor is neutral, act_now is floored — neither should appear.
  const pol = deriveLeadPolicy(graded({ tailwind: bkt(0.9), monitor: bkt(0.5), act_now: bkt(0.1) }))
  const s = narrateLeadPolicy(pol, { audience: 'agency' })
  assert.match(s, /tailwind/)
  assert.ok(!/monitor/.test(s))
  assert.ok(!/act now/.test(s))
})

// ============================================================
// humanizeLane + end-to-end safety integration
// ============================================================

test('humanizeLane: underscores → spaces, lowercased', () => {
  assert.equal(humanizeLane('worth_a_look'), 'worth a look')
  assert.equal(humanizeLane('act_now'), 'act now')
  assert.equal(humanizeLane(null), '')
})

test('integration: an overcalled act_now is neither demoted NOR displaced from the lead', () => {
  // Even with a dismal act_now track record and a stellar tailwind, the emergency leads
  // and its weight is held at neutral — the two-layer safety guarantee, end to end.
  const pol = deriveLeadPolicy(graded({ act_now: bkt(0.05), tailwind: bkt(1.0) }))
  assert.equal(pol.lanes.act_now.weight, 1)
  assert.equal(pol.lanes.act_now.safetyFloored, true)

  const out = applyLeadPolicy(
    [{ id: 'tail', lane: 'tailwind', score: 80 }, { id: 'emerg', lane: 'act_now', score: 40 }],
    pol
  )
  assert.equal(out[0].id, 'emerg')
  near(out[0].score, 40) // un-demoted: base 40 × weight 1
})
