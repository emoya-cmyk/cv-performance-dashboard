// ============================================================
// test/suggest.test.js — intel-v6 (3a): the PURE movers-ranking core.
//
// rankMovers(rawMovers, opts) takes already-computed { metric, current, baseline }
// pairs and turns them into ranked, click-to-run suggestion chips. No DB, no LLM,
// no clock — every figure below is hand-computed, so the assertions are exact.
//
// What's proven here:
//   • ranking is by |%-change|, biggest first;
//   • a jump from a ZERO baseline (undefined %) outranks any finite %;
//   • flat metrics and metrics with no data in either period are dropped;
//   • "improved" tone is polarity-aware (down-good cpl, no-polarity spend);
//   • the headline copies the SAME 1-dp % / formatted delta the delta chip shows;
//   • limit is honoured and clamped; unknown metrics are skipped.
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force SQLite at an isolated path BEFORE requiring ../lib/suggest (which pulls in
// ../lib/ask → ../db). These are pure-function tests — the DB is never queried —
// but isolating the path keeps the require from touching a real file.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `suggest_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const { rankMovers, QUESTION } = require('../lib/suggest')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

const by = (arr) => arr.map(s => s.metric)   // metric keys in returned order

// ── ranking: biggest |%-change| first ────────────────────────────────────────
test('ranks metrics by magnitude of percent change, biggest first', () => {
  const out = rankMovers([
    { metric: 'revenue', current: 128000, baseline: 104000 },  // +23.1%
    { metric: 'leads',   current: 150,    baseline: 100 },     // +50%
    { metric: 'cpl',     current: 47.5,   baseline: 50 },      // -5%
  ])
  assert.deepEqual(by(out), ['leads', 'revenue', 'cpl'])
})

test('a jump from a zero baseline outranks any finite percent change', () => {
  const out = rankMovers([
    { metric: 'revenue', current: 128000, baseline: 104000 },  // +23.1% (finite)
    { metric: 'jobs',    current: 5,      baseline: 0 },        // 0 → 5 (undefined %)
  ])
  assert.equal(out[0].metric, 'jobs')
  assert.equal(out[0].pct_display, null)               // never a fabricated ratio
  assert.equal(out[0].delta_display, '5')              // falls back to the absolute change
  assert.equal(out[0].headline, 'Jobs won up 5')       // and the headline uses it
})

// ── exclusions: flat + no-data drop out ───────────────────────────────────────
test('flat metrics and no-data metrics are dropped', () => {
  const out = rankMovers([
    { metric: 'revenue', current: 5000, baseline: 5000 },  // flat → drop
    { metric: 'leads',   current: 0,    baseline: 0 },     // no data → drop
    { metric: 'spend',   current: 6000, baseline: 5000 },  // a real mover → kept
  ])
  assert.deepEqual(by(out), ['spend'])
})

// ── polarity-aware tone ───────────────────────────────────────────────────────
test('"improved" follows metric polarity, not just direction', () => {
  const out = rankMovers([
    { metric: 'revenue', current: 120, baseline: 100 },   // up-good rising → improved
    { metric: 'cpl',     current: 60,  baseline: 50 },     // down-good rising → regression
    { metric: 'roas',    current: 3,   baseline: 4 },      // up-good falling → regression
  ])
  const m = Object.fromEntries(out.map(s => [s.metric, s.improved]))
  assert.equal(m.revenue, true)
  assert.equal(m.cpl, false)
  assert.equal(m.roas, false)
})

test('a down-good metric falling is an improvement; no-polarity spend is neutral', () => {
  const out = rankMovers([
    { metric: 'cpl',   current: 40,   baseline: 50 },     // cpl down → good
    { metric: 'spend', current: 6000, baseline: 5000 },   // spend has no polarity
  ])
  const m = Object.fromEntries(out.map(s => [s.metric, s.improved]))
  assert.equal(m.cpl, true)
  assert.equal(m.spend, null)
})

// ── headline / display strings match the delta chip exactly ───────────────────
test('headline copies the 1-dp percent and formatted delta the chip renders', () => {
  const [rev] = rankMovers([{ metric: 'revenue', current: 128000, baseline: 104000 }])
  assert.equal(rev.direction, 'up')
  assert.equal(rev.pct_display, '23.1%')        // 24000/104000 → 23.0769 → 23.1
  assert.equal(rev.delta_display, '$24,000')    // money, 0 dp, abs
  assert.equal(rev.headline, 'Revenue up 23.1%')// prefers the % when defined
  assert.equal(rev.metric_label, 'Revenue')

  const [cpl] = rankMovers([{ metric: 'cpl', current: 47.5, baseline: 50 }])
  assert.equal(cpl.direction, 'down')
  assert.equal(cpl.headline, 'Cost per lead down 5%')
})

test('every returned chip carries the window subtext and never a flat direction', () => {
  const out = rankMovers(
    [{ metric: 'leads', current: 150, baseline: 100 }],
    { windowLabel: 'vs the prior week' }
  )
  assert.equal(out[0].subtext, 'vs the prior week')
  for (const s of out) assert.notEqual(s.direction, 'flat')
})

test('subtext defaults to "vs last week" and question is the parser-stable template', () => {
  const [s] = rankMovers([{ metric: 'leads', current: 150, baseline: 100 }])
  assert.equal(s.subtext, 'vs last week')
  assert.equal(s.question, QUESTION.leads)
  assert.equal(s.question, 'How many leads did we get last week?')
})

// ── limit + robustness ────────────────────────────────────────────────────────
test('limit caps the result to the top movers and is clamped to 1..7', () => {
  const movers = [
    { metric: 'leads',      current: 200, baseline: 100 },  // +100%
    { metric: 'revenue',    current: 150, baseline: 100 },  // +50%
    { metric: 'jobs',       current: 130, baseline: 100 },  // +30%
    { metric: 'spend',      current: 120, baseline: 100 },  // +20%
    { metric: 'close_rate', current: 110, baseline: 100 },  // +10%
  ]
  const top3 = rankMovers(movers, { limit: 3 })
  assert.equal(top3.length, 3)
  assert.deepEqual(by(top3), ['leads', 'revenue', 'jobs'])

  assert.equal(rankMovers(movers, { limit: 0 }).length, 3)    // 0 → default 3
  assert.equal(rankMovers(movers, { limit: 99 }).length, 5)   // clamp ≤7, only 5 exist
})

test('unknown / unsupported metrics are skipped, and non-array input is safe', () => {
  const out = rankMovers([
    { metric: 'bogus',   current: 99, baseline: 1 },   // not in METRICS → skip
    { metric: 'revenue', current: 120, baseline: 100 },
  ])
  assert.deepEqual(by(out), ['revenue'])
  assert.deepEqual(rankMovers(null), [])
  assert.deepEqual(rankMovers(undefined), [])
})
