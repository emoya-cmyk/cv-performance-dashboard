'use strict'

// ============================================================
// lib/pacing.js — goal-pacing intelligence (PURE): classify and rank how each
// client is tracking against its target given elapsed time-in-period.
//
// Thin re-export over the vendored @emoya-cmyk/dashboard-core `pacing` engine
// module. The implementation is byte-for-byte identical to the canonical module,
// so cv re-exports it from the vendored package (api/vendor/dashboard-core).
//
// Pure functions only — no DB, no Express, no LLM. The public export shape is
// preserved exactly (classifyPacing, rankPacing, paceStatus, MIN_ELAPSED,
// AHEAD_AT, ON_TRACK_AT, BEHIND_AT, STATUS_RANK) so no call site changes.
// ============================================================

const {
  classifyPacing, rankPacing, paceStatus,
  MIN_ELAPSED, AHEAD_AT, ON_TRACK_AT, BEHIND_AT, STATUS_RANK,
} = require('../vendor/dashboard-core')

module.exports = {
  classifyPacing,
  rankPacing,
  paceStatus,
  // constants (exported for tests + any consumer that wants the same thresholds)
  MIN_ELAPSED,
  AHEAD_AT,
  ON_TRACK_AT,
  BEHIND_AT,
  STATUS_RANK,
}
