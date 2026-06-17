'use strict'

// ============================================================
// lib/correlate.js — root-cause linking (PURE): tie coverage gaps to the
// impact symptoms they most plausibly explain.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `correlate` engine
// module. The implementation is byte-for-byte identical to the canonical module,
// so cv re-exports it from the vendored package (api/vendor/dashboard-core).
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (linkCoverageToImpact, SYMPTOM_KINDS) so no call site
// changes.
// ============================================================

const { linkCoverageToImpact, SYMPTOM_KINDS } = require('../vendor/dashboard-core')

module.exports = { linkCoverageToImpact, SYMPTOM_KINDS }
