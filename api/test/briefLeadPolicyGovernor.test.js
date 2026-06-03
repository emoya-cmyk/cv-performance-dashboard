'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  governLeadPolicy,
  narrateLeadPolicyGovernance,
  humanizeLane,
  SAFETY_FLOOR_LANES,
} = require('../lib/briefLeadPolicyGovernor')
// the REAL monitor — Section H proves the governor consumes its actual output unadapted.
const { assessLeadPolicyHealth } = require('../lib/briefLeadPolicyHealth')

// ── tiny helpers (briefLeadPolicy / -Health test house style) ────────────────
// one deriveLeadPolicy-shaped lane cell. direction defaults to the sign of the weight;
// display fields ride so we can prove the governor preserves them byte-for-byte.
const plane = (weight, opts = {}) => ({
  weight,
  direction: opts.direction || (weight > 1 ? 'promote' : weight < 1 ? 'demote' : 'neutral'),
  adjusted: weight !== 1,
  judged: opts.judged ?? 8,
  hit_rate: opts.hit_rate ?? (weight > 1 ? 0.75 : weight < 1 ? 0.25 : 0.5),
  label: opts.label ?? (weight > 1 ? 'earned' : weight < 1 ? 'overcalled' : 'fair'),
  reason: opts.reason ?? (weight === 1 ? 'insufficient_sample' : 'graded'),
  safetyFloored: !!opts.floored,
})
// a full deriveLeadPolicy result; rollups recomputed from the lanes so status is honest.
// With as_of it doubles as a monitor snapshot (the { ...policy, as_of } shape assess reads).
const ppolicy = (lanes, opts = {}) => {
  let promoted = 0, demoted = 0, floored = 0, adjusted = 0
  for (const k of Object.keys(lanes)) {
    const e = lanes[k]
    if (e.safetyFloored) floored++
    if (e.weight !== 1) { adjusted++; e.direction === 'promote' ? promoted++ : demoted++ }
  }
  return {
    status: opts.status ?? (adjusted > 0 ? 'tuned' : 'idle'),
    neutral_rate: 0.5,
    min_sample: 4,
    bounds: opts.bounds ?? { min: 0.8, max: 1.2 },
    safety_floor_lanes: opts.floorLanes ?? ['act_now'],
    lanes,
    promoted, demoted, floored, adjusted_count: adjusted,
    ...(opts.as_of ? { as_of: opts.as_of } : {}),
  }
}
// a hand-built verdict — the governor reads only verdict.status and verdict.lanes[k].state.
const vlane = (state) => ({ state })
const vverdict = (status, lanes) => ({ status, recommended_action: 'x', lanes: lanes || {} })
// freeze a structure so any accidental input mutation throws (purity proof).
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) }
  return o
}

// ============================================================
// A. fail-safe — no trustworthy verdict ⇒ pass the policy through untouched
// ============================================================

test('govern: null verdict ⇒ abstain, policy passes through unchanged (new object)', () => {
  const policy = ppolicy({ verify: plane(1.1), tailwind: plane(1.15) })
  const r = governLeadPolicy(policy, null)
  assert.equal(r.status, 'abstained')
  assert.deepEqual(r.interventions, [])
  assert.equal(r.counts.passed, 2)
  // governed mirrors the policy weights but is a DISTINCT object (caller can't mutate ours back in).
  assert.notStrictEqual(r.governed, policy)
  assert.equal(r.governed.lanes.verify.weight, 1.1)
  assert.equal(r.governed.lanes.tailwind.weight, 1.15)
  assert.equal(r.governed.status, 'tuned')
})

test('govern: an abstained verdict ⇒ governor abstains too (never act on what it cannot assess)', () => {
  const policy = ppolicy({ verify: plane(1.1) })
  const r = governLeadPolicy(policy, vverdict('abstained', {}))
  assert.equal(r.status, 'abstained')
  assert.equal(r.governed.lanes.verify.weight, 1.1)
  assert.deepEqual(r.interventions, [])
})

test('govern: null policy ⇒ abstain, governed null, no throw', () => {
  const r = governLeadPolicy(null, vverdict('unstable', { verify: vlane('oscillating') }))
  assert.equal(r.status, 'abstained')
  assert.equal(r.governed, null)
  assert.deepEqual(r.snapshot, { lanes: {} })
})

test('govern: a blank/statusless verdict is not trustworthy ⇒ abstain pass-through', () => {
  const policy = ppolicy({ verify: plane(1.1) })
  const r = governLeadPolicy(policy, {})
  assert.equal(r.status, 'abstained')
  assert.equal(r.governed.lanes.verify.weight, 1.1)
})

// ============================================================
// B. clean — a healthy verdict touches nothing
// ============================================================

test('govern: all lanes stable ⇒ clean, weights unchanged', () => {
  const policy = ppolicy({ verify: plane(1.1), tailwind: plane(1.15) })
  const verdict = vverdict('stable', { verify: vlane('stable'), tailwind: vlane('stable') })
  const r = governLeadPolicy(policy, verdict)
  assert.equal(r.status, 'clean')
  assert.deepEqual(r.interventions, [])
  assert.equal(r.counts.passed, 2)
  assert.equal(r.governed.lanes.verify.weight, 1.1)
  assert.equal(r.governed.lanes.tailwind.weight, 1.15)
  assert.equal(r.governed.status, 'tuned')
})

test('govern: settling lanes are still healthy ⇒ clean pass-through', () => {
  const policy = ppolicy({ tailwind: plane(1.06, { direction: 'promote' }) })
  const r = governLeadPolicy(policy, vverdict('settling', { tailwind: vlane('settling') }))
  assert.equal(r.status, 'clean')
  assert.equal(r.governed.lanes.tailwind.weight, 1.06)
})

// ============================================================
// C. corrected — the surgical self-heal (THE WIN over blunt revert)
// ============================================================

test('govern: one oscillating lane is neutralised, the earned lane survives', () => {
  const policy = ppolicy({
    verify: plane(1.1, { direction: 'promote' }),    // thrashing
    tailwind: plane(1.15, { direction: 'promote' }), // honestly earned
  })
  const verdict = vverdict('unstable', { verify: vlane('oscillating'), tailwind: vlane('stable') })
  const r = governLeadPolicy(policy, verdict)

  assert.equal(r.status, 'corrected')
  // the thrashing lane is reset to neutral...
  assert.equal(r.governed.lanes.verify.weight, 1)
  assert.equal(r.governed.lanes.verify.direction, 'neutral')
  assert.equal(r.governed.lanes.verify.adjusted, false)
  assert.equal(r.governed.lanes.verify.reason, 'governed_oscillation')
  // ...while the earned lane is byte-identical to its source — the blunt revert would have lost it.
  assert.deepEqual(r.governed.lanes.tailwind, policy.lanes.tailwind)
  // one recorded intervention, with the before/after for reversibility.
  assert.equal(r.interventions.length, 1)
  assert.deepEqual(r.interventions[0], {
    lane: 'verify', action: 'neutralize', state: 'oscillating',
    from_weight: 1.1, to_weight: 1, from_direction: 'promote', to_direction: 'neutral', reason: 'oscillation',
  })
  assert.deepEqual(r.counts, { neutralized: 1, held: 0, floored_respected: 0, passed: 1 })
  // a learned lane still applies ⇒ governed policy stays tuned.
  assert.equal(r.governed.status, 'tuned')
  // snapshot preserves the pre-governance weight (reversible).
  assert.equal(r.snapshot.lanes.verify.weight, 1.1)
  assert.equal(r.snapshot.lanes.verify.direction, 'promote')
})

test('govern: neutralising the only adjusted lane collapses the policy to idle', () => {
  const policy = ppolicy({ verify: plane(0.9, { direction: 'demote' }) })
  const r = governLeadPolicy(policy, vverdict('unstable', { verify: vlane('oscillating') }))
  assert.equal(r.status, 'corrected')            // governance DID act...
  assert.equal(r.governed.lanes.verify.weight, 1)
  assert.equal(r.governed.adjusted_count, 0)
  assert.equal(r.governed.status, 'idle')        // ...but nothing is left to apply → matches old behaviour.
})

test('govern: result.status (governance) is distinct from governed.status (apply gate)', () => {
  const policy = ppolicy({ verify: plane(1.1), tailwind: plane(1.15) })
  const r = governLeadPolicy(policy, vverdict('unstable', { verify: vlane('oscillating') }))
  assert.equal(r.status, 'corrected')      // the governance verdict
  assert.equal(r.governed.status, 'tuned') // the policy the engine will gate on
})

// ============================================================
// D. advised — advisory holds that change no weight
// ============================================================

test('govern: a saturated lane is HELD at bound, not widened', () => {
  const policy = ppolicy({ tailwind: plane(1.2, { direction: 'promote' }) }) // pinned at max
  const verdict = vverdict('constrained', { tailwind: vlane('saturated_high') })
  const r = governLeadPolicy(policy, verdict)
  assert.equal(r.status, 'advised')
  assert.equal(r.governed.lanes.tailwind.weight, 1.2) // unchanged — widening is a human call
  assert.equal(r.interventions.length, 1)
  assert.equal(r.interventions[0].action, 'hold_at_bound')
  assert.equal(r.interventions[0].from_weight, 1.2)
  assert.equal(r.interventions[0].to_weight, 1.2)
  assert.equal(r.counts.held, 1)
})

test('govern: a floor-masked lane is RESPECTED, the overcall logged', () => {
  const policy = ppolicy({ act_now: plane(1, { direction: 'neutral', floored: true }) })
  const verdict = vverdict('flagged', { act_now: vlane('floor_masked') })
  const r = governLeadPolicy(policy, verdict)
  assert.equal(r.status, 'advised')
  assert.equal(r.governed.lanes.act_now.weight, 1)       // floor stands
  assert.equal(r.governed.lanes.act_now.safetyFloored, true)
  assert.equal(r.interventions[0].action, 'respect_floor')
  assert.equal(r.counts.floored_respected, 1)
})

test('govern: a correction outranks an advisory hold in the same pass', () => {
  const policy = ppolicy({
    verify: plane(1.1, { direction: 'promote' }),
    tailwind: plane(1.2, { direction: 'promote' }),
  })
  const verdict = vverdict('unstable', { verify: vlane('oscillating'), tailwind: vlane('saturated_high') })
  const r = governLeadPolicy(policy, verdict)
  assert.equal(r.status, 'corrected')                 // correction wins the top-level label
  assert.equal(r.counts.neutralized, 1)
  assert.equal(r.counts.held, 1)
  assert.equal(r.governed.lanes.verify.weight, 1)     // neutralised
  assert.equal(r.governed.lanes.tailwind.weight, 1.2) // held, unchanged
})

// ============================================================
// E. safety, blast radius, idempotency, purity, reversibility
// ============================================================

test('govern: neutralising a safety-floor lane lands at exactly the floor, never below', () => {
  const policy = ppolicy({ act_now: plane(1.1, { direction: 'promote' }) }, { status: 'tuned' })
  const r = governLeadPolicy(policy, vverdict('unstable', { act_now: vlane('oscillating') }))
  assert.equal(r.governed.lanes.act_now.weight, 1)
  assert.ok(r.governed.lanes.act_now.weight >= 1, 'a floor lane is never pushed below 1')
})

test('govern: blast radius is bounded — only the faulted lane is touched', () => {
  const policy = ppolicy({
    act_now: plane(1.15, { direction: 'promote' }),
    verify: plane(1.1, { direction: 'promote' }),
    tailwind: plane(0.85, { direction: 'demote' }),
  })
  const verdict = vverdict('unstable', { verify: vlane('oscillating') }) // only verify faulted
  const r = governLeadPolicy(policy, verdict)
  assert.equal(r.counts.neutralized, 1)
  // the two unfaulted lanes survive byte-for-byte.
  assert.deepEqual(r.governed.lanes.act_now, policy.lanes.act_now)
  assert.deepEqual(r.governed.lanes.tailwind, policy.lanes.tailwind)
})

test('govern: idempotent — governing the governed policy again changes no weight', () => {
  const policy = ppolicy({ verify: plane(1.1, { direction: 'promote' }), tailwind: plane(1.15, { direction: 'promote' }) })
  const verdict = vverdict('unstable', { verify: vlane('oscillating'), tailwind: vlane('stable') })
  const once = governLeadPolicy(policy, verdict)
  const twice = governLeadPolicy(once.governed, verdict)
  const weights = (g) => Object.fromEntries(Object.keys(g.lanes).map(k => [k, g.lanes[k].weight]))
  assert.deepEqual(weights(twice.governed), weights(once.governed))
  assert.equal(twice.counts.neutralized, 0) // nothing left to neutralise the second time
})

test('govern: pure — frozen inputs are never mutated', () => {
  const policy = deepFreeze(ppolicy({ verify: plane(1.1, { direction: 'promote' }), tailwind: plane(1.15, { direction: 'promote' }) }))
  const verdict = deepFreeze(vverdict('unstable', { verify: vlane('oscillating') }))
  assert.doesNotThrow(() => governLeadPolicy(policy, verdict))
  assert.equal(policy.lanes.verify.weight, 1.1) // input untouched
})

test('govern: reversible — snapshot reconstructs every pre-governance weight', () => {
  const policy = ppolicy({ verify: plane(0.85, { direction: 'demote' }), tailwind: plane(1.15, { direction: 'promote' }) })
  const r = governLeadPolicy(policy, vverdict('unstable', { verify: vlane('oscillating') }))
  assert.equal(r.snapshot.lanes.verify.weight, 0.85)
  assert.equal(r.snapshot.lanes.verify.direction, 'demote')
  assert.equal(r.snapshot.lanes.tailwind.weight, 1.15)
})

// ============================================================
// F. narration — agency-only, never client
// ============================================================

test('narrate: client gets nothing across every governance status', () => {
  const policy = ppolicy({ verify: plane(1.1), tailwind: plane(1.15) })
  for (const verdict of [
    vverdict('unstable', { verify: vlane('oscillating') }),     // corrected
    vverdict('constrained', { tailwind: vlane('saturated_high') }), // advised
    vverdict('stable', { verify: vlane('stable'), tailwind: vlane('stable') }), // clean
    null,                                                        // abstained
  ]) {
    const r = governLeadPolicy(policy, verdict)
    assert.equal(narrateLeadPolicyGovernance(r, { audience: 'client' }), '')
  }
})

test('narrate: agency hears what was reset, and that the rest stands', () => {
  const policy = ppolicy({ verify: plane(1.1, { direction: 'promote' }), tailwind: plane(1.15, { direction: 'promote' }) })
  const r = governLeadPolicy(policy, vverdict('unstable', { verify: vlane('oscillating'), tailwind: vlane('stable') }))
  const line = narrateLeadPolicyGovernance(r, { audience: 'agency' })
  assert.match(line, /reset/)
  assert.match(line, /verify/)
  assert.match(line, /the rest of the learned order stands/)
})

test('narrate: agency omits "the rest stands" when nothing is left to apply', () => {
  const policy = ppolicy({ verify: plane(1.1, { direction: 'promote' }) })
  const r = governLeadPolicy(policy, vverdict('unstable', { verify: vlane('oscillating') }))
  const line = narrateLeadPolicyGovernance(r, { audience: 'agency' })
  assert.match(line, /verify/)
  assert.ok(!/the rest of the learned order stands/.test(line))
})

test('narrate: advised / clean / abstained say nothing (the verdict narrator owns the diagnosis)', () => {
  const policy = ppolicy({ tailwind: plane(1.2, { direction: 'promote' }) })
  const advised = governLeadPolicy(policy, vverdict('constrained', { tailwind: vlane('saturated_high') }))
  const clean = governLeadPolicy(policy, vverdict('stable', { tailwind: vlane('stable') }))
  const abstained = governLeadPolicy(policy, null)
  for (const r of [advised, clean, abstained]) {
    assert.equal(narrateLeadPolicyGovernance(r, { audience: 'agency' }), '')
  }
})

test('narrate: multiple neutralised lanes are joined with a serial conjunction', () => {
  const policy = ppolicy({
    verify: plane(1.1, { direction: 'promote' }),
    worth_a_look: plane(1.1, { direction: 'promote' }),
    tailwind: plane(1.15, { direction: 'promote' }),
  })
  const verdict = vverdict('unstable', {
    verify: vlane('oscillating'), worth_a_look: vlane('oscillating'), tailwind: vlane('stable'),
  })
  const r = governLeadPolicy(policy, verdict)
  const line = narrateLeadPolicyGovernance(r, { audience: 'agency' })
  assert.match(line, /verify and worth a look/)
})

// ============================================================
// G. robustness — garbage in, sane shape out, never throws
// ============================================================

test('govern: empty objects do not throw and yield a sane abstained shape', () => {
  const r = governLeadPolicy({}, {})
  assert.equal(r.status, 'abstained')
  assert.deepEqual(r.interventions, [])
})

test('govern: null/null does not throw', () => {
  const r = governLeadPolicy(null, null)
  assert.equal(r.status, 'abstained')
  assert.equal(r.governed, null)
})

test('govern: a null lane cell is cloned to neutral and never neutralised below 1', () => {
  const r = governLeadPolicy({ status: 'tuned', lanes: { x: null } }, vverdict('unstable', { x: vlane('oscillating') }))
  assert.doesNotThrow(() => r)
  assert.equal(r.governed.lanes.x.weight, 1)  // finite default
  assert.equal(r.counts.neutralized, 0)        // already neutral ⇒ no spurious correction
})

// ============================================================
// H. integration — consumes the REAL monitor verdict unadapted
// ============================================================

test('govern: end-to-end against assessLeadPolicyHealth — earned lane survives a real oscillation', () => {
  // a genuine oscillation history (verify thrashing promote/demote).
  const history = [
    ppolicy({ verify: plane(1.1, { direction: 'promote' }) }, { as_of: '2026-05-30' }),
    ppolicy({ verify: plane(0.9, { direction: 'demote' }) }, { as_of: '2026-05-31' }),
    ppolicy({ verify: plane(1.1, { direction: 'promote' }) }, { as_of: '2026-06-01' }),
    ppolicy({ verify: plane(0.9, { direction: 'demote' }) }, { as_of: '2026-06-02' }),
  ]
  const verdict = assessLeadPolicyHealth(history)
  assert.equal(verdict.status, 'unstable')               // the real monitor flags it...
  assert.equal(verdict.lanes.verify.state, 'oscillating') // ...verify specifically.

  // today's policy: the thrashing verify lane PLUS a separately-earned tailwind lane.
  const today = ppolicy({
    verify: plane(0.9, { direction: 'demote' }),
    tailwind: plane(1.15, { direction: 'promote' }),
  })
  const r = governLeadPolicy(today, verdict)
  assert.equal(r.status, 'corrected')
  assert.equal(r.governed.lanes.verify.weight, 1)     // surgically neutralised
  assert.equal(r.governed.lanes.tailwind.weight, 1.15) // earned lane survives — end to end
  assert.equal(r.governed.status, 'tuned')
  // governed carries the full deriveLeadPolicy shape, a drop-in for applyLeadPolicy.
  for (const key of ['status', 'neutral_rate', 'min_sample', 'bounds', 'safety_floor_lanes', 'lanes', 'adjusted_count']) {
    assert.ok(key in r.governed, `governed missing ${key}`)
  }
})

// ── sanity: exports are the shape the engine and tests expect ────────────────
test('exports: governor surface is present and well-typed', () => {
  assert.equal(typeof governLeadPolicy, 'function')
  assert.equal(typeof narrateLeadPolicyGovernance, 'function')
  assert.equal(typeof humanizeLane, 'function')
  assert.deepEqual(SAFETY_FLOOR_LANES, ['act_now'])
})
