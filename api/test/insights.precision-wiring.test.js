// ============================================================
// test/insights.precision-wiring.test.js — the SEAM between the pure precision
// brain (lib/precision.js) and the feed it ranks (lib/insights.js).
//
// lib/precision.js is unit-tested in isolation (test/precision.test.js). This file
// pins the WIRING: how a learned per-signature precision entry is attached to a feed
// row on READ, and how the ranker applies (or deliberately withholds) its weight.
// These are the keystone-safety properties that let the loop ship dark — learning in
// the background without ever being able to make today's ordering worse:
//
//   1. NO-OP BELOW EVIDENCE — a feed with no learned history ranks byte-for-byte as
//      it did before the loop existed (neutral 0.5 → 'medium' → weight EXACTLY 1.0).
//   2. LIFECYCLE PATH UNTOUCHED — the 1-arg normalize (setInsightStatus's return)
//      attaches no precision at all, so write responses are unchanged.
//   3. SEVERITY IS LAW — the weight only ever reorders WITHIN a (severity, status)
//      tier; a critical can never sink below a warning, an open below an acked.
//   4. KEYSTONE EXEMPTION — data_health (keeps the tool self-sustaining) and any
//      critical are ranked at neutral weight no matter what the client's behavior
//      taught, so a repeatedly-ignored alarm can never be buried.
//   5. DEFENSIVE — a junk learned weight (0 / NaN / negative) degrades to neutral 1,
//      never collapses a row's score to zero.
//
// PURE: no DB rows are written; every assertion runs against the exported pure
// pieces (normalizeInsightRow / attachPrecision / feedSort). We still point the DB
// shim at an isolated temp path before requiring ../lib/insights (which requires
// ../db) so the require is side-effect-free off the real database.
// ============================================================
'use strict'

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const { test } = require('node:test')
const assert   = require('node:assert/strict')

// No key → deterministic template narration, no network (matches insights.test.js).
delete process.env.ANTHROPIC_API_KEY
// Force the SQLite backend at an isolated path BEFORE requiring ../db (transitively
// pulled in by ../lib/insights). These tests never touch it, but the require must not
// reach for a real Postgres.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `insights_precwire_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const { normalizeInsightRow, attachPrecision, feedSort } = require('../lib/insights')
const { PRIOR_MEAN, bandOf, weightFor, signatureKey } = require('../lib/precision')

// The precision block a signature with NO decided history must read as — computed
// from the brain's own helpers so this expectation can never drift from the math.
const NEUTRAL = {
  confidence: PRIOR_MEAN, band: bandOf(PRIOR_MEAN), weight: weightFor(PRIOR_MEAN),
  n: 0, engaged: 0, ignored: 0,
}

// A bare insight row as it comes off the DB (enough shape for normalize + rank).
function rawRow(over = {}) {
  return {
    kind: 'forecast', metric: 'revenue', severity: 'warning', status: 'open',
    score: 50, direction: 'down', evidence: {}, period_start: '2026-05-01', ...over,
  }
}

// A ready-to-rank feed row the ranker sees. weight === undefined → NO precision block
// at all (the 1-arg lifecycle shape) so rankWeight must read it as neutral 1.
function feedRow(severity, status, score, kind, weight) {
  const r = { severity, status, score, kind }
  if (weight !== undefined) r.precision = { weight }
  return r
}
const sortFeed = rows => [...rows].sort(feedSort)

// ============================================================
// 1. ATTACHMENT — normalizeInsightRow / attachPrecision
// ============================================================

test('attach: the 1-arg normalize (lifecycle-write path) attaches NO precision field', () => {
  const norm = normalizeInsightRow(rawRow())
  assert.equal('precision' in norm, false)
  // and the rest of the read pipeline still fires (regression guard on the edit).
  assert.equal(typeof norm.recommended_action, 'object')
  assert.equal(norm.grounded, false)
})

test('attach: an EMPTY precision map yields the neutral prior (0.5 / medium / weight 1)', () => {
  const norm = normalizeInsightRow(rawRow(), {})
  assert.deepEqual(norm.precision, NEUTRAL)
  // neutral is a genuine no-op: weight is EXACTLY 1.0, not merely ~1.
  assert.equal(norm.precision.weight, 1)
})

test('attach: a signature ABSENT from a non-empty map still reads neutral', () => {
  // map carries a different signature → forecast::revenue is not in it.
  const map = { 'anomaly::leads': { confidence: 0.9, band: 'high', weight: 1.32, n: 5, engaged: 5, ignored: 0 } }
  const norm = normalizeInsightRow(rawRow(), map)
  assert.deepEqual(norm.precision, NEUTRAL)
})

test('attach: a LEARNED signature attaches exactly its six projected fields (no leakage)', () => {
  const entry = {
    confidence: 0.82, band: 'high', weight: 1.3, n: 7, engaged: 6, ignored: 1,
    // these must NOT bleed onto the row's precision block:
    kind: 'forecast', metric: 'revenue', updated_at: 'x', extra: 'nope',
  }
  const norm = normalizeInsightRow(rawRow(), { [signatureKey(rawRow())]: entry })
  assert.deepEqual(norm.precision, {
    confidence: 0.82, band: 'high', weight: 1.3, n: 7, engaged: 6, ignored: 1,
  })
})

test('attach: data_health keys on `kind::*` (metric-less signature) and matches', () => {
  const entry = { confidence: 0.30, band: 'low', weight: 0.76, n: 4, engaged: 1, ignored: 3 }
  const norm = normalizeInsightRow(
    rawRow({ kind: 'data_health', metric: null, direction: null }),
    { 'data_health::*': entry })
  assert.equal(signatureKey(norm), 'data_health::*')
  // attachment is HONEST — the block reports the learned 0.76 for the UI chip…
  assert.equal(norm.precision.weight, 0.76)
  // …even though the RANKER will exempt data_health from that weight (see §2).
})

test('attach: attachPrecision is a pure tag — undefined map returns the row untouched', () => {
  const row = rawRow()
  assert.equal(attachPrecision(row, undefined), row)   // same reference, no precision
  assert.equal('precision' in row, false)
})

// ============================================================
// 2. RANKING — feedSort + rankWeight (severity law + keystone exemption)
// ============================================================

test('rank: SEVERITY dominates — a max-weight warning never outranks a min-weight critical', () => {
  const warn = feedRow('warning',  'open', 100, 'trend',   1.4)  // 140 raw×weight
  const crit = feedRow('critical', 'open',  10, 'anomaly', 0.6)  // tiny — but critical
  assert.deepEqual(sortFeed([warn, crit]).map(r => r.severity), ['critical', 'warning'])
})

test('rank: STATUS is secondary — open precedes acknowledged regardless of weight', () => {
  const ack  = feedRow('warning', 'acknowledged', 100, 'trend', 1.4)  // 140
  const open = feedRow('warning', 'open',          10, 'trend', 0.6)  // 6
  assert.deepEqual(sortFeed([ack, open]).map(r => r.status), ['open', 'acknowledged'])
})

test('rank: within a tier the WEIGHT reorders — 80×1.3 outranks 100×0.6', () => {
  const lifted = feedRow('warning', 'open',  80, 'trend',  1.3)  // 104
  const sunk   = feedRow('warning', 'open', 100, 'pacing', 0.6)  // 60
  assert.deepEqual(sortFeed([sunk, lifted]).map(r => r.kind), ['trend', 'pacing'])
})

test('rank: with NO learned weight the order is identical to raw score', () => {
  // neutral precision attached (empty map) → weight 1 everywhere → pure score order.
  const hi = normalizeInsightRow(rawRow({ kind: 'trend',  score: 90 }), {})
  const lo = normalizeInsightRow(rawRow({ kind: 'pacing', score: 50 }), {})
  assert.deepEqual(sortFeed([lo, hi]).map(r => r.score), [90, 50])
})

test('rank: rows with NO precision block at all rank by raw score (rankWeight → 1)', () => {
  const hi = feedRow('warning', 'open', 90, 'trend')   // no precision field
  const lo = feedRow('warning', 'open', 50, 'pacing')
  assert.deepEqual(sortFeed([lo, hi]).map(r => r.score), [90, 50])
})

test('rank: CRITICAL is exempt — a punishing learned weight cannot reorder criticals', () => {
  // Without the exemption: cA 100×0.6=60 < cB 80×1.4=112 → cB would lead.
  // With it: both ranked at weight 1 → raw score wins → cA(100) leads.
  const cA = feedRow('critical', 'open', 100, 'anomaly', 0.6)
  const cB = feedRow('critical', 'open',  80, 'trend',   1.4)
  assert.deepEqual(sortFeed([cB, cA]).map(r => r.score), [100, 80])
})

test('rank: DATA_HEALTH is exempt — an ignored feed-gap alarm is never buried', () => {
  // data_health learned a low 0.6 weight (client keeps ignoring it). Without the
  // exemption: 70×0.6=42 < sibling 60 → the keystone sinks. With it: weight 1 →
  // 70 > 60 → data_health stays on top, so the operator still sees the dark feed.
  const gap = feedRow('warning', 'open', 70, 'data_health', 0.6)
  const sib = feedRow('warning', 'open', 60, 'trend',       1.0)
  assert.deepEqual(sortFeed([sib, gap]).map(r => r.kind), ['data_health', 'trend'])
})

test('rank: DEFENSIVE — a junk learned weight (0 / NaN / negative) degrades to neutral 1', () => {
  for (const junk of [0, NaN, -2]) {
    const bad  = feedRow('warning', 'open', 90, 'trend',  junk)  // junk → treated as 1 → 90
    const good = feedRow('warning', 'open', 50, 'pacing', 1.0)   // 50
    // If junk were applied literally (×0, ×NaN, ×-2) bad would sink below good; the
    // defensive floor keeps it ranked at its raw 90.
    assert.deepEqual(sortFeed([good, bad]).map(r => r.score), [90, 50],
      `junk weight ${junk} should rank as neutral 1`)
  }
})

test('rank: feedSort is a deterministic TOTAL order across mixed severities + statuses', () => {
  const feed = [
    feedRow('info',     'open',         99, 'pacing',      1.4),
    feedRow('critical', 'acknowledged', 10, 'anomaly',     0.6),
    feedRow('warning',  'open',         40, 'trend',       1.0),
    feedRow('critical', 'open',          5, 'data_health', 0.6),
    feedRow('warning',  'acknowledged', 80, 'forecast',    1.4),
  ]
  // critical-open → critical-acked → warning-open → warning-acked → info-open,
  // severity then status dominating before any weight×score arithmetic.
  assert.deepEqual(sortFeed(feed).map(r => `${r.severity}/${r.status}`), [
    'critical/open', 'critical/acknowledged',
    'warning/open',  'warning/acknowledged',
    'info/open',
  ])
})
