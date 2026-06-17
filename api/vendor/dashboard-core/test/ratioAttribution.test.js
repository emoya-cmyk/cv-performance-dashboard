'use strict'

// Tests for lib/ratioAttribution.js — the quotient (lever) decomposition behind a
// RATIO metric's move (roas, cpl, close_rate). The contract under test:
//   • signed shares sum to EXACTLY 1 (numerator +log, denominator −log);
//   • the lead is the dominant aligned lever; a counter-moving lever is a drag (<0);
//   • pct equals 100·(ratio_to/ratio_from − 1) by construction;
//   • null on a non-ratio metric, any non-positive/non-finite driver, or a flat move;
//   • narrateRatio copies the computed numbers verbatim (grounded by construction).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ratioAttribution, narrateRatio, isRatioMetric, ratioDriversOf, RATIO_IDENTITIES,
} = require('..')

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)
const driverOf = (res, key) => res.drivers.find((d) => d.metric === key)

// ── catalogue predicates ──────────────────────────────────────────────────────
test('isRatioMetric recognises exactly the three ratio metrics', () => {
  assert.equal(isRatioMetric('roas'), true)
  assert.equal(isRatioMetric('cpl'), true)
  assert.equal(isRatioMetric('close_rate'), true)
  assert.equal(isRatioMetric('revenue'), false)  // additive, not a ratio
  assert.equal(isRatioMetric('jobs'), false)
  assert.equal(isRatioMetric('nope'), false)
})

test('ratioDriversOf returns [num, den] for ratios and null otherwise', () => {
  assert.deepEqual(ratioDriversOf('roas'), ['revenue', 'spend'])
  assert.deepEqual(ratioDriversOf('cpl'), ['spend', 'leads'])
  assert.deepEqual(ratioDriversOf('close_rate'), ['jobs', 'leads'])
  assert.equal(ratioDriversOf('revenue'), null)
  // identities expose the SUM drivers used to recompute each side via ask.js METRICS
  assert.deepEqual(RATIO_IDENTITIES.close_rate, { num: 'jobs', den: 'leads' })
})

// ── roas: numerator-only move (spend flat) ─────────────────────────────────────
test('roas up driven entirely by revenue (spend flat) → revenue share = 1', () => {
  const res = ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 1200, spend: 100 })
  assert.equal(res.direction, 'up')
  approx(res.pct, 20)                         // 1200/100 ÷ 1000/100 − 1 = 20%
  approx(res.ratio_from, 10)
  approx(res.ratio_to, 12)
  assert.equal(res.lead, 'revenue')
  approx(driverOf(res, 'revenue').share, 1)
  approx(driverOf(res, 'spend').share, 0)     // flat denominator contributes nothing
  assert.ok(!Object.is(driverOf(res, 'spend').share, -0), 'normalises −0 → +0')
  approx(driverOf(res, 'revenue').pct, 20)
  approx(driverOf(res, 'spend').pct, 0)
})

// ── roas: numerator wins, denominator is a drag ────────────────────────────────
test('roas up with spend rising too → revenue leads, spend is a drag (share < 0)', () => {
  const res = ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 1500, spend: 120 })
  assert.equal(res.direction, 'up')
  approx(res.pct, 25)                         // 12.5 ÷ 10 − 1
  assert.equal(res.lead, 'revenue')
  const rev = driverOf(res, 'revenue'), sp = driverOf(res, 'spend')
  assert.ok(rev.share > 1, 'dominant aligned lever overshoots 1 to offset the drag')
  assert.ok(sp.share < 0, 'spend rose against the ratio → negative (drag) share')
  approx(rev.share + sp.share, 1)             // signed shares sum to exactly 1
  approx(rev.pct, 50)
  approx(sp.pct, 20)
})

// ── cpl: a FALL driven by leads, with spend as a drag ──────────────────────────
test('cpl down via more leads (spend up slightly) → leads leads with share > 1', () => {
  const res = ratioAttribution('cpl', { spend: 100, leads: 50 }, { spend: 110, leads: 90 })
  assert.equal(res.direction, 'down')
  approx(res.pct, -38.9)                       // 1.2222 ÷ 2 − 1 ≈ −38.9%
  assert.equal(res.lead, 'leads')             // the denominator can be the lead lever
  const leads = driverOf(res, 'leads'), sp = driverOf(res, 'spend')
  assert.ok(leads.share > 1, 'more leads dominate the fall')
  assert.ok(sp.share < 0, 'rising spend pushed cpl UP, against the fall → drag')
  approx(leads.share + sp.share, 1)
  approx(leads.pct, 80)
  approx(sp.pct, 10)
})

// ── close_rate: a RISE driven by jobs, leads dilute (drag) ─────────────────────
test('close_rate up via jobs, leads dilute → jobs leads, leads is a drag', () => {
  const res = ratioAttribution('close_rate', { jobs: 10, leads: 100 }, { jobs: 25, leads: 125 })
  assert.equal(res.direction, 'up')
  approx(res.pct, 100)                         // 20% ÷ 10% − 1 = 100%
  approx(res.ratio_from, 0.1)                 // ratio is jobs/leads; the ×100 cancels
  approx(res.ratio_to, 0.2)
  assert.equal(res.lead, 'jobs')
  const jobs = driverOf(res, 'jobs'), leads = driverOf(res, 'leads')
  assert.ok(jobs.share > 1)
  assert.ok(leads.share < 0, 'a growing denominator drags the rate down')
  approx(jobs.share + leads.share, 1)
})

// ── share normalisation invariant across a sweep ───────────────────────────────
test('signed shares always sum to exactly 1 across varied moves', () => {
  const cases = [
    ['roas', { revenue: 800, spend: 200 }, { revenue: 900, spend: 150 }],
    ['cpl', { spend: 300, leads: 120 }, { spend: 280, leads: 100 }],
    ['close_rate', { jobs: 40, leads: 200 }, { jobs: 35, leads: 250 }],
    ['roas', { revenue: 5000, spend: 1000 }, { revenue: 4000, spend: 1100 }],
  ]
  for (const [m, from, to] of cases) {
    const res = ratioAttribution(m, from, to)
    assert.ok(res, `${m} should decompose`)
    approx(res.drivers[0].share + res.drivers[1].share, 1)
    // headline pct matches the ratio recomputed straight from the endpoints
    const rFrom = res.ratio_from, rTo = res.ratio_to
    approx(res.pct, Math.round(1000 * (rTo / rFrom - 1)) / 10)
  }
})

// ── null guards ────────────────────────────────────────────────────────────────
test('flat ratio → null (nothing to attribute)', () => {
  assert.equal(ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 1000, spend: 100 }), null)
  // proportional move keeps the ratio constant → still flat → null
  assert.equal(ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 2000, spend: 200 }), null)
})

test('non-positive or non-finite driver → null (log undefined)', () => {
  assert.equal(ratioAttribution('roas', { revenue: 1000, spend: 0 }, { revenue: 1200, spend: 100 }), null)
  assert.equal(ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: -50, spend: 100 }), null)
  assert.equal(ratioAttribution('cpl', { spend: 100, leads: 0 }, { spend: 100, leads: 80 }), null)
  assert.equal(ratioAttribution('roas', { revenue: NaN, spend: 100 }, { revenue: 1200, spend: 100 }), null)
  assert.equal(ratioAttribution('roas', { revenue: Infinity, spend: 100 }, { revenue: 1200, spend: 100 }), null)
})

test('non-ratio metric or missing endpoints → null', () => {
  assert.equal(ratioAttribution('revenue', { revenue: 1 }, { revenue: 2 }), null)
  assert.equal(ratioAttribution('roas', null, { revenue: 1200, spend: 100 }), null)
  assert.equal(ratioAttribution('roas', { revenue: 1000, spend: 100 }, undefined), null)
})

// ── grounded narration ─────────────────────────────────────────────────────────
test('narrateRatio copies the computed numbers verbatim (roas)', () => {
  const res = ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 1500, spend: 120 })
  const sentence = narrateRatio(res, { label: 'ROAS', numLabel: 'Revenue', denLabel: 'Ad spend' })
  assert.equal(sentence, 'ROAS rose 25% — revenue rose 50% and ad spend rose 20%.')
})

test('narrateRatio renders a fall and a flat lever correctly', () => {
  const fall = ratioAttribution('cpl', { spend: 100, leads: 50 }, { spend: 110, leads: 90 })
  assert.equal(
    narrateRatio(fall, { label: 'Cost per lead', numLabel: 'Ad spend', denLabel: 'Leads' }),
    'Cost per lead fell 38.9% — ad spend rose 10% and leads rose 80%.',
  )
  const flatDen = ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 1200, spend: 100 })
  assert.equal(
    narrateRatio(flatDen, { label: 'ROAS', numLabel: 'Revenue', denLabel: 'Ad spend' }),
    'ROAS rose 20% — revenue rose 20% and ad spend held flat.',
  )
})

test('narrateRatio is empty for a null decomposition', () => {
  assert.equal(narrateRatio(null), '')
  assert.equal(narrateRatio(ratioAttribution('roas', { revenue: 1000, spend: 100 }, { revenue: 1000, spend: 100 })), '')
})
