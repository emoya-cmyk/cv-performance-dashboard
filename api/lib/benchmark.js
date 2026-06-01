'use strict'

// ============================================================
// lib/benchmark.js — portfolio-relative percentile ranking ("peer benchmarking").
//
// Every other detector in the intelligence layer measures a client against its
// OWN history (baselines.js → anomaly/trend/forecast). This module adds the one
// axis they cannot see: how a client stacks up against the REST OF THE PORTFOLIO
// right now. A $80 CPL is meaningless in isolation — it is a triumph if peers sit
// at $120 and a fire drill if they sit at $40. The benchmark is the live portfolio
// itself, so it self-calibrates with zero operator config: connect another account
// and the cohort re-shapes on the next sweep. The more accounts, the sharper it
// gets — intelligence that compounds purely with scale.
//
// DIRECTION-AWARE. "percentile" here always means HOW GOOD, never how high. For a
// good-when-up metric (roas, leads, revenue) a high value ranks high; for a
// good-when-down metric (cpl, spend) a LOW value ranks high. We orient each value
// once (u = goodWhenUp ? v : −v) and rank on the oriented cohort, so the number
// reads the same way for every metric: ~100 = best performer, ~0 = worst, ~50 =
// the portfolio median.
//
// CONSERVATIVE BY CONSTRUCTION, like the rest of the engine:
//   • MIN_COHORT gate — below it, percentiles are withheld (cohort:'insufficient').
//     A percentile across three accounts is statistically thin AND privacy-thin, so
//     we degrade to a bare rank ("2 of 3") that the agency surface may show and the
//     client surface must not. Mirrors baselines' minN "insufficient_history" guard.
//   • spread guard — when every peer is identical there is nothing to compare, so
//     nobody is flagged a standout.
//   • mean-rank percentile lands strictly inside (0,100): the best peer is never a
//     misleading exact 100, the worst never an exact 0.
//
// Pure functions only — no DB, no clock, no LLM, never throws, and a strict no-op
// under a thin cohort. Safe to require from the engine, a route, or a test. The
// caller owns privacy: clientStanding() returns ONLY the asking client's own number
// against the anonymous distribution — never a peer's id, name, or value.
// ============================================================

// Minimum number of finite-valued peers before a percentile is trustworthy enough
// to publish. Below this we still expose ranks (agency-only) but withhold the
// percentile/quartile/standout verdicts.
const MIN_COHORT = 5

// Oriented-standing → quartile bucket. Cutoffs are on the 0–100 "how good" scale,
// so they read identically for good-when-up and good-when-down metrics.
const QUARTILE_CUTOFFS = [
  { quartile: 'top',    min: 75 }, // best quarter of the portfolio
  { quartile: 'upper',  min: 50 },
  { quartile: 'lower',  min: 25 },
  { quartile: 'bottom', min: 0 },  // worst quarter — the triage candidates
]

// A real, comparable number: finite, and NOT a boolean (true would coerce to 1).
// Strings/null/undefined/NaN are absent, never silently coerced to 0 — same
// discipline as baselines.finite, kept local so this module stands alone.
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

// Linear-interpolation quantile (type-7, the NumPy/d3 default) over a pre-sorted
// ascending array. Deterministic and standard, so the distribution numbers are
// stable across runs and easy to pin in tests. null on empty input.
function quantile(sortedAsc, p) {
  const n = sortedAsc.length
  if (n === 0) return null
  if (n === 1) return sortedAsc[0]
  const idx = p * (n - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  return sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo])
}

// Mean-rank percentile of u within values, as a fraction in (0,1):
//   (count strictly below + half the ties) / n.
// The half-tie term makes it symmetric (the lone element of a set scores 0.5, the
// dead-center value scores ~0.5) and keeps the extremes strictly inside (0,1):
// the max of n distinct values is (n−0.5)/n, never 1; the min is 0.5/n, never 0.
function percentileRank(values, u) {
  const n = values.length
  if (n === 0) return 0
  let below = 0
  let ties = 0
  for (const x of values) {
    if (x < u) below++
    else if (x === u) ties++
  }
  return (below + ties / 2) / n
}

function quartileFromPct(pct) {
  if (!isNum(pct)) return null
  for (const c of QUARTILE_CUTOFFS) if (pct >= c.min) return c.quartile
  return 'bottom'
}

// The cohort distribution for one metric, in NATURAL units (not oriented), so
// p25/median/p75 read the way a human expects. null when no finite values.
function distributionOf(rawValues) {
  const vals = (Array.isArray(rawValues) ? rawValues : []).filter(isNum)
  const n = vals.length
  if (n === 0) return null
  const sorted = vals.slice().sort((a, b) => a - b)
  const sum = sorted.reduce((s, x) => s + x, 0)
  return {
    n,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[n - 1],
    mean: sum / n,
  }
}

// Rank one metric across a cohort of { client_id, client_name, value } observations.
//   goodWhenUp — false for cost/efficiency metrics where lower is better.
//   minCohort  — withhold percentiles below this many finite peers.
// Returns { n, cohort, spread, distribution, clients[] }. Non-finite observations
// are dropped (a client with no data for this metric simply isn't ranked on it).
// clients are sorted best-first; each carries { client_id, client_name, value,
// rank, percentile, quartile, standout }. rank is always filled (meaningful even
// in a thin cohort); percentile/quartile/standout are null until cohort==='ok'.
function benchmarkMetric(observations, opts = {}) {
  const goodWhenUp = opts.goodWhenUp !== false // default: higher is better
  const minCohort = isNum(opts.minCohort) ? opts.minCohort : MIN_COHORT

  const list = (Array.isArray(observations) ? observations : [])
    .filter((o) => o && isNum(o.value))
    .map((o) => ({
      client_id: o.client_id ?? null,
      client_name: o.client_name ?? null,
      value: o.value,
      oriented: goodWhenUp ? o.value : -o.value,
    }))

  const n = list.length
  const distribution = distributionOf(list.map((o) => o.value))
  const cohortOk = n >= minCohort
  // Is there anything to compare? All-identical values → no spread → no standouts.
  const spread = !!distribution && distribution.p75 > distribution.p25

  const orientedAll = list.map((o) => o.oriented)

  // best-first: highest oriented value, then client_name for a stable tie-break.
  const sorted = list.slice().sort((a, b) => {
    if (b.oriented !== a.oriented) return b.oriented - a.oriented
    return String(a.client_name ?? '').localeCompare(String(b.client_name ?? ''))
  })

  const clients = sorted.map((o, i) => {
    const pct = cohortOk ? Math.round(100 * percentileRank(orientedAll, o.oriented)) : null
    const quartile = cohortOk ? quartileFromPct(pct) : null
    return {
      client_id: o.client_id,
      client_name: o.client_name,
      value: o.value,
      rank: i + 1, // 1 = best performer on this metric
      percentile: pct, // 0–100, higher = better; null when cohort thin
      quartile, // top|upper|lower|bottom; null when cohort thin
      // worth a callout only when the cohort is real, there's genuine spread, and
      // this client sits in the best or worst quarter.
      standout: !!(cohortOk && spread && (quartile === 'top' || quartile === 'bottom')),
    }
  })

  return {
    n,
    cohort: cohortOk ? 'ok' : 'insufficient',
    spread,
    distribution,
    clients,
  }
}

// Benchmark every metric at once.
//   byMetric  — { [metric]: observations[] }
//   metaByMetric — { [metric]: { goodWhenUp } } (e.g. insights.METRIC_META); a
//                  missing entry defaults to higher-is-better.
// Returns { [metric]: benchmarkMetric(...) }, skipping metrics with no observations
// so the caller never has to guard empties.
function benchmarkPortfolio(byMetric, metaByMetric = {}, opts = {}) {
  const out = {}
  const src = byMetric && typeof byMetric === 'object' ? byMetric : {}
  for (const metric of Object.keys(src)) {
    const observations = src[metric]
    if (!Array.isArray(observations) || observations.length === 0) continue
    const meta = metaByMetric && metaByMetric[metric]
    out[metric] = benchmarkMetric(observations, {
      goodWhenUp: meta ? meta.goodWhenUp !== false : true,
      minCohort: opts.minCohort,
    })
  }
  return out
}

// Privacy-safe extract for the client-facing surface: the asking client's OWN
// standing per metric, against the ANONYMOUS distribution only. Never returns a
// peer's id, name, or value. Includes a metric only when its cohort is 'ok' AND
// this client has a published percentile — so a thin-cohort rank ("2 of 3") can
// never leak to a client. Sorted best-first (wins lead).
function clientStanding(portfolioBenchmarks, clientId) {
  const out = []
  const src = portfolioBenchmarks && typeof portfolioBenchmarks === 'object' ? portfolioBenchmarks : {}
  for (const metric of Object.keys(src)) {
    const b = src[metric]
    if (!b || b.cohort !== 'ok' || !Array.isArray(b.clients)) continue
    const mine = b.clients.find((c) => c.client_id === clientId)
    if (!mine || !isNum(mine.percentile)) continue
    out.push({
      metric,
      value: mine.value,
      percentile: mine.percentile,
      quartile: mine.quartile,
      rank: mine.rank,
      cohort_size: b.n, // count only — reveals no identities
      median: b.distribution ? b.distribution.median : null,
    })
  }
  out.sort((a, b) => b.percentile - a.percentile)
  return out
}

module.exports = {
  benchmarkMetric,
  benchmarkPortfolio,
  clientStanding,
  distributionOf,
  quantile,
  percentileRank,
  quartileFromPct,
  MIN_COHORT,
  QUARTILE_CUTOFFS,
}
