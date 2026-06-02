// ============================================================
// test/ask.compare.test.js — intel-v6 (2a): the PURE period-over-period core.
//
// Three pure surfaces from lib/ask.js, no DB / no LLM:
//   • comparisonRange(spec, now) — the WHERE window for the period immediately
//     before the asked-for one. COMPLETE, equal-length ranges get a baseline;
//     partial/unbounded ones (this_month/this_year/all_time) return null.
//   • computeComparison(cur, base, metric) — delta / %-change / direction /
//     improved, with %=null on a zero baseline and polarity-aware "improved".
//   • compileQuery(..., timeRangeFn) — the 5th-arg seam that lets the baseline
//     compile through the SAME scope+whitelist path. The load-bearing security
//     check: a SCOPED baseline still binds wr.client_id, so a comparison can
//     never read another client's data.
//
// Clock is fixed to 2026-05-30 (a Saturday) — the same NOW the other ask tests
// use — so every expected window below is deterministic. The current week's
// Monday is 2026-05-18; every figure here is derived from that anchor.
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../lib/ask
// (transitively requires ../db). These are pure-function tests — the DB is never
// queried — but we still isolate the path so the require can't touch a real file.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `askcompare_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const { comparisonRange, computeComparison, compileQuery } = require('../lib/ask')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

const NOW = new Date('2026-05-30T00:00:00Z')   // Saturday; current week's Monday is 2026-05-18
const spec = (over = {}) => ({
  metric: 'revenue', group_by: 'none', time_range: 'last_week',
  order: 'desc', limit: 5, client_filter: null, ...over,
})
// The exact { wheres } shape resolveTimeRange/comparisonRange emit for a window.
const wheres = (from, to) => ([
  { sql: 'wr.week_start >= %', value: from },
  { sql: 'wr.week_start <= %', value: to },
])

// ── comparisonRange: window correctness per comparable range ──────────────────
test('last_week → the single week before last week', () => {
  const c = comparisonRange(spec({ time_range: 'last_week' }), NOW)
  assert.deepEqual(c.wheres, wheres('2026-05-11', '2026-05-11'))
  assert.equal(c.label, 'the prior week')
})

test('last_4_weeks → the 4 weeks immediately before the current 4', () => {
  const c = comparisonRange(spec({ time_range: 'last_4_weeks' }), NOW)
  assert.deepEqual(c.wheres, wheres('2026-03-30', '2026-04-20'))
  assert.equal(c.label, 'the prior 4 weeks')
})

test('last_12_weeks → the 12 weeks immediately before the current 12', () => {
  const c = comparisonRange(spec({ time_range: 'last_12_weeks' }), NOW)
  assert.deepEqual(c.wheres, wheres('2025-12-08', '2026-02-23'))
  assert.equal(c.label, 'the prior 12 weeks')
})

test('last_month → the calendar month before last month', () => {
  // NOW is May → last_month is April → its baseline is March.
  const c = comparisonRange(spec({ time_range: 'last_month' }), NOW)
  assert.deepEqual(c.wheres, wheres('2026-03-01', '2026-03-31'))
  assert.equal(c.label, 'the prior month')
})

test('explicit month → the prior calendar month (full last day)', () => {
  const c = comparisonRange(spec({ time_range: 'month', month: '2026-02' }), NOW)
  assert.deepEqual(c.wheres, wheres('2026-01-01', '2026-01-31'))
  assert.equal(c.label, 'the prior month')
})

test('explicit month handles year + leap-February rollover', () => {
  // Jan 2026 → prior month is Dec 2025 (year rolls back).
  const jan = comparisonRange(spec({ time_range: 'month', month: '2026-01' }), NOW)
  assert.deepEqual(jan.wheres, wheres('2025-12-01', '2025-12-31'))
  // Mar 2024 → prior is Feb 2024, a leap February (29 days).
  const mar = comparisonRange(spec({ time_range: 'month', month: '2024-03' }), NOW)
  assert.deepEqual(mar.wheres, wheres('2024-02-01', '2024-02-29'))
})

// ── comparisonRange: null for partial / unbounded ranges ──────────────────────
test('partial / unbounded ranges have no honest baseline → null', () => {
  for (const tr of ['this_month', 'this_year', 'all_time']) {
    assert.equal(comparisonRange(spec({ time_range: tr }), NOW), null, tr)
  }
})

// ── computeComparison: delta math, direction, pct, polarity ───────────────────
test('up-good metric rising is an improvement', () => {
  const c = computeComparison(128000, 104000, 'revenue')
  assert.equal(c.baseline_value, 104000)
  assert.equal(c.delta, 24000)
  assert.equal(c.direction, 'up')
  assert.ok(Math.abs(c.pct_change - (24000 / 104000) * 100) < 1e-9)
  assert.equal(c.improved, true)
})

test('up-good metric falling is a regression', () => {
  const c = computeComparison(80000, 100000, 'revenue')
  assert.equal(c.delta, -20000)
  assert.equal(c.direction, 'down')
  assert.equal(c.pct_change, -20)
  assert.equal(c.improved, false)
})

test('down-good metric (cpl) falling is an improvement, rising a regression', () => {
  const better = computeComparison(40, 50, 'cpl')
  assert.equal(better.direction, 'down')
  assert.equal(better.improved, true)
  const worse = computeComparison(60, 50, 'cpl')
  assert.equal(worse.direction, 'up')
  assert.equal(worse.improved, false)
})

test('spend has no polarity → improved is null in either direction', () => {
  assert.equal(computeComparison(6000, 5000, 'spend').improved, null)
  assert.equal(computeComparison(4000, 5000, 'spend').improved, null)
})

test('flat change → direction flat, improved null', () => {
  const c = computeComparison(5000, 5000, 'revenue')
  assert.equal(c.delta, 0)
  assert.equal(c.direction, 'flat')
  assert.equal(c.pct_change, 0)
  assert.equal(c.improved, null)
})

test('zero baseline → pct_change null (never divide by zero), delta still real', () => {
  const c = computeComparison(5000, 0, 'revenue')
  assert.equal(c.delta, 5000)
  assert.equal(c.direction, 'up')
  assert.equal(c.pct_change, null)
  assert.equal(c.improved, true)
  const both = computeComparison(0, 0, 'revenue')
  assert.equal(both.direction, 'flat')
  assert.equal(both.pct_change, null)
  assert.equal(both.improved, null)
})

// ── compileQuery timeRangeFn seam: default unchanged, override = baseline ──────
test('default timeRangeFn is unchanged — last_month still compiles to its own month', () => {
  const def = compileQuery(spec({ time_range: 'last_month' }), NOW, false)   // no 5th arg
  assert.deepEqual(def.params, ['2026-04-01', '2026-04-30'])                 // April, the asked-for month
  assert.equal(def.timeLabel, 'last month')
})

test('override timeRangeFn compiles the SAME query over the comparison window', () => {
  const s   = spec({ time_range: 'last_month' })
  const cmp = comparisonRange(s, NOW)                       // March window
  const out = compileQuery(s, NOW, false, null, () => cmp)
  assert.deepEqual(out.params, ['2026-03-01', '2026-03-31'])
  assert.equal(out.timeLabel, 'the prior month')
})

// ── the load-bearing security property: a SCOPED baseline can't cross clients ──
test('a scoped comparison baseline still binds wr.client_id — no cross-client leak', () => {
  const s     = spec({ time_range: 'last_month' })
  const cmp   = comparisonRange(s, NOW)
  const SCOPE = `tenant-${process.pid}`
  const out   = compileQuery(s, NOW, false, SCOPE, () => cmp)
  // client scope is bound FIRST ($1), then the comparison window ($2,$3).
  assert.deepEqual(out.params, [SCOPE, '2026-03-01', '2026-03-31'])
  assert.match(out.sql, /wr\.client_id = \$1/)
  assert.match(out.sql, /wr\.week_start >= \$2 AND wr\.week_start <= \$3/)
  assert.deepEqual(out.columns, ['value'])   // single figure, no client bucket emitted
})
