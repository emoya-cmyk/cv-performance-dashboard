// ============================================================
// test/health.test.js — one number for "how is this client doing?"
//
// lib/health.js rolls a client's open findings into a single 0–100 health score
// via multiplicative compounding (health = 100 × Π(1 − pᵢ)), bands the score, names
// the finding that did the most damage, and ranks a portfolio worst-first. These
// tests pin: the exact per-severity scores and band cutoffs; that the product form
// is bounded, monotone and order-independent; that the headline driver is the
// biggest realized bite; that the precision loop only ever QUIETS a finding (never
// amplifies, and never touches a critical or data_health); the no-op guarantee
// (all-neutral precision === no precision); and the triage roster's worst-first
// ordering with its tie-breaks. Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  scoreClient, rankPortfolio, healthBand, confidenceFactor,
  SEVERITY_DAMAGE, FACTOR_FLOOR,
} = require('../lib/health')

// tiny finding builders — only the fields scoreClient reads
const f   = (severity, over = {}) => ({ severity, kind: 'anomaly', metric: 'revenue', direction: 'down', ...over })
const wt  = (weight) => ({ precision: { weight } })

// ---- totality: nothing wrong reads as flawless -------------------------------

test('scoreClient: an empty / missing / garbage feed is a perfect, driverless 100', () => {
  for (const input of [[], null, undefined, 42, { nope: true }]) {
    const h = scoreClient(input)
    assert.equal(h.score, 100)
    assert.equal(h.band, 'healthy')
    assert.equal(h.driver, null)
    assert.deepEqual(h.counts, { critical: 0, warning: 0, info: 0, total: 0 })
    assert.deepEqual(h.contributors, [])
  }
})

test('scoreClient: a row with unknown/absent severity is ignored entirely', () => {
  const h = scoreClient([f('nonsense'), f(undefined), { kind: 'anomaly' }])
  assert.equal(h.score, 100)
  assert.equal(h.counts.total, 0)
  assert.equal(h.driver, null)
})

// ---- exact per-severity scores + bands ---------------------------------------

test('scoreClient: one info barely dents — 96, healthy', () => {
  const h = scoreClient([f('info')])
  assert.equal(h.score, 96)
  assert.equal(h.band, 'healthy')
  assert.deepEqual(h.counts, { critical: 0, warning: 0, info: 1, total: 1 })
})

test('scoreClient: one warning — 80, watch', () => {
  const h = scoreClient([f('warning')])
  assert.equal(h.score, 80)
  assert.equal(h.band, 'watch')
})

test('scoreClient: one critical — 45, at_risk', () => {
  const h = scoreClient([f('critical')])
  assert.equal(h.score, 45)
  assert.equal(h.band, 'at_risk')
})

test('scoreClient: a critical plus a warning compounds to 36, critical band', () => {
  const h = scoreClient([f('critical'), f('warning')])
  assert.equal(h.score, 36) // 100 × 0.45 × 0.80
  assert.equal(h.band, 'critical')
  assert.deepEqual(h.counts, { critical: 1, warning: 1, info: 0, total: 2 })
})

test('healthBand: cutoffs land on the documented edges', () => {
  assert.equal(healthBand(100), 'healthy')
  assert.equal(healthBand(85),  'healthy')
  assert.equal(healthBand(84),  'watch')
  assert.equal(healthBand(65),  'watch')
  assert.equal(healthBand(64),  'at_risk')
  assert.equal(healthBand(40),  'at_risk')
  assert.equal(healthBand(39),  'critical')
  assert.equal(healthBand(0),   'critical')
  // total: out-of-range numbers clamp rather than throw
  assert.equal(healthBand(999),  'healthy')
  assert.equal(healthBand(-5),   'critical')
  assert.equal(healthBand('x'),  'critical')
})

// ---- the product form's defining properties ----------------------------------

test('scoreClient: bounded and monotone — criticals only ever lower the score toward a 0 floor', () => {
  let prev = 101
  for (let n = 1; n <= 12; n++) {
    const { score } = scoreClient(Array.from({ length: n }, () => f('critical')))
    assert.ok(score >= 0 && score <= 100, `n=${n} stays within 0–100`)
    assert.ok(score <= prev, `n=${n} never higher than n=${n - 1}`)
    if (prev > 0) assert.ok(score < prev, `n=${n} strictly lower while above the floor`)
    prev = score
  }
  // the product shrinks geometrically; rounded, enough criticals pin it at the 0
  // floor — and it never crosses below (the bound holds, it does not go negative).
  assert.equal(prev, 0, 'enough criticals drive health to the 0 floor, never past it')
})

test('scoreClient: diminishing returns — the 2nd warning removes less than the 1st', () => {
  const one   = scoreClient([f('warning')]).score                 // 100 → 80, drop 20
  const two   = scoreClient([f('warning'), f('warning')]).score   // 80 → 64, drop 16
  const three = scoreClient([f('warning'), f('warning'), f('warning')]).score // 64 → 51.2→51
  assert.equal(two, 64)
  assert.ok((100 - one) > (one - two), 'first bite bigger than the second')
  assert.ok((one - two) > (two - three), 'second bite bigger than the third')
})

test('scoreClient: order-independent — the same multiset yields the same score', () => {
  const a = scoreClient([f('critical'), f('warning'), f('info')]).score
  const b = scoreClient([f('info'), f('critical'), f('warning')]).score
  const c = scoreClient([f('warning'), f('info'), f('critical')]).score
  assert.equal(a, b)
  assert.equal(b, c)
})

// ---- headline driver + contributors ------------------------------------------

test('scoreClient: driver is the biggest realized bite; contributors are biggest-first', () => {
  const h = scoreClient([
    f('info',     { metric: 'cpl' }),
    f('critical', { metric: 'revenue' }),
    f('warning',  { metric: 'leads' }),
  ])
  assert.equal(h.driver.metric, 'revenue')
  assert.equal(h.driver.severity, 'critical')
  assert.equal(h.driver.damage_pct, 55) // 0.55 × 1
  assert.deepEqual(h.contributors.map((c) => c.severity), ['critical', 'warning', 'info'])
  assert.deepEqual(h.contributors.map((c) => c.metric), ['revenue', 'leads', 'cpl'])
})

// ---- precision: quiets noise, never amplifies, never touches the sacrosanct ---

test('confidenceFactor: < 1 weight damps; ≥ 1 weight is capped at 1; absent → 1', () => {
  assert.equal(confidenceFactor(f('warning', wt(0.6))), 0.6) // ignored kind → damped
  assert.equal(confidenceFactor(f('warning', wt(1.0))), 1)   // neutral → full
  assert.equal(confidenceFactor(f('warning', wt(1.4))), 1)   // acted-on kind → capped, NOT amplified
  assert.equal(confidenceFactor(f('warning')), 1)            // no precision → neutral
  assert.equal(confidenceFactor(f('warning', wt(-3))), 1)    // garbage weight → neutral
})

test('confidenceFactor: a learned-ignore can never damp below the floor', () => {
  assert.equal(confidenceFactor(f('warning', wt(0.01))), FACTOR_FLOOR)
})

test('scoreClient: an ignored warning-kind scores HEALTHIER than a neutral one', () => {
  const neutral = scoreClient([f('warning', wt(1.0))]).score // 80
  const ignored = scoreClient([f('warning', wt(0.6))]).score // 0.20×0.6=0.12 → 88
  assert.equal(neutral, 80)
  assert.equal(ignored, 88)
  assert.ok(ignored > neutral, 'precision QUIETS a habitually-ignored finding')
})

test('scoreClient: an acted-on warning-kind is NOT amplified past neutral', () => {
  assert.equal(scoreClient([f('warning', wt(1.4))]).score, 80) // identical to neutral
})

test('scoreClient: critical and data_health are exempt — precision never quiets them', () => {
  // a critical the client keeps ignoring still bites at full strength
  assert.equal(scoreClient([f('critical', wt(0.6))]).score, 45)
  // data_health (the self-sustaining alarm) is exempt regardless of kind-weight
  assert.equal(scoreClient([{ severity: 'warning', kind: 'data_health', ...wt(0.6) }]).score, 80)
  // contrast: a NON-exempt warning at the same weight is quieted to 88
  assert.equal(scoreClient([f('warning', wt(0.6))]).score, 88)
})

// ---- the no-op guarantee -----------------------------------------------------

test('scoreClient: all-neutral precision is byte-identical to no precision at all', () => {
  const feed       = [f('critical'), f('warning'), f('info')]
  const withNeutral = feed.map((x) => ({ ...x, ...wt(1.0) }))
  assert.deepEqual(scoreClient(withNeutral), scoreClient(feed))
})

// ---- portfolio triage roster -------------------------------------------------

test('rankPortfolio: worst-first by score, healthy clients sink to the bottom', () => {
  const roster = rankPortfolio([
    { client_id: 'c', client_name: 'Clean Co',  insights: [] },                       // 100
    { client_id: 'b', client_name: 'Two Warns', insights: [f('warning'), f('warning')] }, // 64
    { client_id: 'a', client_name: 'One Crit',  insights: [f('critical')] },          // 45
  ])
  assert.deepEqual(roster.map((r) => r.client_id), ['a', 'b', 'c'])
  assert.deepEqual(roster.map((r) => r.score), [45, 64, 100])
  // each entry is enriched with its full health verdict
  assert.equal(roster[0].band, 'at_risk')
  assert.equal(roster[0].driver.severity, 'critical')
  assert.equal(roster[0].client_name, 'One Crit')
})

test('rankPortfolio: a true score tie breaks on client_name for stable order', () => {
  const roster = rankPortfolio([
    { client_id: 'z', client_name: 'Zeta',  insights: [f('warning')] },
    { client_id: 'a', client_name: 'Alpha', insights: [f('warning')] },
  ])
  assert.deepEqual(roster.map((r) => r.client_name), ['Alpha', 'Zeta'])
  assert.deepEqual(roster.map((r) => r.score), [80, 80])
})

test('rankPortfolio: missing fields never throw — null ids/names, empty input', () => {
  assert.deepEqual(rankPortfolio([]), [])
  assert.deepEqual(rankPortfolio(null), [])
  const roster = rankPortfolio([{ insights: [f('critical')] }, {}])
  assert.equal(roster.length, 2)
  assert.equal(roster[0].score, 45)   // the one with a finding sorts first
  assert.equal(roster[0].client_id, null)
  assert.equal(roster[1].score, 100)  // the empty group is a clean 100
})

test('rankPortfolio: pure — the same groups yield an identical roster', () => {
  const groups = [
    { client_id: 'a', client_name: 'A', insights: [f('critical'), f('info')] },
    { client_id: 'b', client_name: 'B', insights: [f('warning')] },
  ]
  assert.deepEqual(rankPortfolio(groups), rankPortfolio(groups))
})

// ---- the damage constants are the documented ones ----------------------------

test('SEVERITY_DAMAGE: critical ≫ warning ≫ info, all in (0,1)', () => {
  assert.ok(SEVERITY_DAMAGE.critical > SEVERITY_DAMAGE.warning)
  assert.ok(SEVERITY_DAMAGE.warning > SEVERITY_DAMAGE.info)
  for (const v of Object.values(SEVERITY_DAMAGE)) assert.ok(v > 0 && v < 1)
})
