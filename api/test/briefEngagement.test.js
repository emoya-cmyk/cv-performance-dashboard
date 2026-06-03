'use strict'

// Tests for lib/briefEngagement.js — the dashboard's first consumer-feedback
// loop. The contract:
//   • RECEPTION = helpful_rate = helpful / (helpful + not_helpful); a vote whose
//     signal is neither 'helpful' nor 'not_helpful' is `ignored` (out of n, still
//     in total) — invariant helpful + not_helpful === n and n + ignored === total
//     on EVERY return path;
//   • HONEST BY ABSTENTION: no gradeable votes → status:'insufficient',
//     reason:'insufficient_history'; fewer than minVotes → 'insufficient_votes';
//     helpful_rate:null in both — never a rate off one or two votes; the raw tally
//     rides every path;
//   • engagementLabel: well_received ≥0.75 · fair 0.50–0.74 · poorly_received <0.50
//     · null→null;
//   • TREND: gated on n ≥ 2·minVotes (so each time-half has ≥ minVotes); a
//     half-over-half swing of ≥ TREND_DELTA (0.15) names improving/declining, else
//     steady; below the gate trend is null;
//   • narrateBriefEngagement turns a GRADED score into one grounded agency
//     sentence whose every figure is copied off the score — and returns ''
//     UNCONDITIONALLY for a client audience (the aggregate is agency-only; the
//     client only ever sees their own vote, never this) and '' for un-graded input;
//   • PURE: order-independent, never mutates its input, never throws on garbage.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  summarizeBriefEngagement,
  narrateBriefEngagement,
  engagementLabel,
  DEFAULT_MIN_VOTES,
} = require('../lib/briefEngagement')

// ── builders ────────────────────────────────────────────────────────────────────────────
// ymd(i) → a deterministic YYYY-MM-DD in 2026-01 (i in [0,30]); no clock-of-now.
const ymd = (i) => `2026-01-${String(i + 1).padStart(2, '0')}`
// votes(['h','n','x',…]) → one event per code in time order: 'h'→helpful, 'n'→not_helpful,
// anything else passes through verbatim as the signal (for the `ignored` path).
const votes = (codes) =>
  codes.map((c, i) => ({
    as_of: ymd(i),
    signal: c === 'h' ? 'helpful' : c === 'n' ? 'not_helpful' : c,
  }))
const repeat = (code, k) => Array.from({ length: k }, () => code)

// ── abstention: too little history ──────────────────────────────────────────────────────
test('empty / garbage / non-array → insufficient_history, helpful_rate null, counts present', () => {
  for (const bad of [undefined, null, [], 'nope', {}, 42, [null, undefined, false]]) {
    const g = summarizeBriefEngagement(bad)
    assert.equal(g.status, 'insufficient')
    assert.equal(g.reason, 'insufficient_history')
    assert.equal(g.helpful_rate, null)
    assert.equal(g.label, null)
    assert.equal(g.trend, null)
    assert.equal(g.recent_rate, null)
    assert.equal(g.older_rate, null)
    // counts still present and coherent even when we abstain
    assert.equal(g.n, 0)
    assert.equal(g.helpful, 0)
    assert.equal(g.not_helpful, 0)
    assert.equal(g.min_votes, DEFAULT_MIN_VOTES)
  }
})

test('fewer than minVotes gradeable votes → insufficient_votes, rate null, tally still reported', () => {
  const g = summarizeBriefEngagement(votes(['h', 'n'])) // n = 2 < 3
  assert.equal(g.status, 'insufficient')
  assert.equal(g.reason, 'insufficient_votes')
  assert.equal(g.helpful_rate, null)
  assert.equal(g.label, null)
  assert.equal(g.helpful, 1)
  assert.equal(g.not_helpful, 1)
  assert.equal(g.n, 2)
  assert.equal(g.total, 2)
})

test('a single vote is never graded (n=1 < minVotes)', () => {
  const g = summarizeBriefEngagement(votes(['h']))
  assert.equal(g.status, 'insufficient')
  assert.equal(g.reason, 'insufficient_votes')
})

// ── counts invariants ───────────────────────────────────────────────────────────────────
test('ignored signals stay out of n but counted in total; invariants hold', () => {
  const events = [
    { as_of: '2026-01-01', signal: 'helpful' },
    { as_of: '2026-01-02', signal: 'helpful' },
    { as_of: '2026-01-03', signal: 'not_helpful' },
    { as_of: '2026-01-04', signal: 'dismissed' }, // unknown → ignored
    { as_of: '2026-01-05' }, // missing signal → ignored
  ]
  const g = summarizeBriefEngagement(events)
  assert.equal(g.helpful, 2)
  assert.equal(g.not_helpful, 1)
  assert.equal(g.ignored, 2)
  assert.equal(g.n, 3)
  assert.equal(g.total, 5)
  assert.equal(g.helpful + g.not_helpful, g.n) // invariant
  assert.equal(g.n + g.ignored, g.total) // invariant
  assert.equal(g.status, 'graded') // n = 3 ≥ minVotes
  assert.equal(g.helpful_rate, 0.6667) // 2/3 rounded 4
  assert.equal(g.label, 'fair')
})

// ── helpful_rate + label bands ──────────────────────────────────────────────────────────
test('engagementLabel bands incl. exact boundaries; null/NaN → null', () => {
  assert.equal(engagementLabel(1), 'well_received')
  assert.equal(engagementLabel(0.75), 'well_received') // boundary inclusive
  assert.equal(engagementLabel(0.7499), 'fair')
  assert.equal(engagementLabel(0.5), 'fair') // boundary inclusive
  assert.equal(engagementLabel(0.4999), 'poorly_received')
  assert.equal(engagementLabel(0), 'poorly_received')
  assert.equal(engagementLabel(null), null)
  assert.equal(engagementLabel(NaN), null)
  assert.equal(engagementLabel(undefined), null)
})

test('well_received at the 0.75 boundary (3 helpful, 1 not)', () => {
  const g = summarizeBriefEngagement(votes(['h', 'h', 'h', 'n']))
  assert.equal(g.status, 'graded')
  assert.equal(g.helpful_rate, 0.75)
  assert.equal(g.label, 'well_received')
})

test('fair just under the boundary (7 helpful, 3 not = 0.70)', () => {
  const g = summarizeBriefEngagement(votes([...repeat('h', 7), ...repeat('n', 3)]))
  assert.equal(g.helpful_rate, 0.7)
  assert.equal(g.label, 'fair')
})

test('fair at the 0.50 boundary (2 helpful, 2 not)', () => {
  const g = summarizeBriefEngagement(votes(['h', 'h', 'n', 'n']))
  assert.equal(g.helpful_rate, 0.5)
  assert.equal(g.label, 'fair')
})

test('poorly_received under 0.50 (1 helpful, 2 not)', () => {
  const g = summarizeBriefEngagement(votes(['h', 'n', 'n']))
  assert.equal(g.helpful_rate, 0.3333)
  assert.equal(g.label, 'poorly_received')
  // label is always engagementLabel(helpful_rate)
  assert.equal(g.label, engagementLabel(g.helpful_rate))
})

// ── window ──────────────────────────────────────────────────────────────────────────────
test('window spans min..max as_of inclusive', () => {
  const g = summarizeBriefEngagement(votes(['h', 'h', 'n', 'h', 'n'])) // 2026-01-01 .. -05
  assert.equal(g.window.from, '2026-01-01')
  assert.equal(g.window.to, '2026-01-05')
  assert.equal(g.window.days, 5)
})

// ── trend (gated) ───────────────────────────────────────────────────────────────────────
test('trend is null below the gate (n < 2·minVotes), even when graded', () => {
  const g = summarizeBriefEngagement(votes(repeat('h', 5))) // n=5 graded, 5 < 6
  assert.equal(g.status, 'graded')
  assert.equal(g.helpful_rate, 1)
  assert.equal(g.label, 'well_received')
  assert.equal(g.trend, null)
  assert.equal(g.recent_rate, null)
  assert.equal(g.older_rate, null)
})

test('trend improving — older half cold, recent half hot', () => {
  const g = summarizeBriefEngagement(votes(['n', 'n', 'n', 'h', 'h', 'h']))
  assert.equal(g.trend, 'improving')
  assert.equal(g.older_rate, 0)
  assert.equal(g.recent_rate, 1)
  assert.equal(g.helpful_rate, 0.5) // overall still 3/6
  assert.equal(g.label, 'fair')
})

test('trend declining — older half hot, recent half cold', () => {
  const g = summarizeBriefEngagement(votes(['h', 'h', 'h', 'n', 'n', 'n']))
  assert.equal(g.trend, 'declining')
  assert.equal(g.older_rate, 1)
  assert.equal(g.recent_rate, 0)
})

test('trend steady — halves within TREND_DELTA', () => {
  const g = summarizeBriefEngagement(votes(['h', 'h', 'n', 'h', 'h', 'n']))
  assert.equal(g.trend, 'steady')
  assert.equal(g.older_rate, g.recent_rate) // both 2/3 here
})

// ── purity / order-independence ─────────────────────────────────────────────────────────
test('order-independent: shuffled input yields an identical grade', () => {
  const base = votes(['h', 'n', 'h', 'h', 'n', 'h', 'h', 'n'])
  const a = summarizeBriefEngagement(base)
  const shuffled = [base[5], base[0], base[7], base[2], base[1], base[6], base[3], base[4]]
  const b = summarizeBriefEngagement(shuffled)
  assert.deepEqual(b, a)
})

test('never mutates its input (frozen array + frozen elements survive)', () => {
  const events = votes(['h', 'n', 'h', 'h', 'n', 'h']).map((e) => Object.freeze(e))
  Object.freeze(events)
  let g
  assert.doesNotThrow(() => {
    g = summarizeBriefEngagement(events)
  })
  assert.equal(g.status, 'graded')
  assert.equal(g.n, 6)
})

test('never throws on hostile input', () => {
  for (const bad of [undefined, null, NaN, 0, '', 'x', {}, [{}], [1, 2], [{ signal: 7 }]]) {
    assert.doesNotThrow(() => summarizeBriefEngagement(bad))
  }
})

// ── minVotes override ───────────────────────────────────────────────────────────────────
test('opts.minVotes lowers the abstention floor (and the trend gate with it)', () => {
  const two = votes(['h', 'n'])
  assert.equal(summarizeBriefEngagement(two).status, 'insufficient') // default 3
  const g = summarizeBriefEngagement(votes(['n', 'n', 'h', 'h']), { minVotes: 2 })
  assert.equal(g.status, 'graded')
  assert.equal(g.min_votes, 2)
  // minTrend = 2·2 = 4, n=4 ≥ 4 → trend computed
  assert.equal(g.trend, 'improving') // older [n,n]=0 → recent [h,h]=1
})

test('DEFAULT_MIN_VOTES is the documented 3', () => {
  assert.equal(DEFAULT_MIN_VOTES, 3)
})

// ── narration: the client-silence privacy invariant (load-bearing) ──────────────────────
test('narrate returns "" for a client audience UNCONDITIONALLY — even a strong grade', () => {
  const strong = summarizeBriefEngagement(votes(repeat('h', 8))) // well_received, perfect
  assert.equal(strong.label, 'well_received')
  assert.equal(narrateBriefEngagement(strong, { audience: 'client' }), '')
  // and for every label band, the client hears nothing
  for (const codes of [['h', 'n', 'n'], ['h', 'h', 'n', 'n'], repeat('h', 8)]) {
    const g = summarizeBriefEngagement(votes(codes))
    assert.equal(narrateBriefEngagement(g, { audience: 'client' }), '')
  }
})

test('narrate returns "" for un-graded / missing grades', () => {
  assert.equal(narrateBriefEngagement(null), '')
  assert.equal(narrateBriefEngagement(undefined), '')
  assert.equal(narrateBriefEngagement(summarizeBriefEngagement([])), '') // insufficient
  assert.equal(narrateBriefEngagement(summarizeBriefEngagement(votes(['h', 'n']))), '') // insufficient_votes
})

// ── narration: agency sentence, figures copied off the grade ────────────────────────────
test('agency well_received sentence + declining trend clause; figures match the grade', () => {
  const g = summarizeBriefEngagement(votes([...repeat('h', 17), ...repeat('n', 3)])) // 17/20 = 0.85
  assert.equal(g.label, 'well_received')
  assert.equal(g.trend, 'declining') // first 10 all h (1.0) → last 10 (7h/3n = 0.7)
  const s = narrateBriefEngagement(g, { audience: 'agency' })
  assert.match(s, /useful 17 of 20 times recently \(~85%\)/)
  assert.match(s, /well received/)
  assert.match(s, /slipping lately/)
  assert.ok(!/improving/.test(s))
})

test('agency fair sentence + improving trend clause', () => {
  const g = summarizeBriefEngagement(votes(['n', 'n', 'n', 'h', 'h', 'h'])) // 0.50, improving
  const s = narrateBriefEngagement(g, { audience: 'agency' })
  assert.match(s, /useful 3 of 6 times recently \(~50%\)/)
  assert.match(s, /a fair reception/)
  assert.match(s, /improving lately/)
})

test('agency poorly_received sentence, no trend clause below the gate', () => {
  const g = summarizeBriefEngagement(votes(['h', 'n', 'n', 'n', 'n'])) // 1/5 = 0.20, n<6 → no trend
  const s = narrateBriefEngagement(g, { audience: 'agency' })
  assert.match(s, /useful 1 of 5 times recently \(~20%\)/)
  assert.match(s, /poorly received; worth a closer look/)
  assert.ok(!/lately/.test(s)) // no trend clause
})

test('agency is the default audience; scopeLabel overrides the subject', () => {
  const g = summarizeBriefEngagement(votes(repeat('h', 8)))
  const dflt = narrateBriefEngagement(g) // no opts → agency
  assert.match(dflt, /^Clients found the morning brief useful/)
  const scoped = narrateBriefEngagement(g, { audience: 'agency', scopeLabel: 'This client' })
  assert.match(scoped, /^This client found the morning brief useful/)
})
