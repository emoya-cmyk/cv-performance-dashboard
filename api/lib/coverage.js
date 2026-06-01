'use strict'

// ============================================================
// lib/coverage.js — per-channel connection-health watchdog (PURE).
//
// The aggregate weekly series the rest of the engine reads can look perfectly
// fresh while a SINGLE channel has silently stopped delivering: the weekly roll-up
// still has a row (the other channels filled it), so detectDataHealth() — which
// only watches the aggregate's recency — sees nothing wrong. Meanwhile that dead
// channel quietly degrades every downstream number: the anomaly band, the trend
// slope, the forecast, the peer benchmark. Inaccuracy with no symptom.
//
// This module closes that hole. Given each channel's own delivery stats over a
// trailing window (computed from the atomic fact grain, fact_metric), it flags any
// channel that has gone dark BEYOND ITS OWN RHYTHM and emits a `coverage_gap`
// finding — which narrates to exactly one operator instruction: "reconnect this
// account." That is the product's north star made literal: the tool needs no
// operator except to connect accounts, so the engine watches for the failure of
// that one job, per channel, and surfaces it on its own.
//
// Cadence-AWARE by construction. A feed that naturally reports weekly must not be
// flagged at its normal ~7-day gap, while a daily feed dark for a week clearly has.
// So eligibility and severity are measured in days-BEYOND-the-channel's-own-cadence,
// where cadence is estimated from the channel's recent history (span ÷ number of
// gaps). A normally-weekly channel silent 7 days scores `beyond = 0` (no flag); a
// daily channel silent 7 days scores `beyond = 6` (warning).
//
// PURE: stats in, findings out. No DB, no clock, no network — the caller reads the
// per-channel stats and passes `asOf`. Unit-testable with plain objects. Empty or
// historyless input → [] (a hard no-op): "no channel stats" must NEVER be read as
// "everything is dark."
//
// The shape returned matches what runInsightsForClient() already persists/dedupes/
// lifecycles, with two coverage-specific fields:
//   • fingerprint_key: <channel key> — so two channels dark on the same last_date
//     get DISTINCT insight identities (fingerprintOf appends it; back-compatible —
//     other kinds never set it, so their hashes are unchanged).
//   • score: days_beyond — the ranking magnitude (how far past its rhythm).
// ============================================================

// Whole days from ISO day `aIso` → `bIso` (i.e. b − a), anchored at UTC midnight so
// it is independent of the host timezone. Returns null on unparseable input.
function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null
  const a = Date.parse(String(aIso).slice(0, 10) + 'T00:00:00Z')
  const b = Date.parse(String(bIso).slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const num   = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }

// Estimate a channel's natural reporting cadence (typical days between deliveries)
// from its own recent history: the observed span divided by the number of gaps
// (activeDays − 1), clamped to [1, 14]. A daily feed (span ≈ activeDays−1) → ~1; a
// weekly feed (span ≈ 7·(activeDays−1)) → ~7. Clamped so a sparse or degenerate
// history can neither suppress all detection (cap 14) nor divide by zero (floor 1).
function estimateCadence(spanDays, activeDays) {
  const gaps = Math.max(1, (Number(activeDays) || 0) - 1)
  const span = Math.max(0, Number(spanDays) || 0)
  const raw  = Math.round(span / gaps)
  return clamp(Number.isFinite(raw) && raw > 0 ? raw : 1, 1, 14)
}

// channels: [{ key, label, category, last_date, first_date, active_days, span_days? }]
//   last_date/first_date — ISO day of the channel's newest/oldest fact in the window
//   active_days          — count of DISTINCT days the channel delivered in the window
//   span_days            — first_date→last_date in days (optional; derived if absent)
// asOf: ISO day the data is expected to be current through (the sweep day).
// opts: { infoDays=4, warnDays=7, critDays=14, minActiveDays=2, windowDays=null }
//   tier thresholds are in DAYS-BEYOND-CADENCE; minActiveDays screens out channels
//   without an established rhythm; windowDays is recorded in evidence for context.
//
// Returns coverage_gap findings, worst-first. Empty/historyless input → [].
function detectCoverageGaps(channels, asOf, opts = {}) {
  if (!Array.isArray(channels) || channels.length === 0) return []
  const day = String(asOf || '').slice(0, 10)
  if (!day) return []

  const infoDays      = num(opts.infoDays, 4)
  const warnDays      = num(opts.warnDays, 7)
  const critDays      = num(opts.critDays, 14)
  const minActiveDays = num(opts.minActiveDays, 2)
  const windowDays    = opts.windowDays == null ? null : num(opts.windowDays, null)

  const out = []
  for (const ch of channels) {
    if (!ch) continue
    const key   = ch.key
    const last  = ch.last_date  ? String(ch.last_date).slice(0, 10)  : null
    const first = ch.first_date ? String(ch.first_date).slice(0, 10) : null
    const active = Number(ch.active_days) || 0
    if (!key || !last || !first) continue

    // Never-connected / barely-seen screen-out: without an established history we
    // cannot tell "the connection dropped" from "this was never set up," and
    // reconnect-nagging a channel that never really delivered is pure noise.
    if (active < minActiveDays) continue

    const daysDark = daysBetween(last, day)
    if (daysDark == null || daysDark <= 0) continue   // up to date (or clock skew) → not dark

    const span    = ch.span_days != null ? Number(ch.span_days) : daysBetween(first, last)
    const cadence = estimateCadence(span, active)
    const beyond  = daysDark - cadence
    if (beyond < infoDays) continue                   // still within its own rhythm → not a gap

    const severity = beyond >= critDays ? 'critical'
                   : beyond >= warnDays ? 'warning'
                   : 'info'

    out.push({
      kind:           'coverage_gap',
      metric:         null,
      scope:          'client',
      severity,
      direction:      'down',
      score:          beyond,         // ranking magnitude: how far past its own cadence
      period_start:   last,           // stable while dark → the SAME row refreshes each sweep
      fingerprint_key: key,           // distinct identity per channel (see fingerprintOf)
      evidence: {
        channel:          key,
        channel_label:    ch.label || key,
        category:         ch.category || null,
        days_dark:        daysDark,
        days_beyond:      beyond,
        cadence_days:     cadence,
        last_date:        last,
        expected_through: day,
        active_days:      active,
        window_days:      windowDays,
      },
    })
  }

  // Worst-first, fully deterministic: severity desc, then days_beyond desc, then
  // channel key asc (stable tie-break so output order never depends on input order).
  const SEV = { critical: 3, warning: 2, info: 1 }
  out.sort((a, b) =>
    (SEV[b.severity] - SEV[a.severity]) ||
    (b.score - a.score) ||
    String(a.fingerprint_key).localeCompare(String(b.fingerprint_key))
  )
  return out
}

module.exports = { detectCoverageGaps, estimateCadence, daysBetween }
