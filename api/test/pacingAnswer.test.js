'use strict'

// Tests for lib/pacingAnswer.js — the grounded "are we on track?" answer behind the
// Ask box. The contract under test:
//   • pacingAnswer is a thin, metric-first adapter over classifyPacing — it returns
//     the full verdict verbatim, never null, never throws (garbage → status:'none');
//   • narratePacing turns a verdict into ONE plain-English sentence per band
//     (ahead / on_track / behind / at_risk / early / none), copying every metric
//     figure verbatim from the verdict (grounded by construction) while rendering
//     attainment%, elapsed% and the catch-up multiple as literal derived ratios;
//   • the honesty bands carry through: 'early' reports numbers but won't call it,
//     'none' says there's no goal to pace against — never a dressed-up number;
//   • the closed-month edge (no catch-up, no days left) reads correctly;
//   • PURE: inputs are not mutated.
//
// The verdict numbers below are hand-traced exactly as in test/pacing.test.js (10 of
// 30 days gone unless overridden), so a drift in classifyPacing surfaces here too.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pacingAnswer, narratePacing } = require('../lib/pacingAnswer')

// echo formatter: wraps the raw number so a narration assertion proves the figure was
// COPIED from the verdict (grounded), not re-derived.
const echo = (x) => '«' + x + '»'
// a plain pass-through formatter for readable assertions
const plain = (x) => String(x)

// facts for one (client, metric): 10 of 30 days gone unless overridden
const facts = (target, actual, extra = {}) => ({ target, actual, daysElapsed: 10, daysInMonth: 30, ...extra })

// ── pacingAnswer is a faithful metric-first pass-through to classifyPacing ──────────
test('pacingAnswer: metric echoed, verdict computed (at_risk hand-trace)', () => {
  const v = pacingAnswer('leads', facts(50, 10))
  assert.equal(v.metric, 'leads')
  assert.equal(v.projected, 30)        // 1.0/day × 30 days
  assert.equal(v.attainment, 0.6)      // 30 / 50
  assert.equal(v.shortfall, 20)
  assert.equal(v.required_rate, 2)
  assert.equal(v.catchup, 2)
  assert.equal(v.status, 'at_risk')
})

test('pacingAnswer: missing / garbage facts → a quiet status:none verdict, never null or throw', () => {
  for (const f of [undefined, null, {}, { actual: 5 }, { target: 0, actual: 5 }]) {
    const v = pacingAnswer('revenue', f)
    assert.equal(v.status, 'none')
    assert.equal(v.projected, null)
    assert.equal(v.metric, 'revenue')
  }
})

// ── narratePacing: one grounded sentence per band ───────────────────────────────────
test('narratePacing: ahead', () => {
  const v = pacingAnswer('revenue', facts(50, 20))   // projects 60 (120%)
  assert.equal(v.status, 'ahead')
  assert.equal(
    narratePacing(v, { label: 'Revenue', fmt: plain }),
    'Revenue is pacing ahead of goal — on track for ~60 against a 50 goal (120% of target).',
  )
})

test('narratePacing: on_track', () => {
  const v = pacingAnswer('revenue', facts(50, 16))   // projects 48 (96%)
  assert.equal(v.status, 'on_track')
  assert.equal(
    narratePacing(v, { label: 'Revenue', fmt: plain }),
    'Revenue is on track — pacing to ~48 against the 50 goal (96% of target).',
  )
})

test('narratePacing: behind — copies projected/target/shortfall verbatim, catch-up multiple literal', () => {
  const v = pacingAnswer('leads', facts(50, 14))     // projects 42 (84%), shortfall 8, catchup 1.29
  assert.equal(v.status, 'behind')
  assert.equal(
    narratePacing(v, { label: 'Leads', fmt: echo }),
    'Leads is behind pace — pacing to ~«42» against a «50» goal (84% of target, about «8» short).'
      + " To still hit it you'd need about 1.29× your current pace.",
  )
})

test('narratePacing: at_risk', () => {
  const v = pacingAnswer('leads', facts(50, 10))     // projects 30 (60%), shortfall 20, catchup 2
  assert.equal(v.status, 'at_risk')
  assert.equal(
    narratePacing(v, { label: 'Leads', fmt: plain }),
    'Leads is at risk of missing goal — pacing to ~30 against a 50 goal (60% of target, about 20 short).'
      + " To still hit it you'd need about 2× your current pace.",
  )
})

test('narratePacing: behind at month close — no catch-up, the gap is final', () => {
  const v = pacingAnswer('leads', facts(50, 45, { daysElapsed: 30 }))  // projects 45 (90%), days_remaining 0
  assert.equal(v.status, 'behind')
  assert.equal(v.catchup, null)
  assert.equal(v.days_remaining, 0)
  assert.equal(
    narratePacing(v, { label: 'Leads', fmt: plain }),
    'Leads is behind pace — pacing to ~45 against a 50 goal (90% of target, about 5 short).'
      + ' The month is closed, so that gap is now final.',
  )
})

test('narratePacing: early — reports numbers, withholds the call', () => {
  const v = pacingAnswer('leads', facts(50, 2, { daysElapsed: 3 }))   // 10% in, attainment 0.4
  assert.equal(v.status, 'early')
  assert.equal(
    narratePacing(v, { label: 'Leads', fmt: plain }),
    'Only 10% of the month in — too early to call leads pacing. So far 2 toward a 50 goal.',
  )
})

test('narratePacing: none — no goal set', () => {
  const v = pacingAnswer('leads', {})
  assert.equal(v.status, 'none')
  assert.equal(
    narratePacing(v, { label: 'Leads', fmt: plain }),
    "No leads goal is set for this month, so there's nothing to pace against yet.",
  )
})

test('narratePacing: none with a target but a degenerate month', () => {
  const v = pacingAnswer('jobs', { target: 20, actual: 4, daysElapsed: 0, daysInMonth: 0 })
  assert.equal(v.status, 'none')
  assert.equal(v.target, 20)
  assert.equal(
    narratePacing(v, { label: 'Jobs', fmt: plain }),
    "A jobs goal of 20 is set, but there isn't enough of the month yet to pace it.",
  )
})

test('narratePacing: empty string for a null/undefined verdict', () => {
  assert.equal(narratePacing(null), '')
  assert.equal(narratePacing(undefined), '')
})

test('narratePacing: label falls back to the verdict metric when none is passed', () => {
  const v = pacingAnswer('revenue', facts(50, 20))
  const s = narratePacing(v, { fmt: plain })                 // no label
  assert.ok(s.startsWith('revenue is pacing ahead'), s)      // uses verdict.metric verbatim
})

// ── purity ──────────────────────────────────────────────────────────────────────────
test('pacingAnswer: does not mutate the facts object (frozen input is safe)', () => {
  const f = Object.freeze(facts(50, 10))
  const v = pacingAnswer('leads', f)                         // frozen → throws if it writes
  assert.equal(v.status, 'at_risk')
})
