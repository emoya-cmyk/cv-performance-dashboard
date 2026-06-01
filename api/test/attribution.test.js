// ============================================================
// test/attribution.test.js — the "why" behind a movement.
//
// lib/attribution.js decomposes a change in either composite KPI (revenue, jobs)
// into the EXACT contributions of its stored drivers, because each composite is
// an exact product: revenue ≡ spend × roas and jobs ≡ leads × (close_rate/100).
// In log space the decomposition is exact and the driver shares sum to 1. These
// tests pin: the single-driver case (one lever does all the work), the both-move
// case (shares split by log-contribution, dominant driver identified), the
// SIGNED case (a driver moving opposite the composite cushions it → negative
// share, > 1 on the aligned driver), and the null guards (non-composite metric,
// non-positive/missing driver where the log is undefined, and a flat composite
// — each a pure no-op the engine renders as "no why"). Pure: no DB, no clock.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  attributeChange, isComposite, driversOf, compositeMetrics, IDENTITIES,
} = require('../lib/attribution')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)

// ---- single driver carries the whole move ----------------------------------

test('attributeChange: revenue down entirely on spend — roas flat', () => {
  // spend 1000→800 (−20%), roas held at 4 → revenue 4000→3200 (−20%). The whole
  // move is spend; roas contributes nothing. share spend = 1, roas = 0.
  const a = attributeChange('revenue', { spend: 1000, roas: 4 }, { spend: 800, roas: 4 })
  assert.ok(a)
  assert.equal(a.metric, 'revenue')
  assert.equal(a.direction, 'down')
  approx(a.pct, -20)                              // 100·(0.8·1 − 1)
  assert.equal(a.lead, 'spend')

  assert.equal(a.drivers.length, 2)
  const [spend, roas] = a.drivers                 // presentation order: spend before roas
  assert.equal(spend.metric, 'spend')
  approx(spend.pct, -20)
  approx(spend.share, 1)
  assert.equal(spend.share_pct, 100)
  assert.equal(roas.metric, 'roas')
  approx(roas.pct, 0)
  approx(roas.share, 0)
  assert.equal(roas.share_pct, 0)

  approx(spend.share + roas.share, 1)             // shares sum to exactly 1
})

// ---- both drivers move; shares split by log-contribution --------------------

test('attributeChange: jobs down — leads and close rate both fall, leads dominates', () => {
  // leads 100→85 (−15%), close_rate 20→18.4 (−8%) → jobs 20→15.64 (−21.8%).
  // ln(0.85) = −0.16252, ln(0.92) = −0.08338, total = −0.24590.
  // leads share = 0.16252/0.24590 ≈ 0.6609, close_rate ≈ 0.3391 → leads leads.
  const a = attributeChange('jobs', { leads: 100, close_rate: 20 }, { leads: 85, close_rate: 18.4 })
  assert.ok(a)
  assert.equal(a.metric, 'jobs')
  assert.equal(a.direction, 'down')
  approx(a.pct, -21.8)                            // 100·(0.85·0.92 − 1) = −21.8
  assert.equal(a.lead, 'leads')

  // Expected shares derived from the SAME exact log-decomposition the module
  // uses (ln(ratio) / Σln(ratio)) rather than hand-rounded constants — so the
  // assertion pins the identity itself, not a transcription of it, and can't
  // drift by a float ULP.
  const tl = Math.log(85 / 100) + Math.log(18.4 / 20)
  const [leads, close] = a.drivers
  assert.equal(leads.metric, 'leads')
  approx(leads.pct, -15)
  approx(leads.share, Math.log(85 / 100) / tl)
  assert.equal(leads.share_pct, 66)
  assert.equal(close.metric, 'close_rate')
  approx(close.pct, -8)
  approx(close.share, Math.log(18.4 / 20) / tl)
  assert.equal(close.share_pct, 34)

  approx(leads.share + close.share, 1)            // exact partition of the log-move
})

// ---- signed shares: a driver moving the OTHER way cushions the move ---------

test('attributeChange: revenue down despite spend UP — roas is the real culprit', () => {
  // spend 1000→1100 (+10%, pushes revenue UP), roas 4→3 (−25%). Net revenue
  // 4000→3300 (−17.5%). ln(1.1)=+0.09531, ln(0.75)=−0.28768, total=−0.19237.
  // spend share = +0.09531/−0.19237 = −0.4954 (NEGATIVE — it cushioned the drop);
  // roas share = −0.28768/−0.19237 = +1.4954 (> 1 — it caused MORE than the whole
  // drop). roas is the lever to pull.
  const a = attributeChange('revenue', { spend: 1000, roas: 4 }, { spend: 1100, roas: 3 })
  assert.ok(a)
  assert.equal(a.direction, 'down')
  approx(a.pct, -17.5)                            // 100·(1.1·0.75 − 1)
  assert.equal(a.lead, 'roas')                    // largest (aligned) share, not spend

  const [spend, roas] = a.drivers
  approx(spend.pct, 10)                           // spend genuinely ROSE
  assert.ok(spend.share < 0, 'spend share is negative — it cushioned the drop')
  assert.equal(spend.share_pct, -50)
  approx(roas.pct, -25)
  assert.ok(roas.share > 1, 'roas share exceeds 1 — it over-explains the move')
  assert.equal(roas.share_pct, 150)

  approx(spend.share + roas.share, 1)             // signed parts still sum to 1
})

// ---- null guards: every degenerate input is a clean no-op -------------------

test('attributeChange: non-composite metric has no identity → null', () => {
  // leads/close_rate/roas/spend are themselves drivers, not products of drivers.
  assert.equal(attributeChange('leads', { x: 1 }, { x: 2 }), null)
  assert.equal(attributeChange('close_rate', { a: 1 }, { a: 2 }), null)
  assert.equal(attributeChange('cpl', {}, {}), null)
})

test('attributeChange: a non-positive or missing driver is undefined in log space → null', () => {
  // The logarithm is undefined at or below zero, so any zero / negative / NaN
  // driver at either endpoint means there is no honest decomposition — return
  // null rather than invent one.
  assert.equal(attributeChange('revenue', { spend: 0,    roas: 4 }, { spend: 800,  roas: 4 }), null)
  assert.equal(attributeChange('revenue', { spend: 1000, roas: 4 }, { spend: -1,   roas: 4 }), null)
  assert.equal(attributeChange('jobs',    { leads: 100,  close_rate: 20 }, { leads: 85 /* close_rate missing */ }), null)
  assert.equal(attributeChange('revenue', null, { spend: 800, roas: 4 }), null)
  assert.equal(attributeChange('revenue', { spend: 1000, roas: 4 }, null), null)
})

test('attributeChange: a composite that did not move → null (nothing to attribute)', () => {
  // Identical endpoints → totalLog 0 → no denominator → no "why".
  assert.equal(attributeChange('revenue', { spend: 1000, roas: 4 }, { spend: 1000, roas: 4 }), null)
  // …and a move below the epsilon is treated the same.
  assert.equal(attributeChange('jobs', { leads: 100, close_rate: 20 }, { leads: 100, close_rate: 20 }), null)
})

// ---- catalogue helpers ------------------------------------------------------

test('isComposite / driversOf / compositeMetrics expose the identity catalogue', () => {
  assert.equal(isComposite('revenue'), true)
  assert.equal(isComposite('jobs'), true)
  assert.equal(isComposite('leads'), false)
  assert.equal(isComposite('roas'), false)

  assert.deepEqual(driversOf('revenue'), ['spend', 'roas'])
  assert.deepEqual(driversOf('jobs'), ['leads', 'close_rate'])
  assert.equal(driversOf('leads'), null)

  // driversOf returns a COPY — a caller mutating it can't corrupt the catalogue.
  const d = driversOf('jobs')
  d.push('tampered')
  assert.deepEqual(driversOf('jobs'), ['leads', 'close_rate'])

  assert.deepEqual(compositeMetrics().sort(), ['jobs', 'revenue'])
  // The exported catalogue matches exactly the two exact identities.
  assert.deepEqual(Object.keys(IDENTITIES).sort(), ['jobs', 'revenue'])
})
