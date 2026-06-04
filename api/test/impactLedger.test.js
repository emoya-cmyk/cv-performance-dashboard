// ============================================================
// test/impactLedger.test.js — "what value has the intelligence system actually delivered?"
//
// lib/impactLedger.js ledgers the wins the OTHER intelligence modules already proved
// (recoveries, vindicated budget shifts, rescued goals, early-warnings that hit) into
// one attributable tally. Its one job is to be honest: every win is risk-adjusted by
// the confidence its upstream track record earned (weighted_value = value × confidence),
// units never sum across each other (a dollar is not a count), and a thin/garbage
// record yields a quiet empty ledger rather than an invented boast. These tests
// hand-trace the weighting, pin the per-unit/per-category/per-client rollups and their
// deterministic ordering, prove the headline picks the most-weighted unit (dollars
// breaking ties), pin the "proven" gate, and prove the client narration stays silent
// unless proven and never leaks a number. Pure: same input always yields the same
// ledger; inputs are never mutated. No DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  recordImpact, buildImpactLedger, summarizeImpactLedger, narrateImpactLedger,
  CATEGORY, UNIT, UNIT_PRIORITY, DEFAULTS,
} = require('../lib/impactLedger')

// a canonical impact event (count-unit recovery unless overridden)
const ev = (over = {}) => ({
  category: CATEGORY.RECOVERY,
  client_id: 'c1', client_name: 'Acme',
  unit: UNIT.COUNT, value: 1, confidence: 0.9,
  ...over,
})

// ── recordImpact: normalize ONE event ─────────────────────────────────────────

test('recordImpact normalizes a valid event and risk-adjusts it', () => {
  const r = recordImpact(ev({ value: 1, confidence: 0.9 }))
  assert.equal(r.category, CATEGORY.RECOVERY)
  assert.equal(r.client_id, 'c1')
  assert.equal(r.client_name, 'Acme')
  assert.equal(r.unit, UNIT.COUNT)
  assert.equal(r.value, 1)
  assert.equal(r.confidence, 0.9)
  assert.equal(r.weighted_value, 0.9)   // 1 × 0.9
})

test('recordImpact: dollars keep two places, counts are integers', () => {
  const d = recordImpact(ev({ unit: UNIT.DOLLARS, metric: 'revenue', value: 4523.5, confidence: 0.8 }))
  assert.equal(d.value, 4523.5)
  assert.equal(d.weighted_value, 3618.8)            // 4523.5 × 0.8
  const c = recordImpact(ev({ unit: UNIT.COUNT, value: 7.6 }))
  assert.equal(c.value, 8)                          // count rounds to a whole win
})

test('recordImpact drops non-wins and unknown shapes (never throws)', () => {
  assert.equal(recordImpact(null), null)
  assert.equal(recordImpact('nope'), null)
  assert.equal(recordImpact(ev({ category: 'made_up' })), null)
  assert.equal(recordImpact(ev({ unit: 'bananas' })), null)   // unknown unit is a guess we won't make
  assert.equal(recordImpact(ev({ value: 0 })), null)          // no positive magnitude ⇒ not a win
  assert.equal(recordImpact(ev({ value: -3 })), null)
  assert.equal(recordImpact(ev({ value: 'NaN' })), null)
})

test('recordImpact: missing unit defaults to count; missing confidence is neutral, never invented high', () => {
  const r = recordImpact({ category: CATEGORY.EARLY_WARNING, value: 2 })
  assert.equal(r.unit, UNIT.COUNT)
  assert.equal(r.confidence, DEFAULTS.defaultConfidence)   // 0.5, not 1
  assert.equal(r.weighted_value, 1)                        // 2 × 0.5
})

test('recordImpact clamps confidence into [0,1]', () => {
  assert.equal(recordImpact(ev({ confidence: 1.7 })).confidence, 1)
  assert.equal(recordImpact(ev({ confidence: -0.4 })).confidence, 0)
})

test('recordImpact honors a minConfidence floor', () => {
  assert.equal(recordImpact(ev({ confidence: 0.3 }), { minConfidence: 0.5 }), null)
  assert.ok(recordImpact(ev({ confidence: 0.6 }), { minConfidence: 0.5 }))
})

test('recordImpact never mutates its input', () => {
  const raw = ev({ value: 3, confidence: 0.7 })
  const snapshot = JSON.stringify(raw)
  recordImpact(raw)
  assert.equal(JSON.stringify(raw), snapshot)
})

// ── buildImpactLedger: the empty / defensive paths ────────────────────────────

test('buildImpactLedger: empty or garbage input ⇒ a quiet empty ledger (no throw, no boast)', () => {
  for (const input of [undefined, null, [], 'x', [null, 'x', {}, { category: 'nope' }]]) {
    const L = buildImpactLedger(input)
    assert.equal(L.count, 0)
    assert.equal(L.client_count, 0)
    assert.equal(L.headline, null)
    assert.equal(L.confidence, null)
    assert.equal(L.proven, false)
    assert.deepEqual(L.entries, [])
  }
})

// ── buildImpactLedger: aggregation math ───────────────────────────────────────

test('buildImpactLedger sums within a unit and reports the effective confidence of the headline', () => {
  const L = buildImpactLedger([
    ev({ value: 1, confidence: 1.0 }),
    ev({ value: 1, confidence: 0.8 }),
    ev({ value: 2, confidence: 0.5 }),
  ])
  assert.equal(L.count, 3)
  assert.equal(L.by_unit[UNIT.COUNT].value, 4)            // 1+1+2
  assert.equal(L.by_unit[UNIT.COUNT].weighted, 2.8)       // 1.0 + 0.8 + 1.0
  assert.equal(L.headline.unit, UNIT.COUNT)
  assert.equal(L.headline.value, 4)
  assert.equal(L.headline.weighted, 2.8)
  assert.equal(L.confidence, 0.7)                         // 2.8 / 4 — how risk-adjusted the headline is
})

test('buildImpactLedger keeps units strictly separate — never sums a dollar with a count', () => {
  const L = buildImpactLedger([
    ev({ unit: UNIT.DOLLARS, metric: 'revenue', value: 5000, confidence: 0.8, category: CATEGORY.PACING_SAVE }),
    ev({ unit: UNIT.COUNT, value: 3, confidence: 0.9 }),
    ev({ unit: UNIT.LEADS, metric: 'leads', value: 40, confidence: 0.6, category: CATEGORY.PACING_SAVE }),
  ])
  assert.deepEqual(Object.keys(L.by_unit).sort(), [UNIT.COUNT, UNIT.DOLLARS, UNIT.LEADS].sort())
  assert.equal(L.by_unit[UNIT.DOLLARS].weighted, 4000)    // 5000 × 0.8
  assert.equal(L.by_unit[UNIT.LEADS].weighted, 24)        // 40 × 0.6
  assert.equal(L.by_unit[UNIT.COUNT].weighted, 2.7)       // 3 × 0.9
  // dollars carry the most weighted value ⇒ they are the headline
  assert.equal(L.headline.unit, UNIT.DOLLARS)
  assert.equal(L.headline.weighted, 4000)
})

test('buildImpactLedger headline breaks a weighted tie by unit priority (dollars first)', () => {
  // contrive equal weighted totals across dollars and count: 10×1.0 == 10 and 20×0.5 == 10
  const L = buildImpactLedger([
    ev({ unit: UNIT.DOLLARS, metric: 'revenue', value: 10, confidence: 1.0, category: CATEGORY.PACING_SAVE }),
    ev({ unit: UNIT.COUNT, value: 20, confidence: 0.5 }),
  ])
  assert.equal(L.by_unit[UNIT.DOLLARS].weighted, L.by_unit[UNIT.COUNT].weighted)
  assert.equal(L.headline.unit, UNIT.DOLLARS)
  assert.ok(UNIT_PRIORITY.indexOf(UNIT.DOLLARS) < UNIT_PRIORITY.indexOf(UNIT.COUNT))
})

test('buildImpactLedger breaks down by category without cross-unit summing', () => {
  const L = buildImpactLedger([
    ev({ category: CATEGORY.RECOVERY, value: 2, confidence: 1.0 }),
    ev({ category: CATEGORY.EARLY_WARNING, value: 4, confidence: 0.5 }),
    ev({ category: CATEGORY.PACING_SAVE, unit: UNIT.DOLLARS, metric: 'revenue', value: 1000, confidence: 0.9 }),
  ])
  assert.equal(L.by_category[CATEGORY.RECOVERY].count, 1)
  assert.equal(L.by_category[CATEGORY.RECOVERY].units[UNIT.COUNT].weighted, 2)
  assert.equal(L.by_category[CATEGORY.EARLY_WARNING].units[UNIT.COUNT].weighted, 2)   // 4 × 0.5
  assert.equal(L.by_category[CATEGORY.PACING_SAVE].units[UNIT.DOLLARS].weighted, 900)
})

// ── by_client roster ──────────────────────────────────────────────────────────

test('buildImpactLedger rolls up per client and ranks dollar-impact clients first', () => {
  const L = buildImpactLedger([
    ev({ client_id: 'big', client_name: 'BigCo', unit: UNIT.DOLLARS, metric: 'revenue', value: 9000, confidence: 0.8, category: CATEGORY.PACING_SAVE }),
    ev({ client_id: 'small', client_name: 'SmallCo', unit: UNIT.COUNT, value: 5, confidence: 0.9 }),
    ev({ client_id: 'small', client_name: 'SmallCo', unit: UNIT.COUNT, value: 2, confidence: 0.9 }),
  ])
  assert.equal(L.client_count, 2)
  // BigCo's primary unit is dollars ⇒ ranks ahead of a count-only client regardless of raw counts
  assert.equal(L.by_client[0].client_id, 'big')
  assert.equal(L.by_client[0].primary_unit, UNIT.DOLLARS)
  assert.equal(L.by_client[0].rank_weight, 7200)               // 9000 × 0.8
  assert.equal(L.by_client[1].client_id, 'small')
  assert.equal(L.by_client[1].count, 2)
  assert.equal(L.by_client[1].units[UNIT.COUNT].value, 7)      // 5 + 2
})

test('buildImpactLedger tolerates unattributed wins (no client id/name)', () => {
  const L = buildImpactLedger([{ category: CATEGORY.RECOVERY, value: 1, confidence: 0.7 }])
  assert.equal(L.count, 1)
  assert.equal(L.client_count, 1)
  assert.equal(L.by_client[0].client_id, null)
  assert.equal(L.by_client[0].client_name, '')
})

// ── deterministic ordering ────────────────────────────────────────────────────

test('buildImpactLedger orders entries by weighted impact, fully tie-broken & deterministic', () => {
  const events = [
    ev({ client_id: 'b', client_name: 'B', value: 1, confidence: 0.9 }),
    ev({ client_id: 'a', client_name: 'A', value: 1, confidence: 0.9 }),   // same weight as B ⇒ name breaks tie
    ev({ client_id: 'z', client_name: 'Z', value: 5, confidence: 0.9 }),   // biggest weight ⇒ first
  ]
  const a = buildImpactLedger(events)
  const b = buildImpactLedger([...events].reverse())
  assert.deepEqual(a.entries, b.entries)                  // order is input-independent
  assert.equal(a.entries[0].client_id, 'z')               // 4.5 weighted leads
  assert.equal(a.entries[1].client_name, 'A')             // tie 0.9 → 'A' before 'B'
  assert.equal(a.entries[2].client_name, 'B')
})

test('buildImpactLedger is byte-stable: identical input ⇒ deep-equal ledger', () => {
  const events = [
    ev({ value: 3, confidence: 0.8 }),
    ev({ unit: UNIT.DOLLARS, metric: 'revenue', value: 1200, confidence: 0.7, category: CATEGORY.PACING_SAVE }),
  ]
  assert.deepEqual(buildImpactLedger(events), buildImpactLedger(events))
})

// ── the "proven" gate ─────────────────────────────────────────────────────────

test('proven gate: enough wins AND enough effective confidence', () => {
  const strong = buildImpactLedger([
    ev({ value: 1, confidence: 0.9 }),
    ev({ value: 1, confidence: 0.9 }),
    ev({ value: 1, confidence: 0.9 }),
  ])
  assert.equal(strong.count, 3)
  assert.equal(strong.confidence, 0.9)
  assert.equal(strong.proven, true)
})

test('proven gate stays false with too few wins, even at perfect confidence', () => {
  const thin = buildImpactLedger([
    ev({ value: 1, confidence: 1.0 }),
    ev({ value: 1, confidence: 1.0 }),
  ])
  assert.equal(thin.count, 2)              // below provenMinEvents (3)
  assert.equal(thin.proven, false)
})

test('proven gate stays false when the effective confidence is weak', () => {
  const weak = buildImpactLedger([
    ev({ value: 1, confidence: 0.3 }),
    ev({ value: 1, confidence: 0.3 }),
    ev({ value: 1, confidence: 0.3 }),
    ev({ value: 1, confidence: 0.3 }),
  ])
  assert.equal(weak.confidence, 0.3)       // below provenMinConfidence (0.6)
  assert.equal(weak.proven, false)
})

test('proven gate thresholds are overridable via opts', () => {
  const L = buildImpactLedger(
    [ev({ value: 1, confidence: 0.55 }), ev({ value: 1, confidence: 0.55 })],
    { provenMinEvents: 2, provenMinConfidence: 0.5 },
  )
  assert.equal(L.proven, true)
})

// ── window passthrough ────────────────────────────────────────────────────────

test('buildImpactLedger echoes a display window when given one, else null', () => {
  assert.equal(buildImpactLedger([ev()]).window, null)
  assert.deepEqual(
    buildImpactLedger([ev()], { window: { since: '2026-05-01', until: '2026-06-01' } }).window,
    { since: '2026-05-01', until: '2026-06-01' },
  )
})

// ── summarizeImpactLedger ─────────────────────────────────────────────────────

test('summarizeImpactLedger returns a compact, safe digest', () => {
  const L = buildImpactLedger([
    ev({ value: 2, confidence: 0.9 }),
    ev({ unit: UNIT.DOLLARS, metric: 'revenue', value: 800, confidence: 0.8, category: CATEGORY.PACING_SAVE }),
  ])
  const s = summarizeImpactLedger(L)
  assert.equal(s.count, 2)
  assert.equal(s.headline.unit, UNIT.DOLLARS)
  assert.deepEqual(s.units.sort(), [UNIT.COUNT, UNIT.DOLLARS].sort())
  assert.deepEqual(s.categories.sort(), [CATEGORY.PACING_SAVE, CATEGORY.RECOVERY].sort())
})

test('summarizeImpactLedger tolerates a junk argument', () => {
  const s = summarizeImpactLedger(null)
  assert.equal(s.count, 0)
  assert.equal(s.proven, false)
  assert.equal(s.headline, null)
})

// ── narration ─────────────────────────────────────────────────────────────────

test('narrateImpactLedger (agency) states the risk-adjusted dollar headline', () => {
  const L = buildImpactLedger([
    ev({ client_id: 'a', client_name: 'A', unit: UNIT.DOLLARS, metric: 'revenue', value: 4000, confidence: 0.9, category: CATEGORY.PACING_SAVE }),
    ev({ client_id: 'b', client_name: 'B', unit: UNIT.DOLLARS, metric: 'revenue', value: 6000, confidence: 0.9, category: CATEGORY.PACING_SAVE }),
    ev({ client_id: 'c', client_name: 'C', unit: UNIT.DOLLARS, metric: 'revenue', value: 2000, confidence: 0.9, category: CATEGORY.PACING_SAVE }),
  ])
  const s = narrateImpactLedger(L, { audience: 'agency' })
  assert.match(s, /\$10,800/)             // (4000+6000+2000) × 0.9, thousands-grouped
  assert.match(s, /3 clients/)
  assert.match(s, /proven track record/)
})

test('narrateImpactLedger (agency) phrases a count headline', () => {
  const L = buildImpactLedger([
    ev({ value: 1, confidence: 0.9 }), ev({ value: 1, confidence: 0.9 }), ev({ value: 1, confidence: 0.9 }),
  ])
  const s = narrateImpactLedger(L, { audience: 'agency' })
  assert.match(s, /3 measurable wins/)
  assert.match(s, /proven track record/)
})

test('narrateImpactLedger (client) reinforces ONLY a proven record and never leaks a number', () => {
  const proven = buildImpactLedger([
    ev({ value: 1, confidence: 0.9 }), ev({ value: 1, confidence: 0.9 }), ev({ value: 1, confidence: 0.9 }),
  ])
  const cs = narrateImpactLedger(proven, { audience: 'client' })
  assert.ok(cs.length > 0)
  assert.equal(/\d/.test(cs), false)                       // no digit ever reaches the client string
  assert.equal(/Acme|client|dollar|\$/.test(cs), false)    // no client name, no category, no money word

  const unproven = buildImpactLedger([ev({ value: 1, confidence: 0.9 })])
  assert.equal(narrateImpactLedger(unproven, { audience: 'client' }), '')   // stays silent
})

test('narrateImpactLedger returns "" for an empty ledger', () => {
  assert.equal(narrateImpactLedger(buildImpactLedger([])), '')
  assert.equal(narrateImpactLedger(null), '')
})
