'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// @emoya-cmyk/compaction — LOSSLESS token-compaction for the dashboard family.
//
// Two primitives, both free, both zero-dependency, both lossless:
//   • compaction — array-of-objects → schema header + delimited rows (drops the
//     repeated field names; every value survives; decode(encode(x)) === x).
//   • cacheAlign — a prompt-prefix assembly discipline so provider caches hit.
//
// What this is NOT: no row-drop, no truncation, no reversible-offload/TTL, no
// opaque-value substitution, no external service. Lossless-only, by design — that
// is what keeps it compatible with the family's grounded-AI invariant.
//
// See README.md for the format spec, the "why lossless" rationale, and the
// cache-alignment ordering rule. Provenance/credit: ../NOTICE.
// ─────────────────────────────────────────────────────────────────────────────

const compaction = require('./lib/compaction')
const cacheAlign = require('./lib/cacheAlign')

module.exports = {
  // primary surface
  compact: compaction.compact,
  expand: compaction.expand,
  assemblePrompt: cacheAlign.assemblePrompt,
  cachePrefix: cacheAlign.cachePrefix,
  // namespaced access to everything each module exports
  compaction,
  cacheAlign,
}
