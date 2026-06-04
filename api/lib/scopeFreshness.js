'use strict'

// ============================================================================
// lib/scopeFreshness.js — intel-v13 C4 (step a), the PURE data-version core.
//
// THE PROBLEM IT SOLVES. C3 made the insight *words* regenerate when a user
// changes a filter or date (a PULL: the scope key changed, so refetch). C4 is
// the PUSH counterpart — re-narrate when new data actually LANDS for a scope the
// user is just sitting on. The live pipe we have (useLiveStream, C1) is a single
// SSE broadcast to every browser: it says "SOME tenant pushed" with no payload
// and no tenant id (leak-safe by construction — see useLiveStream.js). Blindly
// refetching the (two-query) scope-insight on every global tick would be wasteful
// and mostly meaningless: the tick that fired was probably another tenant's.
//
// So we need a CHEAP per-scope "did MY data change?" probe that gates the
// expensive re-narration. fact_metric has NO updated_at/ingested_at column
// (migration 010 — grain is client_id,date,channel_id,entity_id,metric_key,
// metric_value), so a scope's "data version" cannot be a row timestamp. It must
// be CONTENT-derived: a deterministic fingerprint folded from a cheap aggregate
// of the scoped rows — row count + latest date + a per-key value checksum. When
// ingestion adds rows, advances the latest date, or corrects a value in place,
// the fingerprint moves; otherwise it is byte-for-byte identical.
//
// WHAT THIS MODULE IS. Pure functions only — no I/O, no DB, no clock, no random.
// step b runs ONE cheap SQL aggregate (GROUP BY metric_key → a handful of rows of
// {key,rows,maxDate,sumValue}) for the resolved tenant scope and folds it here
// into an opaque token; the FE compares two tokens across probes and re-narrates
// only when they differ. Keeping the fold pure makes it exhaustively testable and
// keeps the token grammar in one versioned place.
//
// LEAK-SAFE. The token is derived ONLY from aggregates of the caller's already-
// tenant-scoped rows. It carries no peer data and nothing tenant-identifying —
// two probes of the SAME scope at different times are all that's ever compared
// (the FE resets its baseline when the scope key changes, so cross-scope token
// equality is never relied upon). The token is opaque; it is a change-detector,
// not a data channel.
//
// FAIL-SAFE. Malformed / partial / garbage input never throws — it folds to the
// canonical EMPTY token. A probe glitch therefore degrades to "no change"
// (shouldRefresh → false: no spurious refetch, no broken render), never to a
// crash. Determinism and order-independence are contract-locked by the tests.
// ============================================================================

// Token grammar:  sf1:<totalRows>:<maxDate>:<fpBase36>   (or the EMPTY sentinel).
// Bump VERSION_PREFIX if the grammar changes so stale baselines from an older
// client never compare equal to a new-grammar token (a mismatch is harmless — it
// just forces one refetch — but the explicit version makes that intent legible).
const VERSION_PREFIX = 'sf1'
const EMPTY_TOKEN = `${VERSION_PREFIX}:empty`

// ──────────────────────────────────────────────────────────────────────────
// small pure helpers
// ──────────────────────────────────────────────────────────────────────────

// Quantise a value to integer "cents" (hundredths). This is what makes the
// fingerprint sensitive to in-place value CORRECTIONS (same grain key, changed
// number) while staying immune to floating-point re-summation noise: a re-sync
// that nudges spend by ≥ $0.01 moves the token; sub-cent float jitter does not.
// Non-finite / non-numeric → 0 (fail-safe).
function toCents(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

// Coerce to a non-negative integer row count; garbage → 0.
function toCount(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const i = Math.trunc(n)
  return i > 0 ? i : 0
}

// Normalise a date-ish value to a bare 'YYYY-MM-DD' (accepts a full ISO
// timestamp and keeps only the calendar day; rejects anything malformed → '').
// Lexical comparison of these strings is a valid chronological max.
function normDate(v) {
  if (v == null) return ''
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

// FNV-1a, 32-bit. Deterministic, fast, dependency-free. Used to fold each
// aggregate partial into a commutative running fingerprint so the token is
// order-independent yet sensitive to every field of every partial.
function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // h *= 16777619, via shifts, kept in uint32
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

// Normalise one aggregate partial to its canonical shape. Accepts a variety of
// caller field names (a raw SQL row, a hand-built object, or an already-canonical
// partial) and never throws:
//   key      — metric_key / channel / dimension label (string; '' if absent)
//   rows     — row count behind this partial (int ≥ 0)
//   maxDate  — latest 'YYYY-MM-DD' in this partial ('' if none)
//   cents    — integer hundredths of the partial's value sum (pre-quantised if
//              `cents` was supplied, else quantised from sumValue/value)
function normPartial(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { key: '', rows: 0, maxDate: '', cents: 0 }
  }
  const key =
    p.key != null ? String(p.key)
    : p.metric_key != null ? String(p.metric_key)
    : p.metric != null ? String(p.metric)
    : p.channel != null ? String(p.channel)
    : ''
  const rows = toCount(p.rows != null ? p.rows : p.count)
  const maxDate = normDate(
    p.maxDate != null ? p.maxDate
    : p.max_date != null ? p.max_date
    : p.date,
  )
  const cents =
    p.cents != null && Number.isFinite(Number(p.cents))
      ? Math.trunc(Number(p.cents))
      : toCents(p.sumValue != null ? p.sumValue
        : p.sum_value != null ? p.sum_value
        : p.value)
  return { key, rows, maxDate, cents }
}

// ──────────────────────────────────────────────────────────────────────────
// public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fold a cheap per-scope aggregate into an opaque data-version token.
 *
 * @param {object|object[]} input  one aggregate partial, or an array of them
 *        (the cheap probe in step b is `GROUP BY metric_key` → one partial per
 *        metric). Each partial: { key?, rows, maxDate, sumValue|cents }. Field
 *        aliases (metric_key/channel, max_date/date, sum_value/value, count) are
 *        accepted. Per-KEY partials are preferred: keying the fingerprint by
 *        metric means a redistribution of value across metrics that leaves the
 *        grand totals unchanged still moves the token (a single combined
 *        aggregate cannot see that). Passing one keyless partial is valid but
 *        coarser.
 * @returns {string} `sf1:<totalRows>:<maxDate>:<fp>` for non-empty scopes, or the
 *        canonical EMPTY token when the scope has zero rows / input is garbage.
 *        Deterministic and order-independent.
 */
function versionFromAggregate(input) {
  const list = Array.isArray(input) ? input : [input]
  let totalRows = 0
  let maxDate = ''
  let fp = 0
  for (const raw of list) {
    const p = normPartial(raw)
    totalRows += p.rows
    if (p.maxDate && p.maxDate > maxDate) maxDate = p.maxDate
    //  is a field separator that cannot occur inside a key/date/number,
    // so distinct partials cannot collide by concatenation ambiguity. Summing
    // the per-partial hashes is commutative → order-independent.
    fp = (fp + fnv1a32(`${p.key}${p.rows}${p.maxDate}${p.cents}`)) >>> 0
  }
  if (!(totalRows > 0)) return EMPTY_TOKEN
  return `${VERSION_PREFIX}:${totalRows}:${maxDate}:${fp.toString(36)}`
}

/**
 * Aggregate raw fact-ish rows into per-metric_key partials. A convenience for
 * tests and any caller holding rows rather than a pre-rolled aggregate; step b
 * does the equivalent in SQL. Groups by metric_key (so the fingerprint is
 * cancellation-resistant), summing value into cents and tracking the latest date
 * and row count per key. Non-array / empty → [].
 *
 * @param {Array<{date?, metric_key?, metric_value?|value?}>} rows
 * @returns {Array<{key,rows,maxDate,cents}>}
 */
function aggregateRows(rows) {
  if (!Array.isArray(rows)) return []
  const byKey = new Map()
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const key =
      r.metric_key != null ? String(r.metric_key)
      : r.metric != null ? String(r.metric)
      : r.key != null ? String(r.key)
      : ''
    const date = normDate(r.date != null ? r.date : r.max_date)
    const cents = toCents(r.metric_value != null ? r.metric_value
      : r.value != null ? r.value
      : r.sumValue)
    let agg = byKey.get(key)
    if (!agg) { agg = { key, rows: 0, maxDate: '', cents: 0 }; byKey.set(key, agg) }
    agg.rows += 1
    agg.cents += cents
    if (date && date > agg.maxDate) agg.maxDate = date
  }
  return Array.from(byKey.values())
}

/**
 * Convenience entry that fingerprints RAW rows directly:
 * versionFromAggregate(aggregateRows(rows)).
 */
function computeScopeVersion(rows) {
  return versionFromAggregate(aggregateRows(rows))
}

/**
 * Did this scope's data CHANGE between two probes? — the gate the FE uses to
 * decide whether a global live tick warrants re-narrating THIS scope.
 *
 *   • next not a valid token            → false  (no usable reading; never refetch)
 *   • prev not a valid token (1st probe) → false  (adopt as baseline; the panel's
 *                                                   initial fetch already reflects
 *                                                   current data — no spurious refetch)
 *   • prev === next                      → false  (steady; includes EMPTY≡EMPTY)
 *   • both valid and differ              → true   (changed → re-narrate)
 *
 * "Changed" (not "strictly newer"): an in-place value correction is a legitimate
 * reason to re-narrate even though it isn't chronologically later, and tokens are
 * opaque so there is no ordering to compare anyway.
 */
function shouldRefresh(prev, next) {
  if (!isValidToken(next)) return false
  if (!isValidToken(prev)) return false
  return prev !== next
}

// A token this module would emit: the versioned prefix plus a body. The EMPTY
// sentinel qualifies (it starts with `${VERSION_PREFIX}:`), so EMPTY is a valid
// baseline and an EMPTY→populated transition correctly reads as a change.
function isValidToken(t) {
  return typeof t === 'string' && t.startsWith(`${VERSION_PREFIX}:`) && t.length > VERSION_PREFIX.length + 1
}

module.exports = {
  VERSION_PREFIX,
  EMPTY_TOKEN,
  toCents,
  normDate,
  normPartial,
  aggregateRows,
  versionFromAggregate,
  computeScopeVersion,
  shouldRefresh,
  isValidToken,
}
