'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  summarizePortfolioPulse,
  summarizeClientPulse,
  isCredible,
  isGraded,
  confidenceLabel,
} = require('../lib/pulseBriefing')
const { rankPulseSignals } = require('../lib/pulseTriage')
const { deriveLeadPolicy } = require('../lib/briefLeadPolicy')

// --- fixture helper: the RAW signal shape rankPulseSignals consumes -----------------
// (severity/adverse/reliability/reliability_label/accuracy_label/delta_pct/z + ids).
// summarizePortfolioPulse calls rankPulseSignals internally, so lane / triage_reason are
// DERIVED — the test only sets inputs and asserts on the synthesis.
function sig(o = {}) {
  // client_id defaults to a slug OF client_name (distinct names → distinct ids, the way
  // real rows arrive) so the roster's client-dedup is exercised honestly. `in` checks let
  // a test pass an explicit `undefined` (the client-pulse rows carry no client identity).
  const name = 'client_name' in o ? o.client_name : 'Acme'
  const cid = 'client_id' in o
    ? o.client_id
    : (name == null ? 'c1' : String(name).toLowerCase().replace(/\s+/g, '_'))
  return {
    client_id:   cid,
    client_name: name,
    metric:      o.metric ?? 'leads',
    label:       o.label ?? 'Leads',
    severity:    o.severity ?? 'critical',
    adverse:     o.adverse ?? true,
    direction:   o.direction ?? 'down',
    delta_pct:   o.delta_pct ?? -40,
    z:           o.z ?? -3,
    ...(o.reliability != null ? { reliability: o.reliability } : {}),
    ...(o.reliability_label != null ? { reliability_label: o.reliability_label } : {}),
    ...(o.accuracy_label != null ? { accuracy_label: o.accuracy_label } : {}),
    ...(o.extra || {}),
  }
}

// =====================================================================================
// helpers — credibility / graded splits + confidence thresholds
// =====================================================================================
test('pulseBriefing.isCredible — proven accuracy OR reliable consistency, nothing less', () => {
  assert.equal(isCredible({ accuracy_label: 'proven' }), true)
  assert.equal(isCredible({ reliability_label: 'reliable' }), true)
  assert.equal(isCredible({ accuracy_label: 'developing', reliability_label: 'mixed' }), false)
  assert.equal(isCredible({ accuracy_label: 'learning', reliability_label: 'noisy' }), false)
  assert.equal(isCredible({}), false)
  assert.equal(isCredible(null), false)
})

test('pulseBriefing.isGraded — any track record on either axis', () => {
  assert.equal(isGraded({ accuracy_label: 'learning' }), true)
  assert.equal(isGraded({ reliability_label: 'noisy' }), true)
  assert.equal(isGraded({ accuracy_label: 'proven', reliability_label: 'reliable' }), true)
  assert.equal(isGraded({}), false)
  assert.equal(isGraded(null), false)
})

test('pulseBriefing.confidenceLabel — monotone in proven_share; graded rescues building→moderate', () => {
  assert.equal(confidenceLabel(0, 0, 0), 'n/a')      // nothing to weigh
  assert.equal(confidenceLabel(0.6, 0.8, 5), 'high')
  assert.equal(confidenceLabel(0.5, 0.5, 4), 'high')
  assert.equal(confidenceLabel(0.25, 0.25, 4), 'moderate') // proven floor
  assert.equal(confidenceLabel(0.1, 0.6, 5), 'moderate')   // graded rescue
  assert.equal(confidenceLabel(0.1, 0.2, 5), 'building')   // mostly new
  assert.equal(confidenceLabel(0, 0, 3), 'building')       // n>0 but ungraded → not n/a
})

// =====================================================================================
// summarizePortfolioPulse — the headline IS act_today[0] (composes, never re-ranks)
// =====================================================================================
test('summarizePortfolioPulse — headline === rankPulseSignals(roster, adverseOnly)[0], by construction', () => {
  const roster = [
    sig({ client_name: 'Acme',   metric: 'leads',   label: 'Leads',   severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven',     delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Harbor', metric: 'revenue', label: 'Revenue', severity: 'warning',  reliability: 0.5, reliability_label: 'mixed',    accuracy_label: 'developing', delta_pct: -22, z: -1.6 }),
    sig({ client_name: 'Vista',  metric: 'spend',   label: 'Spend',   severity: 'critical', reliability: 0.2, reliability_label: 'noisy',    delta_pct: 70,  z: 2.4 }),
    sig({ client_name: 'Zen',    metric: 'jobs',    label: 'Jobs',    severity: 'warning',  delta_pct: -12, z: -1.1 }), // ungraded
    sig({ client_name: 'Acme',   metric: 'calls',   label: 'Calls',   severity: 'warning',  adverse: false, direction: 'up', delta_pct: 30, z: 1.5 }), // tailwind
  ]
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const b = summarizePortfolioPulse(roster)

  assert.deepEqual(b.headline, act[0])           // the one thing IS the top of the action feed
  assert.equal(b.headline.metric, 'leads')       // Acme leads: critical × reliable wins on priority
  assert.equal(b.status, 'briefing')
  assert.equal(b.posture, 'act')                 // an act_now lane is present
})

test('summarizePortfolioPulse — headline_text REUSES the signal\'s own triage_reason verbatim (no new number)', () => {
  const roster = [
    sig({ client_name: 'Acme', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Harbor', metric: 'revenue', label: 'Revenue', severity: 'warning', reliability: 0.5, reliability_label: 'mixed', accuracy_label: 'developing', delta_pct: -22, z: -1.6 }),
    sig({ client_name: 'Vista', metric: 'spend', label: 'Spend', severity: 'critical', reliability: 0.2, reliability_label: 'noisy', delta_pct: 70, z: 2.4 }),
    sig({ client_name: 'Zen', metric: 'jobs', label: 'Jobs', severity: 'warning', delta_pct: -12, z: -1.1 }),
  ]
  const b = summarizePortfolioPulse(roster)
  // the headline sentence contains, verbatim, the triage layer's own sentence for that row
  assert.ok(b.headline.triage_reason && b.headline.triage_reason.length > 0)
  assert.ok(b.headline_text.includes(b.headline.triage_reason),
    `headline_text should embed triage_reason verbatim.\n  text: ${b.headline_text}\n  reason: ${b.headline.triage_reason}`)
  // 4 adverse across 4 clients
  assert.ok(/4 alerts across 4 clients today/.test(b.headline_text), b.headline_text)
})

test('summarizePortfolioPulse — counts + confidence reflect the proven/graded mix', () => {
  const roster = [
    sig({ client_name: 'Acme', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Harbor', metric: 'revenue', label: 'Revenue', severity: 'warning', reliability: 0.5, reliability_label: 'mixed', accuracy_label: 'developing', delta_pct: -22, z: -1.6 }),
    sig({ client_name: 'Vista', metric: 'spend', label: 'Spend', severity: 'critical', reliability: 0.2, reliability_label: 'noisy', delta_pct: 70, z: 2.4 }),
    sig({ client_name: 'Zen', metric: 'jobs', label: 'Jobs', severity: 'warning', delta_pct: -12, z: -1.1 }), // ungraded
    sig({ client_name: 'Acme', metric: 'calls', label: 'Calls', severity: 'warning', adverse: false, direction: 'up', delta_pct: 30, z: 1.5 }), // tailwind
  ]
  const b = summarizePortfolioPulse(roster)
  assert.deepEqual(b.counts, { adverse: 4, clients: 4, act_now: 1, tailwinds: 1, proven: 1, learning: 1 })
  assert.equal(b.confidence.proven_share, 0.25) // 1 of 4 credible
  assert.equal(b.confidence.graded_share, 0.75) // 3 of 4 graded
  assert.equal(b.confidence.label, 'moderate')
  assert.ok(b.confidence.note.length > 0)
})

test('summarizePortfolioPulse — supporting cast: also = act[1..3], also_text names client/metric/lane', () => {
  const roster = [
    sig({ client_name: 'Acme', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Harbor', metric: 'revenue', label: 'Revenue', severity: 'warning', reliability: 0.5, reliability_label: 'mixed', accuracy_label: 'developing', delta_pct: -22, z: -1.6 }),
    sig({ client_name: 'Vista', metric: 'spend', label: 'Spend', severity: 'critical', reliability: 0.2, reliability_label: 'noisy', delta_pct: 70, z: 2.4 }),
    sig({ client_name: 'Zen', metric: 'jobs', label: 'Jobs', severity: 'warning', delta_pct: -12, z: -1.1 }),
  ]
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const b = summarizePortfolioPulse(roster)
  assert.deepEqual(b.also, act.slice(1, 4))
  assert.equal(b.also.length, 3)
  // each supporting row appears as "Name — metric (lane tag)"
  for (const r of b.also) {
    assert.ok(b.also_text.includes(r.client_name), b.also_text)
  }
  assert.ok(b.also_text.startsWith('Next: '))
})

test('summarizePortfolioPulse — alsoCap knob flexes the supporting cast; headline + counts never move (layer 19b)', () => {
  // Six DISTINCT adverse clients → led has a headline (led[0]) plus FIVE tail candidates, so
  // there is genuine room to widen past the default of 3 (the existing 4-signal test above
  // caps out at 3 and can't exercise widening). The engagement grade's earned cap
  // (briefEngagementLearning.deriveBriefEmphasis → also_cap) is the ONLY thing that decides
  // how many of those five ride along — nothing else in the brief sees it.
  const roster = [
    sig({ client_name: 'Acme',   metric: 'leads',   label: 'Leads',   severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Harbor', metric: 'revenue', label: 'Revenue', severity: 'warning',  delta_pct: -22, z: -1.6 }),
    sig({ client_name: 'Vista',  metric: 'spend',   label: 'Spend',   severity: 'critical', delta_pct: -40, z: -2.4 }),
    sig({ client_name: 'Zen',    metric: 'jobs',    label: 'Jobs',    severity: 'warning',  delta_pct: -12, z: -1.1 }),
    sig({ client_name: 'Nova',   metric: 'calls',   label: 'Calls',   severity: 'warning',  delta_pct: -18, z: -1.4 }),
    sig({ client_name: 'Orbit',  metric: 'leads',   label: 'Leads',   severity: 'warning',  delta_pct: -15, z: -1.2 }),
  ]
  // led with no lead policy is a pure no-op over the ranked adverse feed (proven by the test
  // above asserting b.also === rankPulseSignals(...).slice(1, 4)), so we can predict the tail.
  const led = rankPulseSignals(roster, { adverseOnly: true })
  assert.equal(led.length, 6)

  const base  = summarizePortfolioPulse(roster)                 // no opts → neutral cap 3
  const widen = summarizePortfolioPulse(roster, { alsoCap: 4 })
  const wide5 = summarizePortfolioPulse(roster, { alsoCap: 5 })
  const tight = summarizePortfolioPulse(roster, { alsoCap: 1 })

  // the knob is exactly led.slice(1, 1 + cap): the tail grows/shrinks, the head is fixed.
  assert.equal(base.also.length, 3)
  assert.deepEqual(base.also, led.slice(1, 4))
  assert.equal(widen.also.length, 4)
  assert.deepEqual(widen.also, led.slice(1, 5))
  assert.equal(wide5.also.length, 5)
  assert.equal(tight.also.length, 1)
  assert.deepEqual(tight.also, led.slice(1, 2))

  // monotone PREFIX: a wider cap only ever APPENDS rows, it never reorders the tail.
  assert.deepEqual(widen.also.slice(0, 3), base.also)
  assert.deepEqual(base.also.slice(0, 1), tight.also)
  assert.deepEqual(wide5.also.slice(0, 4), widen.also)

  // also_text tracks the tail it renders (more rows when wider, one when tight).
  assert.ok(widen.also_text.length > base.also_text.length)
  assert.ok(tight.also_text.startsWith('Next: '))

  // the headline (led[0]) and EVERY aggregate are cap-invariant — the knob touches the tail only.
  for (const b of [widen, wide5, tight]) {
    assert.deepEqual(b.headline, base.headline)
    assert.equal(b.headline_text, base.headline_text)
    assert.deepEqual(b.counts, base.counts)
    assert.deepEqual(b.confidence, base.confidence)
    assert.equal(b.posture, base.posture)
  }
  assert.equal(base.counts.adverse, 6)
})

test('summarizePortfolioPulse — a garbled / out-of-range alsoCap falls back to the neutral 3 (never silences)', () => {
  // The fallback is the load-bearing safety guarantee. deriveBriefEmphasis passes
  // alsoCap: undefined on its abstained/idle paths, and brief.js passes undefined whenever
  // emphasis didn't EARN a move — so undefined MUST reproduce today's brief exactly, and a
  // stray 0 / negative / fractional must NOT collapse the supporting cast to nothing.
  const roster = [
    sig({ client_name: 'Acme',   metric: 'leads',   label: 'Leads',   severity: 'critical', delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Harbor', metric: 'revenue', label: 'Revenue', severity: 'warning',  delta_pct: -22, z: -1.6 }),
    sig({ client_name: 'Vista',  metric: 'spend',   label: 'Spend',   severity: 'critical', delta_pct: -40, z: -2.4 }),
    sig({ client_name: 'Zen',    metric: 'jobs',    label: 'Jobs',    severity: 'warning',  delta_pct: -12, z: -1.1 }),
    sig({ client_name: 'Nova',   metric: 'calls',   label: 'Calls',   severity: 'warning',  delta_pct: -18, z: -1.4 }),
  ]
  const base = summarizePortfolioPulse(roster)
  assert.equal(base.also.length, 3)
  for (const bad of [undefined, null, 'x', 0, -2, 2.5, NaN, {}]) {
    const b = summarizePortfolioPulse(roster, { alsoCap: bad })
    assert.equal(b.also.length, 3, `alsoCap=${String(bad)} should fall back to 3`)
    assert.deepEqual(b.also, base.also, `alsoCap=${String(bad)} should match the neutral brief`)
  }
})

test('summarizePortfolioPulse — posture watch when adverse but nothing in act_now', () => {
  const roster = [
    // warning + reliable → worth_a_look (not act_now); single client
    sig({ client_name: 'Solo', metric: 'leads', label: 'Leads', severity: 'warning', reliability: 0.85, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -18, z: -1.4 }),
  ]
  const b = summarizePortfolioPulse(roster)
  assert.equal(b.posture, 'watch')
  assert.equal(b.status, 'briefing')
  assert.equal(b.confidence.label, 'high')              // 1/1 credible
  assert.equal(b.confidence.proven_share, 1)
  assert.ok(/^One alert today, on Solo: /.test(b.headline_text), b.headline_text)
  assert.equal(b.also_text, '')
})

test('summarizePortfolioPulse — "N alerts on <client>" phrasing when all adverse are one client', () => {
  const roster = [
    sig({ client_name: 'Acme', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.8, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -40, z: -3 }),
    sig({ client_name: 'Acme', metric: 'revenue', label: 'Revenue', severity: 'warning', delta_pct: -15, z: -1.2 }),
  ]
  const b = summarizePortfolioPulse(roster)
  assert.equal(b.counts.clients, 1)
  assert.ok(/^2 alerts on Acme today\. First up: /.test(b.headline_text), b.headline_text)
})

test('summarizePortfolioPulse — confidence high when the action set is all proven/reliable', () => {
  const roster = [
    sig({ client_name: 'A', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -40, z: -3 }),
    sig({ client_name: 'B', metric: 'jobs', label: 'Jobs', severity: 'warning', reliability: 0.8, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -20, z: -1.5 }),
    sig({ client_name: 'C', metric: 'spend', label: 'Spend', severity: 'critical', reliability: 0.75, reliability_label: 'reliable', accuracy_label: 'developing', delta_pct: 50, z: 2 }),
  ]
  const b = summarizePortfolioPulse(roster)
  assert.equal(b.confidence.label, 'high')
  assert.equal(b.confidence.proven_share, 1)
})

test('summarizePortfolioPulse — confidence building when the action set is all brand-new sensors', () => {
  const roster = [
    sig({ client_name: 'A', metric: 'leads', label: 'Leads', severity: 'critical', delta_pct: -40, z: -3 }),
    sig({ client_name: 'B', metric: 'jobs', label: 'Jobs', severity: 'warning', delta_pct: -20, z: -1.5 }),
    sig({ client_name: 'C', metric: 'spend', label: 'Spend', severity: 'warning', delta_pct: 30, z: 1.5 }),
  ]
  const b = summarizePortfolioPulse(roster)
  assert.equal(b.confidence.proven_share, 0)
  assert.equal(b.confidence.graded_share, 0)
  assert.equal(b.confidence.label, 'building')
})

// =====================================================================================
// summarizePortfolioPulse — quiet mornings + degenerate input
// =====================================================================================
test('summarizePortfolioPulse — quiet with tailwinds: steady posture, no headline, n/a confidence', () => {
  const roster = [
    sig({ client_name: 'A', metric: 'leads', label: 'Leads', severity: 'warning', adverse: false, direction: 'up', delta_pct: 25, z: 1.4 }),
    sig({ client_name: 'B', metric: 'jobs', label: 'Jobs', severity: 'critical', adverse: false, direction: 'up', delta_pct: 60, z: 2.6 }),
  ]
  const b = summarizePortfolioPulse(roster)
  assert.equal(b.status, 'quiet')
  assert.equal(b.posture, 'steady')
  assert.equal(b.headline, null)
  assert.deepEqual(b.also, [])
  assert.equal(b.counts.adverse, 0)
  assert.equal(b.counts.tailwinds, 2)
  assert.equal(b.confidence.label, 'n/a')
  assert.ok(/pacing ahead/.test(b.headline_text), b.headline_text)
})

test('summarizePortfolioPulse — empty / undefined roster → calm quiet briefing, never throws', () => {
  for (const input of [undefined, null, [], 'nope', 42]) {
    const b = summarizePortfolioPulse(input)
    assert.equal(b.status, 'quiet')
    assert.equal(b.posture, 'steady')
    assert.equal(b.headline, null)
    assert.deepEqual(b.counts, { adverse: 0, clients: 0, act_now: 0, tailwinds: 0, proven: 0, learning: 0 })
    assert.equal(b.confidence.label, 'n/a')
    assert.ok(/Quiet across the book/.test(b.headline_text), b.headline_text)
  }
})

// =====================================================================================
// summarizeClientPulse — one calm sentence, MACHINERY-FREE (6d egress contract)
// =====================================================================================
test('summarizeClientPulse — reuses the client-toned triage sentence + a calm tail', () => {
  const signals = [
    sig({ client_id: undefined, client_name: undefined, metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -50, z: -3.2 }),
    sig({ client_id: undefined, client_name: undefined, metric: 'jobs', label: 'Jobs', severity: 'warning', delta_pct: -12, z: -1.1 }),
    sig({ client_id: undefined, client_name: undefined, metric: 'calls', label: 'Calls', severity: 'warning', adverse: false, direction: 'up', delta_pct: 20, z: 1.3 }),
  ]
  const act = rankPulseSignals(signals, { adverseOnly: true })
  const b = summarizeClientPulse(signals)
  assert.equal(b.status, 'briefing')
  assert.equal(b.posture, 'act')                       // leads is act_now
  assert.equal(b.also_count, 1)                        // 2 adverse, 1 is the headline
  assert.ok(b.headline_text.startsWith(act[0].triage_client_reason), b.headline_text)
  assert.ok(/keeping an eye on 1 other metric/.test(b.headline_text), b.headline_text)
  assert.deepEqual(b.focus, { metric: 'leads', label: 'Leads', direction: 'down', delta_pct: -50, lane: 'act_now' })
})

test('summarizeClientPulse — focus carries ONLY client-visible fields; NO z / baseline / tuning ever', () => {
  // a signal as RICH as a real getClientPulse row — with machinery attached
  const machined = sig({
    client_id: undefined, client_name: undefined, metric: 'revenue', label: 'Revenue',
    severity: 'critical', reliability: 0.8, reliability_label: 'reliable', accuracy_label: 'proven',
    delta_pct: -44, z: -3.4,
    extra: {
      baseline: { median: 100, n: 6 },
      latest: 56,
      window: 7,
      latest_index: 41,
      tuning: { status: 'tuned', factor: 0.8, direction: 'down', warn: 1.6, crit: 2.4, base_warn: 2, base_crit: 3, precision: 0.82, label: 'sensitised' },
      tuning_note: 'Revenue: sensitised — warns at 1.6σ (was 2.0σ) after an 82% track record.',
      accuracy: { precision: 0.82, recall: 0.7, f1: 0.75 },
    },
  })
  const b = summarizeClientPulse([machined])
  // focus is exactly the 5 client-visible keys — nothing else rode along
  assert.deepEqual(Object.keys(b.focus).sort(), ['delta_pct', 'direction', 'label', 'lane', 'metric'])
  assert.ok(!('z' in b.focus))
  assert.ok(!('baseline' in b.focus))
  assert.ok(!('tuning' in b.focus))
  // and the ENTIRE client briefing is free of the machinery word — fail-closed
  const blob = JSON.stringify(b)
  assert.ok(!/tuning/.test(blob), 'client briefing must not contain any tuning machinery')
  assert.ok(!/baseline/.test(blob), 'client briefing must not contain baseline machinery')
})

test('summarizeClientPulse — quiet: steady posture, calm sentence, null focus', () => {
  const tail = [sig({ client_id: undefined, client_name: undefined, metric: 'calls', label: 'Calls', severity: 'warning', adverse: false, direction: 'up', delta_pct: 20, z: 1.3 })]
  const b = summarizeClientPulse(tail)
  assert.equal(b.status, 'quiet')
  assert.equal(b.posture, 'steady')
  assert.equal(b.focus, null)
  assert.equal(b.also_count, 0)
  assert.ok(/pacing ahead/.test(b.headline_text), b.headline_text)

  const empty = summarizeClientPulse([])
  assert.equal(empty.status, 'quiet')
  assert.ok(/All steady this week/.test(empty.headline_text), empty.headline_text)
})

test('summarizeClientPulse — posture watch when the top adverse signal is not act_now', () => {
  const signals = [sig({ client_id: undefined, client_name: undefined, metric: 'leads', label: 'Leads', severity: 'warning', reliability: 0.85, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -16, z: -1.3 })]
  const b = summarizeClientPulse(signals)
  assert.equal(b.posture, 'watch')
  assert.equal(b.also_count, 0)
  assert.equal(b.focus.lane, 'worth_a_look')
})

// =====================================================================================
// intel-v7 (13b) — applyLeadPolicyToFeed: the ONE bounded, learned, safety-floored
// re-aim of the lead slot. A tuned policy may nudge WHICH adverse row leads; it can
// never reorder the census, leap a rank, or bury an act_now emergency. Absent / idle /
// abstained / sub-sample policy is a STABLE NO-OP. The lead is the only thing that moves;
// counts, posture and confidence are read over the whole action set, order-free.
// The math is geometric: each candidate is scored decay**rank with decay = 1/bounds.max,
// so a max-promoted follower at rank i+1 ties (never beats) a neutral predecessor at i —
// a swap requires the predecessor to be actively DEMOTED. act_now is safety-floored at
// weight ≥ 1, so no lower lane can ever pass it.
// =====================================================================================

// a graded briefImpact-shaped grade with hand-set per-lane records. rawLaneWeight reads
// only { judged, hit_rate }; label is cosmetic. hit_rate 1.0 → weight 1.2 (promote),
// 0.0 → 0.8 (demote), and judged < 4 → untouched (insufficient_sample).
const laneRec = (judged, hit_rate, label = 'x') => ({ judged, hit_rate, label })
const gradedImpact = (byLane) => ({ status: 'graded', by_lane: byLane })

// two adverse warning rows of DIFFERENT credibility → two distinct, non-act_now lanes.
// triageLane keys off reliability_label, NOT gradedness: a reliable warning → worth_a_look,
// a noisy warning → monitor. (An UNgraded warning is "not shaky" → ALSO worth_a_look, which
// would collide — so the runner-up is explicitly noisy.) Bravo's low reliability (0.30) also
// floors its triage priority below Alpha's, so it deterministically ranks second (act[1]).
// Order is still read at runtime so the assertions never hard-code which row triage leads.
function twoLaneRoster() {
  return [
    sig({ client_name: 'Alpha', metric: 'leads', label: 'Leads', severity: 'warning', reliability: 0.85, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -18, z: -2.0 }),
    sig({ client_name: 'Bravo', metric: 'jobs', label: 'Jobs', severity: 'warning', reliability: 0.30, reliability_label: 'noisy', accuracy_label: 'learning', delta_pct: -14, z: -1.5 }), // noisy → monitor
  ]
}

test('applyLeadPolicyToFeed — absent / abstained / idle / sub-sample policy is a STABLE NO-OP', () => {
  const roster = twoLaneRoster()
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const L0 = act[0].lane
  const noOps = [
    undefined,
    null,
    deriveLeadPolicy({}),                                  // not graded → 'abstained'
    deriveLeadPolicy({ status: 'graded', by_lane: {} }),  // graded, nothing to tune → 'idle'
    deriveLeadPolicy(gradedImpact({ [L0]: laneRec(2, 0) })), // graded but < min_sample → 'idle'
  ]
  for (const leadPolicy of noOps) {
    const tag = leadPolicy ? leadPolicy.status : String(leadPolicy)
    const b = summarizePortfolioPulse(roster, { leadPolicy })
    assert.deepEqual(b.headline, act[0], `policy "${tag}" must not move the headline`)
    assert.deepEqual(b.also, act.slice(1, 4), `policy "${tag}" must not reorder the page`)
  }
})

test('applyLeadPolicyToFeed — a demoted lead + a promoted runner-up is a near-tie swap', () => {
  const roster = twoLaneRoster()
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const L0 = act[0].lane, L1 = act[1].lane
  // preconditions: distinct lanes, and the incumbent is demotable (not safety-floored act_now)
  assert.notEqual(L0, L1, 'fixture must put the top two adverse rows in different lanes')
  assert.notEqual(L0, 'act_now', 'the incumbent must be demotable — act_now is floored')
  // learned: the lead's lane has been over-calling (0/8), the runner-up earning (8/8)
  const policy = deriveLeadPolicy(gradedImpact({ [L0]: laneRec(8, 0), [L1]: laneRec(8, 1) }))
  assert.equal(policy.status, 'tuned')
  const b = summarizePortfolioPulse(roster, { leadPolicy: policy })
  assert.deepEqual(b.headline, act[1], 'the earning runner-up takes the lead')
  assert.deepEqual(b.also[0], act[0], 'the demoted incumbent slides exactly one slot, never off the page')
})

test('applyLeadPolicyToFeed — a safety-floored act_now lead is NEVER displaced, even by a max-promoted rival', () => {
  const roster = [
    sig({ client_name: 'Acme', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -48, z: -3.1 }),
    sig({ client_name: 'Beta', metric: 'revenue', label: 'Revenue', severity: 'warning', reliability: 0.85, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -18, z: -1.5 }),
  ]
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const L0 = act[0].lane, L1 = act[1].lane
  assert.equal(L0, 'act_now', 'the critical reliable lead is the safety lane')
  assert.notEqual(L1, 'act_now')
  // the WORST possible act_now record (0/8) AND a perfectly-earned rival (8/8)
  const policy = deriveLeadPolicy(gradedImpact({ act_now: laneRec(8, 0), [L1]: laneRec(8, 1) }))
  assert.equal(policy.lanes.act_now.safetyFloored, true, 'an act_now demotion is refused')
  assert.equal(policy.lanes.act_now.weight, 1, 'floored to neutral, never below')
  assert.equal(policy.lanes[L1].weight, 1.2, 'the rival is max-promoted')
  const b = summarizePortfolioPulse(roster, { leadPolicy: policy })
  assert.deepEqual(b.headline, act[0], 'the emergency keeps the lead — a promoted rival can tie but never pass it')
  assert.equal(b.headline.lane, 'act_now')
})

test('applyLeadPolicyToFeed — a max-promoted row two ranks down cannot leapfrog two leads', () => {
  const roster = [
    sig({ client_name: 'Acme', metric: 'leads', label: 'Leads', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -48, z: -3.4 }),
    sig({ client_name: 'Beta', metric: 'revenue', label: 'Revenue', severity: 'critical', reliability: 0.88, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -40, z: -2.6 }),
    sig({ client_name: 'Gamma', metric: 'jobs', label: 'Jobs', severity: 'warning', reliability: 0.85, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -16, z: -1.4 }),
  ]
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const L2 = act[2].lane
  assert.notEqual(L2, act[0].lane, 'the promoted row sits in a lower lane than the two leads')
  // promote ONLY L2 to the max; the two leads' lane is left ABSENT → neutral weight 1
  const policy = deriveLeadPolicy(gradedImpact({ [L2]: laneRec(8, 1) }))
  assert.equal(policy.status, 'tuned')
  const b = summarizePortfolioPulse(roster, { leadPolicy: policy })
  assert.deepEqual(b.headline, act[0], 'the top lead is untouched — one max promotion only buys a tie with the immediate predecessor')
  assert.deepEqual(b.also, act.slice(1, 4), 'and the order below it is preserved too')
})

test('applyLeadPolicyToFeed — counts, posture and confidence are permutation-invariant', () => {
  const roster = twoLaneRoster()
  const act = rankPulseSignals(roster, { adverseOnly: true })
  const policy = deriveLeadPolicy(gradedImpact({ [act[0].lane]: laneRec(8, 0), [act[1].lane]: laneRec(8, 1) }))
  const b0 = summarizePortfolioPulse(roster)
  const b1 = summarizePortfolioPulse(roster, { leadPolicy: policy })
  assert.notDeepEqual(b0.headline, b1.headline, 'the policy actually moved the lead (non-vacuous)')
  assert.deepEqual(b0.counts, b1.counts, 'the census never depends on who leads')
  assert.equal(b0.posture, b1.posture, 'posture is read over the whole action set')
  assert.deepEqual(b0.confidence, b1.confidence, 'confidence is order-free')
})

test('applyLeadPolicyToFeed (client) — focus re-aims but stays machinery-free; no lead_policy leaks', () => {
  const signals = [
    sig({ client_id: undefined, client_name: undefined, metric: 'leads', label: 'Leads', severity: 'warning', reliability: 0.85, reliability_label: 'reliable', accuracy_label: 'proven', delta_pct: -18, z: -2.0 }),
    sig({ client_id: undefined, client_name: undefined, metric: 'jobs', label: 'Jobs', severity: 'warning', reliability: 0.30, reliability_label: 'noisy', accuracy_label: 'learning', delta_pct: -14, z: -1.5 }),
  ]
  const act = rankPulseSignals(signals, { adverseOnly: true })
  const L0 = act[0].lane, L1 = act[1].lane
  assert.notEqual(L0, L1)
  assert.notEqual(L0, 'act_now')
  const policy = deriveLeadPolicy(gradedImpact({ [L0]: laneRec(8, 0), [L1]: laneRec(8, 1) }))
  const b = summarizeClientPulse(signals, { leadPolicy: policy })
  // the focus re-aimed off the demoted lead onto the earning runner-up
  assert.equal(b.focus.metric, act[1].metric, 'focus follows the learned lead')
  assert.notEqual(b.focus.metric, act[0].metric)
  // …and it is STILL exactly the five client-visible keys — no tuning machinery rode along
  assert.deepEqual(Object.keys(b.focus).sort(), ['delta_pct', 'direction', 'label', 'lane', 'metric'])
  const blob = JSON.stringify(b)
  for (const word of ['tuning', 'baseline', 'lead_weight', 'base_score', '__lead', 'lead_policy', 'safetyFloored', 'weight']) {
    assert.ok(!blob.includes(word), `the client briefing must not leak "${word}"`)
  }
  assert.ok(!('lead_policy' in b), 'no lead policy crosses the client egress')
  assert.equal(b.also_count, 1, 'the census (also_count) is unchanged by the re-aim')
})
