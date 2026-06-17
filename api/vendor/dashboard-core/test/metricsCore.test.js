// ============================================================
// test/metricsCore.test.js — CHARACTERIZATION test for the derived-KPI core.
//
// lib/metricsCore.js is the SINGLE source of truth for the dashboard's derived
// KPIs: the live metrics endpoints, the Grounded-AI evidence pack, and the
// weekly digest all compute their numbers through `derive`. It also owns the
// wide `AGG` SQL aggregate, the signed `pctChange`, and the generic
// `detectAnomalies` pass. The module had no dedicated test before extraction;
// this test was written FIRST to capture its current observable behavior so the
// thin re-export (cv api/lib/metricsCore.js) can be proven faithful.
//
// What is pinned here:
//   - derive(): numeric coercion of every input column, the four totals, and the
//     three guarded ratios (roas / close_rate / cpl), each computed by hand.
//   - the cold-start hardening: empty / absent / NaN / Infinity inputs all stay
//     finite (no NaN, no Infinity) — the property the module was hardened for.
//   - AGG: shape (a SELECT-list string covering every column + weeks_count).
//   - pctChange(): signed change with the null guard for missing/zero prior.
//   - detectAnomalies(): threshold filter, the zero/absent-prior skip, and the
//     magnitude-descending sort.
//
// Pure functions: no DB, no LLM. Hand-computed expectations only.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { AGG, derive, pctChange, detectAnomalies } = require('..')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x)

// ---- derive: totals + ratios over a representative row ----------------------

test('derive: totals and guarded ratios are computed by hand', () => {
  const row = {
    ads_spend: 100,
    lsa_spend: 50,
    meta_spend: 25,
    raw_leads: 40,
    closed_won: 10,
    projected_revenue: 1750,
  }
  const r = derive(row)

  // total_spend = ads + lsa + meta
  approx(r.total_spend, 175)
  // passthrough totals
  approx(r.total_leads, 40)
  approx(r.total_closed, 10)
  approx(r.total_revenue, 1750)
  // roas = revenue / spend = 1750 / 175 = 10
  approx(r.roas, 10)
  // close_rate = closed / leads * 100 = 10/40*100 = 25
  approx(r.close_rate, 25)
  // cpl = spend / leads = 175 / 40 = 4.375
  approx(r.cpl, 4.375)
})

test('derive: string inputs are coerced numerically (parseFloat)', () => {
  const r = derive({
    ads_spend: '100',
    lsa_spend: '50',
    meta_spend: '0',
    raw_leads: '40',
    closed_won: '10',
    projected_revenue: '1500',
  })
  approx(r.total_spend, 150)
  approx(r.roas, 10)        // 1500 / 150
  approx(r.cpl, 3.75)       // 150 / 40
  approx(r.close_rate, 25)  // 10/40*100
})

// ---- derive: cold-start hardening (no NaN / no Infinity) --------------------

test('derive: an empty row yields all-zero finite derived KPIs', () => {
  const r = derive({})
  for (const k of ['total_spend', 'total_leads', 'total_closed', 'total_revenue',
                   'roas', 'close_rate', 'cpl']) {
    assert.equal(r[k], 0, `${k} should be 0`)
    assert.ok(isFiniteNum(r[k]), `${k} should be finite`)
  }
})

test('derive: null/undefined row is treated as empty (no throw, all finite)', () => {
  for (const input of [null, undefined]) {
    const r = derive(input)
    assert.equal(r.total_spend, 0)
    assert.equal(r.roas, 0)
    assert.equal(r.close_rate, 0)
    assert.equal(r.cpl, 0)
  }
})

test('derive: zero leads/spend never produce Infinity or NaN', () => {
  // spend present but zero leads → close_rate and cpl guard to 0
  const r1 = derive({ ads_spend: 100, raw_leads: 0, projected_revenue: 500 })
  assert.equal(r1.close_rate, 0)
  assert.equal(r1.cpl, 0)
  approx(r1.roas, 5) // 500 / 100
  // zero spend → roas guards to 0 (no divide-by-zero)
  const r2 = derive({ ads_spend: 0, raw_leads: 10, closed_won: 2, projected_revenue: 500 })
  assert.equal(r2.roas, 0)
  approx(r2.close_rate, 20)
  for (const k of ['roas', 'close_rate', 'cpl']) {
    assert.ok(isFiniteNum(r1[k]) && isFiniteNum(r2[k]))
  }
})

test('derive: NaN and non-numeric inputs are neutralized to 0 (finite)', () => {
  // The documented cold-start hardening: a degenerate/empty row (missing columns,
  // NaN, or non-numeric strings) must NOT yield NaN. `parseFloat(NaN)||0 = 0` and
  // `parseFloat('not-a-number')||0 = 0`, so every derived KPI stays a finite 0.
  const r = derive({
    ads_spend: NaN,
    lsa_spend: NaN,
    meta_spend: NaN,
    raw_leads: 'not-a-number',
    closed_won: NaN,
    projected_revenue: NaN,
  })
  for (const k of ['total_spend', 'total_leads', 'total_closed', 'total_revenue',
                   'roas', 'close_rate', 'cpl']) {
    assert.equal(r[k], 0, `${k} should be 0`)
    assert.ok(isFiniteNum(r[k]), `${k} should be finite, got ${r[k]}`)
  }
})

test('derive: literal Infinity passes through parseFloat (documented as-is behavior)', () => {
  // CHARACTERIZATION (not aspiration): the hardening neutralizes NaN, but
  // `parseFloat(Infinity) === Infinity`, so a literal Infinity on an additive
  // column is NOT scrubbed — it flows through. Real weekly_reports rows never
  // contain literal Infinity, so this never bites in practice, but the re-export
  // must reproduce it exactly. Pinned here so any drift is caught.
  const r = derive({ lsa_spend: Infinity, meta_spend: -Infinity, projected_revenue: Infinity })
  assert.equal(r.lsa_spend, Infinity)
  assert.equal(r.meta_spend, -Infinity)
  assert.equal(r.total_revenue, Infinity)
  // Infinity + (-Infinity) === NaN on the additive total — the exact current output.
  assert.ok(Number.isNaN(r.total_spend))
  // ratios still guard: total_spend is not > 0 (it's NaN), so roas falls to 0.
  assert.equal(r.roas, 0)
})

test('derive: arbitrary input columns are coerced and preserved', () => {
  const r = derive({ ads_clicks: '123', ga4_sessions: 45, gbp_views: 'x' })
  assert.equal(r.ads_clicks, 123)
  assert.equal(r.ga4_sessions, 45)
  assert.equal(r.gbp_views, 0) // non-numeric -> 0
})

// ---- AGG: shape -------------------------------------------------------------

test('AGG: is a SELECT-list string covering the key columns + weeks_count', () => {
  assert.equal(typeof AGG, 'string')
  for (const col of ['ads_spend', 'raw_leads', 'closed_won', 'projected_revenue',
                     'ads_roas', 'avg_ticket', 'weeks_count']) {
    assert.ok(AGG.includes(col), `AGG should reference ${col}`)
  }
  // ratio columns use AVG(NULLIF(...)) so empty weeks don't drag the mean down
  assert.ok(AGG.includes('AVG(NULLIF(ads_roas,0))'))
})

// ---- pctChange --------------------------------------------------------------

test('pctChange: signed percent change with null guard', () => {
  approx(pctChange(150, 100), 50)
  approx(pctChange(50, 100), -50)
  assert.equal(pctChange(10, 0), null)    // zero prior -> null
  assert.equal(pctChange(10, null), null) // missing prior -> null
  assert.equal(pctChange(10, undefined), null)
  approx(pctChange(0, 100), -100)         // current zero is a real -100%
})

// ---- detectAnomalies --------------------------------------------------------

test('detectAnomalies: threshold filter, zero-prior skip, magnitude sort', () => {
  const curr = { a: 200, b: 110, c: 50, d: 5 }
  const past = { a: 100, b: 100, c: 0, d: 4 }
  const checks = [
    { key: 'a', label: 'A' }, // +100%
    { key: 'b', label: 'B' }, // +10%  (below threshold)
    { key: 'c', label: 'C' }, // prior 0 -> skipped
    { key: 'd', label: 'D' }, // +25%
  ]
  const out = detectAnomalies(curr, past, checks, 20)
  // b filtered (10% < 20), c skipped (zero prior); a and d remain
  assert.deepEqual(out.map((o) => o.key), ['a', 'd'])
  // sorted by |pct_change| descending: a(100) before d(25)
  approx(out[0].pct_change, 100)
  approx(out[1].pct_change, 25)
  assert.deepEqual(out[0], { key: 'a', label: 'A', current: 200, previous: 100, pct_change: 100 })
})

test('detectAnomalies: absent prior key is skipped (no NaN leak)', () => {
  const out = detectAnomalies({ x: 50 }, {}, [{ key: 'x', label: 'X' }], 1)
  assert.deepEqual(out, [])
})

test('detectAnomalies: empty checks yields empty result', () => {
  assert.deepEqual(detectAnomalies({}, {}, [], 10), [])
})
