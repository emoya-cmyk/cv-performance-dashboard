'use strict'
// lib/scopeNowcast.js — intel-v14 D3 (step a): LIVE NOWCAST off the streak.
//
// D1 (scopeDelta) saw the single hop between two reads. D2 (scopeTrend) confirmed the
// multi-read STREAK — "revenue has climbed 3 straight updates". D3 answers the question a
// streak begs: where is it HEADING? It takes a detectScopeTrends() result and, for each
// metric on a qualifying run, projects the next read AT THE RUN'S CURRENT PACE — hedged
// ("at this pace"), clamped to a short horizon, and floored so a non-negative metric can't
// be projected through zero.
//
// Design properties (the same discipline as its D1/D2 siblings):
//   • PURE + leak-safe by construction — the sole input is an ALREADY leak-safe trend
//     payload (metric labels + the run's own bare values; never any tenant identity). This
//     module sees no clientId and emits none, so its output is identical on the agency and
//     client surfaces.
//   • Honest pace — projection uses the AVERAGE step (delta ÷ runSteps), the most defensible
//     single-number velocity, never the noisiest last step. A decelerating run therefore
//     projects a smaller next step than its peak, which is correct.
//   • Short horizon — default 1 read (the very next update); capped at 3. A handful of live
//     reads cannot support a long extrapolation, and claiming one would be the opposite of
//     accurate. "~" and "at this pace" mark every projection as an estimate, not a promise.
//   • Floored — a known engine metric (revenue/leads/jobs/spend/cpl/roas/close_rate) is
//     non-negative, so a down-run is clamped at 0 (clamped:true) rather than projected into
//     impossible territory. An unknown metric is left unclamped (its domain is unknown).
//   • One oracle — polarity (improving) and phrasing (formatValue/signedDelta/METRICS) are
//     inherited from the trend entry and the shared ask/scopeDelta helpers, so the nowcast
//     reads in the same voice as the streak above it and an adverse projection keeps the
//     soft "— worth a look" nudge.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; stable input order; any malformed
//     input degrades to { status:'none', projections:[] } and never throws.
const { formatValue, METRICS }        = require('./ask')
const { pctChange, signedDelta }      = require('./scopeDelta')
const { toCents }                     = require('./scopeFreshness')

const isNum = (v) => v != null && Number.isFinite(Number(v))
const clampInt = (v, lo, hi, dflt) =>
  Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt

const MAX_HORIZON = 3

// One leak-safe projection sentence, in the same voice as the streak it extends:
//   "At this pace, revenue reaches ~$13,000 next update (+$1,000)."
//   "At this pace, cost per lead reaches ~$55 next update (+$5) — worth a look."
// The label is lowercased mid-sentence to match scopeDelta's headline voice; an adverse
// projection (improving===false) keeps the same soft nudge the trend strip uses. A REAL
// minus sign rides in via signedDelta, so magnitudes read identically everywhere.
function buildNowcastHeadline({ metric, metric_label, improving, horizon, projected, projectedDelta }) {
  const descriptor = METRICS[metric] || null
  const value = descriptor ? formatValue(Math.abs(Number(projected)), descriptor)
    : String(Math.round(Number(projected) * 100) / 100)
  const when = horizon === 1 ? 'next update' : `in ${horizon} updates`
  const mag  = signedDelta(projectedDelta, descriptor)
  const tail = improving === false ? ' — worth a look.' : '.'
  return `At this pace, ${String(metric_label).toLowerCase()} reaches ~${value} ${when} (${mag})${tail}`
}

// projectScopeTrend(trend, opts)
//   trend : a detectScopeTrends() result ({status, trends:[...]}) — or just its trends[].
//   opts  : { horizon=1 } (clamped to 1..3; non-integers fall back to 1).
// Returns { status, projections[], headline, meta }.
//   status: 'none'      — nothing trending to project (or malformed input);
//           'projected' — at least one metric projected forward.
// Each projection: { metric, metric_label, direction, improving, horizon, pace, paceCents,
//   current, projected, projectedDelta, projectedCents, pct, clamped, accelerating, values,
//   headline }. `current` is the launch point (the run's latest value); `projected` is the
//   floored estimate one (or `horizon`) avg-steps ahead.
function projectScopeTrend(trend, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const horizon = clampInt(o.horizon, 1, MAX_HORIZON, 1)

  const trends = Array.isArray(trend) ? trend
    : (trend && typeof trend === 'object' && Array.isArray(trend.trends)) ? trend.trends
    : []

  const projections = []
  for (const t of trends) {
    if (!t || typeof t !== 'object') continue
    const metric = t.metric != null ? String(t.metric) : null
    if (!metric) continue
    // Need a finite launch value, a finite run delta, and at least one step to pace off.
    if (!isNum(t.to) || !isNum(t.delta) || !isNum(t.runSteps) || Number(t.runSteps) < 1) continue

    const current = Number(t.to)
    const pace    = Number(t.delta) / Number(t.runSteps)        // average step over the run
    const known   = !!METRICS[metric]
    const raw     = current + pace * horizon
    const projected = known ? Math.max(0, raw) : raw            // engine metrics are non-negative
    const clamped = known && raw < 0
    const projectedDelta = projected - current                 // consistent with the floor

    const metric_label = t.metric_label != null ? String(t.metric_label)
      : (known && METRICS[metric].label) || metric
    // Direction + polarity are INHERITED from the run (one oracle): the projection continues
    // the same directional streak, so re-deriving them risks divergence at the floored edge.
    const direction = t.direction === 'up' || t.direction === 'down' ? t.direction
      : (pace >= 0 ? 'up' : 'down')
    const improving = t.improving === true ? true : t.improving === false ? false : null

    projections.push({
      metric,
      metric_label,
      direction,
      improving,
      horizon,
      pace,
      paceCents: toCents(pace),
      current,
      projected,
      projectedDelta,
      projectedCents: toCents(projected),
      pct: pctChange(current, projected),
      clamped,
      accelerating: !!t.accelerating,
      values: Array.isArray(t.values) ? t.values.slice() : [],
      headline: buildNowcastHeadline({ metric, metric_label, improving, horizon, projected, projectedDelta }),
    })
  }

  if (!projections.length) {
    return {
      status: 'none', projections: [], headline: null,
      meta: { projectedCount: 0, horizon, basis: 'avg-step' },
    }
  }
  return {
    status: 'projected',
    projections,
    headline: projections[0].headline,    // input order == trend salience order → most salient first
    meta: { projectedCount: projections.length, horizon, basis: 'avg-step' },
  }
}

module.exports = { projectScopeTrend, buildNowcastHeadline }
