'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  deriveBriefEmphasis,
  narrateBriefEmphasis,
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
} = require('../lib/briefEngagementLearning')

// ── grade fixtures (shape = summarizeBriefEngagement output) ───────────────────────
const graded = (over = {}) => ({
  status: 'graded',
  helpful_rate: 0.6,
  label: 'fair',
  trend: 'steady',
  n: 12,
  ...over,
})

// ── abstention: no track record → neutral base, guaranteed no-op ───────────────────
test('abstains when the grade is insufficient (not graded)', () => {
  const p = deriveBriefEmphasis({ status: 'insufficient', helpful_rate: null, n: 2 })
  assert.equal(p.status, 'abstained')
  assert.equal(p.also_cap, BASE_CAP)
  assert.equal(p.delta, 0)
  assert.equal(p.direction, 'neutral')
  assert.equal(p.helpful_rate, null)
  assert.equal(p.label, null)
  assert.equal(p.trend, null)
  assert.equal(p.reason, 'no_track_record')
  assert.equal(p.n, 2)
})

test('abstains when graded but helpful_rate is not finite (defensive)', () => {
  for (const bad of [null, undefined, NaN, 'x', {}]) {
    const p = deriveBriefEmphasis({ status: 'graded', helpful_rate: bad, label: 'well_received' })
    assert.equal(p.status, 'abstained', `helpful_rate=${String(bad)}`)
    assert.equal(p.also_cap, BASE_CAP)
  }
})

test('never throws on garbage input — all abstain to the base', () => {
  for (const bad of [null, undefined, {}, 42, 'nope', [], { status: 'graded' }]) {
    let p
    assert.doesNotThrow(() => {
      p = deriveBriefEmphasis(bad)
    }, `input=${JSON.stringify(bad)}`)
    assert.equal(p.status, 'abstained')
    assert.equal(p.also_cap, BASE_CAP)
    assert.equal(p.direction, 'neutral')
  }
})

// ── the cap law (level drives both directions) ─────────────────────────────────────
test('well_received widens the supporting cast (3 → 4)', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.82, label: 'well_received', trend: 'steady' }))
  assert.equal(p.status, 'tuned')
  assert.equal(p.also_cap, 4)
  assert.equal(p.base_cap, BASE_CAP)
  assert.equal(p.delta, 1)
  assert.equal(p.direction, 'widen')
  assert.equal(p.reason, 'well_received')
  assert.equal(p.helpful_rate, 0.82)
})

test('fair + steady holds neutral — idle, byte-identical to today', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.6, label: 'fair', trend: 'steady' }))
  assert.equal(p.status, 'idle')
  assert.equal(p.also_cap, BASE_CAP)
  assert.equal(p.delta, 0)
  assert.equal(p.direction, 'neutral')
  assert.equal(p.reason, 'steady_reception')
})

test('poorly_received tightens to the essentials (3 → 2)', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.4, label: 'poorly_received', trend: 'steady' }))
  assert.equal(p.status, 'tuned')
  assert.equal(p.also_cap, 2)
  assert.equal(p.delta, -1)
  assert.equal(p.direction, 'tighten')
  assert.equal(p.reason, 'poorly_received')
})

// ── trend sharpens ONLY toward tightening (the safety asymmetry) ───────────────────
test('declining trend sharpens a fair brief one step tighter (3 → 2)', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.55, label: 'fair', trend: 'declining' }))
  assert.equal(p.status, 'tuned')
  assert.equal(p.also_cap, 2)
  assert.equal(p.delta, -1)
  assert.equal(p.direction, 'tighten')
  assert.equal(p.reason, 'reception_declining')
})

test('poorly_received + declining drops to the safety floor (3 → 1)', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.3, label: 'poorly_received', trend: 'declining' }))
  assert.equal(p.status, 'tuned')
  assert.equal(p.also_cap, MIN_CAP)
  assert.equal(p.also_cap, 1)
  assert.equal(p.delta, -2)
  assert.equal(p.direction, 'tighten')
  assert.equal(p.reason, 'poorly_received')
})

test('well_received but slipping holds neutral — widening is never earned by trend', () => {
  // +1 (well) −1 (declining) = 0: the brief was landing well but is fading, so it
  // does NOT get to keep spending the reader's attention. It holds at base, idle.
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.78, label: 'well_received', trend: 'declining' }))
  assert.equal(p.status, 'idle')
  assert.equal(p.also_cap, BASE_CAP)
  assert.equal(p.delta, 0)
  assert.equal(p.direction, 'neutral')
  assert.equal(p.reason, 'steady_reception')
})

test('improving trend never widens on its own — only an earned level does', () => {
  // fair + improving = 0 (trend cannot push up): stays neutral.
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.7, label: 'fair', trend: 'improving' }))
  assert.equal(p.also_cap, BASE_CAP)
  assert.equal(p.direction, 'neutral')
})

// ── rails / safety floor hold on every path ────────────────────────────────────────
test('also_cap stays within [min_cap, max_cap] across the full label×trend matrix', () => {
  const labels = ['well_received', 'fair', 'poorly_received', null, 'bogus']
  const trends = ['improving', 'declining', 'steady', null, 'bogus']
  for (const label of labels) {
    for (const trend of trends) {
      const p = deriveBriefEmphasis(graded({ helpful_rate: 0.6, label, trend }))
      assert.ok(p.also_cap >= p.min_cap, `${label}/${trend} below floor`)
      assert.ok(p.also_cap <= p.max_cap, `${label}/${trend} above ceiling`)
      assert.ok(p.also_cap >= 1, `${label}/${trend} below 1 — headline+1 must survive`)
    }
  }
})

test('safety floor never drops below 1 even with absurd opts', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.1, label: 'poorly_received', trend: 'declining' }), {
    baseCap: 1,
    minCap: 1,
  })
  assert.ok(p.also_cap >= 1)
  assert.equal(p.also_cap, 1)
})

test('opts.baseCap is respected and the ceiling guards it', () => {
  // base 4, well_received → 5, which is exactly MAX_CAP.
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.9, label: 'well_received', trend: 'steady' }), {
    baseCap: 4,
  })
  assert.equal(p.base_cap, 4)
  assert.equal(p.also_cap, 5)
  assert.equal(p.max_cap, 5)
  assert.equal(p.direction, 'widen')
})

// ── purity / determinism ───────────────────────────────────────────────────────────
test('is pure — same input gives same output and the input is not mutated', () => {
  const input = Object.freeze(graded({ helpful_rate: 0.85, label: 'well_received', trend: 'steady' }))
  const a = deriveBriefEmphasis(input)
  const b = deriveBriefEmphasis(input)
  assert.deepEqual(a, b)
})

test('helpful_rate is echoed rounded to 4dp', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.666666, label: 'fair', trend: 'steady' }))
  assert.equal(p.helpful_rate, 0.6667)
})

// ── narrator: client privacy is unconditional ──────────────────────────────────────
test("narrateBriefEmphasis returns '' for audience:'client' on EVERY status", () => {
  const widen = deriveBriefEmphasis(graded({ helpful_rate: 0.85, label: 'well_received', trend: 'steady' }))
  const tighten = deriveBriefEmphasis(graded({ helpful_rate: 0.3, label: 'poorly_received', trend: 'declining' }))
  const idle = deriveBriefEmphasis(graded({ helpful_rate: 0.6, label: 'fair', trend: 'steady' }))
  const abstain = deriveBriefEmphasis({ status: 'insufficient' })
  for (const p of [widen, tighten, idle, abstain]) {
    assert.equal(narrateBriefEmphasis(p, { audience: 'client' }), '')
  }
})

test("narrateBriefEmphasis returns '' for idle and abstained (agency) — nothing changed", () => {
  const idle = deriveBriefEmphasis(graded({ helpful_rate: 0.6, label: 'fair', trend: 'steady' }))
  const abstain = deriveBriefEmphasis({ status: 'insufficient' })
  assert.equal(narrateBriefEmphasis(idle, { audience: 'agency' }), '')
  assert.equal(narrateBriefEmphasis(abstain, { audience: 'agency' }), '')
  assert.equal(narrateBriefEmphasis(null), '')
  assert.equal(narrateBriefEmphasis(undefined), '')
})

test('narrateBriefEmphasis widen sentence carries the rate and the cap numbers (agency)', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.85, label: 'well_received', trend: 'steady' }))
  const s = narrateBriefEmphasis(p, { audience: 'agency' })
  assert.match(s, /85%/)
  assert.match(s, /up from 3/)
  assert.match(s, /4 items/)
})

test('narrateBriefEmphasis tighten sentence carries the rate and a "slipping" note when declining (agency)', () => {
  const p = deriveBriefEmphasis(graded({ helpful_rate: 0.3, label: 'poorly_received', trend: 'declining' }))
  const s = narrateBriefEmphasis(p, { audience: 'agency' })
  assert.match(s, /30%/)
  assert.match(s, /slipping/)
  assert.match(s, /down from 3/)
  assert.match(s, /1 item\b/) // singular at the floor.
})
