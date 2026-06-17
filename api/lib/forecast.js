'use strict'

// ============================================================
// lib/forecast.js — deterministic forward projection for the autonomous
// intelligence layer (Holt double-exponential smoothing, N-step projection,
// ETA-to-target, month-end projection, MAPE).
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `forecast` engine
// module. The implementation is byte-for-byte identical to the canonical module,
// so cv re-exports it from the vendored package (api/vendor/dashboard-core).
// `forecast` depends on `baselines` (finite/mean/stddev), which lives inside the
// same package, so that dependency resolves package-internally.
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (holt, forecast, projectN, etaToTarget, monthEndProjection,
// mapeOf, DEFAULT_ALPHA, DEFAULT_BETA, Z_80) so no call site changes.
// ============================================================

const {
  holt, forecast, projectN, etaToTarget, monthEndProjection, mapeOf,
  DEFAULT_ALPHA, DEFAULT_BETA, Z_80,
} = require('../vendor/dashboard-core')

module.exports = {
  holt, forecast, projectN, etaToTarget, monthEndProjection, mapeOf,
  DEFAULT_ALPHA, DEFAULT_BETA, Z_80,
}
