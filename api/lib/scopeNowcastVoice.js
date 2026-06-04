'use strict'
// lib/scopeNowcastVoice.js — intel-v14 D6 (step a): the nowcast SPEAKS AT ITS MEASURED CONFIDENCE.
//
// D3 (scopeNowcast) wrote one confident headline — "At this pace, revenue reaches ~$13,000 next
// update (+$833)." — at projection time, BEFORE anyone had checked whether that pace has ever
// held. D4 (scopeNowcastAccuracy) then measured how well those projections actually land (sMAPE
// over the buffered reads) and D5 (scopeNowcastBand) turned that error into a calibrated interval.
// But the most-read line on the strip — the headline — still spoke in one fixed, confident voice
// no matter what the track record said. D6 closes that last gap: it RE-VOICES the headline so its
// confidence is gated by the lead projection's OWN measured error. When the model has been within
// a few percent it states the number plainly; when it has been loose it hedges and shows the
// honest range; when it has been wildly off it refuses to name a figure at all and reports only the
// direction. The most prominent sentence stops over-claiming — it speaks exactly as firmly as its
// backtest earns, and no firmer.
//
// The confidence ladder, keyed off the LEAD projection's measured sMAPE (the D5 band's halfPct):
//   • firm      (≤ firmMax,      default  5%) — within a few points historically → say the number,
//                                               drop the "~", lead with the figure.
//   • measured  (≤ measuredMax,  default 15%) — reliable but not tight → keep the "~", append the
//                                               honest range it has earned.
//   • tentative (≤ tentativeMax, default 40%) — shaky → lead with the TREND, soften the figure to
//                                               "roughly", show the ± it has been missing by.
//   • withheld  (> tentativeMax)              — too volatile to call → name only the direction,
//                                               refuse the number ("can't call a number yet").
// A projection whose metric earned no band (no individual or pooled grade) cannot be gated, so the
// module returns { status:'none' } and the surface keeps the original D3 headline untouched.
//
// Design properties (the same discipline as its D1–D5 siblings):
//   • PURE + leak-safe — the inputs are the ALREADY leak-safe projection, accuracy grade, and band
//     (metric labels + the run's own bare numbers + bare error statistics). This module sees no
//     clientId and emits none; its output is a metric label + numbers + confidence phrasing,
//     identical on the agency and client surfaces. `tone` only re-voices peripheral framing in the
//     UI; the calibrated sentence itself is the same honest line for everyone.
//   • One oracle — magnitudes render through the SAME formatValue/METRICS/signedDelta the D3
//     headline and the D5 band already use, so the re-voiced line can never disagree with the
//     number it replaces or the band it cites.
//   • Additive + never louder than measured — the drawn confidence can only ever be CAPPED by the
//     record, never inflated above it; absent a band the headline is left exactly as D3 wrote it.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; any malformed input degrades to
//     { status:'none' } and never throws.
const { formatValue, METRICS } = require('./ask')
const { signedDelta }          = require('./scopeDelta')

const isNum = (v) => v != null && Number.isFinite(Number(v))
const round2 = (n) => Math.round(Number(n) * 100) / 100
const clampNonNeg = (n) => (isNum(n) && Number(n) > 0 ? Number(n) : 0)

// The default confidence ladder, in measured-sMAPE percentage points. Each is the INCLUSIVE upper
// bound of its tier; anything above the last falls to 'withheld'. All overridable via opts so a
// caller (or a future per-metric policy) can tighten or loosen the voice without touching the copy.
const FIRM_MAX = 5
const MEASURED_MAX = 15
const TENTATIVE_MAX = 40

// A magnitude in the projection's own voice — currency/unit via the shared descriptor, or a bare
// rounded number for a metric the engine does not know. Mirrors scopeNowcastBand.labelFor exactly.
function labelFor(metric, value) {
  const descriptor = METRICS[metric] || null
  return descriptor
    ? formatValue(Math.abs(Number(value)), descriptor)
    : String(Math.round(Number(value) * 100) / 100)
}

// A whole-number ± for the hedge tiers. The tentative/withheld tiers only ever fire above the
// measured ceiling (≥ ~15%), so the visible ± is always a clean integer ≥ 1 — no "<1" case here.
const fmtOff = (halfPct) => String(Math.max(1, Math.round(Number(halfPct))))

// horizon → the same "when" phrasing the D3 headline uses, so the re-voiced line reads continuous
// with the strip's grammar.
const whenPhrase = (horizon) => {
  const h = Number.isFinite(Number(horizon)) ? Math.max(1, Math.round(Number(horizon))) : 1
  return h === 1 ? 'next update' : `in ${h} updates`
}

// Capitalize the first letter of a metric label for sentence-lead use ("Revenue is …"), leaving
// the rest as-authored.
const sentenceLabel = (label) => {
  const s = String(label || '').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Compose the calibrated sentence for a tier. Kept as small per-tier builders so each voice reads
// deliberately and the adverse nudge folds in where a confident number is actually spoken.
function composeHeadline(tier, ctx) {
  const { label, lower, projectedLabel, mag, when, rangeLabel, dir, halfPct, adverse } = ctx
  const Label = sentenceLabel(label)
  switch (tier) {
    case 'firm':
      // The record is tight — state the figure plainly, no "~", lead with it.
      return adverse
        ? `${Label} is on track to reach ${projectedLabel} ${when} (${mag}) — worth a look.`
        : `${Label} is on track to reach ${projectedLabel} ${when} (${mag}).`
    case 'measured':
      // Reliable but not tight — keep the soft "~", append the range it has earned.
      return adverse
        ? `At this pace, ${lower} reaches ~${projectedLabel} ${when} — likely ${rangeLabel}, worth a look.`
        : `At this pace, ${lower} reaches ~${projectedLabel} ${when} — likely ${rangeLabel}.`
    case 'tentative':
      // Shaky — lead with the trend, soften the figure to "roughly", show the miss it has run.
      return `${Label} is trending ${dir} — roughly ${projectedLabel} ${when}, but recent estimates have varied ±${fmtOff(halfPct)}%.`
    case 'withheld':
    default:
      // Too volatile to name a figure — report only the direction and why the number is withheld.
      return `${Label} is trending ${dir}, though recent estimates have been too volatile (±${fmtOff(halfPct)}%) to call a number yet.`
  }
}

// calibrateNowcastVoice(nowcast, accuracy, band, opts)
//   nowcast  : a projectScopeTrend() result ({status:'projected', projections:[...], headline}).
//   accuracy : a gradeScopeNowcast() result ({status:'graded', metrics:[...], overall}) — or null.
//   band     : a calibrateNowcastBand() result ({status:'calibrated', bands:[...]}) — or null.
//   opts     : { firmMax=5, measuredMax=15, tentativeMax=40 } (the inclusive tier ceilings).
// Returns { status, confidence, leadMetric, leadLabel, halfPct, speaksNumber, headline, hedge,
//           raw, basis, meta }.
//   status : 'none'   — no projection / no usable band for the lead metric / malformed input;
//            'voiced' — the lead headline was re-voiced at its measured confidence.
//   confidence : 'firm' | 'measured' | 'tentative' | 'withheld'.
//   speaksNumber : whether the calibrated headline names a figure (false only for 'withheld').
//   raw : the original D3 headline, preserved for reference/fallback (already leak-safe).
function calibrateNowcastVoice(nowcast, accuracy, band, opts) {
  const none = { status: 'none', confidence: 'unrated', leadMetric: null, leadLabel: null, halfPct: null, speaksNumber: false, headline: null, hedge: null, raw: null, basis: 'measured-band', meta: { thresholds: { firmMax: FIRM_MAX, measuredMax: MEASURED_MAX, tentativeMax: TENTATIVE_MAX } } }
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const firmMax = isNum(o.firmMax) ? Number(o.firmMax) : FIRM_MAX
    const measuredMax = isNum(o.measuredMax) ? Number(o.measuredMax) : MEASURED_MAX
    const tentativeMax = isNum(o.tentativeMax) ? Number(o.tentativeMax) : TENTATIVE_MAX
    none.meta.thresholds = { firmMax, measuredMax, tentativeMax }

    // Gate 1: a real projection. The headline speaks the LEAD projection (projections[0]).
    if (!nowcast || typeof nowcast !== 'object' || nowcast.status !== 'projected') return none
    const projections = Array.isArray(nowcast.projections) ? nowcast.projections : []
    const lead = projections[0]
    if (!lead || lead.metric == null || !isNum(lead.projected)) return none
    none.raw = nowcast.headline != null ? String(nowcast.headline) : null

    // Gate 2: a graded accuracy. (The band already requires it, but check explicitly so a band
    // handed in without its grade still gates cleanly.)
    if (!accuracy || typeof accuracy !== 'object' || accuracy.status !== 'graded') return none

    // Gate 3: a calibrated band for the LEAD metric — its halfPct is the measured error we voice by.
    if (!band || typeof band !== 'object' || band.status !== 'calibrated' || !Array.isArray(band.bands)) return none
    const metric = String(lead.metric)
    const leadBand = band.bands.find((b) => b && String(b.metric) === metric)
    if (!leadBand || !isNum(leadBand.halfPct)) return none

    const halfPct = Number(leadBand.halfPct)
    const confidence = halfPct <= firmMax ? 'firm'
      : halfPct <= measuredMax ? 'measured'
      : halfPct <= tentativeMax ? 'tentative'
      : 'withheld'
    const speaksNumber = confidence !== 'withheld'

    // One-oracle magnitude rendering, consistent with the D3 headline and the D5 band.
    const label = lead.metric_label != null ? String(lead.metric_label)
      : (METRICS[metric] && METRICS[metric].label) || metric
    const lower = String(label).toLowerCase()
    const descriptor = METRICS[metric] || null
    const projectedLabel = labelFor(metric, lead.projected)
    // signedDelta renders the magnitude in the metric's own voice (and falls back to a bare
    // rounded number with the same +/− convention when the metric is unknown), so the firm tier's
    // "(+$833)" can never disagree with the D3 headline it replaces.
    const mag = isNum(lead.projectedDelta) ? signedDelta(Number(lead.projectedDelta), descriptor) : ''
    const when = whenPhrase(lead.horizon)
    const dir = lead.direction === 'down' ? 'down' : 'up'
    const adverse = lead.improving === false
    const rangeLabel = leadBand.rangeLabel != null ? String(leadBand.rangeLabel) : `${leadBand.loLabel}–${leadBand.hiLabel}`

    const headline = composeHeadline(confidence, { label, lower, projectedLabel, mag, when, rangeLabel, dir, halfPct, adverse })

    // A short machine-readable qualifier clause for callers that want the hedge without re-parsing
    // the sentence (firm speaks plainly, so it carries none).
    const hedge = confidence === 'firm' ? ''
      : confidence === 'measured' ? `likely ${rangeLabel}`
      : confidence === 'tentative' ? `varied ±${fmtOff(halfPct)}%`
      : `too volatile (±${fmtOff(halfPct)}%)`

    return {
      status: 'voiced',
      confidence,
      leadMetric: metric,
      leadLabel: label,
      halfPct: round2(halfPct),
      speaksNumber,
      headline,
      hedge,
      raw: none.raw,
      basis: leadBand.basis === 'overall' ? 'overall' : 'metric',
      meta: { thresholds: { firmMax, measuredMax, tentativeMax }, source: 'measured-band' },
    }
  } catch {
    return none
  }
}

module.exports = { calibrateNowcastVoice, FIRM_MAX, MEASURED_MAX, TENTATIVE_MAX }
