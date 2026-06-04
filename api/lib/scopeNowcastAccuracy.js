'use strict'
// lib/scopeNowcastAccuracy.js — intel-v14 D4 (step a): the nowcast GRADES ITSELF.
//
// D3 (scopeNowcast) projected where a streak is heading "at this pace". The honest next
// question — and the one that makes this layer self-improving rather than just confident —
// is: how well have those projections actually held up? This module answers it by
// BACKTESTING our own nowcast against the very read history the FE already buffers.
//
// The method is a faithful replay, not a re-derivation. For each interior prefix of the
// ordered read series we re-run the REAL pipeline — detectScopeTrends → projectScopeTrend —
// to reproduce the exact one-step projection that WOULD have been shown after that read,
// then compare it to the read that actually followed. Aggregating those hits per metric and
// overall yields a defensible "within ~X% of actual" confidence we can surface beneath the
// live nowcast. Because it replays the same functions the live path uses, the grade can
// only drift from reality if those functions do — there is no second oracle to disagree.
//
// Design properties (the same discipline as its D1/D2/D3 siblings):
//   • PURE + leak-safe by construction — the sole input is the ordered list of ALREADY
//     leak-safe scope-insight reads (metric ids + absolute scope totals + channel-axis
//     labels; never any tenant identity). normalizeSnapshot is the SAME helper the trend
//     core uses to read a snapshot, so "actual" means exactly what the pipeline would see —
//     and it surfaces a metric's value even when the streak BROKE, so an overshoot is graded
//     honestly, not silently dropped. This module sees no clientId and emits none; its
//     output is metric labels + bare error statistics, identical on agency and client.
//   • honest error metric — a symmetric absolute percentage error (|proj−act| ÷ the mean of
//     their magnitudes) so it is scale-free across revenue (~$10k), roas (~3) and counts,
//     naturally bounded to [0,200]%, and stable when a value sits near zero. The reported
//     confidence is the AVERAGE such error over every in-buffer check, never a cherry-picked
//     best case, and the sample COUNT always rides alongside so a thin grade can't overclaim.
//   • one-step only — we grade the horizon-1 projection ("next update"), the single horizon
//     for which an actual next read exists; multi-step claims aren't gradeable from the
//     buffer and so aren't made.
//   • deterministic — no clock, no RNG, no DB; stable per-metric sort; same input → same
//     output (so the D-series deepEqual determinism checks stay green).
//   • fail-safe — too little history, no streak ever formed, or malformed input all degrade
//     to { status:'none', metrics:[] }; it never throws.
const { detectScopeTrends } = require('./scopeTrend')
const { projectScopeTrend } = require('./scopeNowcast')
const { normalizeSnapshot } = require('./scopeDelta')
const { METRICS } = require('./ask')

const isNum  = (v) => v != null && Number.isFinite(Number(v))
const EPS    = 1e-9
const round2 = (n) => Math.round(Number(n) * 100) / 100
const clamp  = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// A trend needs minRunSteps+1 reads to project, and one more read to grade that projection
// against reality — so 4 reads is the floor before any grade can exist.
const MIN_READS = 4
// sMAPE bands → a plain-language grade. Tuned so a tight run reads as "tight".
const GRADE = (smape) => (smape <= 10 ? 'tight' : smape <= 25 ? 'fair' : 'loose')

// Symmetric absolute percentage error between a projection and what actually happened,
// in percent, bounded to [0,200]. Both exactly zero ⇒ a perfect 0 (not a divide-by-zero).
function symPctError(projected, actual) {
  const a = Number(actual)
  const p = Number(projected)
  const denom = (Math.abs(a) + Math.abs(p)) / 2
  if (denom < EPS) return 0
  return clamp((Math.abs(p - a) / denom) * 100, 0, 200)
}

// The headline number is the AVERAGE error; "<1" rather than a misleading rounded "0" once
// there is any error at all, and a bare "0" only for a genuinely perfect record.
function fmtPct(smape) {
  if (smape === 0) return '0'
  return smape < 1 ? '<1' : String(Math.round(smape))
}

function buildAccuracyHeadline(samples, smape) {
  const n = Math.max(0, Number(samples) || 0)
  if (!n) return null
  const unit = n === 1 ? 'check' : 'checks'
  return `Recent projections have landed within ~${fmtPct(smape)}% of actual — ${n} ${unit}.`
}

// gradeScopeNowcast(history, opts)
//   history : the ordered (oldest→newest) read series the nowcast sees — each read one of
//             the leak-safe shapes normalizeSnapshot accepts (compact [{metric,current}] or a
//             full scope-insight payload). This is the same array passed to detectScopeTrends.
//   opts    : forwarded to detectScopeTrends for a faithful replay ({minRunSteps, minStepCents,
//             maxReads}); plus { band=15 } (the "within X%" hit threshold) and
//             { minSamples=1 } (grades below this stay status 'none').
// Returns { status, metrics[], overall, headline, meta }.
//   status : 'none'   — too little history / no streak ever formed / malformed input;
//            'graded' — at least minSamples one-step projections were checked against actuals.
//   metrics[] : per-metric { metric, metric_label, samples, hits, within, smape, accuracyPct,
//               lastErrorPct }, sorted most-evidenced first.
//   overall   : pooled { samples, hits, within, smape, accuracyPct, grade } (null when 'none').
function gradeScopeNowcast(history, opts) {
  const none = {
    status: 'none', metrics: [], overall: null, headline: null,
    meta: { reads: 0, checks: 0, gradedMetrics: 0, band: 15, horizon: 1, basis: 'one-step-backtest' },
  }
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const band = isNum(o.band) ? Math.max(0, Number(o.band)) : 15
    const minSamples = Number.isInteger(o.minSamples) ? Math.max(1, o.minSamples) : 1
    none.meta.band = band

    const reads = Array.isArray(history) ? history : []
    if (reads.length < MIN_READS) return { ...none, meta: { ...none.meta, reads: reads.length } }

    // One sample per (interior prefix × projected metric): replay the projection that would
    // have been shown after read k, then compare to the actual value at read k+1.
    const samples = []
    for (let k = 2; k <= reads.length - 2; k++) {
      let projection
      try {
        const trend = detectScopeTrends(reads.slice(0, k + 1), o)
        if (!trend || trend.status !== 'trending') continue
        projection = projectScopeTrend(trend, { horizon: 1 })
      } catch { continue }
      if (!projection || projection.status !== 'projected') continue

      let actualMap
      try { actualMap = normalizeSnapshot(reads[k + 1]) } catch { actualMap = null }
      if (!actualMap || typeof actualMap.get !== 'function') continue

      for (const p of projection.projections) {
        if (!p || p.metric == null || !isNum(p.projected)) continue
        if (!actualMap.has(p.metric)) continue              // no actual surfaced → not gradeable
        const actual = actualMap.get(p.metric)
        if (!actual || !isNum(actual.current)) continue
        const errPct = symPctError(p.projected, actual.current)
        samples.push({
          metric: String(p.metric),
          metric_label: p.metric_label != null ? String(p.metric_label)
            : (METRICS[p.metric] && METRICS[p.metric].label) || String(p.metric),
          errPct,
          hit: errPct <= band,
        })
      }
    }

    if (samples.length < minSamples) {
      return { ...none, meta: { ...none.meta, reads: reads.length } }
    }

    // Per-metric aggregation. Insertion order tracks first appearance; the final array is
    // sorted deterministically so output never depends on metric-id hashing.
    const byMetric = new Map()
    for (const s of samples) {
      let agg = byMetric.get(s.metric)
      if (!agg) {
        agg = { metric: s.metric, metric_label: s.metric_label, samples: 0, hits: 0, errSum: 0, lastErrorPct: 0 }
        byMetric.set(s.metric, agg)
      }
      agg.samples += 1
      agg.hits += s.hit ? 1 : 0
      agg.errSum += s.errPct
      agg.lastErrorPct = s.errPct          // samples are pushed oldest→newest → last wins
      agg.metric_label = s.metric_label    // freshest label
    }

    const metrics = [...byMetric.values()].map((a) => {
      const smape = a.errSum / a.samples
      return {
        metric: a.metric,
        metric_label: a.metric_label,
        samples: a.samples,
        hits: a.hits,
        within: round2((a.hits / a.samples) * 100),
        smape: round2(smape),
        accuracyPct: round2(clamp(100 - smape, 0, 100)),
        lastErrorPct: round2(a.lastErrorPct),
      }
    })
    metrics.sort((x, y) =>
      (y.samples - x.samples) ||
      (x.smape - y.smape) ||
      (x.metric < y.metric ? -1 : x.metric > y.metric ? 1 : 0))

    const totalSamples = samples.length
    const totalHits = samples.reduce((n, s) => n + (s.hit ? 1 : 0), 0)
    const overallSmape = samples.reduce((n, s) => n + s.errPct, 0) / totalSamples
    const overall = {
      samples: totalSamples,
      hits: totalHits,
      within: round2((totalHits / totalSamples) * 100),
      smape: round2(overallSmape),
      accuracyPct: round2(clamp(100 - overallSmape, 0, 100)),
      grade: GRADE(overallSmape),
    }

    return {
      status: 'graded',
      metrics,
      overall,
      headline: buildAccuracyHeadline(totalSamples, overallSmape),
      meta: {
        reads: reads.length,
        checks: totalSamples,
        gradedMetrics: metrics.length,
        band,
        horizon: 1,
        basis: 'one-step-backtest',
      },
    }
  } catch {
    return none
  }
}

module.exports = { gradeScopeNowcast, buildAccuracyHeadline, symPctError }
