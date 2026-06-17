// ============================================================
// test/correlate.test.js — root-cause linking (lib/correlate.js)
//
// linkCoverageToImpact() connects a downstream adverse metric finding (an anomaly or
// trend that fell) to an upstream dark channel (a coverage_gap) WHEN that channel
// materially fed the metric. These tests pin the three gates that keep the link
// honest — (1) the channel must already be flagged dark, (2) it must contribute at
// least minShare of the metric, (3) the metric must have fallen — plus dominant-cause
// selection, the full blast-radius list, deterministic worst-first ordering, the exact
// link/impacts shapes, the opts override, the hard no-op on degenerate input, and the
// PURITY contract (inputs are never mutated — the caller stamps the result).
// Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { linkCoverageToImpact, SYMPTOM_KINDS } = require('..')

// A dark-channel finding (what detectCoverageGaps emits, trimmed to what correlate reads).
function cov(channel, { label, category = 'paid', days_dark } = {}) {
  return {
    kind: 'coverage_gap', metric: null, scope: 'client', severity: 'warning',
    direction: 'down', score: 10, period_start: '2026-05-20', fingerprint_key: channel,
    evidence: { channel, channel_label: label || channel, category, days_dark },
  }
}

// A metric symptom (anomaly/trend) the engine emits on the aggregate series.
function sym(metric, { kind = 'anomaly', direction = 'down' } = {}) {
  return {
    kind, metric, scope: 'client', severity: 'warning', direction,
    score: 2, period_start: '2026-05-25', evidence: { value: 1, baseline: 2 },
  }
}

const NONE = { links: [], impacts: {} }

// ── exported symptom vocabulary ───────────────────────────────────────────────
test('SYMPTOM_KINDS: observed deliveries only (anomaly, trend) — not projections', () => {
  assert.ok(SYMPTOM_KINDS.has('anomaly'))
  assert.ok(SYMPTOM_KINDS.has('trend'))
  for (const k of ['forecast', 'pacing', 'data_health', 'coverage_gap', 'benchmark']) {
    assert.ok(!SYMPTOM_KINDS.has(k), `${k} is not a symptom a dark channel explains`)
  }
})

// ── no-op guarantees: degenerate input never fabricates a link ──────────────────
test('empty / garbage / shareless input → { links:[], impacts:{} } (hard no-op)', () => {
  assert.deepEqual(linkCoverageToImpact([], { leads: { meta: 0.9 } }), NONE)
  assert.deepEqual(linkCoverageToImpact(null, { leads: { meta: 0.9 } }), NONE)
  assert.deepEqual(linkCoverageToImpact(undefined, {}), NONE)
  assert.deepEqual(linkCoverageToImpact('nonsense', {}), NONE)
  // findings present but NO coverage_gap → nothing is "dark" → no cause to assert
  assert.deepEqual(linkCoverageToImpact([sym('leads')], { leads: { meta: 0.9 } }), NONE)
  // dark channel present but NO shares at all → cannot ground a link
  assert.deepEqual(linkCoverageToImpact([cov('meta', { days_dark: 10 }), sym('leads')], null), NONE)
  assert.deepEqual(linkCoverageToImpact([cov('meta', { days_dark: 10 }), sym('leads')], {}), NONE)
  // only a coverage_gap, no symptom to attach it to
  assert.deepEqual(linkCoverageToImpact([cov('meta', { days_dark: 10 })], { leads: { meta: 0.9 } }), NONE)
})

// ── the basic link + exact shapes ───────────────────────────────────────────────
test('dark channel that materially feeds a fallen metric → grounded link', () => {
  const findings = [
    cov('meta', { label: 'Meta Ads', category: 'paid', days_dark: 12 }),
    sym('leads', { kind: 'anomaly', direction: 'down' }),
  ]
  const shares = { leads: { meta: 0.42, google_ads: 0.40, ghl: 0.18 } }
  const { links, impacts } = linkCoverageToImpact(findings, shares)

  assert.equal(links.length, 1)
  assert.deepEqual(links[0], {
    index: 1,                 // points at the SYMPTOM finding (the leads anomaly)
    channel: 'meta',
    channel_label: 'Meta Ads',
    category: 'paid',
    share: 0.42,              // 0..1, 2dp
    share_pct: 42,            // integer percent for "~42% of leads"
    days_dark: 12,
  })
  // blast radius: ONLY the dark channel appears — google_ads/ghl feed leads too but
  // are healthy, so they are not implicated.
  assert.deepEqual(impacts, { meta: [{ metric: 'leads', share_pct: 42 }] })
})

// ── gate 2: materiality floor ─────────────────────────────────────────────────
test('share below minShare → no link (a trivial contributor is not the cause)', () => {
  const findings = [cov('meta', { days_dark: 10 }), sym('leads')]
  assert.deepEqual(linkCoverageToImpact(findings, { leads: { meta: 0.10 } }), NONE)
  // exactly at the default floor (0.15) it links
  const { links } = linkCoverageToImpact(findings, { leads: { meta: 0.15 } })
  assert.equal(links.length, 1)
  assert.equal(links[0].share_pct, 15)
})

test('opts.minShare can tighten or loosen the materiality floor', () => {
  const findings = [cov('meta', { days_dark: 10 }), sym('leads')]
  // a 10% contributor links only when we lower the floor
  assert.deepEqual(linkCoverageToImpact(findings, { leads: { meta: 0.10 } }, { minShare: 0.05 }).links.length, 1)
  // and a 30% contributor is screened out when we raise it
  assert.deepEqual(linkCoverageToImpact(findings, { leads: { meta: 0.30 } }, { minShare: 0.50 }), NONE)
})

// ── gate 3: sign consistency ──────────────────────────────────────────────────
test('a metric that ROSE is never explained by a channel going dark', () => {
  const findings = [cov('meta', { days_dark: 10 }), sym('leads', { direction: 'up' })]
  assert.deepEqual(linkCoverageToImpact(findings, { leads: { meta: 0.9 } }), NONE)
})

// ── gate 1 / kind screen: only observed-delivery symptoms, never projections ────
test('forecast / pacing / data_health are not linked even when down and material', () => {
  for (const kind of ['forecast', 'pacing', 'data_health']) {
    const findings = [cov('meta', { days_dark: 10 }), sym('revenue', { kind, direction: 'down' })]
    assert.deepEqual(linkCoverageToImpact(findings, { revenue: { meta: 0.9 } }), NONE,
      `${kind} is a projection, not an observed delivery a dark channel explains`)
  }
})

test('a coverage_gap is never treated as its own symptom', () => {
  // two dark channels and shares that would "feed" each other's metric — but neither
  // is an anomaly/trend, so nothing links.
  const findings = [cov('meta', { days_dark: 10 }), cov('google_ads', { days_dark: 20 })]
  assert.deepEqual(linkCoverageToImpact(findings, { leads: { meta: 0.9, google_ads: 0.9 } }), NONE)
})

// ── dominant-cause selection + full blast radius ────────────────────────────────
test('when two dark channels feed one fallen metric, the larger share is named the cause', () => {
  const findings = [
    cov('meta',       { days_dark: 5,  label: 'Meta Ads' }),
    cov('google_ads', { days_dark: 20, label: 'Google Ads' }),
    sym('leads', { direction: 'down' }),
  ]
  const shares = { leads: { meta: 0.30, google_ads: 0.45 } }
  const { links, impacts } = linkCoverageToImpact(findings, shares)

  // caused_by names the DOMINANT lost contributor (google_ads at 45% > meta at 30%)
  assert.equal(links.length, 1)
  assert.equal(links[0].channel, 'google_ads')
  assert.equal(links[0].share_pct, 45)
  assert.equal(links[0].index, 2)
  // ...but BOTH dark channels list leads in their own blast radius
  assert.deepEqual(impacts, {
    meta:        [{ metric: 'leads', share_pct: 30 }],
    google_ads:  [{ metric: 'leads', share_pct: 45 }],
  })
})

test('one dark channel dragging several metrics → blast radius is worst-share-first', () => {
  const findings = [
    cov('meta', { days_dark: 10 }),
    sym('leads',   { kind: 'anomaly', direction: 'down' }),
    sym('revenue', { kind: 'trend',   direction: 'down' }),
    sym('jobs',    { kind: 'anomaly', direction: 'down' }),
  ]
  const shares = { leads: { meta: 0.20 }, revenue: { meta: 0.50 }, jobs: { meta: 0.20 } }
  const { links, impacts } = linkCoverageToImpact(findings, shares)

  // three symptom links, each naming meta with that metric's share
  assert.deepEqual(links.map(l => [l.index, l.channel, l.share_pct]),
    [[1, 'meta', 20], [2, 'meta', 50], [3, 'meta', 20]])
  // blast radius sorted by share_pct desc, then metric name asc (jobs<leads on the 20-tie)
  assert.deepEqual(impacts.meta, [
    { metric: 'revenue', share_pct: 50 },
    { metric: 'jobs',    share_pct: 20 },
    { metric: 'leads',   share_pct: 20 },
  ])
})

test('a dark channel that drags nothing has no impacts entry (no over-claiming)', () => {
  // gbp is dark but does not feed the only fallen metric (leads)
  const findings = [cov('gbp', { days_dark: 30, category: 'local' }), sym('leads', { direction: 'down' })]
  const out = linkCoverageToImpact(findings, { leads: { meta: 0.90 } })
  assert.deepEqual(out, NONE)
})

// ── determinism: output order independent of input order ────────────────────────
test('scrambled findings → identical links/impacts (index follows the array)', () => {
  const findings = [
    sym('revenue', { kind: 'trend', direction: 'down' }),   // index 0
    cov('meta', { days_dark: 12 }),                          // index 1
    sym('leads', { kind: 'anomaly', direction: 'down' }),    // index 2
  ]
  const shares = { leads: { meta: 0.40 }, revenue: { meta: 0.25 } }
  const { links, impacts } = linkCoverageToImpact(findings, shares)
  assert.deepEqual(links.map(l => [l.index, l.share_pct]), [[0, 25], [2, 40]])
  assert.deepEqual(impacts.meta, [
    { metric: 'leads',   share_pct: 40 },
    { metric: 'revenue', share_pct: 25 },
  ])
})

// ── passthrough / rounding details ──────────────────────────────────────────────
test('days_dark is passed through as null when the coverage_gap lacks it', () => {
  const findings = [cov('meta', {}), sym('leads', { direction: 'down' })]   // no days_dark
  const { links } = linkCoverageToImpact(findings, { leads: { meta: 0.5 } })
  assert.equal(links.length, 1)
  assert.equal(links[0].days_dark, null)
})

test('share rounds to 2dp and share_pct to an integer', () => {
  const findings = [cov('meta', { days_dark: 9 }), sym('leads', { direction: 'down' })]
  const { links } = linkCoverageToImpact(findings, { leads: { meta: 0.156 } })
  assert.equal(links[0].share, 0.16)
  assert.equal(links[0].share_pct, 16)
})

// ── PURITY: the inputs are never mutated (the caller stamps the result) ──────────
test('inputs are not mutated — no caused_by / impacts is written onto findings', () => {
  const findings = [
    cov('meta', { label: 'Meta Ads', days_dark: 12 }),
    sym('leads', { direction: 'down' }),
  ]
  const shares = { leads: { meta: 0.42 } }
  const before = JSON.stringify(findings)
  const sharesBefore = JSON.stringify(shares)
  const { links, impacts } = linkCoverageToImpact(findings, shares)

  // a real link was produced...
  assert.equal(links.length, 1)
  assert.ok(impacts.meta)
  // ...yet neither the findings nor the shares object changed at all
  assert.equal(JSON.stringify(findings), before)
  assert.equal(JSON.stringify(shares), sharesBefore)
  assert.equal('caused_by' in findings[1].evidence, false)
  assert.equal('impacts' in findings[0].evidence, false)
})
