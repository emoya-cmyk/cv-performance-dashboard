'use strict'

// ============================================================
// lib/contribution.js — WHICH CLIENT moved the number: additive contribution
// breakdown + narration over an additive metric across a portfolio.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `contribution`
// engine module. The implementation is byte-for-byte identical to the canonical
// module, so cv re-exports it from the vendored package
// (api/vendor/dashboard-core).
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (contributionBreakdown, narrateContribution, isAdditive,
// additiveMetrics, ADDITIVE) so no call site changes.
// ============================================================

const {
  contributionBreakdown, narrateContribution, isAdditive, additiveMetrics, ADDITIVE,
} = require('../vendor/dashboard-core')

module.exports = { contributionBreakdown, narrateContribution, isAdditive, additiveMetrics, ADDITIVE }
