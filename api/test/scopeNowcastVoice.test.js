'use strict'
// Tests for lib/scopeNowcastVoice.js — intel-v14 D6 (step a): the nowcast speaks at its measured
// confidence. Covers: gating (no projection / not projected / ungraded accuracy / no band / the
// LEAD metric has no band → none); the four confidence tiers keyed off the lead band's halfPct
// (firm states the figure & drops the "~"; measured keeps "~" + the earned range; tentative leads
// with the trend, softens to "roughly", shows the ±; withheld names only the direction & refuses a
// figure); the opts threshold overrides; the adverse "worth a look" nudge on the number-speaking
// tiers; the trend-direction word; the END-TO-END voice through the REAL detect→project→grade→band
// pipeline (a tight record → firm, the real projected figure spoken); leak-safety; determinism;
// and fail-safe degradation.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { detectScopeTrends } = require('../lib/scopeTrend')
const { projectScopeTrend } = require('../lib/scopeNowcast')
const { gradeScopeNowcast } = require('../lib/scopeNowcastAccuracy')
const { calibrateNowcastBand } = require('../lib/scopeNowcastBand')
const { calibrateNowcastVoice } = require('../lib/scopeNowcastVoice')

// {revenue:10000} → [{metric,current}] (the compact shape the pipeline reads end-to-end).
const snap = (obj) => Object.entries(obj).map(([metric, current]) => ({ metric, current }))
const hist = (...reads) => reads.map(snap)

// ── synthetic factories (precise control over the lead band's halfPct) ─────────────
const RAW_HEADLINE = 'At this pace, revenue reaches ~$1,000 next update (+$100).'
const mkNowcast = (over = {}) => ({
  status: 'projected',
  projections: [{
    metric: over.metric || 'revenue',
    metric_label: over.metric_label || 'Revenue',
    direction: over.direction || 'up',
    improving: over.improving !== undefined ? over.improving : true,
    horizon: over.horizon || 1,
    projected: over.projected !== undefined ? over.projected : 1000,
    projectedDelta: over.projectedDelta !== undefined ? over.projectedDelta : 100,
    pct: 11.1,
    headline: RAW_HEADLINE,
  }],
  headline: RAW_HEADLINE,
})
const mkAcc = (smape, metric = 'revenue') => ({
  status: 'graded',
  metrics: [{ metric, smape, samples: 1 }],
  overall: { smape, samples: 1 },
})
const mkBand = (halfPct, over = {}) => ({
  status: 'calibrated',
  bands: [{
    metric: over.metric || 'revenue',
    metric_label: over.metric_label || 'Revenue',
    projected: 1000,
    projectedCents: 100000,
    halfPct,
    drawnHalfPct: Math.min(halfPct, 200),
    lo: 900, hi: 1100,
    loCents: 90000, hiCents: 110000,
    loLabel: '$900', hiLabel: '$1,100',
    rangeLabel: '$900–$1,100',
    floored: false,
    basis: over.basis || 'metric',
    samples: 1,
  }],
  meta: { calibrated: 1, basis: 'measured-smape', maxHalfPct: 200 },
})

// ── gating ─────────────────────────────────────────────────────────────────────────
test('no nowcast / not projected → status none, original headline preserved as raw', () => {
  for (const nc of [null, undefined, {}, { status: 'none', projections: [] }, { status: 'projected', projections: [] }]) {
    const v = calibrateNowcastVoice(nc, mkAcc(3), mkBand(3), {})
    assert.equal(v.status, 'none')
    assert.equal(v.headline, null)
  }
})

test('ungraded accuracy → status none (cannot gate without a measured error)', () => {
  // null / undefined / 'none' accuracy is rejected outright regardless of band. An empty 'graded'
  // shell can never coexist with a real band in the pipeline (it would itself produce a 'none'
  // band), so it's paired with the none-band it would actually yield — caught by the band gate.
  for (const acc of [null, undefined, { status: 'none' }]) {
    const v = calibrateNowcastVoice(mkNowcast(), acc, mkBand(3), {})
    assert.equal(v.status, 'none')
    assert.equal(v.raw, RAW_HEADLINE)   // the raw D3 headline is still surfaced for FE fallback
  }
  const empty = calibrateNowcastVoice(mkNowcast(), { status: 'graded', metrics: [], overall: null }, { status: 'none', bands: [] }, {})
  assert.equal(empty.status, 'none')
  assert.equal(empty.raw, RAW_HEADLINE)
})

test('no band / band for a DIFFERENT metric than the lead → status none', () => {
  // no band at all
  assert.equal(calibrateNowcastVoice(mkNowcast(), mkAcc(3), null, {}).status, 'none')
  assert.equal(calibrateNowcastVoice(mkNowcast(), mkAcc(3), { status: 'none', bands: [] }, {}).status, 'none')
  // the lead is 'revenue' but only 'leads' got a band → the headline's metric is ungated → none
  const otherBand = mkBand(10, { metric: 'leads', metric_label: 'Leads' })
  const v = calibrateNowcastVoice(mkNowcast({ metric: 'revenue' }), mkAcc(3), otherBand, {})
  assert.equal(v.status, 'none')
})

// ── the four confidence tiers ────────────────────────────────────────────────────────
test('firm (sMAPE ≤ 5%) — states the figure plainly, drops the "~", speaks the number', () => {
  const v = calibrateNowcastVoice(mkNowcast(), mkAcc(3), mkBand(3), {})
  assert.equal(v.status, 'voiced')
  assert.equal(v.confidence, 'firm')
  assert.equal(v.speaksNumber, true)
  assert.equal(v.leadMetric, 'revenue')
  assert.equal(v.leadLabel, 'Revenue')
  assert.equal(v.halfPct, 3)
  assert.equal(v.basis, 'metric')
  assert.equal(v.hedge, '')                       // firm carries no qualifier
  assert.ok(v.headline.includes('$1,000'), v.headline)
  assert.ok(v.headline.includes('+$100'), v.headline)
  assert.ok(!v.headline.includes('~'), 'firm drops the soft tilde')
  assert.ok(!v.headline.includes('worth a look'), 'good-direction firm carries no nudge')
  assert.equal(v.raw, RAW_HEADLINE)
})

test('measured (5% < sMAPE ≤ 15%) — keeps the "~" and appends the earned range', () => {
  const v = calibrateNowcastVoice(mkNowcast(), mkAcc(10), mkBand(10), {})
  assert.equal(v.confidence, 'measured')
  assert.equal(v.speaksNumber, true)
  assert.ok(v.headline.includes('~$1,000'), v.headline)
  assert.ok(v.headline.includes('likely $900–$1,100'), v.headline)
  assert.equal(v.hedge, 'likely $900–$1,100')
})

test('tentative (15% < sMAPE ≤ 40%) — leads with the trend, softens to "roughly", shows the ±', () => {
  const v = calibrateNowcastVoice(mkNowcast(), mkAcc(25), mkBand(25), {})
  assert.equal(v.confidence, 'tentative')
  assert.equal(v.speaksNumber, true)
  assert.ok(v.headline.startsWith('Revenue is trending up'), v.headline)
  assert.ok(v.headline.includes('roughly $1,000'), v.headline)
  assert.ok(v.headline.includes('±25%'), v.headline)
  assert.equal(v.hedge, 'varied ±25%')
})

test('withheld (sMAPE > 40%) — names only the direction, refuses the figure', () => {
  const v = calibrateNowcastVoice(mkNowcast(), mkAcc(60), mkBand(60), {})
  assert.equal(v.confidence, 'withheld')
  assert.equal(v.speaksNumber, false)
  assert.ok(v.headline.includes('too volatile (±60%)'), v.headline)
  assert.ok(v.headline.includes('to call a number yet'), v.headline)
  assert.ok(!v.headline.includes('$1,000'), 'withheld must not name the figure')
  assert.equal(v.hedge, 'too volatile (±60%)')
})

// ── threshold overrides ──────────────────────────────────────────────────────────────
test('opts thresholds re-bracket the same sMAPE', () => {
  // 3% is firm by default; tightening firmMax to 2 drops it to measured.
  const v = calibrateNowcastVoice(mkNowcast(), mkAcc(3), mkBand(3), { firmMax: 2 })
  assert.equal(v.confidence, 'measured')
  assert.deepEqual(v.meta.thresholds, { firmMax: 2, measuredMax: 15, tentativeMax: 40 })
  // 60% is withheld by default; widening tentativeMax to 100 rescues it to tentative.
  const v2 = calibrateNowcastVoice(mkNowcast(), mkAcc(60), mkBand(60), { tentativeMax: 100 })
  assert.equal(v2.confidence, 'tentative')
  assert.equal(v2.speaksNumber, true)
})

// ── the adverse "worth a look" nudge rides the number-speaking tiers ───────────────────
test('adverse firm/measured append the soft nudge; adverse does not change the tier', () => {
  const firm = calibrateNowcastVoice(mkNowcast({ improving: false }), mkAcc(3), mkBand(3), {})
  assert.equal(firm.confidence, 'firm')
  assert.ok(firm.headline.includes('worth a look'), firm.headline)
  const measured = calibrateNowcastVoice(mkNowcast({ improving: false }), mkAcc(10), mkBand(10), {})
  assert.equal(measured.confidence, 'measured')
  assert.ok(measured.headline.includes('worth a look'), measured.headline)
  assert.ok(measured.headline.includes('likely $900–$1,100'), measured.headline)
})

test('the trend-direction word follows the projection direction', () => {
  const down = calibrateNowcastVoice(mkNowcast({ direction: 'down', improving: false }), mkAcc(25), mkBand(25), {})
  assert.ok(down.headline.startsWith('Revenue is trending down'), down.headline)
})

// ── end-to-end through the REAL pipeline ───────────────────────────────────────────────
test('end-to-end — a tight record speaks firmly with the real projected figure', () => {
  // [10k,11k,12k,12.5k] → revenue projected 13333.33; the one-step backtest grades sMAPE 3.92% →
  // band halfPct 3.92 → firm. The voice should state "$13,333" plainly, no tilde, with the +$833.
  const h = hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 12500 })
  const trend = detectScopeTrends(h, {})
  const nowcast = projectScopeTrend(trend, { horizon: 1 })
  const accuracy = gradeScopeNowcast(h, {})
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  const v = calibrateNowcastVoice(nowcast, accuracy, band, {})

  assert.equal(v.status, 'voiced')
  assert.equal(v.confidence, 'firm')
  assert.equal(v.speaksNumber, true)
  assert.equal(v.leadMetric, 'revenue')
  assert.equal(v.halfPct, 3.92)
  assert.equal(v.basis, 'metric')
  assert.ok(v.headline.includes('$13,333'), v.headline)
  assert.ok(v.headline.includes('+$833'), v.headline)
  assert.ok(!v.headline.includes('~'), 'firm drops the tilde even on the live projection')
})

// ── leak-safety + determinism ──────────────────────────────────────────────────────────
test('emitted voice carries no tenant identity', () => {
  const h = hist({ revenue: 10000 }, { revenue: 11000 }, { revenue: 12000 }, { revenue: 12500 })
  const trend = detectScopeTrends(h, {})
  const nowcast = projectScopeTrend(trend, { horizon: 1 })
  const accuracy = gradeScopeNowcast(h, {})
  const band = calibrateNowcastBand(nowcast, accuracy, {})
  const blob = JSON.stringify(calibrateNowcastVoice(nowcast, accuracy, band, {}))
  for (const needle of ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!blob.includes(needle), `voice must not contain ${needle}`)
  }
})

test('same input → byte-identical output (deterministic)', () => {
  assert.deepEqual(
    calibrateNowcastVoice(mkNowcast(), mkAcc(10), mkBand(10), {}),
    calibrateNowcastVoice(mkNowcast(), mkAcc(10), mkBand(10), {}),
  )
})

// ── fail-safe ───────────────────────────────────────────────────────────────────────────
test('malformed input never throws — degrades to status none', () => {
  const okN = mkNowcast(), okA = mkAcc(5), okB = mkBand(5)
  for (const bad of [null, undefined, 42, 'nope', {}, [], NaN, { status: 'projected' }]) {
    assert.equal(calibrateNowcastVoice(bad, okA, okB, {}).status, 'none')
    assert.equal(calibrateNowcastVoice(okN, bad, okB, {}).status, 'none')
    assert.equal(calibrateNowcastVoice(okN, okA, bad, {}).status, 'none')
  }
  // all junk, and junk opts on a good call → no throw; good call still voices.
  assert.equal(calibrateNowcastVoice('x', 'y', 'z', 'w').status, 'none')
  assert.equal(calibrateNowcastVoice(okN, okA, okB, 42).status, 'voiced')
})
