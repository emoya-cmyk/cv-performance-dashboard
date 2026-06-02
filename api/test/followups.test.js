// ============================================================
// test/followups.test.js — intel-v6 (4a): the PURE follow-up-suggestion core.
//
// suggestFollowups(spec, opts) takes the spec that was JUST answered and proposes
// the next questions to ask as click-to-run chips. No DB, no LLM, no clock — every
// chip is a deterministic pivot of one dimension (metric / window / grouping) away
// from the source, so the assertions below are exact.
//
// What's proven here:
//   • PARSER-STABILITY — every metric-pivot chip is byte-identical to a proven
//     suggest.js QUESTION template, so a clicked chip round-trips to a real spec
//     (a chip the grammar couldn't parse would 422 on click);
//   • the agency-only "By client" ranking is suppressed on a client-scoped surface;
//   • with no comparison yet, the "widen the window" pivot is surfaced first;
//   • each group_by shape (single figure / ranking / trend) yields sensible pivots;
//   • the source question is never re-offered; limit is honoured and clamped;
//   • there is NO "why" chip, and malformed/unknown input degrades safely.
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force SQLite at an isolated path BEFORE requiring ../lib/followups (→ ../lib/ask
// → ../db). These are pure-function tests — the DB is never queried — but isolating
// the path keeps the require from touching a real file.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `followups_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const { suggestFollowups } = require('../lib/followups')
const { QUESTION } = require('../lib/suggest')
const { METRICS } = require('../lib/ask')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

const AGENCY = { allowClientBreakdown: true }
const kinds  = (out) => out.map((o) => o.kind)
const find   = (out, kind) => out.find((o) => o.kind === kind)

// ── the canonical single-figure answer: drill in three ways ───────────────────
test('a single figure (agency, with comparison) offers trend, clients, then a metric pivot', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'none', time_range: 'last_week' },
    { ...AGENCY, hasComparison: true, limit: 3 }
  )
  assert.equal(out.length, 3)
  assert.deepEqual(kinds(out), ['trend', 'clients', 'metric'])
  assert.equal(out[0].question, 'Show our revenue by week in the last 12 weeks.')
  assert.equal(out[0].label, 'By week')
  assert.equal(out[1].question, 'Which clients had the most revenue last week?')
  assert.equal(out[1].label, 'By client')
  assert.equal(out[2].question, 'How many leads did we get last week?')
  assert.equal(out[2].question, QUESTION.leads)         // ← parser-stable, same as the mover chip
  assert.equal(out[2].label, METRICS.leads.label)       // label is the single source of truth
})

// ── a client-scoped surface never gets a cross-client ranking ─────────────────
test('a client-scoped surface suppresses the "By client" ranking', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'none', time_range: 'last_week' },
    { allowClientBreakdown: false, hasComparison: true, limit: 3 }
  )
  assert.ok(!kinds(out).includes('clients'), 'no clients-kind chip')
  for (const o of out) assert.ok(!/which clients/i.test(o.question), 'no client-ranking question')
  // it still drills usefully: a trend, a metric pivot, and a wider window.
  assert.deepEqual(kinds(out), ['trend', 'metric', 'time'])
  assert.equal(find(out, 'time').question, 'What was our revenue in the last 4 weeks?')
  assert.equal(find(out, 'time').label, 'Last 4 weeks')
})

// ── no "vs" yet → the most valuable next step is to get one ───────────────────
test('with no comparison on a single figure, the wider-window pivot is surfaced first', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'none', time_range: 'last_week' },
    { ...AGENCY, hasComparison: false, limit: 3 }
  )
  assert.equal(out[0].kind, 'time')
  assert.equal(out[0].label, 'Last 4 weeks')
  assert.equal(out[0].question, 'What was our revenue in the last 4 weeks?')
})

// ── parser-stability: every metric pivot equals a proven mover template ────────
test('every metric-pivot chip (off a last-week figure) is a verbatim suggest.js QUESTION', () => {
  const templates = new Set(Object.values(QUESTION))
  for (const metric of Object.keys(METRICS)) {
    const out = suggestFollowups(
      { metric, group_by: 'none', time_range: 'last_week' },
      { ...AGENCY, hasComparison: true, limit: 5 }
    )
    const pivot = find(out, 'metric')
    assert.ok(pivot, `${metric}: a metric pivot is offered`)
    assert.ok(templates.has(pivot.question), `${metric}: "${pivot.question}" is a parser-stable template`)
    assert.notEqual(pivot.question, QUESTION[metric], `${metric}: the pivot is a DIFFERENT metric`)
  }
})

// ── never re-ask the question just answered; widen to a genuinely wider window ─
test('the source question is never re-offered, and a wider window widens', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'none', time_range: 'last_4_weeks' },
    { ...AGENCY, hasComparison: true, limit: 5 }
  )
  for (const o of out) {
    assert.notEqual(o.question, 'What was our revenue in the last 4 weeks?', 'source not re-offered')
  }
  assert.equal(find(out, 'time').question, 'What was our revenue in the last 12 weeks?')
  assert.equal(find(out, 'time').label, 'Last 12 weeks')
  // a 4-week source keeps a 4-week trend window (not the default 12).
  assert.equal(find(out, 'trend').question, 'Show our revenue by week in the last 4 weeks.')
})

// ── a ranking answer → collapse to a total, pivot the metric, widen ───────────
test('a client-ranking answer offers an overall total, a metric pivot, and a wider window', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'client', time_range: 'last_week' },
    { ...AGENCY, limit: 5 }
  )
  assert.equal(out[0].kind, 'total')
  assert.equal(out[0].label, 'Overall total')
  assert.equal(out[0].question, 'What was our revenue last week?')
  assert.equal(find(out, 'metric').question, 'Which clients had the most leads last week?')
  assert.equal(find(out, 'time').question, 'Which clients had the most revenue in the last 4 weeks?')
})

// ── a trend answer → pivot the metric (keep the trend) + collapse to a total ──
test('a week-trend answer pivots the metric within the trend and offers a total', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'week', time_range: 'last_12_weeks' },
    { ...AGENCY, limit: 5 }
  )
  assert.equal(find(out, 'metric').question, 'Show our leads by week in the last 12 weeks.')
  assert.equal(find(out, 'total').question, 'What was our revenue in the last 12 weeks?')
  assert.ok(kinds(out).includes('clients'), 'agency trend also offers a client ranking')
})

// ── down-good cpl ranks by the LOWEST, so wording and sort agree ──────────────
test('a cpl ranking uses "the lowest" so the chip wording matches an ascending sort', () => {
  const out = suggestFollowups(
    { metric: 'cpl', group_by: 'none', time_range: 'last_week' },
    { ...AGENCY, hasComparison: true, limit: 5 }
  )
  assert.equal(find(out, 'clients').question, 'Which clients had the lowest cost per lead last week?')
})

// ── a named-month source renders a parser-stable "in March 2026" clause ───────
test('a named-month source renders "in March 2026" in its pivots', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'none', time_range: 'month', month: '2026-03' },
    { ...AGENCY, hasComparison: true, limit: 5 }
  )
  assert.equal(find(out, 'clients').question, 'Which clients had the most revenue in March 2026?')
  assert.equal(find(out, 'metric').question, 'How many leads did we get in March 2026?')
})

// ── a malformed month can't be re-phrased stably → fall back to last week ──────
test('a malformed month falls back to last week rather than emit "that month"', () => {
  const out = suggestFollowups(
    { metric: 'revenue', group_by: 'none', time_range: 'month', month: 'bogus' },
    { ...AGENCY, hasComparison: true, limit: 5 }
  )
  assert.equal(find(out, 'metric').question, 'How many leads did we get last week?')
  for (const o of out) {
    assert.ok(!/that month|undefined|NaN/i.test(o.question), `clean clause: "${o.question}"`)
  }
})

// ── limit is honoured and clamped ─────────────────────────────────────────────
test('limit is honoured (1), defaulted (0 → 3), and clamped (99 → at most 5)', () => {
  const src = { metric: 'revenue', group_by: 'none', time_range: 'last_week' }
  assert.equal(suggestFollowups(src, { ...AGENCY, hasComparison: true, limit: 1 }).length, 1)
  assert.equal(suggestFollowups(src, { ...AGENCY, hasComparison: true, limit: 0 }).length, 3)
  const big = suggestFollowups(src, { ...AGENCY, hasComparison: true, limit: 99 })
  assert.ok(big.length <= 5 && big.length >= 3, `clamped pool: ${big.length}`)
})

// ── structural invariants over a spread of sources: shape + no "why" chip ─────
test('every chip is a non-empty, well-formed question and there is never a "why" chip', () => {
  const sources = [
    { metric: 'revenue',    group_by: 'none',   time_range: 'last_week' },
    { metric: 'leads',      group_by: 'none',   time_range: 'last_4_weeks' },
    { metric: 'roas',       group_by: 'client', time_range: 'last_week' },
    { metric: 'spend',      group_by: 'week',   time_range: 'last_12_weeks' },
    { metric: 'close_rate', group_by: 'month',  time_range: 'this_year' },
    { metric: 'jobs',       group_by: 'none',   time_range: 'this_month' },
  ]
  for (const src of sources) {
    for (const opts of [{ ...AGENCY, hasComparison: true, limit: 5 }, { allowClientBreakdown: false, limit: 5 }]) {
      const out = suggestFollowups(src, opts)
      const seen = new Set()
      for (const o of out) {
        assert.equal(typeof o.question, 'string')
        assert.ok(o.question.length > 0, 'non-empty question')
        assert.ok(/[.?]$/.test(o.question), `ends with . or ?: "${o.question}"`)
        assert.ok(!/\bwhy\b/i.test(o.question), `no "why" intent: "${o.question}"`)
        assert.ok(typeof o.label === 'string' && o.label.length > 0, 'non-empty label')
        assert.ok(['metric', 'time', 'trend', 'clients', 'total'].includes(o.kind), `known kind: ${o.kind}`)
        if (o.kind === 'trend')   assert.ok(/by week|by month/.test(o.question), 'trend names a bucket')
        if (o.kind === 'clients') assert.ok(/which clients/i.test(o.question), 'ranking asks which clients')
        assert.ok(!seen.has(o.question), `no duplicate question: "${o.question}"`)
        seen.add(o.question)
      }
      if (!opts.allowClientBreakdown) {
        for (const o of out) assert.ok(!/which clients/i.test(o.question), 'client surface: no ranking')
      }
    }
  }
})

// ── robustness: unknown metric / null / sparse spec ───────────────────────────
test('an unknown metric or null spec yields no follow-ups; a sparse spec defaults safely', () => {
  assert.deepEqual(suggestFollowups(null), [])
  assert.deepEqual(suggestFollowups(undefined), [])
  assert.deepEqual(suggestFollowups({ metric: 'bogus', group_by: 'none', time_range: 'last_week' }), [])
  // metric only → group_by:none, time_range:last_week assumed; still produces chips.
  const out = suggestFollowups({ metric: 'revenue' }, AGENCY)
  assert.ok(out.length >= 1)
  for (const o of out) assert.ok(typeof o.question === 'string' && o.question.length > 0)
})
