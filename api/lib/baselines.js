'use strict'

// ============================================================
// lib/baselines.js — self-calibrating statistical baselines for the
// autonomous intelligence layer.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `baselines`
// engine module. The implementation (median/MAD, robust z, linreg slope, EWMA,
// severity buckets, and the `summarizeSeries` composite the engine calls) is
// byte-for-byte identical to the canonical module, so cv re-exports it from the
// vendored package (api/vendor/dashboard-core).
//
// Pure functions only — no DB, no Express, no LLM. The engine (lib/insights.js)
// fetches each client's weekly series and feeds it here; everything returned is
// deterministic and unit-tested. The public export shape is preserved exactly
// (finite, mean, stddev, median, mad, robustStats, robustZ, linregSlope, ewma,
// classifyZ, direction, summarizeSeries, MAD_TO_SIGMA, DEFAULT_WARN,
// DEFAULT_CRIT) so no call site changes.
// ============================================================

const {
  finite, mean, stddev, median, mad, robustStats, robustZ,
  linregSlope, ewma, classifyZ, direction, summarizeSeries,
  MAD_TO_SIGMA, DEFAULT_WARN, DEFAULT_CRIT,
} = require('../vendor/dashboard-core')

module.exports = {
  finite, mean, stddev, median, mad, robustStats, robustZ,
  linregSlope, ewma, classifyZ, direction, summarizeSeries,
  MAD_TO_SIGMA, DEFAULT_WARN, DEFAULT_CRIT,
}
