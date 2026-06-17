'use strict'

// ============================================================
// lib/attribution.js — the "why" behind a movement (composite-metric change
// decomposition into per-driver contributions).
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `attribution`
// engine module. The implementation is byte-for-byte identical to the canonical
// module, so cv re-exports it from the vendored package
// (api/vendor/dashboard-core).
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (attributeChange, isComposite, driversOf, compositeMetrics,
// IDENTITIES) so no call site changes.
// ============================================================

const {
  attributeChange, isComposite, driversOf, compositeMetrics, IDENTITIES,
} = require('../vendor/dashboard-core')

module.exports = { attributeChange, isComposite, driversOf, compositeMetrics, IDENTITIES }
