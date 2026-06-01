'use strict'

// ============================================================
// lib/attribution.js — the "why" behind a movement.
//
// baselines.js says a metric is unusual; forecast.js says where it lands; this
// module answers the question a human asks next: WHY did it move? For the two
// KPIs that are EXACT products of stored drivers, the answer is grounded
// arithmetic — no model, no tuning, nothing to calibrate:
//
//   revenue ≡ spend × roas               (roas is defined as revenue / spend)
//   jobs    ≡ leads × (close_rate / 100) (close_rate is 100 × closed / leads)
//
// Because each identity is EXACT, a change in the composite decomposes exactly
// into its drivers in log space:
//
//   ln(b / a) = ln(b₁ / a₁) + ln(b₂ / a₂)
//
// so each driver's signed share of the composite's log-move is
// ln(bᵢ/aᵢ) / ln(b/a), and the shares sum to 1. "Jobs fell 22%" becomes
// "leads fell 15% and close rate fell 8% — leads is the bigger driver," every
// number individually true and traceable to a stored value. This is the
// intelligence layer explaining itself: a finding that says not just WHAT moved
// but WHICH lever to pull, identically useful to a client ("fewer leads"), an
// agency triaging a portfolio ("top-of-funnel vs conversion problem"), and the
// system itself (pure data, no operator).
//
// The /100 constant in the jobs identity is irrelevant to attribution — it
// cancels inside the ratio close_rate_to / close_rate_from — so drivers are
// addressed by their catalogue keys and the decomposition is unit-free.
//
// Pure functions only — no DB, no clock, no LLM — exactly like selftune.js,
// forecast.js and baselines.js. Never throws. Any non-positive or non-finite
// driver value (where the logarithm is undefined) or a composite that didn't
// really move yields null — the caller simply omits the "why," producing output
// byte-identical to before this module existed.
// ============================================================

// The only two exact identities in the metric catalogue (see METRIC_META in
// insights.js). The array is presentation order — cause/top-of-funnel first:
// leads before close_rate, spend before roas — so a surface can render the
// drivers left-to-right without re-sorting.
const IDENTITIES = {
  revenue: ['spend', 'roas'],
  jobs:    ['leads', 'close_rate'],
}

// Below this |Δln| the composite is effectively flat: there is nothing to
// attribute, and dividing each driver's log-move by a near-zero denominator
// would explode the shares. Treat it as "no meaningful move" → null.
const MOVE_EPS = 1e-9

const isComposite = (m) => Object.prototype.hasOwnProperty.call(IDENTITIES, m)
const driversOf   = (m) => (IDENTITIES[m] ? IDENTITIES[m].slice() : null)
const compositeMetrics = () => Object.keys(IDENTITIES)

// In the log domain a driver value must be finite and strictly positive.
const pos = (v) => Number.isFinite(v) && v > 0
const r1  = (n) => Math.round((Number(n) || 0) * 10) / 10

/**
 * attributeChange(metric, from, to)
 *   metric : a composite key — 'revenue' or 'jobs'
 *   from   : { <driver>: value, … } at the BASELINE endpoint
 *   to     : { <driver>: value, … } at the CURRENT endpoint
 *
 * Returns null unless `metric` is composite, every driver value at both
 * endpoints is finite and strictly positive, and the composite actually moved.
 * Otherwise returns:
 *   {
 *     metric,                       // the composite that was decomposed
 *     direction: 'up' | 'down',     // sign of the composite's log-move
 *     pct,                          // composite % change implied by the drivers
 *     lead,                         // driver key with the largest aligned share
 *     drivers: [                    // in presentation order; shares sum to 1
 *       { metric, from, to, pct, share, share_pct }, …
 *     ],
 *   }
 *
 * `share` is SIGNED and exact (the parts sum to exactly 1): a driver that moved
 * OPPOSITE the composite carries a negative share — it cushioned the move rather
 * than caused it — and the dominant aligned driver carries a share > 1 to
 * compensate. `share_pct` is the rounded convenience; because each is rounded
 * independently the two integers may total 99 or 101, so a surface that needs a
 * clean split should derive the second from the first or simply lead with
 * `lead`. The composite `pct` equals 100·(b/a − 1) by construction, so it agrees
 * with a detector that reports the same endpoints.
 */
function attributeChange(metric, from, to) {
  const drivers = IDENTITIES[metric]
  if (!drivers || !from || !to) return null

  const parts = []
  let totalLog = 0
  for (const d of drivers) {
    const a = Number(from[d])
    const b = Number(to[d])
    if (!pos(a) || !pos(b)) return null          // log undefined → no decomposition
    const l = Math.log(b / a)
    parts.push({ metric: d, from: a, to: b, log: l })
    totalLog += l
  }
  if (Math.abs(totalLog) < MOVE_EPS) return null  // composite essentially flat

  const driversOut = parts.map((p) => {
    let share = p.log / totalLog                  // signed; the parts sum to 1
    if (share === 0) share = 0                    // normalize −0 → 0 (a flat driver)
    return {
      metric:    p.metric,
      from:      p.from,
      to:        p.to,
      pct:       r1(100 * (p.to / p.from - 1)),   // the driver's own % change
      share,
      share_pct: Math.round(100 * share) || 0,    // −0 → 0
    }
  })

  // The dominant driver: the largest share. Shares sum to 1 (> 0), so the max is
  // always positive and aligned with the composite's direction — the lever that
  // most explains the move. Ties keep presentation order (reduce is stable here).
  const lead = driversOut.reduce((best, p) => (p.share > best.share ? p : best), driversOut[0])

  return {
    metric,
    direction: totalLog > 0 ? 'up' : 'down',
    pct:       r1(100 * (Math.exp(totalLog) - 1)),  // = 100·(b/a − 1), the composite move
    lead:      lead.metric,
    drivers:   driversOut,
  }
}

module.exports = { attributeChange, isComposite, driversOf, compositeMetrics, IDENTITIES }
