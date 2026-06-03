'use strict'

// Tests for lib/briefQuality.js — the self-grade the Morning Brief never had: does
// narration still speak in its own words, or has it silently degraded to the grounded
// template? The contract these tests pin:
//   • THE DISCRIMINATOR IS `model`, NOT `grounded`: every persisted row is grounded:true
//     (the template fallback is grounded by construction), so narration health is read
//     off model — 'template'/absent ⇒ fellback, any real id ⇒ narrated. grounded is
//     surfaced SEPARATELY as the trust invariant (grounded_rate / all_grounded);
//   • NARRATABLE GATE mirrors generateBriefText's briefWorthNarrating EXACTLY: a quiet
//     morning (nothing worth narrating) is template BY DESIGN and must score 'quiet',
//     never 'fellback' — so coverage's denominator is narratable briefs only. Both
//     audience OR-branches are pinned (client: has_focus|has_resolved|focus; agency:
//     has_action|has_resolved|headline);
//   • COVERAGE = narrated / narratable (4dp), null when none narratable; health bands
//     'no-data' | 'quiet' | 'template-only' | 'mixed' | 'rich' (rich at/above richCoverage);
//   • STREAK_FELLBACK = consecutive MOST-RECENT narratable briefs that fell back, computed
//     off a deterministic ascending sort so it's stable on unsorted input; latest is the
//     most-recent narratable row's { as_of, state };
//   • WINDOW = min..max as_of + inclusive day span, via static Date.UTC (no clock-of-now);
//   • narrateBriefHealth: one grounded agency sentence whose numbers are straight off the
//     bucket; '' for empty/all-quiet AND ALWAYS '' for a client audience (no-leak baked in);
//   • PURE: rows in, summary out; never mutates input, never throws, deep-equal on repeat.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  summarizeBriefQuality,
  narrateBriefHealth,
  isNarratable,
  briefRowState,
  RICH_COVERAGE,
} = require('../lib/briefQuality')

// ── Row builders ──────────────────────────────────────────────────────────────
// A narratable client pack (has_focus path). A real model id ⇒ narrated.
function clientRow(as_of, model, over = {}) {
  return {
    scope_key: over.scope_key || 'c1',
    as_of,
    audience: 'client',
    client_id: over.client_id || 'c1',
    model,
    grounded: over.grounded == null ? true : over.grounded,
    pack: over.pack || { audience: 'client', meta: { has_focus: true }, focus: { metric: 'leads' } },
  }
}
// A narratable agency pack (has_action path).
function agencyRow(as_of, model, over = {}) {
  return {
    scope_key: over.scope_key || '__portfolio__',
    as_of,
    audience: 'agency',
    client_id: null,
    model,
    grounded: over.grounded == null ? true : over.grounded,
    pack: over.pack || { audience: 'agency', meta: { has_action: true }, headline: { client: 'Acme' } },
  }
}
// A dead-quiet client morning: nothing worth narrating → template by DESIGN.
function quietClientRow(as_of) {
  return {
    scope_key: 'c1', as_of, audience: 'client', client_id: 'c1',
    model: 'template', grounded: true,
    pack: { audience: 'client', meta: { quiet: true, has_focus: false, has_resolved: false } },
  }
}

// ── isNarratable: mirror of briefWorthNarrating, BOTH audience OR-branches ───────
test('isNarratable — client branch: has_focus OR has_resolved OR focus', () => {
  assert.equal(isNarratable({ audience: 'client', meta: { has_focus: true } }), true)
  assert.equal(isNarratable({ audience: 'client', meta: { has_resolved: true } }), true)
  assert.equal(isNarratable({ audience: 'client', meta: {}, focus: { metric: 'leads' } }), true)
  assert.equal(isNarratable({ audience: 'client', meta: { has_focus: false, has_resolved: false } }), false)
})

test('isNarratable — agency branch: has_action OR has_resolved OR headline', () => {
  assert.equal(isNarratable({ audience: 'agency', meta: { has_action: true } }), true)
  assert.equal(isNarratable({ audience: 'agency', meta: { has_resolved: true } }), true)
  assert.equal(isNarratable({ audience: 'agency', meta: {}, headline: { client: 'Acme' } }), true)
  assert.equal(isNarratable({ audience: 'agency', meta: { has_action: false, has_resolved: false } }), false)
})

test('isNarratable — accepts a raw JSON-string pack; null/garbage ⇒ false', () => {
  assert.equal(isNarratable(JSON.stringify({ audience: 'client', meta: { has_focus: true } })), true)
  assert.equal(isNarratable(null), false)
  assert.equal(isNarratable('not json'), false)
  assert.equal(isNarratable(42), false)
})

// ── briefRowState: the three states ──────────────────────────────────────────────
test('briefRowState — narrated / fellback / quiet', () => {
  assert.equal(briefRowState(clientRow('2026-06-01', 'claude-haiku-4-5')), 'narrated')
  assert.equal(briefRowState(clientRow('2026-06-01', 'template')), 'fellback')
  assert.equal(briefRowState(quietClientRow('2026-06-01')), 'quiet')
  // A narratable pack with NO model stamp is treated as fellback (defensive).
  assert.equal(briefRowState(clientRow('2026-06-01', undefined)), 'fellback')
  assert.equal(briefRowState(null), 'quiet')
})

// ── Empty / no-data ──────────────────────────────────────────────────────────────
test('empty input ⇒ no-data, null coverage, grounded vacuously true', () => {
  const s = summarizeBriefQuality([])
  assert.equal(s.total, 0)
  assert.equal(s.overall.health, 'no-data')
  assert.equal(s.overall.coverage, null)
  assert.equal(s.grounded_rate, null)
  assert.equal(s.all_grounded, true)
  assert.deepEqual(s.window, { from: null, to: null, days: 0 })
  assert.equal(s.by_audience.client.health, 'no-data')
  assert.equal(s.by_audience.agency.health, 'no-data')
})

test('non-array input is tolerated ⇒ no-data', () => {
  assert.equal(summarizeBriefQuality(undefined).overall.health, 'no-data')
  assert.equal(summarizeBriefQuality(null).total, 0)
})

// ── All-quiet: template by design is NOT a failure ──────────────────────────────
test('all-quiet window ⇒ quiet health, coverage null, grounded_rate 1', () => {
  const s = summarizeBriefQuality([
    quietClientRow('2026-05-30'),
    quietClientRow('2026-05-31'),
    quietClientRow('2026-06-01'),
  ])
  assert.equal(s.total, 3)
  assert.equal(s.overall.narratable, 0)
  assert.equal(s.overall.quiet, 3)
  assert.equal(s.overall.coverage, null)
  assert.equal(s.overall.health, 'quiet')
  assert.equal(s.overall.streak_fellback, 0)
  assert.equal(s.overall.latest, null)
  // grounded is orthogonal: all three are grounded templates.
  assert.equal(s.grounded_rate, 1)
  assert.equal(s.all_grounded, true)
})

// ── Coverage math + health bands ────────────────────────────────────────────────
test('rich band — coverage at/above RICH_COVERAGE (0.8)', () => {
  // 4 narrated, 1 fellback ⇒ 0.8 exactly ⇒ rich.
  const s = summarizeBriefQuality([
    clientRow('2026-05-28', 'claude-haiku-4-5'),
    clientRow('2026-05-29', 'claude-haiku-4-5'),
    clientRow('2026-05-30', 'claude-haiku-4-5'),
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(s.overall.narratable, 5)
  assert.equal(s.overall.narrated, 4)
  assert.equal(s.overall.fellback, 1)
  assert.equal(s.overall.coverage, 0.8)
  assert.equal(s.overall.health, 'rich')
  // latest (2026-06-01) fell back ⇒ streak 1.
  assert.deepEqual(s.overall.latest, { as_of: '2026-06-01', state: 'fellback' })
  assert.equal(s.overall.streak_fellback, 1)
  assert.deepEqual(s.overall.models, { 'claude-haiku-4-5': 4, template: 1 })
})

test('mixed band — below RICH_COVERAGE but some narration survives', () => {
  // 1 narrated, 2 fellback ⇒ 0.3333 ⇒ mixed.
  const s = summarizeBriefQuality([
    clientRow('2026-05-30', 'claude-haiku-4-5'),
    clientRow('2026-05-31', 'template'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(s.overall.coverage, 0.3333)
  assert.equal(s.overall.health, 'mixed')
  // two most-recent both fell back ⇒ streak 2.
  assert.equal(s.overall.streak_fellback, 2)
})

test('template-only band — every narratable brief fell back', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-31', 'template'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(s.overall.narratable, 2)
  assert.equal(s.overall.narrated, 0)
  assert.equal(s.overall.coverage, 0)
  assert.equal(s.overall.health, 'template-only')
  assert.equal(s.overall.streak_fellback, 2)
})

test('quiet rows do NOT count against coverage or break the streak', () => {
  // narrated, fellback, QUIET, fellback (ascending). Quiet is skipped entirely:
  // narratable=3, narrated=1, the two fellbacks are the most-recent run ⇒ streak 2.
  const s = summarizeBriefQuality([
    clientRow('2026-05-29', 'claude-haiku-4-5'),
    clientRow('2026-05-30', 'template'),
    quietClientRow('2026-05-31'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(s.overall.total, 4)
  assert.equal(s.overall.narratable, 3)
  assert.equal(s.overall.quiet, 1)
  assert.equal(s.overall.narrated, 1)
  assert.equal(s.overall.streak_fellback, 2)
  assert.deepEqual(s.overall.latest, { as_of: '2026-06-01', state: 'fellback' })
})

// ── richCoverage override ────────────────────────────────────────────────────────
test('opts.richCoverage retunes the rich/mixed boundary; invalid opts ignored', () => {
  const rows = [
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'template'),
  ] // coverage 0.5
  assert.equal(summarizeBriefQuality(rows, { richCoverage: 0.5 }).overall.health, 'rich')
  assert.equal(summarizeBriefQuality(rows, { richCoverage: 0.9 }).overall.health, 'mixed')
  // out-of-range / NaN falls back to the 0.8 default ⇒ 0.5 is mixed.
  assert.equal(summarizeBriefQuality(rows, { richCoverage: 5 }).overall.health, 'mixed')
  assert.equal(summarizeBriefQuality(rows, { richCoverage: NaN }).overall.health, 'mixed')
})

// ── Per-audience bucketing (both OR-branches via real packs) ─────────────────────
test('client + agency rows split into independent buckets', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-31', 'claude-haiku-4-5'),                 // client narrated
    clientRow('2026-06-01', 'template'),                        // client fellback
    agencyRow('2026-05-31', 'claude-haiku-4-5'),                // agency narrated
    agencyRow('2026-06-01', 'claude-haiku-4-5', {               // agency narrated via has_resolved branch
      pack: { audience: 'agency', meta: { has_resolved: true } },
    }),
  ])
  assert.equal(s.by_audience.client.narratable, 2)
  assert.equal(s.by_audience.client.narrated, 1)
  assert.equal(s.by_audience.client.coverage, 0.5)
  assert.equal(s.by_audience.agency.narratable, 2)
  assert.equal(s.by_audience.agency.narrated, 2)
  assert.equal(s.by_audience.agency.coverage, 1)
  assert.equal(s.by_audience.agency.health, 'rich')
  // overall folds both: 4 narratable, 3 narrated.
  assert.equal(s.overall.narratable, 4)
  assert.equal(s.overall.narrated, 3)
})

test('agency headline-only and client focus-only packs are narratable', () => {
  const s = summarizeBriefQuality([
    agencyRow('2026-06-01', 'template', { pack: { audience: 'agency', meta: {}, headline: { client: 'Acme' } } }),
    clientRow('2026-06-01', 'template', { pack: { audience: 'client', meta: {}, focus: { metric: 'leads' } } }),
  ])
  assert.equal(s.by_audience.agency.narratable, 1)
  assert.equal(s.by_audience.agency.health, 'template-only')
  assert.equal(s.by_audience.client.narratable, 1)
  assert.equal(s.by_audience.client.health, 'template-only')
})

// ── grounded_rate + all_grounded (the trust invariant) ──────────────────────────
test('grounded_rate is 1 when every row is grounded', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(s.grounded_rate, 1)
  assert.equal(s.all_grounded, true)
})

test('a synthetic ungrounded row drops grounded_rate below 1 — orthogonal to coverage', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-30', 'claude-haiku-4-5'),
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'claude-haiku-4-5', { grounded: false }),
  ])
  // narration is perfect…
  assert.equal(s.overall.coverage, 1)
  assert.equal(s.overall.health, 'rich')
  // …yet grounding is not, and we report that separately.
  assert.equal(s.grounded_rate, 0.6667)
  assert.equal(s.all_grounded, false)
})

// ── Window from/to/days ──────────────────────────────────────────────────────────
test('window spans min..max as_of with an inclusive day count', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-28', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(s.window.from, '2026-05-28')
  assert.equal(s.window.to, '2026-06-01')
  assert.equal(s.window.days, 5) // 28,29,30,31,01 inclusive
})

test('window day-span crosses a month boundary correctly', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-04-30', 'template'),
    clientRow('2026-05-02', 'template'),
  ])
  assert.equal(s.window.days, 3) // Apr30, May01, May02
})

// ── Unsorted input ⇒ deterministic latest/streak ────────────────────────────────
test('latest + streak are computed off a stable sort, not input order', () => {
  // Same rows, shuffled. Ascending truth: 29 narrated, 30 fellback, 31 fellback.
  const rows = [
    clientRow('2026-05-31', 'template'),
    clientRow('2026-05-29', 'claude-haiku-4-5'),
    clientRow('2026-05-30', 'template'),
  ]
  const a = summarizeBriefQuality(rows)
  const b = summarizeBriefQuality(rows.slice().reverse())
  assert.deepEqual(a.overall.latest, { as_of: '2026-05-31', state: 'fellback' })
  assert.equal(a.overall.streak_fellback, 2)
  assert.deepEqual(a, b) // order-independent result
})

// ── narrateBriefHealth ──────────────────────────────────────────────────────────
test('narrateBriefHealth — agency rich sentence, numbers straight off the bucket', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-29', 'claude-haiku-4-5'),
    clientRow('2026-05-30', 'claude-haiku-4-5'),
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'claude-haiku-4-5'),
  ])
  const line = narrateBriefHealth(s.overall, { audience: 'agency', scopeLabel: 'Acme' })
  assert.match(line, /Acme wrote 4 of 4 morning briefs in its own words/)
  assert.match(line, /grounded to your verified numbers/)
})

test('narrateBriefHealth — mixed sentence mentions the template; streak adds a heads-up', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-29', 'claude-haiku-4-5'),
    clientRow('2026-05-30', 'template'),
    clientRow('2026-05-31', 'template'),
    clientRow('2026-06-01', 'template'),
  ])
  const line = narrateBriefHealth(s.overall, { audience: 'agency' })
  assert.match(line, /The AI wrote 1 of 4 morning briefs in its own words; the rest used the safe template/)
  assert.match(line, /Heads up — the last 3 fell back to the template/)
})

test('narrateBriefHealth — template-only phrasing', () => {
  const s = summarizeBriefQuality([clientRow('2026-06-01', 'template')])
  const line = narrateBriefHealth(s.overall, { audience: 'agency' })
  assert.match(line, /Every morning brief used the safe template/)
})

test('narrateBriefHealth — singular noun when exactly one narratable brief', () => {
  const s = summarizeBriefQuality([clientRow('2026-06-01', 'claude-haiku-4-5')])
  const line = narrateBriefHealth(s.overall, { audience: 'agency' })
  assert.match(line, /wrote 1 of 1 morning brief in its own words/)
  assert.doesNotMatch(line, /briefs/)
})

test('narrateBriefHealth — empty / all-quiet bucket ⇒ no claim', () => {
  assert.equal(narrateBriefHealth(summarizeBriefQuality([]).overall, { audience: 'agency' }), '')
  const quiet = summarizeBriefQuality([quietClientRow('2026-06-01')]).overall
  assert.equal(narrateBriefHealth(quiet, { audience: 'agency' }), '')
})

test('narrateBriefHealth — ALWAYS empty for a client audience (no-leak)', () => {
  const s = summarizeBriefQuality([
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'template'),
  ])
  assert.equal(narrateBriefHealth(s.overall, { audience: 'client' }), '')
  assert.equal(narrateBriefHealth(s.by_audience.client, { audience: 'client', scopeLabel: 'Acme' }), '')
})

// ── Purity ───────────────────────────────────────────────────────────────────────
test('pure — does not mutate input and is deep-equal on repeat', () => {
  const rows = [
    clientRow('2026-05-31', 'claude-haiku-4-5'),
    clientRow('2026-06-01', 'template'),
    quietClientRow('2026-05-30'),
  ]
  const snapshot = JSON.parse(JSON.stringify(rows))
  const a = summarizeBriefQuality(rows)
  const b = summarizeBriefQuality(rows)
  assert.deepEqual(a, b)
  assert.deepEqual(rows, snapshot) // input untouched
})

test('RICH_COVERAGE is exported and sane', () => {
  assert.ok(RICH_COVERAGE > 0 && RICH_COVERAGE <= 1)
})
