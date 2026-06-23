'use strict'

// ============================================================
// lib/compaction.js — LOSSLESS tabular compaction (the token saving).
//
// The single most compressible shape we send a model is an array of near-uniform
// JSON objects: the field NAMES repeat on every row. A CRM read of 120 contacts
// pays for `"first_name":`, `"status":`, `"created_at":` … 120 times over. This
// module reformats such an array into ONE schema header + one delimited line per
// row, so each key is named once. Every VALUE survives unchanged — this is a pure
// reformat, a bijection on the value set, not a summary. `decode(encode(x))`
// reconstructs `x` exactly. That fidelity is the whole point: because no value is
// dropped, substituted, or reordered, any count/sum/lookup the model performs is
// over the complete, unaltered set — which is exactly what the family's
// grounded-AI invariant requires. (See README §"Why lossless".)
//
// What this module DELIBERATELY does NOT do (out of scope, family-wide):
//   • never drops or truncates a row (no "keep 15 of N")
//   • never substitutes a value with an opaque marker
//   • never reorders values within a row
//   • no reversible-offload / TTL retrieval of any kind
// If a transform cannot be proven lossless for a given input, it PASSES THE INPUT
// THROUGH untouched. Conservative by construction: when in doubt, send the
// original. Never guess.
//
// PURE: no DB, no clock, no network, ZERO npm dependencies (node builtins only).
//
// Provenance: the array-of-objects → schema+rows idea is inspired by
// chopratejas/headroom (Apache-2.0); this is a clean-room re-implementation of
// only that one lossless primitive — see ../NOTICE. The lossy paths Headroom also
// offers (row-drop, CCR offload) are intentionally NOT carried here.
// ============================================================

// ── tuning constants (the only thresholds, all in one place) ─────────────────
// These are the §3.3 (D-3) defaults; every one is overridable per-call so a repo
// can tune to its own read shapes after measuring on real data.
const MIN_ROWS = 5 // fewer rows than this → the header overhead isn't worth it → passthrough
const MIN_TOKENS = 200 // smaller rendered payloads → not worth compacting → passthrough
const CORE_FIELD_FRACTION = 0.8 // a key is "core" if present in ≥ this share of rows
const HETEROGENEOUS_CORE_RATIO = 0.6 // if fewer than this share of the union keys are core,
//                                       the array is too ragged for a single clean table → passthrough
const ENC_VERSION = 1 // format version stamped into every ##TBL header
const TOKENS_PER_CHAR = 0.25 // ~4 chars/token — a cheap, provider-agnostic token ESTIMATE
//                              used ONLY for the eligibility threshold, never for billing.

// Cell delimiter and the escapes that make the reformat reversible. The escape
// char is backslash; we escape it FIRST so the other escapes can't be forged.
const DELIM = '|'
// A whole cell equal to this sentinel means "this row did not have this key" —
// distinct from an empty string (empty cell) and from null. escapeCell() can never
// emit a bare `\z`, so the sentinel is unambiguous.
const ABSENT = '\\z'

// ── tiny escaping helpers ────────────────────────────────────────────────────
// Reversible by construction: encode maps each of { \  |  \n  \r } to a two-char
// sequence; decode consumes `\` + one following char. Because `\` itself is
// escaped, no content can forge a delimiter or the ABSENT sentinel.
function escapeCell(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

function unescapeCell(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i]
      if (n === '\\') out += '\\'
      else if (n === '|') out += '|'
      else if (n === 'n') out += '\n'
      else if (n === 'r') out += '\r'
      else out += n // not produced by escapeCell; pass through defensively
    } else {
      out += c
    }
  }
  return out
}

// Split a row on UNESCAPED delimiters (a `\|` belongs to the cell, not a boundary).
// Keeps trailing empties so an absent/empty final cell is preserved.
function splitCells(line) {
  const cells = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[++i] // keep the escape pair intact; unescapeCell resolves it later
    } else if (c === DELIM) {
      cells.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  cells.push(cur)
  return cells
}

// ── value classification ─────────────────────────────────────────────────────
// The JSON value kinds we distinguish. Object/array → 'json' (encoded inline in a
// cell); everything else is a scalar we can render bare with a per-column type.
function kindOf(v) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string') return 'string'
  if (t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'object') return 'json' // array or plain object
  return 'unsupported' // undefined/function/symbol/bigint — forces passthrough
}

// A column's storage type, inferred over the rows that HAVE the key:
//   's' all strings · 'n' all numbers · 'b' all booleans · 'x' anything else
// 'x' is the mixed/null/nested column — its cells are individually TAGGED so each
// value's type is recoverable. A row missing the key is allowed in any column type
// (stored as the ABSENT sentinel).
function colType(values) {
  const kinds = new Set()
  for (const { present, value } of values) {
    if (!present) continue
    kinds.add(kindOf(value))
  }
  if (kinds.size === 1) {
    if (kinds.has('string')) return 's'
    if (kinds.has('number')) return 'n'
    if (kinds.has('boolean')) return 'b'
  }
  return 'x'
}

// ── per-cell encode / decode ─────────────────────────────────────────────────
function encodeCell(value, present, type) {
  if (!present) return ABSENT
  switch (type) {
    case 's':
      return escapeCell(value)
    case 'n':
      return JSON.stringify(value) // canonical number form; Number() parses it back
    case 'b':
      return value ? 'true' : 'false'
    default: {
      // 'x' — tag every cell with its kind so decode can rebuild the exact type.
      const k = kindOf(value)
      if (k === 'null') return '~'
      if (k === 'string') return 's:' + escapeCell(value)
      if (k === 'number') return 'n:' + JSON.stringify(value)
      if (k === 'boolean') return 'b:' + (value ? 't' : 'f')
      return 'j:' + escapeCell(JSON.stringify(value)) // object/array inline-JSON
    }
  }
}

// Returns { absent } or { value }. We use a marker object so an absent key can be
// distinguished from a real `undefined`/null value cleanly by the caller.
function decodeCell(cell, type) {
  if (cell === ABSENT) return { absent: true }
  switch (type) {
    case 's':
      return { value: unescapeCell(cell) }
    case 'n':
      return { value: Number(cell) }
    case 'b':
      return { value: cell === 'true' }
    default: {
      if (cell === '~') return { value: null }
      const tag = cell.slice(0, 2)
      const rest = cell.slice(2)
      if (tag === 's:') return { value: unescapeCell(rest) }
      if (tag === 'n:') return { value: Number(rest) }
      if (tag === 'b:') return { value: rest === 't' }
      if (tag === 'j:') return { value: JSON.parse(unescapeCell(rest)) }
      // Unknown tag → surface as a raw string; verify() will catch any resulting
      // mismatch and the caller falls back to the original payload.
      return { value: cell }
    }
  }
}

// ── the table codec ──────────────────────────────────────────────────────────
// encodeTable assumes an eligible array of plain objects (compact() is the gate
// that decides eligibility). Keys are emitted in first-seen order for stability.
function encodeTable(rows) {
  const keys = []
  const seen = new Set()
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  const types = keys.map((k) =>
    colType(rows.map((row) => ({ present: Object.prototype.hasOwnProperty.call(row, k), value: row[k] })))
  )
  // Header carries keys/types as JSON arrays so keys with commas/brackets/spaces
  // survive — robustness over the brief's illustrative bare `[id,status]` form.
  const header = `##TBL keys=${JSON.stringify(keys)} types=${JSON.stringify(types)} rows=${rows.length} enc=v${ENC_VERSION}`
  const body = rows.map((row) =>
    keys
      .map((k, i) => encodeCell(row[k], Object.prototype.hasOwnProperty.call(row, k), types[i]))
      .join(DELIM)
  )
  return [header, ...body].join('\n')
}

function parseHeader(line) {
  // ##TBL keys=[...] types=[...] rows=N enc=vK
  const m = line.match(/^##TBL keys=(\[.*?\]) types=(\[.*?\]) rows=(\d+) enc=v(\d+)$/)
  if (!m) return null
  let keys, types
  try {
    keys = JSON.parse(m[1])
    types = JSON.parse(m[2])
  } catch {
    return null
  }
  return { keys, types, rows: Number(m[3]), enc: Number(m[4]) }
}

function decodeTable(text) {
  const lines = text.split('\n')
  const head = parseHeader(lines[0])
  if (!head) throw new Error('compaction: not a ##TBL block')
  const { keys, types } = head
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCells(lines[i])
    const obj = {}
    for (let j = 0; j < keys.length; j++) {
      const d = decodeCell(cells[j], types[j])
      if (!d.absent) obj[keys[j]] = d.value
    }
    out.push(obj)
  }
  return out
}

// ── structural equality over JSON-shaped data (no deps) ──────────────────────
// Key ORDER is irrelevant (objects compare by key set), which is correct: the
// reformat preserves every key/value pair, not their textual order.
function jsonEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return a === b
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!jsonEqual(a[k], b[k])) return false
  }
  return true
}

// The fidelity predicate the verify guard is built on: does `text` decode back to
// exactly `value`? Tested both ways (true for a good block, false for a corrupted
// one) so the fallback path in compact() is provably load-bearing.
function roundTripsLossless(value, text) {
  let decoded
  try {
    decoded = decodeTable(text)
  } catch {
    return false
  }
  return jsonEqual(decoded, value)
}

// ── eligibility ──────────────────────────────────────────────────────────────
function isArrayOfObjects(v) {
  if (!Array.isArray(v) || v.length === 0) return false
  for (const el of v) {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) return false
  }
  return true
}

function estimateTokens(s) {
  return Math.ceil(s.length * TOKENS_PER_CHAR)
}

// ── the public transform ─────────────────────────────────────────────────────
// compact(value, opts) → {
//   compacted: boolean,        // true only if we actually emitted a ##TBL block
//   text: string,              // ALWAYS ready to send to the model (block, or raw JSON)
//   reason: string,            // why it was / wasn't compacted (for logging/measurement)
//   originalChars, compactedChars, ratio,   // measured size, never estimated
//   originalTokensEst, compactedTokensEst,  // ESTIMATE only (≈chars/4)
// }
// expand(text) is the exact inverse: ##TBL → array, otherwise JSON.parse.
//
// Guarantee: expand(compact(x).text) deep-equals x for ALL inputs. When verify is
// on (default), a round-trip is checked inline and ANY mismatch forces passthrough
// — we would rather send more tokens than send a single altered value.
function compact(value, opts = {}) {
  const {
    minRows = MIN_ROWS,
    minTokens = MIN_TOKENS,
    coreFieldFraction = CORE_FIELD_FRACTION,
    heterogeneousCoreRatio = HETEROGENEOUS_CORE_RATIO,
    verify = true,
  } = opts

  const original = JSON.stringify(value)
  const base = {
    compacted: false,
    text: original,
    originalChars: original.length,
    compactedChars: original.length,
    ratio: 1,
    originalTokensEst: estimateTokens(original),
    compactedTokensEst: estimateTokens(original),
  }

  if (!isArrayOfObjects(value)) return { ...base, reason: 'not-array-of-objects' }
  if (value.length < minRows) return { ...base, reason: 'below-min-rows' }
  if (estimateTokens(original) < minTokens) return { ...base, reason: 'below-min-tokens' }

  // Union keys + how often each appears → is the array uniform enough for one table?
  const presence = new Map()
  for (const row of value) {
    for (const k of Object.keys(row)) presence.set(k, (presence.get(k) || 0) + 1)
  }
  const keyCount = presence.size
  if (keyCount === 0) return { ...base, reason: 'no-keys' }
  let coreKeys = 0
  for (const n of presence.values()) {
    if (n / value.length >= coreFieldFraction) coreKeys++
  }
  const coreShare = coreKeys / keyCount
  if (coreShare < heterogeneousCoreRatio) {
    // Too ragged for a clean single table. Multi-bucket compaction of heterogeneous
    // arrays is a deliberate v2 deferral (see README); v1 stays lossless by passing
    // the original through rather than guessing a discriminator.
    return { ...base, reason: 'heterogeneous' }
  }

  const text = encodeTable(value)

  if (verify && !roundTripsLossless(value, text)) {
    // Fidelity guard tripped — should never happen for JSON-shaped input, but if it
    // does we fail LOUD-SAFE: ship the original, flag it, never a lossy reformat.
    return { ...base, reason: 'verify-failed-fallback' }
  }

  if (text.length >= original.length) {
    // No actual saving (tiny/degenerate shapes) — don't pay the header cost.
    return { ...base, reason: 'no-gain' }
  }

  return {
    compacted: true,
    text,
    reason: 'compacted',
    originalChars: original.length,
    compactedChars: text.length,
    ratio: text.length / original.length,
    originalTokensEst: estimateTokens(original),
    compactedTokensEst: estimateTokens(text),
  }
}

function expand(text) {
  if (typeof text === 'string' && text.startsWith('##TBL')) return decodeTable(text)
  return JSON.parse(text)
}

module.exports = {
  compact,
  expand,
  // lower-level codec + predicates (exported for tests and advanced callers)
  encodeTable,
  decodeTable,
  roundTripsLossless,
  jsonEqual,
  isArrayOfObjects,
  estimateTokens,
  // constants
  MIN_ROWS,
  MIN_TOKENS,
  CORE_FIELD_FRACTION,
  HETEROGENEOUS_CORE_RATIO,
  ENC_VERSION,
}
