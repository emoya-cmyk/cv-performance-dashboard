'use strict'
// lib/scopeNowcastBand.js — intel-v14 D5 (step a): the nowcast CALIBRATES ITS OWN UNCERTAINTY.
//
// D3 (scopeNowcast) projected where a streak is heading "at this pace" — a single number. D4
// (scopeNowcastAccuracy) then measured how well those projections have actually held up — a
// symmetric percentage error (sMAPE) over the buffered reads. D5 closes that loop the honest
// way: it turns the MEASURED error into a calibrated interval around the LIVE projection, so
// the nowcast stops implying false precision ("reaches ~$13,000") and instead reads
// "≈ $13,000, likely $12,480–$13,520 (±4%)" — a band sized by the model's OWN recent track
// record. There is no hand-tuned width anywhere: the band tightens as projections get more
// accurate and widens when they have been missing. The width IS the self-grade.
//
// Design properties (the same discipline as its D1–D4 siblings):
//   • PURE + leak-safe — the inputs are the ALREADY leak-safe projection values (metric labels
//     + the run's own bare numbers) and the ALREADY leak-safe accuracy grade (metric labels +
//     bare error statistics). This module sees no clientId and emits none; its output is metric
//     labels + numeric bounds, identical on the agency and client surfaces.
//   • Honest width — the half-width % is the metric's OWN measured sMAPE when it was graded
//     individually, else the pooled overall sMAPE (basis:'overall'), so a thinly-graded metric
//     borrows the only track record there is rather than inventing precision it has not earned.
//     The percentage is applied symmetrically about the projection (sMAPE is itself symmetric),
//     and the lower bound is floored to 0 for a known non-negative engine metric — never drawn
//     through zero, mirroring the D3 floor. An unknown metric's domain is unknown, so it is
//     left unfloored, exactly as D3 leaves it unclamped.
//   • Never tighter than measured — the drawn band can only be CAPPED (a >±200% interval runs
//     off-scale and just means "we can't say"), never shrunk below the measured error, so the
//     surface can never claim more confidence than the backtest supports. The raw sMAPE rides
//     alongside the (possibly capped) drawn width so the payload stays honest either way.
//   • One oracle — magnitudes are rendered with the SAME formatValue/METRICS the nowcast
//     headline uses, so the band reads in the projection's own currency/unit voice and can
//     never disagree with the number it surrounds.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; stable input order; any malformed
//     input degrades to { status:'none', bands:[] } and never throws.
const { formatValue, METRICS } = require('./ask')
const { toCents }              = require('./scopeFreshness')

const isNum  = (v) => v != null && Number.isFinite(Number(v))
const round2 = (n) => Math.round(Number(n) * 100) / 100
const clamp  = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// The widest honest half-width we will DRAW. sMAPE is bounded to [0,200]; a ±200% band already
// says "we really can't say" while staying on-scale, and the floor keeps a non-negative
// metric's low end at 0 rather than below it. The raw measured sMAPE is preserved separately.
const MAX_HALF_PCT = 200

// A magnitude in the projection's own voice — currency/unit via the shared descriptor, or a
// bare rounded number for a metric the engine does not know.
function labelFor(metric, value) {
  const descriptor = METRICS[metric] || null
  return descriptor
    ? formatValue(Math.abs(Number(value)), descriptor)
    : String(Math.round(Number(value) * 100) / 100)
}

// calibrateNowcastBand(nowcast, accuracy, opts)
//   nowcast  : a projectScopeTrend() result ({status, projections:[...]}) — or just projections[].
//   accuracy : a gradeScopeNowcast() result ({status:'graded', metrics:[...], overall}) — or null.
//   opts     : { maxHalfPct=200 } (the widest band drawn; raw sMAPE is preserved regardless).
// Returns { status, bands[], meta }.
//   status : 'none'       — no projection / no usable grade / malformed input;
//            'calibrated' — at least one projection received a measured band.
//   bands[] : per-metric { metric, metric_label, projected, projectedCents, halfPct, drawnHalfPct,
//             lo, hi, loCents, hiCents, loLabel, hiLabel, rangeLabel, floored, basis, samples }.
//             `halfPct` is the raw measured sMAPE; `drawnHalfPct` is what the band actually used
//             (== halfPct unless capped). `basis` is 'metric' (the metric's own grade) or
//             'overall' (the pooled grade, when that metric was not individually graded).
function calibrateNowcastBand(nowcast, accuracy, opts) {
  const none = { status: 'none', bands: [], meta: { calibrated: 0, basis: 'measured-smape', maxHalfPct: MAX_HALF_PCT } }
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const maxHalf = isNum(o.maxHalfPct) ? clamp(Number(o.maxHalfPct), 0, 200) : MAX_HALF_PCT
    none.meta.maxHalfPct = maxHalf

    const projections = Array.isArray(nowcast) ? nowcast
      : (nowcast && typeof nowcast === 'object' && Array.isArray(nowcast.projections)) ? nowcast.projections
      : []
    if (!projections.length) return none

    const acc = accuracy && typeof accuracy === 'object' && accuracy.status === 'graded' ? accuracy : null
    if (!acc) return none

    // The metric's own measured error is preferred; the pooled overall is the fallback so a
    // projection whose metric was never individually graded still gets an honest (if broader)
    // band rather than a bare number.
    const overallSmape = acc.overall && isNum(acc.overall.smape) ? Number(acc.overall.smape) : null
    const overallSamples = acc.overall && Number.isFinite(Number(acc.overall.samples)) ? Number(acc.overall.samples) : 0
    const byMetric = new Map()
    if (Array.isArray(acc.metrics)) {
      for (const m of acc.metrics) {
        if (m && m.metric != null && isNum(m.smape)) byMetric.set(String(m.metric), m)
      }
    }
    if (!byMetric.size && overallSmape == null) return none   // no usable error anywhere

    const bands = []
    for (const p of projections) {
      if (!p || p.metric == null || !isNum(p.projected)) continue
      const metric = String(p.metric)
      const own = byMetric.get(metric)
      const halfPct = own ? Number(own.smape) : overallSmape
      if (!isNum(halfPct)) continue                            // this metric has no measured error → no band
      const basis = own ? 'metric' : 'overall'
      const samples = own && Number.isFinite(Number(own.samples)) ? Number(own.samples) : overallSamples

      const projected = Number(p.projected)
      const drawnHalfPct = clamp(halfPct, 0, maxHalf)          // capped, never shrunk below measured
      const frac = drawnHalfPct / 100
      const known = !!METRICS[metric]
      const rawLo = projected * (1 - frac)
      const lo = known ? Math.max(0, rawLo) : rawLo            // engine metrics are non-negative
      const hi = projected * (1 + frac)
      const floored = known && rawLo < 0

      const metric_label = p.metric_label != null ? String(p.metric_label)
        : (known && METRICS[metric].label) || metric
      const loLabel = labelFor(metric, lo)
      const hiLabel = labelFor(metric, hi)

      bands.push({
        metric,
        metric_label,
        projected: round2(projected),
        projectedCents: toCents(projected),
        halfPct: round2(halfPct),
        drawnHalfPct: round2(drawnHalfPct),
        lo: round2(lo),
        hi: round2(hi),
        loCents: toCents(lo),
        hiCents: toCents(hi),
        loLabel,
        hiLabel,
        rangeLabel: `${loLabel}–${hiLabel}`,
        floored,
        basis,
        samples,
      })
    }

    if (!bands.length) return none
    return {
      status: 'calibrated',
      bands,
      meta: { calibrated: bands.length, basis: 'measured-smape', maxHalfPct: maxHalf },
    }
  } catch {
    return none
  }
}

module.exports = { calibrateNowcastBand }
