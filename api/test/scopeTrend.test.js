'use strict'
// Tests for lib/scopeTrend.js — intel-v14 D2 (step a): cross-read micro-trend core.
// Covers: insufficient/flat/trending status gating, the trailing-run walk (gap, flat,
// and reversal all break a streak), polarity-correct verbs + byte-identical magnitudes,
// monotonic/accelerating flags, salience ordering, every accepted read shape, leak-safety
// of the emitted payload, and determinism.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { detectScopeTrends, trailingRun, buildTrendHeadline } = require('../lib/scopeTrend')

// Compact-snapshot helper: {revenue:10000, leads:50} → [{metric,current}] (the shape the
// FE buffers via snapOf). Order is irrelevant — normalizeSnapshot keys by metric id.
const snap = (obj) => Object.entries(obj).map(([metric, current]) => ({ metric, current }))

// ── status gating ────────────────────────────────────────────────────────────
test('fewer than minRunSteps+1 reads → insufficient, no trends', () => {
  const r = detectScopeTrends([snap({ revenue: 10000 }), snap({ revenue: 11000 })])
  assert.equal(r.status, 'insufficient')
  assert.deepEqual(r.trends, [])
  assert.equal(r.headline, null)
  assert.equal(r.meta.reads, 2)
})

test('clean 3-read revenue up-run → trending with correct shape + headline', () => {
  const r = detectScopeTrends([
    snap({ revenue: 10000 }),
    snap({ revenue: 11000 }),
    snap({ revenue: 12000 }),
  ])
  assert.equal(r.status, 'trending')
  assert.equal(r.trends.length, 1)
  const t = r.trends[0]
  assert.equal(t.metric, 'revenue')
  assert.equal(t.metric_label, 'Revenue')
  assert.equal(t.direction, 'up')
  assert.equal(t.improving, true)        // revenue up is good
  assert.equal(t.runSteps, 2)
  assert.equal(t.runReads, 3)
  assert.equal(t.from, 10000)
  assert.equal(t.to, 12000)
  assert.equal(t.delta, 2000)
  assert.equal(t.monotonic, true)        // whole series moved one way
  assert.deepEqual(t.values, [10000, 11000, 12000])
  assert.equal(t.headline, 'Revenue has climbed 2 straight updates (+$2,000).')
  assert.equal(r.headline, t.headline)
  assert.equal(r.meta.longestRun, 2)
  assert.equal(r.meta.trendingCount, 1)
})

test('a trailing reversal breaks the run → flat (not trending)', () => {
  // up, up, then DOWN at the latest read → trailing run is a single down-step (<2).
  const r = detectScopeTrends([
    snap({ revenue: 10000 }),
    snap({ revenue: 10500 }),
    snap({ revenue: 11000 }),
    snap({ revenue: 10800 }),
  ])
  assert.equal(r.status, 'flat')
  assert.deepEqual(r.trends, [])
  assert.equal(r.headline, null)
})

test('a gap (metric absent for a read) breaks the run → flat', () => {
  // Same numbers as the clean up-run but with read #2 missing revenue entirely.
  // Proves movers-only semantics: an absence severs the streak (contrast the trending case).
  const r = detectScopeTrends([
    snap({ revenue: 10000 }),
    [],                          // revenue did not surface this read
    snap({ revenue: 10500 }),
    snap({ revenue: 11000 }),
  ])
  assert.equal(r.status, 'flat')
  assert.deepEqual(r.trends, [])
})

// ── polarity-correct verbs + byte-identical magnitudes ─────────────────────────
test('adverse metric on a run → improving:false, "risen" verb, "worth a look" tail', () => {
  const r = detectScopeTrends([
    snap({ cpl: 40 }),
    snap({ cpl: 45 }),
    snap({ cpl: 50 }),
  ])
  assert.equal(r.status, 'trending')
  const t = r.trends[0]
  assert.equal(t.metric, 'cpl')
  assert.equal(t.direction, 'up')
  assert.equal(t.improving, false)       // cpl up is bad
  assert.equal(t.headline, 'Cost per lead has risen 2 straight updates (+$10) — worth a look.')
})

test('adverse metric easing (good direction) → "eased" verb, no tail, REAL minus sign', () => {
  const r = detectScopeTrends([
    snap({ cpl: 50 }),
    snap({ cpl: 45 }),
    snap({ cpl: 40 }),
  ])
  const t = r.trends[0]
  assert.equal(t.direction, 'down')
  assert.equal(t.improving, true)        // cpl down is good
  assert.equal(t.headline, 'Cost per lead has eased 2 straight updates (−$10).')
  assert.ok(t.headline.includes('−'), 'uses the real minus sign, not a hyphen')
  assert.ok(!t.headline.includes('-$'), 'no ASCII hyphen before the magnitude')
})

test('good metric sliding → "slid" verb + worth-a-look tail', () => {
  const r = detectScopeTrends([
    snap({ revenue: 12000 }),
    snap({ revenue: 11000 }),
    snap({ revenue: 10000 }),
  ])
  const t = r.trends[0]
  assert.equal(t.direction, 'down')
  assert.equal(t.improving, false)       // revenue down is bad
  assert.equal(t.headline, 'Revenue has slid 2 straight updates (−$2,000) — worth a look.')
})

test('rising spend is treated as adverse → improving:false, "risen", worth-a-look tail', () => {
  // spend has goodWhenUp:false in the shared polarity oracle — a climbing spend run reads
  // as a runaway-campaign concern (isAdverse), not a neutral fact.
  const r = detectScopeTrends([
    snap({ spend: 1000 }),
    snap({ spend: 2000 }),
    snap({ spend: 3000 }),
  ])
  const t = r.trends[0]
  assert.equal(t.improving, false)
  assert.equal(t.headline, 'Ad spend has risen 2 straight updates (+$2,000) — worth a look.')
})

test('an unknown metric → improving:null (neutral verbs, no nudge) — defensive path', () => {
  // scopeInsight only emits the 7 engine metrics; an unrecognised id still trends safely,
  // labelled by its raw id, with neutral phrasing and no good/bad claim. signedDelta has no
  // descriptor here, so the magnitude renders as a bare number.
  const r = detectScopeTrends([
    [{ metric: 'mrr', current: 3000 }],
    [{ metric: 'mrr', current: 2500 }],
    [{ metric: 'mrr', current: 2000 }],
  ])
  const t = r.trends[0]
  assert.equal(t.metric, 'mrr')
  assert.equal(t.metric_label, 'mrr')    // falls back to the raw id
  assert.equal(t.direction, 'down')
  assert.equal(t.improving, null)
  assert.equal(t.headline, 'Mrr has fallen 2 straight updates (−1000).')
  assert.ok(!t.headline.includes('worth a look'), 'no good/bad claim for an unknown metric')
})

// ── flags ──────────────────────────────────────────────────────────────────────
test('accelerating reflects non-decreasing, strictly-growing step magnitudes', () => {
  const acc = detectScopeTrends([
    snap({ revenue: 10000 }),
    snap({ revenue: 10200 }),   // +200
    snap({ revenue: 10700 }),   // +500
    snap({ revenue: 11600 }),   // +900
  ])
  assert.equal(acc.trends[0].accelerating, true)

  const steady = detectScopeTrends([
    snap({ revenue: 10000 }),
    snap({ revenue: 10500 }),   // +500
    snap({ revenue: 11000 }),   // +500
  ])
  assert.equal(steady.trends[0].accelerating, false)  // equal steps are not accelerating
})

test('monotonic is false when the run does not start at read 0', () => {
  // [down, up, up, up] → trailing up-run is 3 steps starting at index 1, not the whole series.
  const r = detectScopeTrends([
    snap({ revenue: 11000 }),
    snap({ revenue: 10000 }),
    snap({ revenue: 10500 }),
    snap({ revenue: 11000 }),
    snap({ revenue: 11500 }),
  ])
  assert.equal(r.status, 'trending')
  const t = r.trends[0]
  assert.equal(t.runSteps, 3)
  assert.equal(t.runReads, 4)
  assert.equal(t.monotonic, false)
  assert.deepEqual(t.values, [10000, 10500, 11000, 11500])
})

// ── salience ─────────────────────────────────────────────────────────────────
test('salience ranks the longer streak first', () => {
  const r = detectScopeTrends([
    snap({ leads: 50 }),                      // revenue not yet in view
    snap({ revenue: 10000, leads: 55 }),
    snap({ revenue: 11000, leads: 60 }),
    snap({ revenue: 12000, leads: 65 }),
  ])
  assert.equal(r.status, 'trending')
  assert.equal(r.trends.length, 2)
  assert.equal(r.trends[0].metric, 'leads')    // 3-step run outranks…
  assert.equal(r.trends[0].runSteps, 3)
  assert.equal(r.trends[1].metric, 'revenue')  // …the 2-step run
  assert.equal(r.trends[1].runSteps, 2)
  assert.equal(r.headline, r.trends[0].headline)
})

// ── accepted read shapes ──────────────────────────────────────────────────────
test('full findings-payload reads (evidence.current) normalize correctly', () => {
  const r = detectScopeTrends([
    { findings: [{ metric: 'revenue', evidence: { current: 10000 } }] },
    { findings: [{ metric: 'revenue', evidence: { current: 11000 } }] },
    { findings: [{ metric: 'revenue', evidence: { current: 12000 } }] },
  ])
  assert.equal(r.status, 'trending')
  assert.equal(r.trends[0].metric, 'revenue')
  assert.equal(r.trends[0].to, 12000)
})

// ── leak-safety + determinism ─────────────────────────────────────────────────
test('emitted payload carries no tenant identity', () => {
  const r = detectScopeTrends([
    snap({ revenue: 10000, cpl: 50 }),
    snap({ revenue: 11000, cpl: 48 }),
    snap({ revenue: 12000, cpl: 46 }),
  ])
  const blob = JSON.stringify(r)
  for (const needle of ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!blob.includes(needle), `payload must not contain ${needle}`)
  }
})

test('same input → byte-identical output (deterministic)', () => {
  const history = [
    snap({ revenue: 10000, leads: 50 }),
    snap({ revenue: 11000, leads: 60 }),
    snap({ revenue: 12000, leads: 70 }),
  ]
  assert.deepEqual(detectScopeTrends(history), detectScopeTrends(history))
})

// ── fail-safe + unit helpers ──────────────────────────────────────────────────
test('malformed input never throws — degrades to a safe flat shape', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, [null, null, null]]) {
    const r = detectScopeTrends(bad)
    assert.ok(['insufficient', 'flat'].includes(r.status))
    assert.deepEqual(r.trends, [])
  }
})

test('trailingRun: returns null on empty / short / latest-absent series', () => {
  assert.equal(trailingRun([], 0), null)
  assert.equal(trailingRun([5], 0), null)
  assert.equal(trailingRun([1, 2, undefined], 0), null)   // latest is a gap
  assert.deepEqual(trailingRun([1, 2, 3], 0), { runSteps: 2, direction: 'up', startIdx: 0 })
})

test('buildTrendHeadline: a single step reads "1 straight update" (singular)', () => {
  const h = buildTrendHeadline({
    metric_label: 'Revenue', direction: 'up', improving: true, runSteps: 1, delta: 500, metric: 'revenue',
  })
  assert.equal(h, 'Revenue has climbed 1 straight update (+$500).')
})
