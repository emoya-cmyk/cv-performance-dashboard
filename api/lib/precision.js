'use strict'

// ============================================================
// lib/precision.js — the self-improving PRECISION loop (pure): outcome
// classification, signature tallying, Beta-Bernoulli confidence + banding.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `precision` engine
// module. The implementation is byte-for-byte identical to the canonical module,
// so cv re-exports it from the vendored package (api/vendor/dashboard-core).
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (classifyOutcome, signatureKey, tallyOutcomes, rateOf,
// confidenceOf, bandOf, weightFor, baseRateOf, confidenceTable, PRIOR_WEIGHT,
// PRIOR_MEAN, BAND_LOW, BAND_HIGH, WEIGHT_MIN, WEIGHT_MAX) so no call site
// changes.
// ============================================================

const {
  classifyOutcome, signatureKey, tallyOutcomes, rateOf,
  confidenceOf, bandOf, weightFor, baseRateOf, confidenceTable,
  PRIOR_WEIGHT, PRIOR_MEAN, BAND_LOW, BAND_HIGH, WEIGHT_MIN, WEIGHT_MAX,
} = require('../vendor/dashboard-core')

module.exports = {
  classifyOutcome, signatureKey, tallyOutcomes, rateOf,
  confidenceOf, bandOf, weightFor, baseRateOf, confidenceTable,
  // constants (exported for tests + any consumer that wants the same thresholds)
  PRIOR_WEIGHT, PRIOR_MEAN, BAND_LOW, BAND_HIGH, WEIGHT_MIN, WEIGHT_MAX,
}
