'use strict'
// test/scopeDelta.test.js — intel-v14 D1 (step a). Exercises the "since you last
// looked" diff core: baseline/steady/changed status, cent-granular materiality (shared
// with scopeFreshness so jitter is swallowed exactly as the C4 refresh gate swallows
// it), polarity via the real isAdverse oracle, byte-identical formatValue phrasing,
// appeared/resolved set deltas, driver-shift detection, input-shape parity, deterministic
// ordering, fail-safety on junk, and structural leak-safety.
const { test } = require('node:test')
const assert = require('node:assert')

const {
  diffScopeInsights,
  normalizeSnapshot,
  classifyMove,
  pctChange,
  signedDelta,
  buildDeltaHeadline,
} = require('../lib/scopeDelta')

// Build a scope-insight-shaped finding the way scopeInsight emits one. Only the fields
// the differ reads (metric, evidence.current, metric_label, driver.label) matter; the
// rest are present to prove they're ignored.
function finding(metric, current, { label, driver } = {}) {
  const f = {
    kind: 'movement',
    metric,
    severity: 'info',
    title: `${metric} title`,
    detail: 'some detail',
    direction: 'up',
    improved: true,
    evidence: { current, previous: 999, delta: 1, pct_change: 1 },
    recommendation: null,
  }
  if (label !== undefined) f.metric_label = label
  if (driver !== undefined) f.driver = { label: driver, delta: 0, display: 'x' }
  return f
}
// A whole scope-insight payload around a list of findings.
const payload = (findings) => ({
  headline: 'h', scope: { windowLabel: 'w', compareLabel: null, hasCompare: false },
  findings, meta: { steady: 0 },
})

// ──────────────────────────────────────────────────────────────────────────
// status: baseline
// ──────────────────────────────────────────────────────────────────────────

test('no usable prev → baseline, empty arrays, null headline, zeroed meta', () => {
  for (const prev of [null, undefined, 'x', 42, {}, { findings: 'nope' }, [], [{ no: 'metric' }]]) {
    const d = diffScopeInsights(prev, payload([finding('revenue', 6240)]))
    assert.strictEqual(d.status, 'baseline', `prev=${JSON.stringify(prev)}`)
    assert.deepStrictEqual(d.changes, [])
    assert.deepStrictEqual(d.appeared, [])
    assert.deepStrictEqual(d.resolved, [])
    assert.strictEqual(d.headline, null)
    assert.deepStrictEqual(d.meta, { comparedMetrics: 0, movedCount: 0, appearedCount: 0, resolvedCount: 0 })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// status: steady (incl. sub-cent jitter immunity)
// ──────────────────────────────────────────────────────────────────────────

test('identical currents → steady, no changes, null headline', () => {
  const d = diffScopeInsights(payload([finding('revenue', 5000)]), payload([finding('revenue', 5000)]))
  assert.strictEqual(d.status, 'steady')
  assert.strictEqual(d.changes.length, 0)
  assert.strictEqual(d.headline, null)
  assert.strictEqual(d.meta.comparedMetrics, 1)
})

test('sub-cent jitter is swallowed exactly as the freshness gate swallows it', () => {
  // 5000.001 vs 5000.004 both → 500000 cents → no move.
  const d = diffScopeInsights(payload([finding('revenue', 5000.001)]), payload([finding('revenue', 5000.004)]))
  assert.strictEqual(d.status, 'steady')
  assert.strictEqual(d.changes.length, 0)
})

test('a one-cent move DOES register', () => {
  const d = diffScopeInsights(payload([finding('revenue', 5000.00)]), payload([finding('revenue', 5000.01)]))
  assert.strictEqual(d.status, 'changed')
  assert.strictEqual(d.changes.length, 1)
  assert.strictEqual(d.changes[0].deltaCents, 1)
})

// ──────────────────────────────────────────────────────────────────────────
// status: changed — magnitude / direction / pct / phrasing
// ──────────────────────────────────────────────────────────────────────────

test('revenue 5000→6240: +1240 up improved, pct 24.8, cents 124000, phrased "+$1,240"', () => {
  const d = diffScopeInsights(payload([finding('revenue', 5000)]), payload([finding('revenue', 6240)]))
  assert.strictEqual(d.status, 'changed')
  assert.strictEqual(d.changes.length, 1)
  const c = d.changes[0]
  assert.strictEqual(c.metric, 'revenue')
  assert.strictEqual(c.metric_label, 'Revenue')
  assert.strictEqual(c.from, 5000)
  assert.strictEqual(c.to, 6240)
  assert.strictEqual(c.delta, 1240)
  assert.strictEqual(c.deltaCents, 124000)
  assert.strictEqual(c.direction, 'up')
  assert.strictEqual(c.improved, true)
  assert.ok(Math.abs(c.pct - 24.8) < 1e-9)
  assert.strictEqual(c.driverShift, null)
  assert.strictEqual(d.headline, 'Since you last looked: revenue +$1,240.')
})

// ──────────────────────────────────────────────────────────────────────────
// polarity via the real isAdverse oracle
// ──────────────────────────────────────────────────────────────────────────

test('cpl polarity: up is bad (improved false), down is good (improved true)', () => {
  const up = diffScopeInsights(payload([finding('cpl', 50)]), payload([finding('cpl', 60)]))
  assert.strictEqual(up.changes[0].direction, 'up')
  assert.strictEqual(up.changes[0].improved, false)
  const down = diffScopeInsights(payload([finding('cpl', 60)]), payload([finding('cpl', 50)]))
  assert.strictEqual(down.changes[0].direction, 'down')
  assert.strictEqual(down.changes[0].improved, true)
})

test('spend polarity (goodWhenUp:false): up not improved, down improved', () => {
  const up = diffScopeInsights(payload([finding('spend', 1000)]), payload([finding('spend', 1200)]))
  assert.strictEqual(up.changes[0].direction, 'up')
  assert.strictEqual(up.changes[0].improved, false)
  const down = diffScopeInsights(payload([finding('spend', 1200)]), payload([finding('spend', 1000)]))
  assert.strictEqual(down.changes[0].improved, true)
})

test('revenue down is adverse (improved false)', () => {
  const d = diffScopeInsights(payload([finding('revenue', 6000)]), payload([finding('revenue', 5000)]))
  assert.strictEqual(d.changes[0].direction, 'down')
  assert.strictEqual(d.changes[0].improved, false)
})

test('leads up is good (improved true)', () => {
  const d = diffScopeInsights(payload([finding('leads', 10)]), payload([finding('leads', 14)]))
  assert.strictEqual(d.changes[0].improved, true)
})

test('an unknown metric id yields improved:null (neutral), still a registered change', () => {
  const d = diffScopeInsights(payload([finding('made_up', 10)]), payload([finding('made_up', 20)]))
  assert.strictEqual(d.changes.length, 1)
  assert.strictEqual(d.changes[0].improved, null)
  assert.strictEqual(d.changes[0].direction, 'up')
})

// ──────────────────────────────────────────────────────────────────────────
// from-zero
// ──────────────────────────────────────────────────────────────────────────

test('from zero: pct null but delta and direction still computed', () => {
  const d = diffScopeInsights(payload([finding('revenue', 0)]), payload([finding('revenue', 100)]))
  assert.strictEqual(d.changes[0].pct, null)
  assert.strictEqual(d.changes[0].delta, 100)
  assert.strictEqual(d.changes[0].direction, 'up')
  assert.strictEqual(d.changes[0].improved, true)
})

// ──────────────────────────────────────────────────────────────────────────
// appeared / resolved set deltas
// ──────────────────────────────────────────────────────────────────────────

test('a metric only in next → appeared; only in prev → resolved; status changed', () => {
  const prev = payload([finding('revenue', 5000), finding('cpl', 50)])
  const next = payload([finding('revenue', 5000), finding('leads', 12)])
  const d = diffScopeInsights(prev, next)
  assert.strictEqual(d.status, 'changed')
  assert.strictEqual(d.changes.length, 0)                 // revenue identical
  assert.deepStrictEqual(d.appeared, [{ metric: 'leads', metric_label: 'Leads', to: 12 }])
  assert.deepStrictEqual(d.resolved, [{ metric: 'cpl', metric_label: 'Cost per lead', from: 50 }])
  assert.strictEqual(d.meta.appearedCount, 1)
  assert.strictEqual(d.meta.resolvedCount, 1)
})

test('headline falls back to appeared count when nothing crossed the cent threshold', () => {
  const prev = payload([finding('revenue', 5000)])
  const next = payload([finding('revenue', 5000), finding('leads', 12)])
  assert.strictEqual(diffScopeInsights(prev, next).headline, 'Since you last looked: 1 new mover in view.')
})

test('headline falls back to resolved count when only resolutions occurred', () => {
  const prev = payload([finding('revenue', 5000), finding('cpl', 50)])
  const next = payload([finding('revenue', 5000)])
  assert.strictEqual(diffScopeInsights(prev, next).headline, 'Since you last looked: 1 mover settled.')
})

// ──────────────────────────────────────────────────────────────────────────
// driver shift
// ──────────────────────────────────────────────────────────────────────────

test('driver flip is reported; same driver yields null', () => {
  const flip = diffScopeInsights(
    payload([finding('revenue', 5000, { driver: 'Google Ads' })]),
    payload([finding('revenue', 6240, { driver: 'Meta' })]),
  )
  assert.deepStrictEqual(flip.changes[0].driverShift, { from: 'Google Ads', to: 'Meta' })
  const same = diffScopeInsights(
    payload([finding('revenue', 5000, { driver: 'Google Ads' })]),
    payload([finding('revenue', 6240, { driver: 'Google Ads' })]),
  )
  assert.strictEqual(same.changes[0].driverShift, null)
})

// ──────────────────────────────────────────────────────────────────────────
// input-shape parity
// ──────────────────────────────────────────────────────────────────────────

test('full payload, bare findings[], and compact [{metric,current}] all diff alike', () => {
  const expectDelta = (d) => {
    assert.strictEqual(d.status, 'changed')
    assert.strictEqual(d.changes.length, 1)
    assert.strictEqual(d.changes[0].delta, 1240)
  }
  // full payload on both sides
  expectDelta(diffScopeInsights(payload([finding('revenue', 5000)]), payload([finding('revenue', 6240)])))
  // bare findings arrays
  expectDelta(diffScopeInsights([finding('revenue', 5000)], [finding('revenue', 6240)]))
  // compact snapshots (current directly on the item, no evidence wrapper)
  expectDelta(diffScopeInsights([{ metric: 'revenue', current: 5000 }], [{ metric: 'revenue', current: 6240 }]))
  // mixed: compact prev (what the FE captures) vs full next (what the server narrates)
  expectDelta(diffScopeInsights([{ metric: 'revenue', current: 5000 }], payload([finding('revenue', 6240)])))
})

test('metric_label falls back to the METRICS catalogue when absent on the item', () => {
  const d = diffScopeInsights([{ metric: 'cpl', current: 40 }], [{ metric: 'cpl', current: 55 }])
  assert.strictEqual(d.changes[0].metric_label, 'Cost per lead')
})

// ──────────────────────────────────────────────────────────────────────────
// deterministic ordering
// ──────────────────────────────────────────────────────────────────────────

test('changes sort by |deltaCents| desc, metric id as the tiebreak', () => {
  const prev = payload([finding('revenue', 5000), finding('leads', 10), finding('cpl', 50)])
  const next = payload([finding('revenue', 6240), finding('leads', 15), finding('cpl', 60)])
  // |deltas| in cents: revenue 124000, cpl 1000, leads 500 → revenue, cpl, leads
  const order = diffScopeInsights(prev, next).changes.map((c) => c.metric)
  assert.deepStrictEqual(order, ['revenue', 'cpl', 'leads'])
})

test('equal magnitudes break ties by metric id ascending; order is input-independent', () => {
  // jobs and leads both move +5 (=500 cents). 'jobs' < 'leads' alphabetically.
  const a = diffScopeInsights(payload([finding('leads', 10), finding('jobs', 10)]),
                              payload([finding('leads', 15), finding('jobs', 15)]))
  const b = diffScopeInsights(payload([finding('jobs', 10), finding('leads', 10)]),
                              payload([finding('jobs', 15), finding('leads', 15)]))
  assert.deepStrictEqual(a.changes.map((c) => c.metric), ['jobs', 'leads'])
  assert.deepStrictEqual(b.changes.map((c) => c.metric), ['jobs', 'leads'])
})

// ──────────────────────────────────────────────────────────────────────────
// caller knobs: minDeltaCents floor, headlineLimit
// ──────────────────────────────────────────────────────────────────────────

test('minDeltaCents drops moves below the floor, keeps those at/above it', () => {
  const prev = payload([finding('revenue', 5000), finding('leads', 10)])
  const next = payload([finding('revenue', 5005), finding('leads', 15)])   // revenue +500c, leads +500c
  // floor 600c drops both; floor 500c keeps both; floor 501c drops both
  assert.strictEqual(diffScopeInsights(prev, next, { minDeltaCents: 600 }).changes.length, 0)
  assert.strictEqual(diffScopeInsights(prev, next, { minDeltaCents: 500 }).changes.length, 2)
  assert.strictEqual(diffScopeInsights(prev, next, { minDeltaCents: 501 }).changes.length, 0)
})

test('headlineLimit caps how many moves the sentence names (default 2)', () => {
  const prev = payload([finding('revenue', 5000), finding('leads', 10), finding('cpl', 50)])
  const next = payload([finding('revenue', 6240), finding('leads', 15), finding('cpl', 60)])
  const def = diffScopeInsights(prev, next).headline
  assert.ok(def.includes(' and '), 'default joins two moves')
  assert.ok(def.startsWith('Since you last looked: revenue +$1,240 and cost per lead '))
  const one = diffScopeInsights(prev, next, { headlineLimit: 1 }).headline
  assert.ok(!one.includes(' and '), 'limit 1 names a single move')
  assert.strictEqual(one, 'Since you last looked: revenue +$1,240.')
})

// ──────────────────────────────────────────────────────────────────────────
// fail-safety: never throws on junk; junk items are ignored, not counted
// ──────────────────────────────────────────────────────────────────────────

test('junk items inside an otherwise valid list are ignored, never throw', () => {
  const prev = { findings: [null, 7, 'x', { no: 'metric' }, { metric: 'revenue', current: 5000 },
                            { metric: 'leads', current: NaN }, { metric: 'jobs', evidence: { current: 'oops' } }] }
  const next = { findings: [finding('revenue', 6240), { metric: null, current: 1 }] }
  let d
  assert.doesNotThrow(() => { d = diffScopeInsights(prev, next) })
  assert.strictEqual(d.status, 'changed')
  assert.strictEqual(d.changes.length, 1)         // only revenue survived on both sides
  assert.strictEqual(d.changes[0].metric, 'revenue')
})

test('totally malformed opts is tolerated', () => {
  assert.doesNotThrow(() => diffScopeInsights(payload([finding('revenue', 1)]), payload([finding('revenue', 2)]), 'nope'))
  assert.doesNotThrow(() => diffScopeInsights(payload([finding('revenue', 1)]), payload([finding('revenue', 2)]), { headlineLimit: -3, minDeltaCents: -9 }))
})

// ──────────────────────────────────────────────────────────────────────────
// structural leak-safety
// ──────────────────────────────────────────────────────────────────────────

test('the delta payload embeds no tenant identity', () => {
  const prev = payload([finding('revenue', 5000, { driver: 'Google Ads' }), finding('cpl', 50)])
  const next = payload([finding('revenue', 6240, { driver: 'Meta' }), finding('leads', 12)])
  const blob = JSON.stringify(diffScopeInsights(prev, next))
  for (const banned of ['clientId', 'client_id', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!blob.includes(banned), `delta must not contain ${banned}`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// exported helpers, directly
// ──────────────────────────────────────────────────────────────────────────

test('signedDelta uses a REAL minus sign and unit-aware magnitude', () => {
  const { revenue, cpl } = require('../lib/ask').METRICS
  assert.strictEqual(signedDelta(1240, revenue), '+$1,240')
  assert.strictEqual(signedDelta(-1240, revenue), '−$1,240')   // U+2212, not '-'
  assert.ok(signedDelta(-1240, revenue).charCodeAt(0) === 0x2212)
  assert.strictEqual(signedDelta(-2.55, cpl), '−$2.55')        // money keeps up to dp:2 places
  assert.strictEqual(signedDelta(-2.5, cpl), '−$2.5')          // …and trims the trailing zero (minFractionDigits:0)
  assert.strictEqual(signedDelta(5), '+5')                     // no descriptor → bare number
})

test('pctChange is sign-correct and null-safe at zero', () => {
  assert.ok(Math.abs(pctChange(5000, 6240) - 24.8) < 1e-9)
  assert.ok(Math.abs(pctChange(6000, 5000) - -16.6666666) < 1e-4)
  assert.strictEqual(pctChange(0, 100), null)
  assert.strictEqual(pctChange(NaN, 100), null)
})

test('classifyMove pairs direction with the polarity oracle', () => {
  assert.deepStrictEqual(classifyMove('revenue', 10), { direction: 'up', improved: true })
  assert.deepStrictEqual(classifyMove('revenue', -10), { direction: 'down', improved: false })
  assert.deepStrictEqual(classifyMove('cpl', 10), { direction: 'up', improved: false })
  assert.deepStrictEqual(classifyMove('cpl', -10), { direction: 'down', improved: true })
  assert.deepStrictEqual(classifyMove('zzz', 10), { direction: 'up', improved: null })
})

test('normalizeSnapshot dedupes a repeated metric (first wins) and skips junk', () => {
  const m = normalizeSnapshot([{ metric: 'revenue', current: 1 }, { metric: 'revenue', current: 2 }, null, { current: 9 }])
  assert.strictEqual(m.size, 1)
  assert.strictEqual(m.get('revenue').current, 1)
})

test('buildDeltaHeadline returns null when there is nothing to say', () => {
  assert.strictEqual(buildDeltaHeadline({ changes: [], appeared: [], resolved: [], headlineLimit: 2 }), null)
})
