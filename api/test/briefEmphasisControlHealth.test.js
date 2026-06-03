'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  assessEmphasisControlHealth,
  narrateEmphasisControlHealth,
  shouldDampControl,
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
  DEFAULT_WINDOW,
  DEFAULT_OSCILLATION_FLIPS,
  DEFAULT_SATURATION_RUNS,
} = require('../lib/briefEmphasisControlHealth')

// deep-freeze helper — proves the module never mutates its inputs
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

// A single layer-21 applyEmphasisControl() snapshot, with sane defaults.
function ctrl(over = {}) {
  return {
    status: 'tuned',
    also_cap: 3,
    delta: 0,
    direction: 'neutral',
    controlled: false,
    control_move: 'none',
    control_reason: 'efficacy_neutral',
    step_scale: null,
    base_step: 0,
    controlled_step: 0,
    base_cap: 3,
    min_cap: 1,
    max_cap: 5,
    emphasis_also_cap: 3,
    ...over,
  }
}

// A compact (move, cap) cell → a realistic layer-21 snapshot.
function c(move, cap, over = {}) {
  const base = over.base_cap != null ? over.base_cap : 3
  return ctrl({
    control_move: move,
    also_cap: cap,
    controlled: move === 'lean_in' || move === 'ease_off',
    direction: cap > base ? 'widen' : cap < base ? 'tighten' : 'neutral',
    ...over,
  })
}

// [[move, cap, over?], ...] → dated snapshots ({as_of, ...control}), oldest→newest.
function series(cells) {
  return cells.map(([move, cap, over], i) => ({
    as_of: `2026-04-${String(10 + i).padStart(2, '0')}`,
    ...c(move, cap, over),
  }))
}

// Named fixtures reused across groups.
const HUNTING = () => series([['lean_in', 4], ['ease_off', 3], ['lean_in', 4]]) // 2 flips
const SAT_HIGH = () => series([['hold', 5], ['hold', 5], ['hold', 5]]) // cap pinned at max
const SAT_LOW = () => series([['hold', 1], ['hold', 1], ['hold', 1]]) // cap pinned at min
const STABLE = () => series([['lean_in', 4], ['hold', 4], ['hold', 4]]) // engaged then flat
const SETTLING = () => series([['none', 3], ['lean_in', 4]]) // engaged, still moving
const IDLE = () => series([['none', 3], ['hold', 3], ['none', 3]]) // never engaged, at base

// ════════════════════════════════════════════════════════════════════════════
// Abstention & input hygiene
// ════════════════════════════════════════════════════════════════════════════

test('22a — abstains below minHistory and on junk, never throwing', () => {
  for (const bad of [undefined, null, 'nope', 42, {}, []]) {
    const v = assessEmphasisControlHealth(bad)
    assert.equal(v.status, 'abstained')
    assert.equal(v.recommended_action, 'none')
    assert.equal(v.verdict_reason, 'insufficient_history')
  }
  // a single usable snapshot is still too little to judge a control LOOP
  const one = assessEmphasisControlHealth([c('lean_in', 4)])
  assert.equal(one.status, 'abstained')
  assert.equal(one.history_len, 1)
})

test('22a — skips malformed snapshots (no usable cap) without throwing', () => {
  const v = assessEmphasisControlHealth([{}, { also_cap: null }, { also_cap: 'x' }, c('hold', 3), c('hold', 3)])
  assert.equal(v.history_len, 2) // only the two real holds survive
  assert.equal(v.status, 'idle') // both holds at base → controller quiet
})

// ════════════════════════════════════════════════════════════════════════════
// HUNTING / oscillation → unstable / damp (the self-healing signal)
// ════════════════════════════════════════════════════════════════════════════

test('22a — a controller swinging lean_in↔ease_off is UNSTABLE and asks to DAMP', () => {
  const v = assessEmphasisControlHealth(HUNTING())
  assert.equal(v.control.flips, 2)
  assert.equal(v.status, 'unstable')
  assert.equal(v.recommended_action, 'damp')
  assert.equal(v.verdict_reason, 'control_hunting')
  assert.equal(shouldDampControl(v), true)
})

test('22a — hold/none between directional moves are NEUTRAL (do not break a flip run)', () => {
  // lean_in, hold, ease_off, none, lean_in → directional subseq [lean,ease,lean] = 2 flips
  const v = assessEmphasisControlHealth(
    series([['lean_in', 4], ['hold', 4], ['ease_off', 3], ['none', 3], ['lean_in', 4]]),
  )
  assert.equal(v.control.flips, 2)
  assert.equal(v.status, 'unstable')
})

test('22a — one adjustment then rest is NOT hunting (a single flip stays sub-threshold)', () => {
  const v = assessEmphasisControlHealth(series([['lean_in', 4], ['ease_off', 3]]))
  assert.equal(v.control.flips, 1)
  assert.notEqual(v.status, 'unstable')
})

// ════════════════════════════════════════════════════════════════════════════
// SATURATION / rail → constrained / review_bounds
// ════════════════════════════════════════════════════════════════════════════

test('22a — a cap pinned at the ceiling is CONSTRAINED (review bounds), even while quiet', () => {
  const v = assessEmphasisControlHealth(SAT_HIGH())
  assert.equal(v.control.high_run, 3)
  assert.equal(v.control.engaged, false) // controller is holding, not pushing
  assert.equal(v.status, 'constrained')
  assert.equal(v.recommended_action, 'review_bounds')
  assert.equal(v.verdict_reason, 'pinned_high')
  assert.equal(shouldDampControl(v), false) // advisory, NOT a self-heal
})

test('22a — a cap pinned at the floor is CONSTRAINED low', () => {
  const v = assessEmphasisControlHealth(SAT_LOW())
  assert.equal(v.control.low_run, 3)
  assert.equal(v.status, 'constrained')
  assert.equal(v.verdict_reason, 'pinned_low')
})

test('22a — leaning repeatedly INTO the ceiling saturates without counting as a flip', () => {
  const v = assessEmphasisControlHealth(series([['lean_in', 5], ['lean_in', 5], ['lean_in', 5]]))
  assert.equal(v.control.flips, 0) // same direction throughout
  assert.equal(v.status, 'constrained')
  assert.equal(v.verdict_reason, 'pinned_high')
})

// ════════════════════════════════════════════════════════════════════════════
// CONVERGED → stable / trust   and   SETTLING → settling / hold
// ════════════════════════════════════════════════════════════════════════════

test('22a — engaged then a flat cap is STABLE (trust)', () => {
  const v = assessEmphasisControlHealth(STABLE())
  assert.equal(v.control.engaged, true)
  assert.equal(v.control.settled_run, 3)
  assert.equal(v.status, 'stable')
  assert.equal(v.recommended_action, 'trust')
  assert.equal(v.verdict_reason, 'control_converged')
})

test('22a — engaged but still moving is SETTLING (hold)', () => {
  const v = assessEmphasisControlHealth(SETTLING())
  assert.equal(v.control.engaged, true)
  assert.equal(v.control.settled_run, 1) // cap changed last morning
  assert.equal(v.status, 'settling')
  assert.equal(v.recommended_action, 'hold')
  assert.equal(v.verdict_reason, 'control_settling')
})

// ════════════════════════════════════════════════════════════════════════════
// IDLE → idle / none
// ════════════════════════════════════════════════════════════════════════════

test('22a — a controller that never engages in the window is IDLE', () => {
  const v = assessEmphasisControlHealth(IDLE())
  assert.equal(v.control.engaged, false)
  assert.equal(v.status, 'idle')
  assert.equal(v.recommended_action, 'none')
  assert.equal(v.verdict_reason, 'controller_quiet')
})

// ════════════════════════════════════════════════════════════════════════════
// Precedence — hunting > saturation > idle > converged > settling
// ════════════════════════════════════════════════════════════════════════════

test('22a — hunting outranks a momentary rail touch', () => {
  // oscillates AND the newest cap happens to land on the ceiling
  const v = assessEmphasisControlHealth(series([['lean_in', 5], ['ease_off', 4], ['lean_in', 5]]))
  assert.equal(v.control.flips, 2)
  assert.equal(v.status, 'unstable') // hunting wins over the single-morning rail touch
})

test('22a — a chronic rail outranks BOTH idle and converged', () => {
  // engaged once, then a flat run at the ceiling: would be "stable" on settled_run,
  // but the cap is pinned at a genuine rail → constrained takes precedence.
  const v = assessEmphasisControlHealth(series([['lean_in', 5], ['hold', 5], ['hold', 5]]))
  assert.equal(v.control.engaged, true)
  assert.equal(v.control.settled_run, 3) // would read as converged…
  assert.equal(v.control.high_run, 3) // …but it's pinned at the ceiling
  assert.equal(v.status, 'constrained')
})

test('22a — every status maps to its one fixed recommended_action', () => {
  const expect = {
    unstable: 'damp',
    constrained: 'review_bounds',
    stable: 'trust',
    settling: 'hold',
    idle: 'none',
    abstained: 'none',
  }
  const cases = [HUNTING(), SAT_HIGH(), STABLE(), SETTLING(), IDLE(), [c('hold', 3)]]
  for (const f of cases) {
    const v = assessEmphasisControlHealth(f)
    assert.equal(v.recommended_action, expect[v.status], `${v.status} → ${expect[v.status]}`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Windowing, thresholds, carried fields, input shapes
// ════════════════════════════════════════════════════════════════════════════

test('22a — the window bounds the lookback', () => {
  const v = assessEmphasisControlHealth(HUNTING(), { window: 2 })
  assert.equal(v.control.series.length, 2) // only the last two snapshots weighed
  assert.equal(v.window_used, 2)
  // last two moves: ease_off, lean_in → 1 flip < 2 → no longer hunting
  assert.notEqual(v.status, 'unstable')
})

test('22a — custom thresholds are honored', () => {
  // raise the bar to 3 flips → a 2-flip series is no longer unstable
  assert.notEqual(assessEmphasisControlHealth(HUNTING(), { oscillationFlips: 3 }).status, 'unstable')
  // lower the saturation run to 2 → a 2-morning rail now constrains
  const sat2 = assessEmphasisControlHealth(series([['hold', 5], ['hold', 5]]), { saturationRuns: 2 })
  assert.equal(sat2.status, 'constrained')
})

test('22a — surfaces last move/cap/direction, working bounds, and the windowed series', () => {
  const v = assessEmphasisControlHealth(STABLE())
  assert.equal(v.control.last_move, 'hold')
  assert.equal(v.control.last_cap, 4)
  assert.equal(v.control.last_direction, 'widen')
  assert.deepEqual(v.bounds, { min: 1, max: 5, base: 3 })
  assert.equal(v.as_of, '2026-04-12')
  assert.deepEqual(
    v.control.series.map((s) => s.cap),
    [4, 4, 4],
  )
})

test('22a — accepts bare results, {as_of,control} wrappers, and {as_of,...control} spreads', () => {
  const bare = c('lean_in', 4) // no as_of
  const wrapped = { as_of: '2026-04-11', control: c('ease_off', 3) }
  const spread = { as_of: '2026-04-12', ...c('lean_in', 4) }
  const v = assessEmphasisControlHealth([bare, wrapped, spread])
  assert.equal(v.history_len, 3) // all three shapes parsed
  assert.equal(v.control.flips, 2) // lean, ease, lean → hunting
  assert.equal(v.status, 'unstable')
  assert.equal(v.as_of, '2026-04-12') // newest as_of surfaced; bare's null ignored
})

test('22a — re-exports the shared rails and the default thresholds', () => {
  assert.equal(BASE_CAP, 3)
  assert.equal(MIN_CAP, 1)
  assert.equal(MAX_CAP, 5)
  assert.equal(DEFAULT_WINDOW, 6)
  assert.equal(DEFAULT_OSCILLATION_FLIPS, 2)
  assert.equal(DEFAULT_SATURATION_RUNS, 3)
})

// ════════════════════════════════════════════════════════════════════════════
// No-leak discipline + agency narration
// ════════════════════════════════════════════════════════════════════════════

test('22a — client audience gets NOTHING for every status (no-leak, unconditional)', () => {
  const fixtures = [HUNTING(), SAT_HIGH(), SAT_LOW(), STABLE(), SETTLING(), IDLE(), [c('hold', 3)]]
  for (const f of fixtures) {
    const v = assessEmphasisControlHealth(f)
    assert.equal(narrateEmphasisControlHealth(v, { audience: 'client' }), '')
  }
  // robust to junk verdicts too
  assert.equal(narrateEmphasisControlHealth(null, { audience: 'client' }), '')
  assert.equal(narrateEmphasisControlHealth(undefined), '')
})

test('22a — agency narration speaks for unstable/constrained/stable, silent otherwise', () => {
  assert.match(narrateEmphasisControlHealth(assessEmphasisControlHealth(HUNTING())), /swinging|steadied|reliable/i)
  assert.match(narrateEmphasisControlHealth(assessEmphasisControlHealth(SAT_HIGH())), /widest/i)
  assert.match(narrateEmphasisControlHealth(assessEmphasisControlHealth(SAT_LOW())), /leanest/i)
  assert.match(narrateEmphasisControlHealth(assessEmphasisControlHealth(STABLE())), /steady setting/i)
  assert.equal(narrateEmphasisControlHealth(assessEmphasisControlHealth(SETTLING())), '')
  assert.equal(narrateEmphasisControlHealth(assessEmphasisControlHealth(IDLE())), '')
})

test('22a — agency narration carries NO machine vocabulary (leak-guard safe)', () => {
  const banned = /damp|saturat|flip|lean_in|ease_off|step_scale|control_move|verdict|recommended_action/i
  for (const f of [HUNTING(), SAT_HIGH(), SAT_LOW(), STABLE()]) {
    const line = narrateEmphasisControlHealth(assessEmphasisControlHealth(f))
    assert.ok(line.length > 0)
    assert.ok(!banned.test(line), `leaked machine vocab: ${line}`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Predicate + purity
// ════════════════════════════════════════════════════════════════════════════

test('22a — shouldDampControl is true ONLY for the hunting/damp verdict', () => {
  assert.equal(shouldDampControl(assessEmphasisControlHealth(HUNTING())), true)
  assert.equal(shouldDampControl(assessEmphasisControlHealth(SAT_HIGH())), false)
  assert.equal(shouldDampControl(assessEmphasisControlHealth(STABLE())), false)
  assert.equal(shouldDampControl(assessEmphasisControlHealth(IDLE())), false)
  assert.equal(shouldDampControl(null), false)
  assert.equal(shouldDampControl({}), false)
})

test('22a — never mutates its input and is deterministic across repeated calls', () => {
  const frozen = deepFreeze(HUNTING())
  const a = assessEmphasisControlHealth(frozen)
  const b = assessEmphasisControlHealth(frozen)
  assert.deepEqual(a, b)
  assert.equal(a.status, 'unstable')
})
