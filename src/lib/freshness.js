// ============================================================================
// lib/freshness.js — the recency classifier behind every "live" badge (intel-v13 C1).
//
// One PURE function, no I/O, no React, no DOM — so it unit-tests in isolation
// (covered by the API gate via a dynamic import from api/test/) AND imports
// natively into the FE (useLiveStream, liveness badges) as ESM. Single source of
// truth for "how fresh is this?", consumed on every surface.
//
// It answers exactly one question: given a last-seen timestamp and "now", is a
// stream/channel LIVE (a heartbeat or event within the last ~90s), merely RECENT
// (within the hour), STALE (older), or UNKNOWN (never seen / unparseable)? The
// SSE transport pings every 30s and real events arrive sporadically, so the live
// window is deliberately a few ping-intervals wide — a single dropped ping must
// not flip a healthy stream to "stale".
//
// LEAK-SAFE BY NATURE: this module only ever touches timestamps and the integer
// age between them. No client id, no name, no figure, no agency internal can pass
// through it — the richest thing it emits is a relative-age label like "3m ago",
// which is safe on any surface (agency or client).
//
// TOTAL: every guard errs toward a defined, non-throwing result. Junk input
// classifies as 'unknown' rather than blowing up a render.
// ============================================================================

// Live = within a few SSE ping-intervals (ping is 30s); recent = within the hour.
// Exported so the badge layer (C2) can show the same thresholds it classifies by.
export const FRESHNESS_THRESHOLDS = Object.freeze({
  liveMs:   90_000,      // ≤ 90s  → 'live'   (heartbeat/event seen very recently)
  recentMs: 3_600_000,   // ≤ 1h   → 'recent' (data is current but not actively streaming)
})

/**
 * Coerce a timestamp of unknown provenance to epoch-ms, or null if it can't be
 * trusted. Accepts a Date, an epoch-ms number, or an ISO/date string. A numeric
 * STRING (e.g. "1700000000000") is intentionally rejected — epoch values must
 * arrive as numbers; a bare number-string is far more likely a malformed field
 * than a real instant, and 'unknown' is the safe classification for it.
 *
 * @param {unknown} t
 * @returns {number|null}
 */
function toMs(t) {
  if (t == null) return null
  if (t instanceof Date) {
    const n = t.getTime()
    return Number.isFinite(n) ? n : null
  }
  if (typeof t === 'number') return Number.isFinite(t) ? t : null
  if (typeof t === 'string') {
    const s = t.trim()
    if (!s) return null
    const n = Date.parse(s)            // ISO / RFC strings → ms; junk → NaN
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * A relative-age label — the only string this module emits. Pure buckets, no
 * locale dependence, no figures beyond the age itself. Returns '' for a
 * non-finite/negative age so callers can treat it as "no label".
 *
 * @param {number} ageMs
 * @returns {string}
 */
export function formatAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return ''
  const s = Math.floor(ageMs / 1000)
  if (s < 5)  return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/**
 * Classify how fresh a last-seen timestamp is, relative to `now`.
 *
 * @param {Date|number|string|null|undefined} asOf  last time this thing was seen
 * @param {Date|number} [now]   reference instant (defaults to Date.now())
 * @param {{liveMs?: number, recentMs?: number}} [opts]  threshold overrides
 * @returns {{state: 'live'|'recent'|'stale'|'unknown', ageMs: number|null, label: string, fresh: boolean}}
 *
 * - 'unknown' (ageMs null) when asOf is missing or unparseable.
 * - Future timestamps (clock skew between server and browser) clamp to age 0 and
 *   read as 'live' — the freshest possible — never as an error.
 * - Boundaries are inclusive of the younger bucket: age == liveMs → 'live';
 *   age == recentMs → 'recent'.
 */
export function classifyFreshness(asOf, now = Date.now(), opts = {}) {
  const liveMs   = Number.isFinite(opts.liveMs)   ? opts.liveMs   : FRESHNESS_THRESHOLDS.liveMs
  const recentMs = Number.isFinite(opts.recentMs) ? opts.recentMs : FRESHNESS_THRESHOLDS.recentMs

  const t = toMs(asOf)
  if (t == null) return { state: 'unknown', ageMs: null, label: 'no data', fresh: false }

  const nowMs = toMs(now)
  const ref   = nowMs == null ? Date.now() : nowMs
  let ageMs   = ref - t
  if (ageMs < 0) ageMs = 0            // future ts → clock skew, treat as freshest

  let state
  if (ageMs <= liveMs)        state = 'live'
  else if (ageMs <= recentMs) state = 'recent'
  else                        state = 'stale'

  return { state, ageMs, label: formatAge(ageMs), fresh: state === 'live' }
}
