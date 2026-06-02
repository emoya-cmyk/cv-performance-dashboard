'use strict'

// ============================================================
// lib/ratioAttribution.js — the "why" behind a RATIO's movement.
//
// lib/contribution.js answers "WHO moved an ADDITIVE metric" (which client).
// lib/attribution.js answers "which lever moved a COMPOSITE product" (revenue,
// jobs) for the insights engine. This module answers the third, missing case the
// Ask box surfaces: WHICH LEVER moved a RATIO metric — roas, cpl, close_rate —
// none of which decompose by client (a ratio of sums isn't a sum) and none of
// which attribution.js covers (it decomposes products, not quotients).
//
// Each ratio in the Ask catalogue is computed as a RATIO OF SUMS (see ask.js
// METRICS — SUM(num)/SUM(den)), so the quotient identity is EXACT at the very
// figure the answer reported:
//
//   roas       = revenue / spend
//   cpl        = spend   / leads
//   close_rate = jobs    / leads        (the ×100 cancels inside the ratio)
//
// An exact quotient decomposes exactly in log space — same idea as a product,
// but the denominator enters with a MINUS sign:
//
//   ln(M_to / M_from) = ln(N_to/N_from) − ln(D_to/D_from)
//
// so the numerator's signed share of the move is +ln(N_to/N_from) / totalLog and
// the denominator's is −ln(D_to/D_from) / totalLog, and the two shares sum to
// exactly 1. "ROAS rose 12%" becomes "revenue grew 18% (the driver) while spend
// rose 5% (a partial offset)" — each number individually true and traceable to a
// stored SUM. A driver that pushed the ratio the way it actually went carries a
// POSITIVE share (a driver); one that pushed against the move carries a NEGATIVE
// share (a drag) — true regardless of the headline's direction, because the share
// folds direction in. For cpl that means "more leads" reads as the driver of a
// FALL (good); for close_rate it means "more leads" reads as a drag on the rate
// (the denominator grew) — both mechanically exact.
//
// Pure functions only — no DB, no clock, no LLM — exactly like attribution.js and
// contribution.js. Never throws. Any non-positive or non-finite driver value
// (where the logarithm is undefined) or a ratio that didn't really move yields
// null, so the caller simply omits the "why."
// ============================================================

// The three quotient identities in the Ask metric catalogue. `num`/`den` are the
// ADDITIVE driver keys (each one is itself a metric in ask.js METRICS, so the
// caller can recompute their SUMs through the very same compile path). Order is
// presentation order — numerator (the thing you grow) first.
const RATIO_IDENTITIES = {
  roas:       { num: 'revenue', den: 'spend' },
  cpl:        { num: 'spend',   den: 'leads' },
  close_rate: { num: 'jobs',    den: 'leads' },
}

// Below this |Δln| the ratio is effectively flat: nothing to attribute, and
// dividing each driver's log-move by a near-zero denominator would explode the
// shares. Treat it as "no meaningful move" → null. (Matches attribution.js.)
const MOVE_EPS = 1e-9

const isRatioMetric  = (m) => Object.prototype.hasOwnProperty.call(RATIO_IDENTITIES, m)
const ratioDriversOf = (m) => (RATIO_IDENTITIES[m] ? [RATIO_IDENTITIES[m].num, RATIO_IDENTITIES[m].den] : null)

// In the log domain a driver value must be finite and strictly positive.
const pos = (v) => Number.isFinite(v) && v > 0
const r1  = (n) => Math.round((Number(n) || 0) * 10) / 10

/**
 * ratioAttribution(metric, from, to)
 *   metric : a ratio key — 'roas' | 'cpl' | 'close_rate'
 *   from   : { <numKey>: value, <denKey>: value } at the BASELINE endpoint
 *   to     : { <numKey>: value, <denKey>: value } at the CURRENT endpoint
 *
 * Returns null unless `metric` is a ratio identity, every driver value at both
 * endpoints is finite and strictly positive, and the ratio actually moved.
 * Otherwise:
 *   {
 *     metric,                        // the ratio that was decomposed
 *     direction: 'up' | 'down',      // sign of the ratio's log-move
 *     pct,                           // ratio % change = 100·(M_to/M_from − 1)
 *     ratio_from, ratio_to,          // derived num/den at each endpoint
 *     lead,                          // driver key with the largest aligned share
 *     drivers: [                     // [numerator, denominator]; shares sum to 1
 *       { metric, role, from, to, pct, share, share_pct }, …
 *     ],
 *   }
 *
 * `share` is SIGNED and exact (the parts sum to exactly 1): the denominator's
 * share is the NEGATIVE of its own log-move over the total, so a driver moving
 * AGAINST the ratio carries a negative share (it cushioned the move) and the
 * dominant aligned driver carries a share > 1 to compensate. `share_pct` is the
 * rounded convenience (independently rounded, so two may total 99/101 — lead with
 * `lead`). `pct` equals 100·(M_to/M_from − 1) by construction, so it agrees with
 * the figure a detector reports for the same endpoints.
 */
function ratioAttribution(metric, from, to) {
  const ident = RATIO_IDENTITIES[metric]
  if (!ident || !from || !to) return null

  const numFrom = Number(from[ident.num]), numTo = Number(to[ident.num])
  const denFrom = Number(from[ident.den]), denTo = Number(to[ident.den])
  if (![numFrom, numTo, denFrom, denTo].every(pos)) return null  // log undefined → no decomposition

  const numLog   = Math.log(numTo / numFrom)
  const denLog   = Math.log(denTo / denFrom)
  const totalLog = numLog - denLog                 // = ln(ratio_to / ratio_from)
  if (Math.abs(totalLog) < MOVE_EPS) return null   // ratio essentially flat

  // Signed shares: numerator enters as +log, denominator as −log; they sum to 1.
  const mk = (key, role, a, b, log) => {
    let share = log / totalLog
    if (share === 0) share = 0                      // normalize −0 → 0 (a flat driver)
    return {
      metric:    key,
      role,
      from:      a,
      to:        b,
      pct:       r1(100 * (b / a - 1)),             // the driver's OWN % change
      share,
      share_pct: Math.round(100 * share) || 0,      // −0 → 0
    }
  }
  const drivers = [
    mk(ident.num, 'numerator',    numFrom, numTo,  numLog),
    mk(ident.den, 'denominator',  denFrom, denTo, -denLog),
  ]

  // The dominant lever: the largest share. Shares sum to 1 (> 0), so the max is
  // always positive and aligned with the ratio's direction — the lever that most
  // explains the move. Ties keep presentation order (reduce is stable here).
  const lead = drivers.reduce((best, p) => (p.share > best.share ? p : best), drivers[0])

  return {
    metric,
    direction:  totalLog > 0 ? 'up' : 'down',
    pct:        r1(100 * (Math.exp(totalLog) - 1)),  // = 100·(M_to/M_from − 1)
    ratio_from: numFrom / denFrom,
    ratio_to:   numTo / denTo,
    lead:       lead.metric,
    drivers,
  }
}

// One grounded sentence for a ratio decomposition — deterministic, no LLM. Every
// number is copied from the already-computed result, so it's grounded by
// construction (like narrateContribution). Labels come from the caller (ask.js
// METRICS) so this module stays free of any cycle back into ask.js.
//   "ROAS rose 12% — revenue rose 18% and ad spend rose 5%."
const pctText = (p) => {
  const a = Math.abs(r1(p))
  return (Number.isInteger(a) ? a : a.toFixed(1)) + '%'
}
const moveText = (p) => (Math.abs(r1(p)) < 0.05 ? 'held flat' : (p > 0 ? 'rose ' : 'fell ') + pctText(p))

function narrateRatio(result, labels = {}) {
  if (!result) return ''
  const { label = result.metric, numLabel = result.drivers[0].metric, denLabel = result.drivers[1].metric } = labels
  const [num, den] = result.drivers
  const dir = result.direction === 'up' ? 'rose' : 'fell'
  return `${label} ${dir} ${pctText(result.pct)} — ${numLabel.toLowerCase()} ${moveText(num.pct)} `
    + `and ${denLabel.toLowerCase()} ${moveText(den.pct)}.`
}

module.exports = {
  ratioAttribution, narrateRatio, isRatioMetric, ratioDriversOf, RATIO_IDENTITIES,
}
