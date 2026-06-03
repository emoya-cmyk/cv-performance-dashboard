'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  tuneEmphasisControlAuthority,
  narrateEmphasisControlTuning,
  controlAuthorityRails,
  shouldReduceControlAuthority,
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
  DEFAULT_WINDOW,
  DEFAULT_RESTORE_RUN,
  DEFAULT_MIN_HISTORY,
} = require('../lib/briefEmphasisControlTuning')

// deep-freeze helper — proves the module never mutates its inputs
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

// A single layer-22 governor verdict, with realistic action/reason/bounds for its status.
function gov(status, over = {}) {
  const action = {
    unstable: 'damp', constrained: 'review_bounds', stable: 'trust',
    settling: 'hold', idle: 'none', abstained: 'none',
  }[status] || 'none'
  const reason = {
    unstable: 'control_hunting', constrained: 'pinned_high', stable: 'control_converged',
    settling: 'control_settling', idle: 'controller_quiet', abstained: 'insufficient_history',
  }[status] || null
  return {
    status,
    recommended_action: action,
    verdict_reason: reason,
    bounds: { min: 1, max: 5, base: 3 },
    ...over,
  }
}

// [status | [status, over]][] → dated governor verdicts, oldest→newest.
function series(rows) {
  return rows.map((row, i) => {
    const [status, over] = Array.isArray(row) ? row : [row, {}]
    return { as_of: `2026-05-${String(10 + i).padStart(2, '0')}`, ...gov(status, over) }
  })
}

// Named fixtures reused across groups. (maxReach for [1,3,5] = 2.)
const HUNT_FRESH = () => series(['stable', 'unstable']) // one fresh hunt after calm → reach 1
const HUNT_RUN = () => series(['unstable', 'unstable']) // two consecutive hunts → frozen (reach 0)
const RESTORED = () => series(['unstable', 'stable', 'stable']) // hunted, then proven converged
const HOLDING = () => series(['unstable', 'stable']) // hunted, recovering but unproven (1<2)
const NEVER = () => series(['stable', 'stable', 'stable']) // never hunted → full authority
const CONSTRAINED = () => series(['constrained', 'constrained']) // pinned ≠ aggressive → full authority

// ════════════════════════════════════════════════════════════════════════════
// Abstention & input hygiene — a gain schedule needs a track record
// ════════════════════════════════════════════════════════════════════════════

test('23a — abstains to full-authority no-op below minHistory and on junk, never throwing', () => {
  for (const bad of [undefined, null, 'nope', 42, {}, []]) {
    const v = tuneEmphasisControlAuthority(bad)
    assert.equal(v.status, 'default')
    assert.equal(v.recommended_action, 'none')
    assert.equal(v.reason, 'insufficient_history')
    assert.equal(v.reach, v.max_reach) // full authority
    assert.equal(v.authority, 'full')
    assert.deepEqual(v.effective_bounds, v.bounds) // provable no-op vs an un-tuned controller
  }
  // a single governor verdict is still too little to schedule a gain
  const one = tuneEmphasisControlAuthority(series(['unstable']))
  assert.equal(one.status, 'default')
  assert.equal(one.reason, 'insufficient_history')
  assert.equal(one.history_len, 1)
})

test('23a — skips verdicts with no recognizable governor status, without throwing', () => {
  const v = tuneEmphasisControlAuthority([{}, { bounds: {} }, { status: 'nonsense' }, gov('idle'), gov('idle')])
  assert.equal(v.history_len, 2) // only the two real governor verdicts survive
  assert.equal(v.status, 'default') // idle is not hunting → full authority
  assert.equal(v.reason, 'no_intervention')
})

// ════════════════════════════════════════════════════════════════════════════
// ACTIVELY HUNTING → detuned / reduce_authority  (reduce-fast)
// ════════════════════════════════════════════════════════════════════════════

test('23a — one fresh hunt HALVES the controller authority', () => {
  const v = tuneEmphasisControlAuthority(HUNT_FRESH())
  assert.equal(v.status, 'detuned')
  assert.equal(v.recommended_action, 'reduce_authority')
  assert.equal(v.reason, 'hunting_active')
  assert.equal(v.max_reach, 2)
  assert.equal(v.reach, 1) // maxReach - 1 fresh hunt
  assert.equal(v.authority, 'reduced')
  assert.deepEqual(v.effective_bounds, { min: 2, max: 4, base: 3 })
  assert.equal(shouldReduceControlAuthority(v), true)
})

test('23a — a second consecutive hunt FREEZES the controller at base', () => {
  const v = tuneEmphasisControlAuthority(HUNT_RUN())
  assert.equal(v.status, 'detuned')
  assert.equal(v.reason, 'hunting_active')
  assert.equal(v.reach, 0) // maxReach - 2 consecutive hunts → pinned
  assert.equal(v.authority, 'frozen')
  assert.deepEqual(v.effective_bounds, { min: 3, max: 3, base: 3 }) // cannot oscillate at all
})

test('23a — a fresh hunt INSTANTLY revokes a long-earned full authority', () => {
  // three converged mornings, then a new hunt → actively hunting outranks the calm history
  const v = tuneEmphasisControlAuthority(series(['stable', 'stable', 'stable', 'unstable']))
  assert.equal(v.status, 'detuned')
  assert.equal(v.governor.trailing_unstable, 1)
  assert.equal(v.reach, 1)
})

// ════════════════════════════════════════════════════════════════════════════
// RECOVERED & PROVEN → restored / restore_authority  (restore-slow)
// ════════════════════════════════════════════════════════════════════════════

test('23a — full authority is restored only after restoreRun CONVERGED mornings', () => {
  const v = tuneEmphasisControlAuthority(RESTORED())
  assert.equal(v.status, 'restored')
  assert.equal(v.recommended_action, 'restore_authority')
  assert.equal(v.reason, 'stability_proven')
  assert.equal(v.reach, v.max_reach) // back to full
  assert.equal(v.authority, 'full')
  assert.deepEqual(v.effective_bounds, v.bounds) // no-op rails again
  assert.equal(shouldReduceControlAuthority(v), false)
  assert.equal(controlAuthorityRails(v), null) // full authority imposes no constraint
})

// ════════════════════════════════════════════════════════════════════════════
// RECOVERING but UNPROVEN → holding / hold_authority  (the hysteresis band)
// ════════════════════════════════════════════════════════════════════════════

test('23a — one converged morning is NOT enough; authority HOLDS reduced until proven', () => {
  const v = tuneEmphasisControlAuthority(HOLDING())
  assert.equal(v.status, 'holding')
  assert.equal(v.recommended_action, 'hold_authority')
  assert.equal(v.reason, 'awaiting_stability')
  assert.equal(v.reach, 1) // one notch below full while it proves out
  assert.equal(v.authority, 'reduced')
  assert.equal(shouldReduceControlAuthority(v), true)
})

test('23a — hunting that merely went QUIET (idle/settling) still HOLDS — quiet ≠ proven', () => {
  for (const tail of ['idle', 'settling', 'constrained']) {
    const v = tuneEmphasisControlAuthority(series(['unstable', tail]))
    assert.equal(v.status, 'holding', `tail=${tail}`)
    assert.equal(v.reason, 'awaiting_stability')
    assert.equal(v.reach, 1)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// NEVER HUNTED → default / none  (distrust is earned, never assumed)
// ════════════════════════════════════════════════════════════════════════════

test('23a — a controller that never hunts keeps FULL authority (provable no-op)', () => {
  const v = tuneEmphasisControlAuthority(NEVER())
  assert.equal(v.status, 'default')
  assert.equal(v.recommended_action, 'none')
  assert.equal(v.reason, 'no_intervention')
  assert.equal(v.reach, v.max_reach)
  assert.equal(v.authority, 'full')
  assert.deepEqual(v.effective_bounds, v.bounds)
  assert.equal(controlAuthorityRails(v), null)
})

test('23a — a PINNED controller (saturation) is NOT a reason to detune — bounds, not aggression', () => {
  const v = tuneEmphasisControlAuthority(CONSTRAINED())
  assert.equal(v.status, 'default') // review_bounds is layer 22's job; authority stays full
  assert.equal(v.reason, 'no_intervention')
  assert.equal(v.reach, v.max_reach)
})

test('23a — a long converged history with NO prior hunt reads as default, not restored', () => {
  // trailingStable >= restoreRun, but nothing was ever wrong → no restoration to narrate
  const v = tuneEmphasisControlAuthority(series(['stable', 'stable', 'stable', 'stable']))
  assert.equal(v.status, 'default')
  assert.equal(v.reason, 'no_intervention')
})

// ════════════════════════════════════════════════════════════════════════════
// Precedence — hunting > restore > hold > default
// ════════════════════════════════════════════════════════════════════════════

test('23a — every status maps to its one fixed recommended_action', () => {
  const expect = {
    detuned: 'reduce_authority',
    restored: 'restore_authority',
    holding: 'hold_authority',
    default: 'none',
  }
  const cases = [HUNT_FRESH(), HUNT_RUN(), RESTORED(), HOLDING(), NEVER(), CONSTRAINED()]
  for (const f of cases) {
    const v = tuneEmphasisControlAuthority(f)
    assert.equal(v.recommended_action, expect[v.status], `${v.status} → ${expect[v.status]}`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Windowing, thresholds, carried fields, input shapes
// ════════════════════════════════════════════════════════════════════════════

test('23a — the window bounds the lookback and can change the verdict', () => {
  const f = series(['unstable', 'unstable', 'stable', 'stable'])
  // default window (6) sees the earlier hunting → proven recovery → restored
  assert.equal(tuneEmphasisControlAuthority(f).status, 'restored')
  // window 2 sees only [stable, stable] → no hunt in view → plain default, full authority
  const w2 = tuneEmphasisControlAuthority(f, { window: 2 })
  assert.equal(w2.window_used, 2)
  assert.equal(w2.governor.statuses.length, 2)
  assert.equal(w2.status, 'default')
  assert.equal(w2.reason, 'no_intervention')
})

test('23a — restoreRun is honored: a lower bar restores after a single converged morning', () => {
  // HOLDING() = [unstable, stable]; default restoreRun 2 → holding, but restoreRun 1 → restored
  assert.equal(tuneEmphasisControlAuthority(HOLDING()).status, 'holding')
  assert.equal(tuneEmphasisControlAuthority(HOLDING(), { restoreRun: 1 }).status, 'restored')
})

test('23a — minHistory is honored: a lower bar judges a single verdict', () => {
  assert.equal(tuneEmphasisControlAuthority(series(['unstable'])).status, 'default') // default minHistory 2
  const m1 = tuneEmphasisControlAuthority(series(['unstable']), { minHistory: 1 })
  assert.equal(m1.status, 'detuned')
  assert.equal(m1.reach, 1)
})

test('23a — surfaces the governor evidence, working bounds, max_reach, and as_of', () => {
  const v = tuneEmphasisControlAuthority(RESTORED())
  assert.equal(v.governor.last_status, 'stable')
  assert.equal(v.governor.trailing_unstable, 0)
  assert.equal(v.governor.trailing_stable, 2)
  assert.equal(v.governor.hunt_count, 1)
  assert.equal(v.governor.saw_hunting, true)
  assert.deepEqual(v.governor.statuses, ['unstable', 'stable', 'stable'])
  assert.deepEqual(v.bounds, { min: 1, max: 5, base: 3 })
  assert.equal(v.max_reach, 2)
  assert.equal(v.as_of, '2026-05-12') // newest verdict's as_of
})

test('23a — reads the structural rails from the newest verdict, clamping reach to the long arm', () => {
  // asymmetric rails [2,3,5]: maxReach = max(3-2, 5-3) = 2; a fresh hunt → reach 1 → [2,4]
  const bnd = { bounds: { min: 2, max: 5, base: 3 } }
  const v = tuneEmphasisControlAuthority(series([['stable', bnd], ['unstable', bnd]]))
  assert.equal(v.max_reach, 2)
  assert.equal(v.reach, 1)
  assert.deepEqual(v.bounds, { min: 2, max: 5, base: 3 })
  assert.deepEqual(v.effective_bounds, { min: 2, max: 4, base: 3 }) // low arm clamped at the rail
})

test('23a — a degenerate rail (nothing to tune) yields a structurally frozen no-op', () => {
  const bnd = { bounds: { min: 3, max: 3, base: 3 } }
  const v = tuneEmphasisControlAuthority(series([['unstable', bnd], ['unstable', bnd]]))
  assert.equal(v.max_reach, 0)
  assert.equal(v.reach, 0)
  assert.equal(v.authority, 'frozen')
  assert.deepEqual(v.effective_bounds, { min: 3, max: 3, base: 3 })
})

test('23a — accepts bare verdicts, {as_of,verdict} wrappers, and {as_of,...verdict} spreads', () => {
  const bare = gov('stable') // no as_of
  const wrapped = { as_of: '2026-05-11', verdict: gov('unstable') }
  const spread = { as_of: '2026-05-12', ...gov('unstable') }
  const v = tuneEmphasisControlAuthority([bare, wrapped, spread])
  assert.equal(v.history_len, 3) // all three shapes parsed
  assert.equal(v.governor.trailing_unstable, 2) // …, unstable, unstable
  assert.equal(v.status, 'detuned')
  assert.equal(v.reach, 0)
  assert.equal(v.as_of, '2026-05-12') // newest as_of surfaced; bare's null ignored
})

test('23a — re-exports the shared rails and the default knobs', () => {
  assert.equal(BASE_CAP, 3)
  assert.equal(MIN_CAP, 1)
  assert.equal(MAX_CAP, 5)
  assert.equal(DEFAULT_WINDOW, 6)
  assert.equal(DEFAULT_RESTORE_RUN, 2)
  assert.equal(DEFAULT_MIN_HISTORY, 2)
})

// ════════════════════════════════════════════════════════════════════════════
// Engine hooks — controlAuthorityRails + shouldReduceControlAuthority
// ════════════════════════════════════════════════════════════════════════════

test('23a — controlAuthorityRails returns reduced rails only while authority is below full', () => {
  const detuned = tuneEmphasisControlAuthority(HUNT_FRESH())
  assert.deepEqual(controlAuthorityRails(detuned), { min: 2, max: 4, base: 3, reach: 1, frozen: false })

  const frozen = tuneEmphasisControlAuthority(HUNT_RUN())
  assert.deepEqual(controlAuthorityRails(frozen), { min: 3, max: 3, base: 3, reach: 0, frozen: true })

  const holding = tuneEmphasisControlAuthority(HOLDING())
  assert.deepEqual(controlAuthorityRails(holding), { min: 2, max: 4, base: 3, reach: 1, frozen: false })

  // full authority (default / restored) and junk → null (no constraint to impose)
  assert.equal(controlAuthorityRails(tuneEmphasisControlAuthority(NEVER())), null)
  assert.equal(controlAuthorityRails(tuneEmphasisControlAuthority(RESTORED())), null)
  assert.equal(controlAuthorityRails(null), null)
  assert.equal(controlAuthorityRails({}), null)
})

test('23a — shouldReduceControlAuthority is true ONLY while below full authority', () => {
  assert.equal(shouldReduceControlAuthority(tuneEmphasisControlAuthority(HUNT_FRESH())), true) // detuned
  assert.equal(shouldReduceControlAuthority(tuneEmphasisControlAuthority(HOLDING())), true) // holding
  assert.equal(shouldReduceControlAuthority(tuneEmphasisControlAuthority(NEVER())), false) // default
  assert.equal(shouldReduceControlAuthority(tuneEmphasisControlAuthority(RESTORED())), false) // restored
  assert.equal(shouldReduceControlAuthority(null), false)
  assert.equal(shouldReduceControlAuthority({}), false)
})

// ════════════════════════════════════════════════════════════════════════════
// No-leak discipline + agency narration
// ════════════════════════════════════════════════════════════════════════════

test('23a — client audience gets NOTHING for every status (no-leak, unconditional)', () => {
  const fixtures = [HUNT_FRESH(), HUNT_RUN(), RESTORED(), HOLDING(), NEVER(), CONSTRAINED()]
  for (const f of fixtures) {
    const v = tuneEmphasisControlAuthority(f)
    assert.equal(narrateEmphasisControlTuning(v, { audience: 'client' }), '')
  }
  assert.equal(narrateEmphasisControlTuning(null, { audience: 'client' }), '')
  assert.equal(narrateEmphasisControlTuning(undefined), '')
})

test('23a — agency narration speaks for detuned/restored, silent for holding/default', () => {
  assert.match(narrateEmphasisControlTuning(tuneEmphasisControlAuthority(HUNT_FRESH())), /narrowed|settle/i)
  assert.match(narrateEmphasisControlTuning(tuneEmphasisControlAuthority(HUNT_RUN())), /single steady setting|stops swinging/i)
  assert.match(narrateEmphasisControlTuning(tuneEmphasisControlAuthority(RESTORED())), /steady again|handed back/i)
  assert.equal(narrateEmphasisControlTuning(tuneEmphasisControlAuthority(HOLDING())), '')
  assert.equal(narrateEmphasisControlTuning(tuneEmphasisControlAuthority(NEVER())), '')
})

test('23a — agency narration carries NO machine vocabulary (leak-guard safe)', () => {
  const banned = /detuned|holding|restored|reduce_authority|hold_authority|restore_authority|hunting|max_reach|effective_bounds|\bauthority\b|\breach\b|verdict|recommended_action|stability_proven|awaiting_stability|no_intervention/i
  for (const f of [HUNT_FRESH(), HUNT_RUN(), RESTORED()]) {
    const line = narrateEmphasisControlTuning(tuneEmphasisControlAuthority(f))
    assert.ok(line.length > 0)
    assert.ok(!banned.test(line), `leaked machine vocab: ${line}`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Purity
// ════════════════════════════════════════════════════════════════════════════

test('23a — never mutates its input and is deterministic across repeated calls', () => {
  const frozen = deepFreeze(RESTORED())
  const a = tuneEmphasisControlAuthority(frozen)
  const b = tuneEmphasisControlAuthority(frozen)
  assert.deepEqual(a, b)
  assert.equal(a.status, 'restored')
})
