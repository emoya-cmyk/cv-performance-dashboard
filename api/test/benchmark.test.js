// ============================================================
// test/benchmark.test.js — "how does this client stack up against its peers?"
//
// lib/benchmark.js ranks each client's KPIs against the LIVE portfolio distribution
// and reports a direction-aware percentile (~100 = best performer, ~0 = worst, ~50 =
// portfolio median) regardless of whether the metric is good-when-up (roas) or
// good-when-down (cpl). These tests pin: exact quantiles + percentiles; that the
// orientation truly flips for cost metrics (lowest cpl ranks best); that mean-rank
// keeps every percentile strictly inside (0,100); the MIN_COHORT no-op (thin cohort
// → ranks only, percentiles withheld); the all-identical "no spread → no standout"
// guarantee; that non-finite values are dropped (never coerced — true ≠ 1); the
// client-facing privacy contract (own number only, never a peer's identity, never a
// thin-cohort leak); and determinism. Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  benchmarkMetric, benchmarkPortfolio, clientStanding,
  distributionOf, quantile, percentileRank, quartileFromPct,
  MIN_COHORT, QUARTILE_CUTOFFS,
} = require('../lib/benchmark')

// tiny observation builder — { client_id, client_name, value }
const o = (client_id, value, client_name) => ({ client_id, value, client_name: client_name ?? client_id })
// a clean 5-peer cohort with distinct values 10..50 (≥ MIN_COHORT)
const five = () => [o('a', 10), o('b', 20), o('c', 30), o('d', 40), o('e', 50)]
const find = (r, id) => r.clients.find((c) => c.client_id === id)

// ---- totality: empty / null / garbage never throws, surfaces nothing ----------

test('benchmarkMetric: empty / null / garbage → insufficient, no distribution, no clients', () => {
  for (const input of [[], null, undefined, 42, { nope: true }, 'x']) {
    const b = benchmarkMetric(input)
    assert.equal(b.cohort, 'insufficient')
    assert.equal(b.n, 0)
    assert.equal(b.distribution, null)
    assert.equal(b.spread, false)
    assert.deepEqual(b.clients, [])
  }
})

test('MIN_COHORT is the documented threshold', () => {
  assert.equal(MIN_COHORT, 5)
})

// ---- exact distribution (natural units, type-7 quantiles) ----------------------

test('distributionOf: pins min/p25/median/p75/max/mean on a clean 5-set', () => {
  const d = distributionOf([50, 10, 30, 20, 40]) // unsorted on purpose
  assert.deepEqual(d, { n: 5, min: 10, p25: 20, median: 30, p75: 40, max: 50, mean: 30 })
})

test('distributionOf: interpolates between samples (n=4)', () => {
  const d = distributionOf([10, 20, 30, 40])
  assert.equal(d.p25, 17.5)   // 0.75 of the way 10→20
  assert.equal(d.median, 25)  // halfway 20→30
  assert.equal(d.p75, 32.5)   // 0.25 of the way 30→40
})

test('distributionOf: empty → null', () => {
  assert.equal(distributionOf([]), null)
  assert.equal(distributionOf(['x', null, true]), null) // nothing finite
})

// ---- exact percentiles + quartiles + ranks, good-when-up -----------------------

test('benchmarkMetric: good-when-up cohort — exact percentile/quartile/rank/standout', () => {
  const b = benchmarkMetric(five()) // default goodWhenUp = true
  assert.equal(b.cohort, 'ok')
  assert.equal(b.n, 5)
  assert.equal(b.spread, true)

  // best performer (highest value) → rank 1, top quartile, flagged standout
  assert.deepEqual(find(b, 'e'), {
    client_id: 'e', client_name: 'e', value: 50,
    rank: 1, percentile: 90, quartile: 'top', standout: true,
  })
  assert.deepEqual(find(b, 'd'), {
    client_id: 'd', client_name: 'd', value: 40,
    rank: 2, percentile: 70, quartile: 'upper', standout: false,
  })
  assert.deepEqual(find(b, 'c'), {
    client_id: 'c', client_name: 'c', value: 30,
    rank: 3, percentile: 50, quartile: 'upper', standout: false,
  })
  assert.deepEqual(find(b, 'b'), {
    client_id: 'b', client_name: 'b', value: 20,
    rank: 4, percentile: 30, quartile: 'lower', standout: false,
  })
  // worst performer → rank 5, bottom quartile, flagged standout (a triage candidate)
  assert.deepEqual(find(b, 'a'), {
    client_id: 'a', client_name: 'a', value: 10,
    rank: 5, percentile: 10, quartile: 'bottom', standout: true,
  })

  // clients come back best-first
  assert.deepEqual(b.clients.map((c) => c.client_id), ['e', 'd', 'c', 'b', 'a'])
})

// ---- the defining property: direction-awareness --------------------------------

test('benchmarkMetric: good-when-DOWN flips it — the LOWEST value ranks best', () => {
  const b = benchmarkMetric(five(), { goodWhenUp: false }) // e.g. cpl / spend
  // lowest cpl (value 10) is now the champion: rank 1, top, percentile 90
  assert.deepEqual(find(b, 'a'), {
    client_id: 'a', client_name: 'a', value: 10,
    rank: 1, percentile: 90, quartile: 'top', standout: true,
  })
  // highest cpl (value 50) is now the laggard: rank 5, bottom, percentile 10
  assert.deepEqual(find(b, 'e'), {
    client_id: 'e', client_name: 'e', value: 50,
    rank: 5, percentile: 10, quartile: 'bottom', standout: true,
  })
  // distribution stays in NATURAL units regardless of orientation
  assert.equal(b.distribution.median, 30)
  assert.deepEqual(b.clients.map((c) => c.client_id), ['a', 'b', 'c', 'd', 'e'])
})

// ---- mean-rank keeps percentiles strictly inside (0,100) -----------------------

test('benchmarkMetric: no percentile is ever a misleading exact 0 or 100', () => {
  const b = benchmarkMetric(five())
  for (const c of b.clients) {
    assert.ok(c.percentile > 0 && c.percentile < 100, `${c.client_id}=${c.percentile} strictly inside (0,100)`)
  }
  // ranks are a strict 1..n permutation, best-first
  assert.deepEqual(b.clients.map((c) => c.rank), [1, 2, 3, 4, 5])
})

test('benchmarkMetric: rank is monotone with oriented performance (up & down)', () => {
  const up = benchmarkMetric(five())
  // higher value ⇒ better rank (lower number) when good-when-up
  assert.ok(find(up, 'e').rank < find(up, 'a').rank)
  const down = benchmarkMetric(five(), { goodWhenUp: false })
  // higher value ⇒ worse rank when good-when-down
  assert.ok(find(down, 'e').rank > find(down, 'a').rank)
})

// ---- the MIN_COHORT no-op: thin cohort yields ranks, never percentiles ---------

test('benchmarkMetric: below MIN_COHORT → insufficient; ranks kept, percentiles withheld', () => {
  const b = benchmarkMetric([o('a', 10), o('b', 20), o('c', 30)]) // n=3 < 5
  assert.equal(b.cohort, 'insufficient')
  assert.equal(b.n, 3)
  assert.notEqual(b.distribution, null)        // distribution still computed
  assert.equal(b.distribution.median, 20)
  for (const c of b.clients) {
    assert.equal(c.percentile, null, 'percentile withheld in a thin cohort')
    assert.equal(c.quartile, null)
    assert.equal(c.standout, false)
    assert.ok(Number.isInteger(c.rank), 'but a bare rank is still available')
  }
  // best-first ordering still holds
  assert.deepEqual(b.clients.map((c) => c.client_id), ['c', 'b', 'a'])
})

test('benchmarkMetric: a lowered minCohort publishes percentiles for the same thin set', () => {
  const b = benchmarkMetric([o('a', 10), o('b', 20), o('c', 30)], { minCohort: 3 })
  assert.equal(b.cohort, 'ok')
  assert.equal(find(b, 'c').percentile, Math.round(100 * (2.5 / 3))) // 83
  assert.equal(find(b, 'a').percentile, Math.round(100 * (0.5 / 3))) // 17
})

// ---- all-identical: there is nothing to compare, so nobody stands out ----------

test('benchmarkMetric: a flat cohort has no spread and no standouts (all land at 50)', () => {
  const b = benchmarkMetric([o('a', 20), o('b', 20), o('c', 20), o('d', 20), o('e', 20)])
  assert.equal(b.cohort, 'ok')
  assert.equal(b.spread, false) // p75 === p25
  for (const c of b.clients) {
    assert.equal(c.percentile, 50, 'every identical peer is the median')
    assert.equal(c.standout, false, 'no spread ⇒ no standout, even at the extremes')
  }
  // a true tie orders by client_name for stability
  assert.deepEqual(b.clients.map((c) => c.client_id), ['a', 'b', 'c', 'd', 'e'])
})

// ---- non-finite values are dropped, never coerced ------------------------------

test('benchmarkMetric: junk values are dropped — true is NOT 1, "" is NOT 0', () => {
  const b = benchmarkMetric([
    o('a', 10), o('x', 'nope'), o('y', null), o('z', true), o('w', NaN), o('b', 20),
  ])
  assert.equal(b.n, 2, 'only the two finite values count toward the cohort')
  assert.deepEqual(b.clients.map((c) => c.client_id).sort(), ['a', 'b'])
})

// ---- benchmarkPortfolio: orients each metric from its meta --------------------

test('benchmarkPortfolio: orients per-metric from meta, skips empty metrics', () => {
  const byMetric = {
    roas: five(),                // higher is better
    cpl:  five(),                // lower is better
    leads: [],                   // empty → skipped entirely
  }
  const meta = { roas: { goodWhenUp: true }, cpl: { goodWhenUp: false } }
  const out = benchmarkPortfolio(byMetric, meta)

  assert.deepEqual(Object.keys(out).sort(), ['cpl', 'roas'])
  // roas: highest value wins; cpl: lowest value wins
  assert.equal(find(out.roas, 'e').percentile, 90)
  assert.equal(find(out.cpl, 'a').percentile, 90)
  assert.equal(find(out.cpl, 'e').percentile, 10)
})

test('benchmarkPortfolio: a metric absent from meta defaults to higher-is-better', () => {
  const out = benchmarkPortfolio({ jobs: five() }, {})
  assert.equal(find(out.jobs, 'e').percentile, 90) // treated good-when-up
})

// ---- clientStanding: the privacy contract --------------------------------------

test('clientStanding: returns only the asking client\'s own number, never a peer\'s', () => {
  const out = benchmarkPortfolio(
    { roas: five() },
    { roas: { goodWhenUp: true } },
  )
  const mine = clientStanding(out, 'e')
  assert.equal(mine.length, 1)
  // exact key set — no client_id/name/value of any PEER can be present
  assert.deepEqual(Object.keys(mine[0]).sort(), ['cohort_size', 'median', 'metric', 'percentile', 'quartile', 'rank', 'value'])
  assert.equal(mine[0].metric, 'roas')
  assert.equal(mine[0].percentile, 90)
  assert.equal(mine[0].quartile, 'top')
  assert.equal(mine[0].cohort_size, 5) // a count only — reveals no identities
  assert.equal(mine[0].median, 30)
  // nothing in the payload names another client
  const serialized = JSON.stringify(mine)
  for (const peer of ['a', 'b', 'c', 'd']) {
    assert.ok(!serialized.includes(`"${peer}"`), `peer ${peer} must not leak into a client payload`)
  }
})

test('clientStanding: a thin-cohort metric is never exposed to a client', () => {
  const out = benchmarkPortfolio(
    { roas: five(), leads: [o('a', 1), o('b', 2), o('e', 3)] }, // leads cohort = 3 (thin)
    { roas: { goodWhenUp: true }, leads: { goodWhenUp: true } },
  )
  const mine = clientStanding(out, 'e')
  assert.deepEqual(mine.map((m) => m.metric), ['roas']) // leads withheld
})

test('clientStanding: a client absent from the cohort gets nothing for that metric', () => {
  const out = benchmarkPortfolio({ roas: five() }, { roas: { goodWhenUp: true } })
  assert.deepEqual(clientStanding(out, 'ghost'), [])
})

test('clientStanding: multiple metrics come back best-first', () => {
  const out = benchmarkPortfolio(
    { roas: five(), cpl: five() },
    { roas: { goodWhenUp: true }, cpl: { goodWhenUp: false } },
  )
  // client 'c' is the median on roas (50) and the median on cpl (50) → both 50
  // client 'e' is top roas (90) but worst cpl (10) → sorted 90 then 10
  const e = clientStanding(out, 'e')
  assert.deepEqual(e.map((m) => m.percentile), [90, 10])
  assert.deepEqual(e.map((m) => m.metric), ['roas', 'cpl'])
})

// ---- primitives ----------------------------------------------------------------

test('quartileFromPct: cutoffs land on the documented edges', () => {
  assert.equal(quartileFromPct(100), 'top')
  assert.equal(quartileFromPct(75),  'top')
  assert.equal(quartileFromPct(74),  'upper')
  assert.equal(quartileFromPct(50),  'upper')
  assert.equal(quartileFromPct(49),  'lower')
  assert.equal(quartileFromPct(25),  'lower')
  assert.equal(quartileFromPct(24),  'bottom')
  assert.equal(quartileFromPct(0),   'bottom')
  assert.equal(quartileFromPct(null), null)
  assert.equal(quartileFromPct('x'),  null)
})

test('quantile / percentileRank: degenerate inputs never throw', () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([5], 0.5), 5)
  assert.equal(percentileRank([], 3), 0)
  assert.equal(percentileRank([5], 5), 0.5) // the lone element sits at the median
})

test('QUARTILE_CUTOFFS: four buckets, descending, covering 0..100', () => {
  assert.deepEqual(QUARTILE_CUTOFFS.map((c) => c.quartile), ['top', 'upper', 'lower', 'bottom'])
  assert.deepEqual(QUARTILE_CUTOFFS.map((c) => c.min), [75, 50, 25, 0])
})

// ---- determinism ---------------------------------------------------------------

test('benchmarkMetric / clientStanding: pure — identical inputs yield identical output', () => {
  assert.deepEqual(benchmarkMetric(five()), benchmarkMetric(five()))
  const a = benchmarkPortfolio({ roas: five() }, { roas: { goodWhenUp: true } })
  const b = benchmarkPortfolio({ roas: five() }, { roas: { goodWhenUp: true } })
  assert.deepEqual(a, b)
  assert.deepEqual(clientStanding(a, 'e'), clientStanding(b, 'e'))
})
