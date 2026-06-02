'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  rankPulseSignals,
  triagePriority,
  triageLane,
  narrateTriage,
  SEVERITY_WEIGHT,
  RELIABILITY_FLOOR,
  NEUTRAL_PRIOR,
  LANES,
} = require('../lib/pulseTriage')

// ------------------------------------------------------------------
// A signal as it arrives from getClientPulse/getPortfolioPulse: the dayPulse
// verdict fields (severity, adverse, z, delta_pct, label, metric) plus the
// optional reliability fields (reliability, reliability_label) when graded.
// ------------------------------------------------------------------
function sig(over = {}) {
  return {
    metric: 'jobs_won',
    label: 'Jobs won',
    client_name: 'Acme',
    severity: 'warning',
    adverse: true,
    z: 2.4,
    delta_pct: 0, // neutralize the magnitude nudge unless a test sets it
    direction: 'down',
    ...over,
  }
}

// ====================== priority arithmetic =======================

test('triagePriority: critical + reliable(0.9) = 0.9 (no magnitude)', () => {
  assert.equal(triagePriority(sig({ severity: 'critical', reliability: 0.9 })), 0.9)
})

test('triagePriority: warning + reliable(0.9) = 0.54', () => {
  assert.ok(Math.abs(triagePriority(sig({ severity: 'warning', reliability: 0.9 })) - 0.54) < 1e-9)
})

test('triagePriority: critical + noisy(0.3333) ≈ 0.3333', () => {
  assert.ok(Math.abs(triagePriority(sig({ severity: 'critical', reliability: 0.3333 })) - 0.3333) < 1e-9)
})

test('triagePriority: ungraded uses the neutral prior (critical → 0.6)', () => {
  // no reliability field at all
  assert.equal(triagePriority(sig({ severity: 'critical' })), 1.0 * NEUTRAL_PRIOR)
})

test('triagePriority: reliability is clamped up to the floor (noisy 0.1 → 0.25)', () => {
  assert.equal(triagePriority(sig({ severity: 'critical', reliability: 0.1 })), 1.0 * RELIABILITY_FLOOR)
})

test('triagePriority: reliability is clamped to 1 (a >1 value never inflates)', () => {
  assert.equal(triagePriority(sig({ severity: 'critical', reliability: 1.7 })), 1.0)
})

test('triagePriority: unknown / null severity → 0 (sorts last)', () => {
  assert.equal(triagePriority(sig({ severity: null, reliability: 0.9 })), 0)
  assert.equal(triagePriority(sig({ severity: 'info', reliability: 0.9 })), 0)
})

test('triagePriority: magnitude nudge is bounded to +20% and uses |delta_pct|', () => {
  const base = triagePriority(sig({ severity: 'critical', reliability: 1, delta_pct: 0 }))      // 1.0
  const huge = triagePriority(sig({ severity: 'critical', reliability: 1, delta_pct: 999 }))    // capped → 1.2
  const neg  = triagePriority(sig({ severity: 'critical', reliability: 1, delta_pct: -999 }))   // |.| → 1.2
  assert.equal(base, 1.0)
  assert.ok(Math.abs(huge - 1.2) < 1e-9)
  assert.equal(huge, neg)
})

test('triagePriority: null delta_pct (ratio metric) does not throw → no nudge', () => {
  assert.equal(triagePriority(sig({ severity: 'critical', reliability: 1, delta_pct: null })), 1.0)
})

// ====================== the headline cross ========================

test('reliable Warning (0.54) outranks noisy Critical (0.33)', () => {
  const noisyCrit = sig({ metric: 'revenue', severity: 'critical', reliability: 0.3333, reliability_label: 'noisy' })
  const relWarn   = sig({ metric: 'jobs_won', severity: 'warning', reliability: 0.9, reliability_label: 'reliable' })
  const ranked = rankPulseSignals([noisyCrit, relWarn])
  assert.equal(ranked[0].metric, 'jobs_won')   // reliable warning first
  assert.equal(ranked[0].priority_rank, 1)
  assert.equal(ranked[1].metric, 'revenue')
  assert.equal(ranked[1].priority_rank, 2)
})

test('reliable Critical is #1 over reliable Warning', () => {
  const relCrit = sig({ metric: 'revenue', severity: 'critical', reliability: 0.9, reliability_label: 'reliable' })
  const relWarn = sig({ metric: 'jobs_won', severity: 'warning', reliability: 0.9, reliability_label: 'reliable' })
  const ranked = rankPulseSignals([relWarn, relCrit])
  assert.equal(ranked[0].metric, 'revenue')
})

test('ungraded Critical (0.6) outranks measured-noisy Critical (0.33)', () => {
  const ungraded = sig({ metric: 'revenue', severity: 'critical' })                       // no reliability → 0.6
  const noisy    = sig({ metric: 'jobs_won', severity: 'critical', reliability: 0.3333, reliability_label: 'noisy' })
  const ranked = rankPulseSignals([noisy, ungraded])
  assert.equal(ranked[0].metric, 'revenue')   // unproven beats measured-noisy
})

test('magnitude never flips a severity band when reliability is equal', () => {
  // warning with a huge move (0.6×0.9×1.2 = 0.648) vs critical with no move (0.9)
  const bigWarn  = sig({ metric: 'revenue', severity: 'warning', reliability: 0.9, reliability_label: 'reliable', delta_pct: 999 })
  const calmCrit = sig({ metric: 'jobs_won', severity: 'critical', reliability: 0.9, reliability_label: 'reliable', delta_pct: 0 })
  const ranked = rankPulseSignals([bigWarn, calmCrit])
  assert.equal(ranked[0].metric, 'jobs_won')  // critical still wins despite the warning's bigger move
})

test('adverse always outranks non-adverse — even a reliable Critical tailwind', () => {
  const goodCrit = sig({ metric: 'revenue', severity: 'critical', reliability: 0.95, reliability_label: 'reliable', adverse: false, direction: 'up' })
  const badWarn  = sig({ metric: 'jobs_won', severity: 'warning', reliability: 0.5, reliability_label: 'mixed', adverse: true })
  const ranked = rankPulseSignals([goodCrit, badWarn])
  assert.equal(ranked[0].metric, 'jobs_won')  // bad news first, regardless of priority math
  assert.equal(ranked[0].adverse, true)
  assert.equal(ranked[1].adverse, false)
})

// ====================== filters & limit ===========================

test('adverseOnly drops tailwinds', () => {
  const rows = [
    sig({ metric: 'a', adverse: true }),
    sig({ metric: 'b', adverse: false }),
    sig({ metric: 'c', adverse: true }),
  ]
  const ranked = rankPulseSignals(rows, { adverseOnly: true })
  assert.equal(ranked.length, 2)
  assert.ok(ranked.every((r) => r.adverse === true))
})

test('limit caps length and priority_rank runs 1..limit', () => {
  const rows = [
    sig({ metric: 'a', severity: 'critical', reliability: 0.9 }),
    sig({ metric: 'b', severity: 'warning', reliability: 0.9 }),
    sig({ metric: 'c', severity: 'warning', reliability: 0.5 }),
    sig({ metric: 'd', severity: 'warning' }),
  ]
  const ranked = rankPulseSignals(rows, { limit: 2 })
  assert.equal(ranked.length, 2)
  assert.deepEqual(ranked.map((r) => r.priority_rank), [1, 2])
})

test('limit: 0 returns an empty list', () => {
  assert.deepEqual(rankPulseSignals([sig()], { limit: 0 }), [])
})

test('empty / non-array input → []', () => {
  assert.deepEqual(rankPulseSignals([]), [])
  assert.deepEqual(rankPulseSignals(null), [])
  assert.deepEqual(rankPulseSignals(undefined), [])
})

// ====================== deterministic tie-break ===================

test('ties break on client_name, then metric (fully deterministic)', () => {
  // identical priority (same severity, same reliability, no magnitude, same |z|)
  const common = { severity: 'warning', reliability: 0.5, reliability_label: 'mixed', z: 2, delta_pct: 0 }
  const rows = [
    sig({ ...common, client_name: 'Beta', metric: 'revenue' }),
    sig({ ...common, client_name: 'Acme', metric: 'revenue' }),
    sig({ ...common, client_name: 'Acme', metric: 'jobs_won' }),
  ]
  const a = rankPulseSignals(rows)
  const b = rankPulseSignals([...rows].reverse())
  // same order regardless of input order
  assert.deepEqual(a.map((r) => [r.client_name, r.metric]), b.map((r) => [r.client_name, r.metric]))
  // Acme before Beta; within Acme, jobs_won before revenue
  assert.deepEqual(a.map((r) => `${r.client_name}/${r.metric}`), ['Acme/jobs_won', 'Acme/revenue', 'Beta/revenue'])
})

test('|z| breaks ties before names when priority is equal', () => {
  const common = { severity: 'warning', reliability: 0.5, reliability_label: 'mixed', delta_pct: 0 }
  const lowZ  = sig({ ...common, client_name: 'Acme', metric: 'a', z: 2.0 })
  const highZ = sig({ ...common, client_name: 'Zeta', metric: 'z', z: 9.0 })
  const ranked = rankPulseSignals([lowZ, highZ])
  assert.equal(ranked[0].metric, 'z') // bigger |z| first despite later name
})

// ====================== purity ====================================

test('rankPulseSignals does not mutate its input and is deterministic', () => {
  const input = [
    sig({ metric: 'a', severity: 'critical', reliability: 0.9 }),
    sig({ metric: 'b', severity: 'warning' }),
  ]
  const snapshot = JSON.parse(JSON.stringify(input))
  const r1 = rankPulseSignals(input)
  const r2 = rankPulseSignals(input)
  assert.deepEqual(input, snapshot)                 // input untouched (no priority_rank leaked in)
  assert.deepEqual(r1, r2)                          // identical across calls
  assert.ok(!('priority' in input[0]))              // enrichment lives only on the output copy
})

// ====================== lane mapping ==============================

test('triageLane: the full severity × adverse × reliability grid', () => {
  // adverse critical
  assert.equal(triageLane(sig({ severity: 'critical', adverse: true, reliability_label: 'reliable' })), 'act_now')
  assert.equal(triageLane(sig({ severity: 'critical', adverse: true, reliability_label: 'mixed' })),    'verify')
  assert.equal(triageLane(sig({ severity: 'critical', adverse: true, reliability_label: 'noisy' })),    'verify')
  assert.equal(triageLane(sig({ severity: 'critical', adverse: true })),                                 'act_now') // ungraded
  // adverse warning
  assert.equal(triageLane(sig({ severity: 'warning', adverse: true, reliability_label: 'reliable' })),  'worth_a_look')
  assert.equal(triageLane(sig({ severity: 'warning', adverse: true, reliability_label: 'mixed' })),     'monitor')
  assert.equal(triageLane(sig({ severity: 'warning', adverse: true, reliability_label: 'noisy' })),     'monitor')
  assert.equal(triageLane(sig({ severity: 'warning', adverse: true })),                                  'worth_a_look') // ungraded
  // non-adverse → tailwind regardless of severity/reliability
  assert.equal(triageLane(sig({ severity: 'critical', adverse: false, reliability_label: 'reliable' })), 'tailwind')
  assert.equal(triageLane(sig({ severity: 'warning', adverse: false })),                                  'tailwind')
  // unknown/null severity → safe default
  assert.equal(triageLane(sig({ severity: null, adverse: true })), 'monitor')
  assert.equal(triageLane(null), 'monitor')
})

test('every signal lands in a known lane', () => {
  const combos = []
  for (const severity of ['critical', 'warning', null]) {
    for (const adverse of [true, false]) {
      for (const reliability_label of ['reliable', 'mixed', 'noisy', undefined]) {
        combos.push(sig({ severity, adverse, reliability_label }))
      }
    }
  }
  for (const c of combos) assert.ok(LANES.includes(triageLane(c)), `lane for ${JSON.stringify(c)}`)
})

// ====================== narrator ==================================

test('narrateTriage agency: act_now reliable cites the track record', () => {
  const s = sig({ label: 'Jobs won', severity: 'critical', adverse: true, reliability_label: 'reliable' })
  assert.equal(narrateTriage(s), 'Jobs won is critical and this alert has a reliable track record — act today.')
})

test('narrateTriage agency: act_now ungraded stays clean', () => {
  const s = sig({ label: 'Jobs won', severity: 'critical', adverse: true })
  assert.equal(narrateTriage(s), 'Jobs won is critical — act today.')
})

test('narrateTriage agency: verify names the shaky grade', () => {
  const s = sig({ label: 'Revenue', severity: 'critical', adverse: true, reliability_label: 'noisy' })
  assert.equal(narrateTriage(s), 'Revenue is critical, but this alert has been noisy lately — confirm before acting.')
})

test('narrateTriage agency: worth_a_look reliable vs ungraded', () => {
  assert.equal(
    narrateTriage(sig({ label: 'Revenue', severity: 'warning', adverse: true, reliability_label: 'reliable' })),
    'Revenue is slipping and this alert has held up before — worth a look today.'
  )
  assert.equal(
    narrateTriage(sig({ label: 'Revenue', severity: 'warning', adverse: true })),
    'Revenue is slipping — worth a look.'
  )
})

test('narrateTriage agency: monitor and tailwind', () => {
  assert.equal(
    narrateTriage(sig({ label: 'Revenue', severity: 'warning', adverse: true, reliability_label: 'noisy' })),
    'Revenue is slipping, but this alert flickers (noisy) — monitor for now.'
  )
  assert.equal(
    narrateTriage(sig({ label: 'Revenue', severity: 'critical', adverse: false, reliability_label: 'reliable', direction: 'up' })),
    'Revenue is well above its usual band and the gain is holding — a tailwind to lean into.'
  )
  assert.equal(
    narrateTriage(sig({ label: 'Revenue', severity: 'critical', adverse: false, direction: 'up' })),
    'Revenue is well above its usual band — a tailwind to lean into.'
  )
})

test('narrateTriage client: gentle, second-person copy', () => {
  assert.equal(narrateTriage(sig({ label: 'Jobs won', severity: 'critical', adverse: true, reliability_label: 'reliable' }), { audience: 'client' }), 'Your jobs won needs attention today.')
  assert.equal(narrateTriage(sig({ label: 'Revenue', severity: 'warning', adverse: true, reliability_label: 'reliable' }), { audience: 'client' }), 'Your revenue is worth a look this week.')
  assert.equal(narrateTriage(sig({ label: 'Revenue', severity: 'critical', adverse: false, direction: 'up' }), { audience: 'client' }), 'Your revenue is pacing ahead — nice momentum.')
})

test('narrateTriage: null signal → empty string', () => {
  assert.equal(narrateTriage(null), '')
})

// ====================== enrichment shape ==========================

test('rankPulseSignals attaches priority, lane, reasons, and rank to each row', () => {
  const ranked = rankPulseSignals([sig({ severity: 'critical', adverse: true, reliability: 0.9, reliability_label: 'reliable' })])
  const r = ranked[0]
  assert.equal(typeof r.priority, 'number')
  assert.equal(r.lane, 'act_now')
  assert.ok(r.triage_reason.length > 0)
  assert.ok(r.triage_client_reason.length > 0)
  assert.equal(r.priority_rank, 1)
  // original verdict fields are carried through untouched
  assert.equal(r.metric, 'jobs_won')
  assert.equal(r.severity, 'critical')
})

test('SEVERITY_WEIGHT exposes the two real severities only', () => {
  assert.deepEqual(SEVERITY_WEIGHT, { critical: 1.0, warning: 0.6 })
})
