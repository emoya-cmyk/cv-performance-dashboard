// ============================================================
// test/systemic.test.js — cross-client common-cause detection (lib/systemic.js)
//
// detectSystemicSignals() collapses N independent per-client findings into ONE systemic
// signal when the same (channel, metric, direction) adverse move hit ≥ minClients distinct
// clients in a sweep — the "is this us or is this the platform?" call. These tests pin every
// gate: the eligible-kind set and the excluded projections/peer-relative kinds, grouping by
// each dimension (channel / metric / direction), distinct-client counting (a client that
// fires twice counts once; anomaly+trend co-group), the direction / client_id / catch-all
// eligibility filters, the count threshold and optional share floor, the explicit-vs-fallback
// portfolio denominator, the confidence blend (exact on clean cases + bounds + monotonicity),
// the deterministic sort, the exact verdict shape, and the PURITY contract (inputs never
// mutated; member_indices point back into the input). Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { detectSystemicSignals, SYSTEMIC_KINDS, HIGH_SEVERITIES } = require('../lib/systemic')

// An observed metric move (anomaly/trend), trimmed to what systemic reads.
function anom(client_id, { metric = 'leads', direction = 'down', channel = null, channel_label = null, severity = 'warning', kind = 'anomaly' } = {}) {
  const evidence = {}
  if (channel)       evidence.channel = channel
  if (channel_label) evidence.channel_label = channel_label
  return { kind, metric, direction, severity, client_id, scope: 'client', evidence }
}

// A dark-channel finding (coverage_gap): a channel, no metric.
function gap(client_id, { channel = 'meta_ads', channel_label = 'Meta Ads', severity = 'warning', direction = 'down' } = {}) {
  return { kind: 'coverage_gap', metric: null, direction, severity, client_id, scope: 'client',
           evidence: { channel, channel_label, days_dark: 6 } }
}

const onlySignal = (out) => { assert.equal(out.signals.length, 1); return out.signals[0] }

// ── exported sets ─────────────────────────────────────────────────────────────
test('SYSTEMIC_KINDS is exactly {anomaly, trend, coverage_gap}', () => {
  for (const k of ['anomaly', 'trend', 'coverage_gap']) assert.ok(SYSTEMIC_KINDS.has(k))
  for (const k of ['forecast', 'pacing', 'benchmark', 'data_health']) {
    assert.equal(SYSTEMIC_KINDS.has(k), false, `${k} must not be systemic`)
  }
  assert.equal(SYSTEMIC_KINDS.size, 3)
})

test('HIGH_SEVERITIES marks critical/severe, not warning/info', () => {
  assert.ok(HIGH_SEVERITIES.has('critical'))
  assert.ok(HIGH_SEVERITIES.has('severe'))
  assert.equal(HIGH_SEVERITIES.has('warning'), false)
  assert.equal(HIGH_SEVERITIES.has('info'), false)
})

// ── degenerate input → safe no-op ──────────────────────────────────────────────
test('null / non-array / empty → { signals: [] }, no throw', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, []]) {
    assert.deepEqual(detectSystemicSignals(bad), { signals: [] })
  }
})

// ── threshold ───────────────────────────────────────────────────────────────────
test('below minClients (default 3) → no signal', () => {
  const out = detectSystemicSignals([anom('a'), anom('b')], { portfolioSize: 10 })
  assert.deepEqual(out.signals, [])
})

test('exactly minClients distinct clients → one signal', () => {
  const out = detectSystemicSignals([anom('a'), anom('b'), anom('c')], { portfolioSize: 10 })
  const s = onlySignal(out)
  assert.equal(s.affected_count, 3)
  assert.equal(s.metric, 'leads')
  assert.equal(s.direction, 'down')
  assert.equal(s.channel, null)
  assert.deepEqual(s.kinds, ['anomaly'])
  assert.deepEqual(s.affected_client_ids, ['a', 'b', 'c'])
  assert.equal(s.key, '*|leads|down')
})

test('opts.minClients can tighten the threshold', () => {
  const findings = [anom('a'), anom('b'), anom('c')]
  assert.deepEqual(detectSystemicSignals(findings, { minClients: 4 }).signals, [])
  assert.equal(detectSystemicSignals(findings, { minClients: 3 }).signals.length, 1)
})

// ── distinct-client counting + anomaly/trend co-grouping ────────────────────────
test('a client firing twice counts ONCE; anomaly and trend co-group', () => {
  // client a emits BOTH an anomaly and a trend on leads-down; b and c emit one each.
  // → 3 distinct clients (not 4 findings), one signal spanning both kinds.
  const findings = [
    anom('a', { kind: 'anomaly' }),
    anom('a', { kind: 'trend' }),
    anom('b', { kind: 'anomaly' }),
    anom('c', { kind: 'trend' }),
  ]
  const s = onlySignal(detectSystemicSignals(findings, { portfolioSize: 10 }))
  assert.equal(s.affected_count, 3)
  assert.deepEqual(s.affected_client_ids, ['a', 'b', 'c'])
  assert.deepEqual(s.kinds, ['anomaly', 'trend'])      // sorted, deduped
  assert.deepEqual(s.member_indices, [0, 1, 2, 3])     // ALL four findings are members
})

// ── grouping separates by each dimension ────────────────────────────────────────
test('opposite directions form separate signals', () => {
  const findings = [
    anom('a', { direction: 'down' }), anom('b', { direction: 'down' }), anom('c', { direction: 'down' }),
    anom('d', { direction: 'up' }),   anom('e', { direction: 'up' }),   anom('f', { direction: 'up' }),
  ]
  const out = detectSystemicSignals(findings, { portfolioSize: 12 })
  assert.equal(out.signals.length, 2)
  assert.deepEqual(out.signals.map(s => s.key).sort(), ['*|leads|down', '*|leads|up'])
})

test('different metrics form separate signals', () => {
  const findings = [
    anom('a', { metric: 'leads' }), anom('b', { metric: 'leads' }), anom('c', { metric: 'leads' }),
    anom('d', { metric: 'revenue' }), anom('e', { metric: 'revenue' }), anom('f', { metric: 'revenue' }),
  ]
  const keys = detectSystemicSignals(findings, { portfolioSize: 12 }).signals.map(s => s.key).sort()
  assert.deepEqual(keys, ['*|leads|down', '*|revenue|down'])
})

test('same metric via different channels form separate signals', () => {
  const findings = [
    anom('a', { channel: 'meta_ads' }), anom('b', { channel: 'meta_ads' }), anom('c', { channel: 'meta_ads' }),
    anom('d', { channel: 'google_ads' }), anom('e', { channel: 'google_ads' }), anom('f', { channel: 'google_ads' }),
  ]
  const keys = detectSystemicSignals(findings, { portfolioSize: 12 }).signals.map(s => s.key).sort()
  assert.deepEqual(keys, ['google_ads|leads|down', 'meta_ads|leads|down'])
})

// ── coverage_gap (channel dark, no metric) ──────────────────────────────────────
test('coverage_gap across clients → one channel-level signal (metric null)', () => {
  const s = onlySignal(detectSystemicSignals([gap('a'), gap('b'), gap('c'), gap('d')], { portfolioSize: 10 }))
  assert.equal(s.affected_count, 4)
  assert.equal(s.channel, 'meta_ads')
  assert.equal(s.channel_label, 'Meta Ads')
  assert.equal(s.metric, null)
  assert.deepEqual(s.kinds, ['coverage_gap'])
  assert.equal(s.key, 'meta_ads|*|down')
})

// ── excluded kinds + eligibility filters ────────────────────────────────────────
test('projection / peer-relative / internal kinds never group', () => {
  const findings = []
  for (const kind of ['forecast', 'pacing', 'benchmark', 'data_health']) {
    findings.push({ kind, metric: 'leads', direction: 'down', severity: 'warning', client_id: `${kind}1`, evidence: {} })
    findings.push({ kind, metric: 'leads', direction: 'down', severity: 'warning', client_id: `${kind}2`, evidence: {} })
    findings.push({ kind, metric: 'leads', direction: 'down', severity: 'warning', client_id: `${kind}3`, evidence: {} })
  }
  assert.deepEqual(detectSystemicSignals(findings, { portfolioSize: 20 }).signals, [])
})

test('a finding with no direction is skipped', () => {
  // two valid + one missing direction → only 2 distinct → below threshold.
  const findings = [anom('a'), anom('b'), { kind: 'anomaly', metric: 'leads', client_id: 'c', evidence: {} }]
  assert.deepEqual(detectSystemicSignals(findings, { portfolioSize: 10 }).signals, [])
})

test('a finding with neither channel nor metric is skipped (no catch-all)', () => {
  const findings = [
    { kind: 'anomaly', metric: null, direction: 'down', client_id: 'a', evidence: {} },
    { kind: 'anomaly', metric: null, direction: 'down', client_id: 'b', evidence: {} },
    { kind: 'anomaly', metric: null, direction: 'down', client_id: 'c', evidence: {} },
  ]
  assert.deepEqual(detectSystemicSignals(findings, { portfolioSize: 10 }).signals, [])
})

test('a finding with no client_id is skipped', () => {
  const findings = [anom('a'), anom('b'), { kind: 'anomaly', metric: 'leads', direction: 'down', evidence: {} }]
  assert.deepEqual(detectSystemicSignals(findings, { portfolioSize: 10 }).signals, [])
})

// ── share floor + portfolio denominator ─────────────────────────────────────────
test('opts.minShare gates out a thin slice of a big book', () => {
  const findings = [anom('a'), anom('b'), anom('c')]   // 3 of 100
  assert.deepEqual(detectSystemicSignals(findings, { portfolioSize: 100, minShare: 0.1 }).signals, [])
  assert.equal(detectSystemicSignals(findings, { portfolioSize: 100 }).signals.length, 1) // default minShare 0
})

test('explicit portfolioSize drives share_of_portfolio / share_pct', () => {
  const findings = [anom('a'), anom('b'), anom('c'), anom('d')]
  const s = onlySignal(detectSystemicSignals(findings, { portfolioSize: 10 }))
  assert.equal(s.share_of_portfolio, 0.4)
  assert.equal(s.share_pct, 40)
})

test('without portfolioSize, the denominator falls back to clients-with-findings', () => {
  // 4 clients in the group + 3 more clients present only via excluded benchmark findings
  // → denominator 7, share 4/7 ≈ 0.57.
  const findings = [anom('a'), anom('b'), anom('c'), anom('d')]
  for (const c of ['x', 'y', 'z']) {
    findings.push({ kind: 'benchmark', metric: 'leads', direction: 'down', severity: 'warning', client_id: c, evidence: {} })
  }
  const s = onlySignal(detectSystemicSignals(findings))
  assert.equal(s.share_pct, 57)
  assert.equal(s.share_of_portfolio, 0.57)
})

// ── severity summary ────────────────────────────────────────────────────────────
test('severity is critical when any affected client carries a critical finding', () => {
  const warnOnly = [anom('a'), anom('b'), anom('c')]
  assert.equal(onlySignal(detectSystemicSignals(warnOnly, { portfolioSize: 10 })).severity, 'warning')

  const withCrit = [anom('a', { severity: 'critical' }), anom('b'), anom('c')]
  assert.equal(onlySignal(detectSystemicSignals(withCrit, { portfolioSize: 10 })).severity, 'critical')
})

// ── confidence ────────────────────────────────────────────────────────────────
test('confidence — clean case: 8/10 clients, all critical → 0.91', () => {
  // share 0.8 (·0.45) + countScore 1.0 (·0.35) + sevScore 1.0 (·0.20) = 0.91
  const findings = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(c => anom(c, { severity: 'critical' }))
  const s = onlySignal(detectSystemicSignals(findings, { portfolioSize: 10 }))
  assert.equal(s.affected_count, 8)
  assert.equal(s.confidence, 0.91)
})

test('confidence — fully saturated (whole book, all critical) → 1', () => {
  const findings = ['a', 'b', 'c', 'd', 'e'].map(c => anom(c, { severity: 'critical' }))
  const s = onlySignal(detectSystemicSignals(findings, { portfolioSize: 5, countSaturation: 5 }))
  assert.equal(s.confidence, 1)
  assert.equal(s.share_of_portfolio, 1)
  assert.equal(s.share_pct, 100)
})

test('confidence stays within [0,1] and rises with reach', () => {
  // two disjoint signals in one book: leads-down spans 8 clients, revenue-up spans 3.
  const findings = [
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(c => anom(c, { metric: 'leads', direction: 'down' })),
    ...['a', 'b', 'c'].map(c => anom(c, { metric: 'revenue', direction: 'up' })),
  ]
  const out = detectSystemicSignals(findings, { portfolioSize: 10 })
  assert.equal(out.signals.length, 2)
  for (const s of out.signals) { assert.ok(s.confidence >= 0 && s.confidence <= 1) }
  // sorted strongest-first → the broader (leads, 8 clients) leads.
  assert.equal(out.signals[0].metric, 'leads')
  assert.ok(out.signals[0].confidence > out.signals[1].confidence)
})

// ── deterministic shape ─────────────────────────────────────────────────────────
test('signal carries exactly the documented keys', () => {
  const s = onlySignal(detectSystemicSignals([anom('a'), anom('b'), anom('c')], { portfolioSize: 10 }))
  const want = ['affected_client_ids', 'affected_count', 'channel', 'channel_label', 'confidence',
    'direction', 'key', 'kinds', 'member_indices', 'metric', 'severity', 'share_of_portfolio', 'share_pct'].sort()
  assert.deepEqual(Object.keys(s).sort(), want)
})

test('member_indices point back at the contributing input findings', () => {
  const findings = [
    anom('a', { metric: 'revenue', direction: 'up' }), // 0 — different group
    anom('b', { metric: 'leads', direction: 'down' }), // 1
    anom('c', { metric: 'leads', direction: 'down' }), // 2
    anom('d', { metric: 'leads', direction: 'down' }), // 3
  ]
  const leads = detectSystemicSignals(findings, { portfolioSize: 10 }).signals.find(s => s.metric === 'leads')
  assert.deepEqual(leads.member_indices, [1, 2, 3])
  for (const i of leads.member_indices) {
    assert.equal(findings[i].metric, 'leads')
    assert.equal(findings[i].direction, 'down')
  }
})

// ── purity ────────────────────────────────────────────────────────────────────
test('PURE: input findings are never mutated', () => {
  const findings = [anom('a', { severity: 'critical' }), anom('b'), gap('c'), gap('d'), gap('e')]
  const snap = JSON.stringify(findings)
  detectSystemicSignals(findings, { portfolioSize: 10 })
  assert.equal(JSON.stringify(findings), snap, 'findings must not be mutated')
  for (const f of findings) assert.equal('systemic' in f, false, 'no systemic key grafted onto inputs')
})
