'use strict'

// ============================================================
// lib/ratioAttribution.js — the "why" behind a RATIO's movement: decompose a
// ratio metric's change into numerator/denominator driver contributions.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `ratioAttribution`
// engine module. The implementation is byte-for-byte identical to the canonical
// module, so cv re-exports it from the vendored package
// (api/vendor/dashboard-core). NOTE: the package exposes the `ratioAttribution`
// function as a member and its namespace as `ratioAttributionNs` (to avoid a
// name collision); this shim destructures the function, preserving cv's shape.
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (ratioAttribution, narrateRatio, isRatioMetric,
// ratioDriversOf, RATIO_IDENTITIES) so no call site changes.
// ============================================================

const {
  ratioAttribution, narrateRatio, isRatioMetric, ratioDriversOf, RATIO_IDENTITIES,
} = require('../vendor/dashboard-core')

module.exports = {
  ratioAttribution, narrateRatio, isRatioMetric, ratioDriversOf, RATIO_IDENTITIES,
}
