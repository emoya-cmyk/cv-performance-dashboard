'use strict'

// ============================================================
// lib/metricsCore.js — the SINGLE source of truth for derived KPIs.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `metricsCore`
// engine module. The implementation is byte-for-byte identical to the canonical
// module, so cv re-exports it from the vendored package
// (api/vendor/dashboard-core). It stays the ONE way the live metrics endpoints
// (routes/metrics.js), the Grounded-AI evidence pack (lib/evidence.js), and the
// weekly digest all compute numbers — the accuracy guarantee of the AI layer
// rests on this, so the golden-parity and evidence-exactness tests still hold.
//
// Pure functions only — no DB, no Express. The public export shape is preserved
// exactly (AGG, derive, pctChange, detectAnomalies) so no call site changes.
// ============================================================

const { AGG, derive, pctChange, detectAnomalies } = require('../vendor/dashboard-core')

module.exports = { AGG, derive, pctChange, detectAnomalies }
