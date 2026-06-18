'use strict'

// ============================================================================
// lib/writeVerification.js — Write-Verification correctness primitive (Spec A,
// cli_framework). Pure, deterministic, zero I/O: same input → same outcome, so
// the correctness logic unit-tests in isolation and ports verbatim into the
// cli_framework repo (like lib/makeRemediation.js).
//
// THE GAP THIS CLOSES
//   The remediation log records that a write PERSISTED. Persistence is only
//   *correlated* with correctness — a write can save and still hold the wrong
//   value. This module turns a write + its round-trip read-back into a
//   correctness verdict on a FOUR-state axis (the spec's three states plus the
//   explicit "persisted-but-wrong" outcome it says must be "logged as such"):
//
//     FAILED               — did not persist
//     PERSISTED_UNVERIFIED — saved, read-back unavailable (e.g. consistency lag)
//     PERSISTED_INCORRECT  — saved, but the round-trip does NOT match intent
//     VERIFIED_CORRECT     — saved and the round-trip matches intent
//
//   Field comparison normalizes through a per-field equivalence map first
//   (vendor representations differ from canonical), so a match is a match on
//   *normalized* values, not raw bytes.
//
// SEQUENCING (see DECISION_REGISTER.md): the Wilson lower bound below is provided
// for the promotion gate but is intentionally NOT wired to it yet. Build
// correctness samples first; promoting on persistence data would be irreversible.
// ============================================================================

const crypto = require('crypto')

// ── The correctness axis ────────────────────────────────────────────────────
const OUTCOME = Object.freeze({
  FAILED:               'FAILED',
  PERSISTED_UNVERIFIED: 'PERSISTED_UNVERIFIED',
  PERSISTED_INCORRECT:  'PERSISTED_INCORRECT',
  VERIFIED_CORRECT:     'VERIFIED_CORRECT',
})

// outcome → the stats column it increments (see migration 035).
const STAT_COLUMN = Object.freeze({
  [OUTCOME.FAILED]:               'failed',
  [OUTCOME.PERSISTED_UNVERIFIED]: 'persisted_unverified',
  [OUTCOME.PERSISTED_INCORRECT]:  'persisted_incorrect',
  [OUTCOME.VERIFIED_CORRECT]:     'verified_correct',
})

// ── Field-level equivalence normalization ───────────────────────────────────

/**
 * Normalize a single field value for comparison. An optional per-field map
 * (`opts.map`) translates a known vendor representation to its canonical form
 * before generic normalization; `opts.kind` ('email' | 'phone') applies a
 * type-aware rule. Generic strings are trimmed, lower-cased, and inner
 * whitespace collapsed. null/undefined normalize to '' (so absent === empty).
 *
 * @param {*} value
 * @param {{ kind?: string, map?: Record<string,*> }} [opts]
 * @returns {string}
 */
function normalizeValue(value, opts = {}) {
  const { kind, map } = opts
  let v = value
  if (v == null) return ''
  if (map && typeof v !== 'object' && Object.prototype.hasOwnProperty.call(map, String(v))) {
    v = map[String(v)]
    if (v == null) return ''
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  const s = String(v).trim()
  if (kind === 'phone') return s.replace(/\D+/g, '')
  if (kind === 'email') return s.toLowerCase()
  return s.toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Compare an intended payload against a round-trip read-back, field by field,
 * over the keys present in `intended` (intent-driven — extra read-back keys are
 * ignored). When `readBack` is null/undefined the read is treated as
 * unavailable and no field is judged.
 *
 * @param {Record<string,*>} intended
 * @param {Record<string,*>|null|undefined} readBack
 * @param {{ equivalence?: Record<string,{kind?:string,map?:object}> }} [opts]
 * @returns {{ readBackAvailable:boolean, fields:Array, fieldCount:number,
 *             matchCount:number, mismatchFields:string[], allMatch:boolean }}
 */
function compareReadback(intended = {}, readBack, opts = {}) {
  const equivalence = opts.equivalence || {}
  const readBackAvailable = readBack != null && typeof readBack === 'object'
  const fields = []
  const mismatchFields = []
  let matchCount = 0
  const keys = Object.keys(intended || {})
  for (const k of keys) {
    const fieldOpts = equivalence[k] || {}
    const iNorm = normalizeValue(intended[k], fieldOpts)
    if (!readBackAvailable) {
      fields.push({ field: k, intended: iNorm, match: null })
      continue
    }
    const rNorm = normalizeValue(readBack[k], fieldOpts)
    const match = iNorm === rNorm
    if (match) matchCount++
    else mismatchFields.push(k)
    fields.push({ field: k, intended: iNorm, readBack: rNorm, match })
  }
  const fieldCount = keys.length
  const allMatch = readBackAvailable && fieldCount > 0 && mismatchFields.length === 0
  return { readBackAvailable, fields, fieldCount, matchCount, mismatchFields, allMatch }
}

/**
 * Classify a write on the correctness axis from whether it persisted and the
 * read-back comparison.
 *
 * @param {{ persisted:boolean, comparison?:ReturnType<typeof compareReadback> }} args
 * @returns {string} one of OUTCOME
 */
function classifyWrite({ persisted, comparison } = {}) {
  if (!persisted) return OUTCOME.FAILED
  if (!comparison || comparison.readBackAvailable !== true) return OUTCOME.PERSISTED_UNVERIFIED
  return comparison.allMatch ? OUTCOME.VERIFIED_CORRECT : OUTCOME.PERSISTED_INCORRECT
}

/**
 * Stable SHA-256 of the NORMALIZED intended payload (sorted keys), so logically
 * equivalent intents hash identically. Stores a fingerprint of intent without
 * persisting raw (possibly PII-bearing) values.
 */
function hashIntended(intended = {}, equivalence = {}) {
  const norm = {}
  for (const k of Object.keys(intended || {}).sort()) {
    norm[k] = normalizeValue(intended[k], equivalence[k] || {})
  }
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex')
}

// ── Wilson lower bound (for the FUTURE promotion gate — not yet wired) ────────

/**
 * Wilson score interval lower bound for a binomial proportion. The promotion
 * gate will read this over VERIFIED_CORRECT / total per (tenant, endpoint);
 * until real correctness samples exist it is reporting-only (see Spec A
 * sequencing). Returns 0 for an empty sample.
 *
 * @param {number} correct successes (VERIFIED_CORRECT)
 * @param {number} total    sample size
 * @param {number} [z]      z for the desired confidence (default 1.96 ≈ 95%)
 * @returns {number} lower bound in [0,1]
 */
function wilsonLowerBound(correct, total, z = 1.96) {
  const n = Number(total) || 0
  if (n <= 0) return 0
  const phat = (Number(correct) || 0) / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = phat + z2 / (2 * n)
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
  return Math.max(0, (center - margin) / denom)
}

/**
 * Map a correctness outcome to the existing Make-remediation Wilson-score
 * feedback key (lib/makeRemediation.WILSON_FEEDBACK). This finally makes the
 * dormant `tier1_remapped_verified` key meaningful — driven by CORRECTNESS, not
 * persistence. Returned for callers that choose to wire it; PERSISTED_UNVERIFIED
 * maps to null (unknown → no confidence movement).
 *
 * @param {string} outcome
 * @returns {string|null}
 */
function outcomeToWilsonFeedback(outcome) {
  switch (outcome) {
    case OUTCOME.VERIFIED_CORRECT:    return 'tier1_remapped_verified'
    case OUTCOME.PERSISTED_INCORRECT: return 'tier1_dead_lettered'
    case OUTCOME.FAILED:              return 'tier1_dead_lettered'
    default:                          return null
  }
}

module.exports = {
  OUTCOME,
  STAT_COLUMN,
  normalizeValue,
  compareReadback,
  classifyWrite,
  hashIntended,
  wilsonLowerBound,
  outcomeToWilsonFeedback,
}
