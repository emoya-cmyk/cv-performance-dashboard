'use strict'

// Tests for lib/intelDigest.js — the client-safe "posture" summary folded into
// the AI evidence pack. These pin the two guarantees the recap narrator depends
// on: (1) every emitted value is a small finite integer count or a label string,
// so it is grounded the instant it lands in the pack; and (2) the escalation
// roll-up copies ONLY the metric, never the candid efficacy statistic that drives
// it — the digest is leak-safe by construction, not by careful prompting. Same
// node:test house style as escalation.test.js / outcomes.test.js.

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  summarizeIntelligence, defaultLabel, DEFAULT_MAX_AREAS,
} = require('../lib/intelDigest')

// ── builders ──────────────────────────────────────────────────────────────────
// An adverse finding the self-improving loop has escalated. The escalation block
// carries the CANDID stats (pct/successes/n) exactly as attachEscalations hoists
// them — the digest must look at the metric and ignore the rest.
const escalated = (metric, over = {}) => ({
  kind: 'trend', metric, severity: 'critical', direction: 'down',
  escalation: { reason: 'play_ineffective', pct: 18, successes: 1, n: 7, band: 'low' },
  ...over,
})
const plain = (metric, severity = 'warning', over = {}) =>
  ({ kind: 'anomaly', metric, severity, direction: 'down', ...over })
const recovery = (metric, over = {}) => ({ kind: 'anomaly', metric, recovered_at: '2026-05-20T00:00:00Z', ...over })
const pacingOf = (...statuses) => ({ metrics: statuses.map((status, i) => ({ metric: `m${i}`, status })) })

// ── shape + empties ─────────────────────────────────────────────────────────
test('empty inputs → an all-zero, well-formed digest (never throws)', () => {
  const d = summarizeIntelligence([], [], { metrics: [] })
  assert.deepEqual(d, {
    active: 0,
    by_severity: { critical: 0, warning: 0, info: 0 },
    adjusting: { count: 0, areas: [] },
    improving: { count: 0, areas: [] },
    pacing: { on_track: 0, at_risk: 0 },
  })
})

test('non-array / null inputs degrade to safe defaults', () => {
  const d = summarizeIntelligence(null, undefined, null)
  assert.equal(d.active, 0)
  assert.deepEqual(d.adjusting, { count: 0, areas: [] })
  assert.deepEqual(d.improving, { count: 0, areas: [] })
  assert.deepEqual(d.pacing, { on_track: 0, at_risk: 0 })
})

// ── severity census ──────────────────────────────────────────────────────────
test('by_severity tallies the active feed; active is the raw length', () => {
  const d = summarizeIntelligence(
    [plain('leads', 'critical'), plain('cpl', 'warning'), plain('roas', 'info'), plain('jobs', 'warning')],
    [], { metrics: [] })
  assert.equal(d.active, 4)
  assert.deepEqual(d.by_severity, { critical: 1, warning: 2, info: 1 })
})

// ── adjusting (the self-improving loop) ───────────────────────────────────────
test('adjusting picks up only play_ineffective escalations and names their metric', () => {
  const d = summarizeIntelligence(
    [escalated('leads'), plain('cpl', 'warning')],   // only the first is escalated
    [], { metrics: [] })
  assert.equal(d.adjusting.count, 1)
  assert.deepEqual(d.adjusting.areas, [{ metric: 'leads', label: 'Leads' }])
})

test('adjusting ignores escalations with a different reason', () => {
  const d = summarizeIntelligence(
    [escalated('leads', { escalation: { reason: 'something_else', pct: 5, successes: 0, n: 9 } })],
    [], { metrics: [] })
  assert.deepEqual(d.adjusting, { count: 0, areas: [] })
})

test('adjusting de-dupes by metric: two escalated leads findings = one area, count 1', () => {
  const d = summarizeIntelligence([escalated('leads'), escalated('leads')], [], { metrics: [] })
  assert.equal(d.adjusting.count, 1)
  assert.equal(d.adjusting.areas.length, 1)
})

test('adjusting count is the honest distinct total; areas cap at maxAreas (default 3)', () => {
  const d = summarizeIntelligence(
    ['leads', 'cpl', 'roas', 'jobs', 'spend'].map(m => escalated(m)),
    [], { metrics: [] })
  assert.equal(d.adjusting.count, 5)               // honest total
  assert.equal(d.adjusting.areas.length, DEFAULT_MAX_AREAS)   // but only 3 named
})

test('a null-metric escalation (data-health) buckets as "Data freshness", metric null', () => {
  const d = summarizeIntelligence(
    [escalated(null, { kind: 'data_health' })], [], { metrics: [] })
  assert.deepEqual(d.adjusting.areas, [{ metric: null, label: 'Data freshness' }])
})

// ── improving (wins) ─────────────────────────────────────────────────────────
test('improving rolls up the recovery stream, de-duped by metric', () => {
  const d = summarizeIntelligence(
    [], [recovery('revenue'), recovery('revenue'), recovery('leads')], { metrics: [] })
  assert.equal(d.improving.count, 2)
  assert.deepEqual(d.improving.areas.map(a => a.metric), ['revenue', 'leads'])
})

// ── pacing posture ───────────────────────────────────────────────────────────
test('pacing collapses bands: ahead/on_track → on_track, behind/at_risk → at_risk', () => {
  const d = summarizeIntelligence([], [],
    pacingOf('ahead', 'on_track', 'behind', 'at_risk'))
  assert.deepEqual(d.pacing, { on_track: 2, at_risk: 2 })
})

test('pacing ignores "early" and "none" (not yet judgeable / no goal set)', () => {
  const d = summarizeIntelligence([], [], pacingOf('early', 'none', 'on_track'))
  assert.deepEqual(d.pacing, { on_track: 1, at_risk: 0 })
})

// ── injectable labeler + maxAreas ────────────────────────────────────────────
test('opts.label overrides the built-in labeler (wiring injects METRIC_META)', () => {
  const d = summarizeIntelligence([escalated('leads')], [], { metrics: [] },
    { label: (m) => `<<${m}>>` })
  assert.equal(d.adjusting.areas[0].label, '<<leads>>')
})

test('opts.maxAreas tightens how many areas are named', () => {
  const d = summarizeIntelligence(
    ['leads', 'cpl', 'roas'].map(m => escalated(m)), [], { metrics: [] }, { maxAreas: 1 })
  assert.equal(d.adjusting.count, 3)
  assert.equal(d.adjusting.areas.length, 1)
})

test('defaultLabel humanises known keys and a null metric', () => {
  assert.equal(defaultLabel('cpl'), 'Cost per lead')
  assert.equal(defaultLabel('revenue'), 'Revenue')
  assert.equal(defaultLabel(null), 'Data freshness')
  assert.equal(defaultLabel('unknown_key'), 'unknown_key')   // unknown passes through
})

// ── THE leak-safety contract: candid efficacy stats can never reach the digest ─
test('CLIENT-SAFE: the escalation pct/successes/n never appear anywhere in the digest', () => {
  // The escalated finding carries pct:18, successes:1, n:7 and band 'low'.
  const d = summarizeIntelligence([escalated('leads')], [], { metrics: [] })
  const json = JSON.stringify(d)
  // none of the candid keys ride along
  assert.doesNotMatch(json, /pct|successes|\bband\b|escalat/i)
  // and none of the candid VALUES leak as numbers (18% / 1-of-7)
  const nums = new Set(JSON.stringify(d).match(/\d+/g).map(Number))
  assert.ok(!nums.has(18), 'efficacy pct 18 must not appear')
  assert.ok(!nums.has(7),  'attempt count 7 must not appear')
  // the only numbers present are the small grounded counts
  assert.deepEqual([...nums].sort((a, b) => a - b), [0, 1])
})

test('every numeric leaf of the digest is a finite integer (grounded-friendly)', () => {
  const d = summarizeIntelligence(
    [escalated('leads'), plain('cpl', 'warning')],
    [recovery('revenue')],
    pacingOf('ahead', 'at_risk'))
  const leaves = []
  ;(function walk(v) {
    if (typeof v === 'number') leaves.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  })(d)
  assert.ok(leaves.length > 0)
  for (const n of leaves) assert.ok(Number.isInteger(n) && Number.isFinite(n), `${n} is a finite int`)
})
