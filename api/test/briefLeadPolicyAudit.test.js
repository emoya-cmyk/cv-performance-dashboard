'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  auditLeadPolicyGovernance,
  shouldEscalateGovernance,
  narrateLeadPolicyGovernanceAudit,
  humanizeLane,
  DEFAULT_WINDOW,
  DEFAULT_RECURRING_RUNS,
  DEFAULT_MIN_HISTORY,
} = require('../lib/briefLeadPolicyAudit')
// the REAL governor and monitor — every fixture below is minted from the actual governor so a
// test can never pass against a hand-stamped shape the governor would never emit.
const { governLeadPolicy } = require('../lib/briefLeadPolicyGovernor')
const { assessLeadPolicyHealth } = require('../lib/briefLeadPolicyHealth')

// ── tiny helpers (briefLeadPolicy / -Health / -Governor test house style) ────
// one deriveLeadPolicy-shaped lane cell with the display fields that ride alongside the weight.
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
// a full deriveLeadPolicy result; rollups recomputed so status is honest.
const ppolicy = (lanes, opts = {}) => {
  let promoted = 0, demoted = 0, floored = 0, adjusted = 0
  for (const k of Object.keys(lanes)) {
    const e = lanes[k]
    if (e.safetyFloored) floored++
    if (e.weight !== 1) { adjusted++; e.direction === 'promote' ? promoted++ : demoted++ }
  }
  return {
    status: opts.status ?? (adjusted > 0 ? 'tuned' : 'idle'),
    neutral_rate: 0.5, min_sample: 4,
    bounds: opts.bounds ?? { min: 0.8, max: 1.2 },
    safety_floor_lanes: opts.floorLanes ?? ['act_now'],
    lanes, promoted, demoted, floored, adjusted_count: adjusted,
    ...(opts.as_of ? { as_of: opts.as_of } : {}),
  }
}
// a hand-built verdict — the governor reads only verdict.status and verdict.lanes[k].state.
const vlane = (state) => ({ state })
const vverdict = (status, lanes) => ({ status, recommended_action: 'x', lanes: lanes || {} })
// monitor-snapshot helpers for the end-to-end chain test.
const hlane = (weight, direction, floored = false) => ({ weight, direction, adjusted: weight !== 1, safetyFloored: !!floored })
const hsnap = (lanes, as_of) => (as_of ? { as_of, lanes } : { lanes })
// freeze a structure so any accidental input mutation throws (purity proof).
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) }
  return o
}

// Mint a REAL governor result for ONE morning. `osc` = the lanes the monitor flagged
// oscillating (each gets neutralised by the real governor); the safety-floored act_now always
// rides along untouched. osc=[] yields a genuinely clean morning (no interventions).
const morning = (osc = []) => {
  const lanes = { act_now: plane(1, { direction: 'neutral', floored: true }) }
  const vlanes = {}
  for (const L of osc) { lanes[L] = plane(1.1, { direction: 'promote' }); vlanes[L] = vlane('oscillating') }
  return governLeadPolicy(ppolicy(lanes), vverdict(osc.length ? 'unstable' : 'stable', vlanes))
}
// a REAL advisory-only morning: one saturated lane HELD at its bound (changes no weight).
const morningHold = (lane) =>
  governLeadPolicy(ppolicy({ [lane]: plane(1.2, { direction: 'promote' }) }),
    vverdict('constrained', { [lane]: vlane('saturated_high') }))

// the agency one-liner is internal copy, but it must still read as plain English — none of the
// raw control-plane vocabulary may leak into it.
const FORBIDDEN_NARRATION_TOKENS =
  /neutralize|hold_at_bound|respect_floor|oscillat|from_weight|to_weight|lead_policy|leadPolicy|\bgoverned\b|safetyFloored|\bweight\b|\brecurring\b|\bchurning\b|\bescalate\b|\bintermittent\b|one_off|\bresolved\b|\blanes\b|adjusted/i

const STATUSES = ['churning', 'effective', 'quiet', 'abstained']
function assertShape(r, where) {
  assert.ok(r && typeof r === 'object', `${where}: result object`)
  assert.ok(STATUSES.includes(r.status), `${where}: status "${r.status}" invalid`)
  assert.ok(r.recommendation && (r.recommendation.action === 'escalate' || r.recommendation.action === 'none'), `${where}: recommendation.action`)
  assert.ok(Array.isArray(r.recommendation.lanes), `${where}: recommendation.lanes array`)
  for (const k of ['recurring', 'resolved', 'intermittent', 'one_off', 'corrected_mornings', 'advisory_mornings', 'quiet_mornings'])
    assert.ok(Number.isInteger(r.counts[k]), `${where}: counts.${k} integer`)
  assert.ok(r.lanes && typeof r.lanes === 'object', `${where}: lanes object`)
}

// ============================================================
// 0. premise guard — the fixtures really are unadapted governor output
// ============================================================

test('audit: fixtures are REAL governor output (premise guard)', () => {
  const m = morning(['verify'])
  assert.equal(m.status, 'corrected')
  assert.equal(m.interventions.length, 1)
  assert.equal(m.interventions[0].action, 'neutralize') // the real action string the audit keys on
  assert.equal(m.interventions[0].lane, 'verify')
  const clean = morning([])
  assert.equal(clean.status, 'clean')
  assert.deepEqual(clean.interventions, [])
  const held = morningHold('tailwind')
  assert.equal(held.status, 'advised')
  assert.equal(held.interventions[0].action, 'hold_at_bound')
})

test('audit: sensible exported defaults (a window must hold a full recurring run)', () => {
  assert.ok(DEFAULT_WINDOW >= DEFAULT_RECURRING_RUNS, 'window >= recurringRuns')
  assert.ok(DEFAULT_RECURRING_RUNS >= 2, 'a run is more than one morning')
  assert.ok(DEFAULT_MIN_HISTORY >= 2, 'one morning is not a track record')
  assert.equal(humanizeLane('worth_a_look'), 'worth a look')
})

// ============================================================
// A. fail-safe — junk in, a well-formed abstention out, never a throw
// ============================================================

test('audit: junk and non-arrays never throw, return a well-formed abstained', () => {
  for (const junk of [null, undefined, 42, 'x', {}, [null], [1, 2, 3], [{}], [{ interventions: 'nope' }], [{ status: 'x' }]]) {
    let r
    assert.doesNotThrow(() => { r = auditLeadPolicyGovernance(junk) }, `threw on ${JSON.stringify(junk)}`)
    assertShape(r, `junk ${JSON.stringify(junk)}`)
    assert.equal(r.status, 'abstained')
    assert.deepEqual(r.recommendation, { action: 'none', lanes: [] })
    assert.deepEqual(r.lanes, {})
    assert.equal(r.counts.recurring, 0)
  }
})

test('audit: abstains below minHistory — one morning is not a track record', () => {
  const r1 = auditLeadPolicyGovernance([morning(['verify'])])
  assert.equal(r1.status, 'abstained')
  assert.equal(r1.audit_reason, 'abstained:thin_history')
  assert.equal(r1.history_len, 1)
  // a custom floor: two usable mornings still abstain under minHistory:3.
  const r2 = auditLeadPolicyGovernance([morning(['verify']), morning(['verify'])], { minHistory: 3 })
  assert.equal(r2.status, 'abstained')
})

// ============================================================
// B. quiet — the governor had nothing to heal (the healthy quiet)
// ============================================================

test('audit: an all-clean history reads quiet, recommends nothing', () => {
  const r = auditLeadPolicyGovernance([morning([]), morning([]), morning([])])
  assertShape(r, 'quiet')
  assert.equal(r.status, 'quiet')
  assert.equal(r.audit_reason, 'quiet')
  assert.deepEqual(r.recommendation, { action: 'none', lanes: [] })
  assert.deepEqual(r.lanes, {})
  assert.equal(r.counts.corrected_mornings, 0)
  assert.equal(r.counts.quiet_mornings, 3)
})

test('audit: advisory holds are NOT churn by default; the correctingActions knob can include them', () => {
  const hist = [morningHold('tailwind'), morningHold('tailwind'), morningHold('tailwind')]
  // default — a hold changes no weight, so it is an advisory, not a correction → quiet.
  const def = auditLeadPolicyGovernance(hist)
  assert.equal(def.status, 'quiet')
  assert.equal(def.counts.advisory_mornings, 3)
  assert.equal(def.counts.corrected_mornings, 0)
  assert.deepEqual(def.lanes, {})
  // opt in — count hold_at_bound as a correction and the same lane reads as a standing run.
  const incl = auditLeadPolicyGovernance(hist, { correctingActions: ['neutralize', 'hold_at_bound'] })
  assert.equal(incl.status, 'churning')
  assert.deepEqual(incl.recommendation, { action: 'escalate', lanes: ['tailwind'] })
})

// ============================================================
// C. effective — corrections happened and took; the per-lane outcomes classify
// ============================================================

test('audit: corrections that settle read effective; outcomes classify per lane', () => {
  const hist = [
    morning(['worth_a_look', 'tailwind']), // m0
    morning([]),                           // m1 — clean
    morning(['tailwind']),                 // m2
    morning(['verify', 'tailwind']),       // m3 — newest
  ]
  const r = auditLeadPolicyGovernance(hist)
  assertShape(r, 'effective')
  assert.equal(r.status, 'effective')
  assert.equal(r.recommendation.action, 'none')
  assert.equal(r.lanes.verify.outcome, 'one_off')        // [F,F,F,T]
  assert.equal(r.lanes.verify.current_run, 1)
  assert.equal(r.lanes.worth_a_look.outcome, 'resolved') // [T,F,F,F]
  assert.equal(r.lanes.worth_a_look.current_run, 0)
  assert.equal(r.lanes.tailwind.outcome, 'intermittent') // [T,F,T,T]
  assert.equal(r.lanes.tailwind.current_run, 2)
  assert.equal(r.lanes.tailwind.corrections, 3)
  assert.deepEqual(r.counts, {
    recurring: 0, resolved: 1, intermittent: 1, one_off: 1,
    corrected_mornings: 3, advisory_mornings: 0, quiet_mornings: 1,
  })
})

// ============================================================
// D. churning — a standing run the safe corrective is not resolving → escalate
// ============================================================

test('audit: a standing run reads churning and escalates ONLY the recurring lane', () => {
  const hist = [
    morning(['verify', 'worth_a_look']), // worth_a_look corrected once, then settles
    morning(['verify']),
    morning(['verify']),
    morning(['verify']),                 // verify: a 4-morning run
  ]
  const r = auditLeadPolicyGovernance(hist)
  assertShape(r, 'churning')
  assert.equal(r.status, 'churning')
  assert.equal(r.lanes.verify.outcome, 'recurring')
  assert.equal(r.lanes.verify.current_run, 4)
  assert.equal(r.lanes.worth_a_look.outcome, 'resolved') // a resolved lane never enters the escalation
  assert.deepEqual(r.recommendation, { action: 'escalate', lanes: ['verify'] })
  assert.equal(r.counts.recurring, 1)
  assert.match(r.audit_reason, /^churning:verify$/)
})

// ============================================================
// E. window — only the most-recent mornings are weighed
// ============================================================

test('audit: corrections older than the window fall out of scope', () => {
  const hist = [morning(['verify']), morning(['verify'])] // 2 old corrections...
  for (let i = 0; i < 8; i++) hist.push(morning([]))       // ...buried under 8 clean mornings
  const r = auditLeadPolicyGovernance(hist)                // default window 8 → only the clean tail counts
  assert.equal(r.status, 'quiet')
  assert.equal(r.window_used, 8)
  assert.equal(r.history_len, 10)
  assert.deepEqual(r.lanes, {})
})

// ============================================================
// F. narrator — client silent always; agency speaks ONLY on churning
// ============================================================

test('audit: the narrator is silent to the client across every status', () => {
  const byStatus = {
    churning: auditLeadPolicyGovernance([morning(['verify']), morning(['verify']), morning(['verify'])]),
    effective: auditLeadPolicyGovernance([morning(['verify']), morning([]), morning([])]),
    quiet: auditLeadPolicyGovernance([morning([]), morning([]), morning([])]),
    abstained: auditLeadPolicyGovernance([morning(['verify'])]),
  }
  for (const [name, r] of Object.entries(byStatus)) {
    assert.equal(r.status, name, `fixture should be ${name}`)
    assert.equal(narrateLeadPolicyGovernanceAudit(r, { audience: 'client' }), '', `client must be silent for ${name}`)
  }
})

test('audit: the narrator speaks to the agency ONLY when churning — humanized, counted, leak-free', () => {
  const churn = auditLeadPolicyGovernance([morning(['worth_a_look']), morning(['worth_a_look']), morning(['worth_a_look'])])
  assert.equal(churn.status, 'churning')
  const line = narrateLeadPolicyGovernanceAudit(churn, { audience: 'agency' })
  assert.ok(line.length > 0, 'agency speaks on churning')
  assert.ok(line.includes('worth a look'), 'lane is humanized')
  assert.ok(!line.includes('worth_a_look'), 'no raw underscore key')
  assert.match(line, /3 mornings running/)
  assert.doesNotMatch(line, FORBIDDEN_NARRATION_TOKENS) // no internal control-plane vocabulary leaks
  // silent on the non-urgent postures — a corrective that takes is not news.
  assert.equal(narrateLeadPolicyGovernanceAudit(auditLeadPolicyGovernance([morning(['verify']), morning([]), morning([])]), { audience: 'agency' }), '')
  assert.equal(narrateLeadPolicyGovernanceAudit(auditLeadPolicyGovernance([morning([]), morning([])]), { audience: 'agency' }), '')
  assert.equal(narrateLeadPolicyGovernanceAudit(auditLeadPolicyGovernance([morning(['verify'])]), { audience: 'agency' }), '')
})

// ============================================================
// G. the self-improving hook
// ============================================================

test('audit: shouldEscalateGovernance tracks the churning verdict and is fail-safe', () => {
  assert.equal(shouldEscalateGovernance(auditLeadPolicyGovernance([morning(['verify']), morning(['verify']), morning(['verify'])])), true)
  assert.equal(shouldEscalateGovernance(auditLeadPolicyGovernance([morning(['verify']), morning([]), morning([])])), false)
  assert.equal(shouldEscalateGovernance(auditLeadPolicyGovernance([morning([]), morning([])])), false)
  assert.equal(shouldEscalateGovernance(auditLeadPolicyGovernance([])), false)
  assert.equal(shouldEscalateGovernance(null), false)
})

// ============================================================
// H. purity + the wrappers + the full SENSE→ACT→audit chain
// ============================================================

test('audit: pure — frozen inputs never throw, output is deterministic, inputs unmutated', () => {
  const hist = [morning(['verify', 'tailwind']), morning(['verify']), morning(['verify'])]
  const before = JSON.stringify(hist)
  deepFreeze(hist)
  let r1, r2
  assert.doesNotThrow(() => { r1 = auditLeadPolicyGovernance(hist) })
  assert.doesNotThrow(() => { r2 = auditLeadPolicyGovernance(hist) })
  assert.deepEqual(r1, r2, 'same input → identical output')
  assert.equal(JSON.stringify(hist), before, 'input history not mutated')
})

test('audit: accepts bare results, {as_of,...gov} and {as_of,governance} wrappers; surfaces newest as_of', () => {
  const g0 = morning(['verify']), g1 = morning(['verify']), g2 = morning(['verify'])
  const wrapped = [
    { as_of: '2026-06-01', ...g0 },          // { as_of, ...governorResult }
    { as_of: '2026-06-02', governance: g1 },  // { as_of, governance }
    { as_of: '2026-06-03', ...g2 },
  ]
  const r = auditLeadPolicyGovernance(wrapped)
  assert.equal(r.status, 'churning')
  assert.equal(r.as_of, '2026-06-03', 'newest as_of surfaces')
  assert.deepEqual(r.recommendation, { action: 'escalate', lanes: ['verify'] })
})

test('audit: full chain — real monitor verdict → real governor → audit reads churning', () => {
  // a genuinely oscillating verify lane, graded by the REAL stability monitor.
  const hist = [
    hsnap({ verify: hlane(1.1, 'promote') }),
    hsnap({ verify: hlane(0.9, 'demote') }),
    hsnap({ verify: hlane(1.1, 'promote') }),
    hsnap({ verify: hlane(0.9, 'demote') }),
  ]
  const verdict = assessLeadPolicyHealth(hist)
  const policy = ppolicy({ act_now: plane(1, { direction: 'neutral', floored: true }), verify: plane(1.1, { direction: 'promote' }) })
  const realGov = governLeadPolicy(policy, verdict)
  assert.equal(realGov.status, 'corrected') // premise: the governor really did correct verify
  const audit = auditLeadPolicyGovernance([realGov, realGov, realGov])
  assert.equal(audit.status, 'churning')
  assert.deepEqual(audit.recommendation, { action: 'escalate', lanes: ['verify'] })
})
