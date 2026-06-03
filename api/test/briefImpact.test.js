'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  summarizeBriefImpact,
  classifyLeadOutcome,
  narrateBriefImpact,
  impactLabel,
  followState,
  DEFAULT_CONFIRM_WINDOW,
  DEFAULT_MIN_SAMPLE,
} = require('../lib/briefImpact')

// ── small builders ─────────────────────────────────────────────────────────
// A follow-up that CONFIRMS an adverse lead (still firing, same polarity).
const confADv = { status: 'signal', adverse: true }
// A follow-up that REFUTES (reverted to normal).
const revert = { status: 'normal', adverse: true }
// A follow-up with no data (sensor couldn't speak).
const nodata = { status: 'insufficient' }
// A favorable lead's confirming follow-up (still firing, NOT adverse).
const confFav = { status: 'signal', adverse: false }

function obs(extra = {}) {
  return { audience: 'agency', lane: 'act_now', adverse: true, followups: [], ...extra }
}

// =============================================================================
// followState — the normalizer is the load-bearing primitive
// =============================================================================
test('followState: dayPulse {status} shape — confirm / refute / nodata', () => {
  assert.equal(followState({ status: 'signal', adverse: true }, true), 'confirm')
  assert.equal(followState({ status: 'normal', adverse: true }, true), 'refute')
  assert.equal(followState({ status: 'insufficient' }, true), 'nodata')
})

test('followState: polarity flip refutes (signal, opposite direction)', () => {
  // lead was adverse; a follow-up firing the FAVORABLE way is not a confirmation.
  assert.equal(followState({ status: 'signal', adverse: false }, true), 'refute')
  // lead was favorable; a follow-up firing adverse is likewise a refute.
  assert.equal(followState({ status: 'signal', adverse: true }, false), 'refute')
  // favorable lead, favorable follow-up → confirm.
  assert.equal(followState({ status: 'signal', adverse: false }, false), 'confirm')
})

test('followState: terse {signal:boolean} shape accepted', () => {
  assert.equal(followState({ signal: true, adverse: true }, true), 'confirm')
  assert.equal(followState({ signal: false }, true), 'refute')
})

test('followState: anything unreadable → nodata (never throws)', () => {
  assert.equal(followState(null, true), 'nodata')
  assert.equal(followState(undefined, true), 'nodata')
  assert.equal(followState(42, true), 'nodata')
  assert.equal(followState({}, true), 'nodata') // neither status nor signal present
  assert.equal(followState({ adverse: true }, true), 'nodata')
})

// =============================================================================
// classifyLeadOutcome — one lead, its follow-through, one verdict
// =============================================================================
test('classifyLeadOutcome: majority confirm → hit', () => {
  const r = classifyLeadOutcome(obs({ followups: [confADv, confADv, revert] }))
  assert.equal(r.outcome, 'hit')
  assert.equal(r.usable, 3)
  assert.equal(r.confirms, 2)
  assert.equal(r.window, DEFAULT_CONFIRM_WINDOW)
})

test('classifyLeadOutcome: majority refute → miss', () => {
  const r = classifyLeadOutcome(obs({ followups: [revert, revert, confADv] }))
  assert.equal(r.outcome, 'miss')
  assert.equal(r.usable, 3)
  assert.equal(r.confirms, 1)
})

test('classifyLeadOutcome: confirmFloor is inclusive — exactly half confirms → hit', () => {
  const r = classifyLeadOutcome(obs({ followups: [confADv, revert] })) // 1/2 = 0.5
  assert.equal(r.outcome, 'hit')
})

test('classifyLeadOutcome: no usable follow-up → unknown', () => {
  assert.equal(classifyLeadOutcome(obs({ followups: [] })).outcome, 'unknown')
  assert.equal(classifyLeadOutcome(obs({ followups: [nodata, nodata] })).outcome, 'unknown')
})

test('classifyLeadOutcome: no-data follow-ups are excluded from usable, not counted against', () => {
  // one confirm + two nodata → usable 1, confirms 1 → hit (abstain on the blanks).
  const r = classifyLeadOutcome(obs({ followups: [nodata, confADv, nodata] }))
  assert.equal(r.usable, 1)
  assert.equal(r.confirms, 1)
  assert.equal(r.outcome, 'hit')
})

test('classifyLeadOutcome: only the first `window` follow-ups count', () => {
  // window 2: [confirm, confirm | revert, revert] — the trailing refutes are out of window.
  const r = classifyLeadOutcome(obs({ followups: [confADv, confADv, revert, revert] }), { window: 2 })
  assert.equal(r.window, 2)
  assert.equal(r.usable, 2)
  assert.equal(r.confirms, 2)
  assert.equal(r.outcome, 'hit')
})

test('classifyLeadOutcome: minFollow gate — needs enough data to judge', () => {
  // one usable follow-up, minFollow 2 → unknown.
  assert.equal(classifyLeadOutcome(obs({ followups: [confADv, nodata] }), { minFollow: 2 }).outcome, 'unknown')
})

test('classifyLeadOutcome: favorable lead graded on its own polarity', () => {
  const favLead = { adverse: false, followups: [confFav, confFav] }
  assert.equal(classifyLeadOutcome(favLead).outcome, 'hit')
  // a favorable lead that flips adverse next mornings → miss.
  assert.equal(classifyLeadOutcome({ adverse: false, followups: [confADv, confADv] }).outcome, 'miss')
})

test('classifyLeadOutcome: garbage observation never throws → unknown', () => {
  assert.equal(classifyLeadOutcome(null).outcome, 'unknown')
  assert.equal(classifyLeadOutcome({}).outcome, 'unknown')
  assert.equal(classifyLeadOutcome({ followups: 'nope' }).outcome, 'unknown')
})

// =============================================================================
// impactLabel — the third, disjoint vocabulary
// =============================================================================
test('impactLabel: bands earned / fair / overcalled, null off-range', () => {
  assert.equal(impactLabel(1), 'earned')
  assert.equal(impactLabel(0.7), 'earned')
  assert.equal(impactLabel(0.69), 'fair')
  assert.equal(impactLabel(0.4), 'fair')
  assert.equal(impactLabel(0.39), 'overcalled')
  assert.equal(impactLabel(0), 'overcalled')
  assert.equal(impactLabel(null), null)
  assert.equal(impactLabel(NaN), null)
})

// =============================================================================
// summarizeBriefImpact — rollup, abstention, invariants
// =============================================================================
test('summarizeBriefImpact: empty → insufficient_history, empty buckets, never throws', () => {
  const s = summarizeBriefImpact([])
  assert.equal(s.status, 'insufficient')
  assert.equal(s.reason, 'insufficient_history')
  assert.equal(s.sample, 0)
  assert.equal(s.judged, 0)
  assert.equal(s.hit_rate, null)
  assert.equal(s.label, null)
  assert.deepEqual(s.by_lane, {})
  assert.equal(s.by_audience.client.sample, 0)
  assert.equal(s.by_audience.agency.sample, 0)
  // tolerates non-arrays
  assert.equal(summarizeBriefImpact(null).status, 'insufficient')
  assert.equal(summarizeBriefImpact(undefined).reason, 'insufficient_history')
})

test('summarizeBriefImpact: some but < minSample resolved → insufficient_sample, raw tally kept', () => {
  // 3 resolved (< default 4) + 1 unknown.
  const s = summarizeBriefImpact([
    obs({ followups: [confADv, confADv] }), // hit
    obs({ followups: [confADv, confADv] }), // hit
    obs({ followups: [revert, revert] }),   // miss
    obs({ followups: [] }),                 // unknown
  ])
  assert.equal(s.status, 'insufficient')
  assert.equal(s.reason, 'insufficient_sample')
  assert.equal(s.min_sample, DEFAULT_MIN_SAMPLE)
  assert.equal(s.sample, 4)
  assert.equal(s.judged, 3)
  assert.equal(s.hits, 2)
  assert.equal(s.misses, 1)
  assert.equal(s.unknown, 1)
  assert.equal(s.label, null) // no claim on a thin record
  // raw hit_rate still computed and visible even when abstaining on the label
  assert.equal(s.hit_rate, round(2 / 3))
})

test('summarizeBriefImpact: graded — hit_rate + label correct', () => {
  // 8 hits, 2 misses → 0.8 → earned.
  const list = []
  for (let i = 0; i < 8; i++) list.push(obs({ followups: [confADv, confADv] }))
  for (let i = 0; i < 2; i++) list.push(obs({ followups: [revert, revert] }))
  const s = summarizeBriefImpact(list)
  assert.equal(s.status, 'graded')
  assert.equal(s.reason, 'graded')
  assert.equal(s.judged, 10)
  assert.equal(s.hits, 8)
  assert.equal(s.hit_rate, 0.8)
  assert.equal(s.label, 'earned')
})

test('summarizeBriefImpact: overcalled record grades low', () => {
  const list = []
  for (let i = 0; i < 2; i++) list.push(obs({ followups: [confADv, confADv] })) // hit
  for (let i = 0; i < 7; i++) list.push(obs({ followups: [revert, revert] }))   // miss
  const s = summarizeBriefImpact(list)
  assert.equal(s.status, 'graded')
  assert.equal(s.label, 'overcalled')
  assert.equal(s.hit_rate, round(2 / 9))
})

test('summarizeBriefImpact: invariant hits+misses+unknown===sample (overall + buckets)', () => {
  const list = [
    obs({ lane: 'act_now', followups: [confADv, confADv] }),
    obs({ lane: 'act_now', followups: [revert, revert] }),
    obs({ lane: 'tailwind', adverse: false, followups: [confFav] }),
    obs({ lane: null, followups: [] }),                 // unknown, unspecified lane
    obs({ audience: 'client', lane: 'act_now', followups: [confADv] }),
  ]
  const s = summarizeBriefImpact(list, { minSample: 1 })
  assert.equal(s.hits + s.misses + s.unknown, s.sample)
  for (const k of Object.keys(s.by_lane)) {
    const b = s.by_lane[k]
    assert.equal(b.hits + b.misses + b.unknown, b.sample, `lane ${k}`)
  }
  const a = s.by_audience
  assert.equal(a.client.hits + a.client.misses + a.client.unknown, a.client.sample)
  assert.equal(a.agency.hits + a.agency.misses + a.agency.unknown, a.agency.sample)
  // overall sample is the sum of the two audience buckets
  assert.equal(a.client.sample + a.agency.sample, s.sample)
})

test('summarizeBriefImpact: by_lane keys + unspecified bucket', () => {
  const s = summarizeBriefImpact([
    obs({ lane: 'act_now', followups: [confADv, confADv] }),
    obs({ lane: 'tailwind', adverse: false, followups: [confFav, confFav] }),
    obs({ lane: '', followups: [revert, revert] }), // empty lane → 'unspecified'
  ], { minSample: 1 })
  assert.deepEqual(Object.keys(s.by_lane).sort(), ['act_now', 'tailwind', 'unspecified'])
  assert.equal(s.by_lane.act_now.hits, 1)
  assert.equal(s.by_lane.tailwind.hits, 1)
  assert.equal(s.by_lane.unspecified.misses, 1)
})

test('summarizeBriefImpact: by_audience splits client vs agency', () => {
  const s = summarizeBriefImpact([
    obs({ audience: 'agency', followups: [confADv, confADv] }),
    obs({ audience: 'client', followups: [revert, revert] }),
    obs({ audience: 'client', followups: [confADv, confADv] }),
  ], { minSample: 1 })
  assert.equal(s.by_audience.agency.hits, 1)
  assert.equal(s.by_audience.agency.misses, 0)
  assert.equal(s.by_audience.client.hits, 1)
  assert.equal(s.by_audience.client.misses, 1)
  assert.equal(s.by_audience.client.hit_rate, 0.5)
})

test('summarizeBriefImpact: unknowns never inflate judged or trip minSample', () => {
  const list = []
  for (let i = 0; i < 10; i++) list.push(obs({ followups: [nodata] })) // all unknown
  const s = summarizeBriefImpact(list)
  assert.equal(s.sample, 10)
  assert.equal(s.judged, 0)
  assert.equal(s.unknown, 10)
  assert.equal(s.status, 'insufficient')
  assert.equal(s.reason, 'insufficient_sample') // had observations, just none resolved
  assert.equal(s.hit_rate, null)
})

test('summarizeBriefImpact: opts (window, confirmFloor, minSample) forwarded', () => {
  // confirmFloor 0.75 turns a 2/3-confirm lead from hit into miss.
  const two3 = obs({ followups: [confADv, confADv, revert] })
  assert.equal(summarizeBriefImpact([two3], { minSample: 1 }).hits, 1)
  assert.equal(summarizeBriefImpact([two3], { minSample: 1, confirmFloor: 0.75 }).misses, 1)
  // minSample override lets a tiny record grade.
  assert.equal(summarizeBriefImpact([obs({ followups: [confADv] })], { minSample: 1 }).status, 'graded')
})

test('summarizeBriefImpact: filters null observations, never throws on junk', () => {
  const s = summarizeBriefImpact([null, undefined, obs({ followups: [confADv] }), 0, false], { minSample: 1 })
  assert.equal(s.sample, 1)
  assert.equal(s.status, 'graded')
})

// =============================================================================
// narrateBriefImpact — agency-rich, client reinforce-only, grounded figures
// =============================================================================
function gradedEarned() {
  const list = []
  for (let i = 0; i < 8; i++) list.push(obs({ followups: [confADv, confADv] }))
  for (let i = 0; i < 2; i++) list.push(obs({ followups: [revert, revert] }))
  return summarizeBriefImpact(list)
}

test('narrateBriefImpact: un-graded → empty string', () => {
  assert.equal(narrateBriefImpact(null, { audience: 'agency' }), '')
  assert.equal(narrateBriefImpact(summarizeBriefImpact([]), { audience: 'agency' }), '')
  // insufficient_sample (hit_rate present but not graded) still stays silent
  const thin = summarizeBriefImpact([obs({ followups: [confADv] })]) // 1 judged < 4
  assert.equal(thin.status, 'insufficient')
  assert.equal(narrateBriefImpact(thin, { audience: 'agency' }), '')
})

test('narrateBriefImpact: agency earned — figures copied straight off the grade', () => {
  const s = gradedEarned()
  const line = narrateBriefImpact(s, { audience: 'agency' })
  assert.match(line, /earned their place 8 of 10 times recently \(~80%\)/)
  assert.match(line, /well-aimed/)
})

test('narrateBriefImpact: agency overcalled phrasing + verb', () => {
  const list = []
  for (let i = 0; i < 2; i++) list.push(obs({ followups: [confADv, confADv] }))
  for (let i = 0; i < 7; i++) list.push(obs({ followups: [revert, revert] }))
  const line = narrateBriefImpact(summarizeBriefImpact(list), { audience: 'agency' })
  assert.match(line, /held up 2 of 9 times/)
  assert.match(line, /overcalling; tighten lead selection/)
})

test('narrateBriefImpact: agency fair record', () => {
  const list = []
  for (let i = 0; i < 5; i++) list.push(obs({ followups: [confADv, confADv] })) // hit
  for (let i = 0; i < 5; i++) list.push(obs({ followups: [revert, revert] }))   // miss
  const s = summarizeBriefImpact(list)
  assert.equal(s.label, 'fair')
  assert.match(narrateBriefImpact(s, { audience: 'agency' }), /a fair record/)
})

test('narrateBriefImpact: client only reinforces an earned record, else silent', () => {
  assert.equal(
    narrateBriefImpact(gradedEarned(), { audience: 'client' }),
    'When we lead your morning brief with something, it has usually held up.'
  )
  // fair / overcalled → client sees nothing (never volunteer a weak front page)
  const list = []
  for (let i = 0; i < 5; i++) list.push(obs({ followups: [confADv, confADv] }))
  for (let i = 0; i < 5; i++) list.push(obs({ followups: [revert, revert] }))
  assert.equal(narrateBriefImpact(summarizeBriefImpact(list), { audience: 'client' }), '')
})

test('narrateBriefImpact: singular noun + scopeLabel override', () => {
  // exactly one judged lead, graded via minSample override → "1 time"
  const s = summarizeBriefImpact([obs({ followups: [confADv, confADv] })], { minSample: 1 })
  const line = narrateBriefImpact(s, { audience: 'agency', scopeLabel: 'Portfolio headlines' })
  assert.match(line, /^Portfolio headlines have earned their place 1 of 1 time recently/)
})

// local rounding mirror for the assertions above
function round(x) {
  return Math.round(x * 1e4) / 1e4
}
