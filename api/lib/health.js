'use strict'

// ============================================================
// lib/health.js — one number for "how is this client doing?"
//
// The engine emits a STREAM of individual findings (anomalies, trends, forecast
// misses, pacing slips, data-health gaps), each ranked by severity then a per-kind
// magnitude. That stream is the right grain for "what is wrong," but it is the
// wrong grain for the question an agency lead or an internal user asks FIRST every
// morning: of my N clients, WHERE do I look first? Reading fifty interleaved
// findings to reconstruct "Acme has a critical plus three warnings, so it's worse
// off than Globex with its lone warning" is exactly the manual scan this tool
// exists to remove.
//
// This module is the synthesis layer on top of everything intel-v2/v3 built. It
// rolls one client's open findings into a single 0–100 HEALTH SCORE, a band, and
// the one finding most responsible for the deduction — and ranks the whole
// portfolio worst-first into a triage roster. Pure arithmetic, no model, nothing
// to calibrate: the same inputs always yield the same roster.
//
// THE SCORE. Health starts at a perfect 100 and each open finding takes a bite.
// Bites COMPOUND multiplicatively rather than sum:
//
//   health = 100 × Π (1 − pᵢ)        pᵢ = damage(severityᵢ) × confidenceFactorᵢ
//
// The product form is deliberate and has the properties a sum does not:
//   • bounded in (0, 100] — ten warnings can never drive health negative;
//   • monotone — every extra or worse finding only ever lowers it;
//   • order-independent — multiplication commutes, so the roster is stable;
//   • diminishing returns — the fifth warning hurts less than the first, which
//     matches how a human reads a pile-up (the client is "already in trouble").
//
// DAMAGE is a fixed per-severity fraction (critical ≫ warning ≫ info) — the only
// constants here, chosen so one critical alone lands a client in "at risk" and a
// lone info barely registers. No per-kind weighting: a critical forecast miss and
// a critical anomaly are equally alarming at the portfolio grain.
//
// CONFIDENCE FACTOR folds in the self-improving precision loop (lib/precision.js)
// — but ONLY ever to QUIET noise, never to amplify. A finding-kind THIS client has
// repeatedly ignored (learned weight < 1) bites less; a kind they reliably act on
// does NOT bite more (the factor is capped at 1). This keeps the score honest: the
// loop can stop a client's pet false-alarm from dragging their score down, but it
// can never manufacture severity. Two findings stay sacrosanct, exactly as in the
// feed ranker (insights.js#rankWeight): a `critical`, by definition the thing that
// most needs eyes, and `data_health`, which keeps the tool self-sustaining — both
// always bite at full strength regardless of what the client clicks.
//
// THE NO-OP GUARANTEE. With no learned history every weight is the neutral 1.0, so
// every confidence factor is 1.0 and the score is a pure function of the severity
// counts — identical whether or not the precision loop has run. The loop only ever
// sharpens the roster as it learns; it can never silently rewrite a fresh client's
// score. (The same guarantee precision, forecast intervals and attribution carry.)
//
// Pure functions only — no DB, no clock, no LLM, like attribution.js / forecast.js
// / selftune.js. Never throws: a missing, empty, or garbage feed yields a
// perfect-100, no-driver verdict, so a client with nothing wrong reads as flawless.
// ============================================================

// Per-severity damage fraction — the bite ONE finding of each severity takes out of
// a perfect score before the confidence factor. Tuned so: one info → 96 (healthy),
// one warning → 80 (watch), one critical → 45 (at risk), a critical plus a warning
// → 36 (critical). Criticals dominate; infos are nearly cosmetic.
const SEVERITY_DAMAGE = { critical: 0.55, warning: 0.2, info: 0.04 }

// Score → band. Cutoffs chosen against the damage constants above: a lone warning
// (80) is "watch," a lone critical (45) is "at risk," anything compounding past a
// single critical (< 40) is "critical." Bands are advisory labels for the UI; the
// score is the source of truth and the sort key. Descending by `min` so the first
// satisfied cutoff wins.
const BAND_CUTOFFS = [
  { band: 'healthy',  min: 85 },
  { band: 'watch',    min: 65 },
  { band: 'at_risk',  min: 40 },
  { band: 'critical', min: 0  },
]

// A learned-ignore can damp a finding's bite to this floor but never erase it: a
// client clicking away their anomalies should QUIET, not silence, the score's
// response. Deliberately health's OWN policy constant, independent of precision's
// WEIGHT_MIN (which bounds feed RE-RANKING; this bounds health DAMPING) so retuning
// one never silently moves the other. Real learned weights floor at 0.6, so this
// 0.5 is a safety net against malformed input, not a value reached in practice.
const FACTOR_FLOOR = 0.5

// Tie-break rank for the headline driver — same order as the feed's SEV_RANK.
const SEV_ORDER = { critical: 3, warning: 2, info: 1 }

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n
}

// A finding's confidence factor: how hard its severity bites AFTER folding in what
// this client has taught us. `data_health` and `critical` are exempt (always 1.0 —
// they bite at full strength no matter what). Otherwise a learned weight below 1 (a
// kind this client tends to ignore) damps the bite toward FACTOR_FLOOR; a weight at
// or above 1 leaves it at full strength (capped — precision QUIETS, never
// amplifies). Absent or odd precision → neutral 1.0, the pre-loop behavior.
function confidenceFactor(row) {
  if (!row) return 1
  if (row.kind === 'data_health' || row.severity === 'critical') return 1
  const w = row.precision && Number(row.precision.weight)
  if (!Number.isFinite(w) || w <= 0) return 1
  return clamp(Math.min(1, w), FACTOR_FLOOR, 1)
}

// Map a 0–100 score to its band label. Total: clamps first, so any number lands.
function healthBand(score) {
  const s = clamp(Number(score) || 0, 0, 100)
  for (const c of BAND_CUTOFFS) if (s >= c.min) return c.band
  return 'critical' // unreachable (last cutoff min = 0) — defensive
}

// ── score one client ────────────────────────────────────────────────────────────
// insights: that client's OPEN/active findings (normalized rows as the feed returns
// them — severity, kind, metric, direction, score, optional precision). Returns
// { score, band, counts, driver, contributors } for ANY input:
//   • score        : integer 0–100, 100 = nothing open
//   • band         : healthy | watch | at_risk | critical
//   • counts       : { critical, warning, info, total }
//   • driver       : the single finding that took the biggest realized bite (or
//                    null when nothing is open) — the "why this client scored low"
//   • contributors : every counted finding with its realized damage (as an integer
//                    percent), biggest-first, so a surface can show the full
//                    breakdown audit-grade.
function scoreClient(insights) {
  const rows = Array.isArray(insights) ? insights : []
  const counts = { critical: 0, warning: 0, info: 0, total: 0 }
  const contributors = []
  let product = 1

  for (const row of rows) {
    const sev = row && row.severity
    const base = SEVERITY_DAMAGE[sev]
    if (!Number.isFinite(base)) continue // unknown/absent severity → no effect, can't be a driver
    counts[sev]++
    counts.total++
    const damage = base * confidenceFactor(row) // realized bite ∈ [0, base]
    product *= 1 - damage
    contributors.push({
      metric:    row.metric || null,
      kind:      row.kind || null,
      severity:  sev,
      direction: row.direction || null,
      damage, // raw fraction, for sorting; mapped to a percent on the way out
    })
  }

  // biggest realized bite first; ties by severity, then input order stays stable
  contributors.sort(
    (a, b) =>
      b.damage - a.damage ||
      (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0)
  )

  const displayed = contributors.map(({ damage, ...c }) => ({
    ...c,
    damage_pct: Math.round(damage * 100),
  }))
  const score = Math.round(clamp(100 * product, 0, 100))

  return {
    score,
    band: healthBand(score),
    counts,
    driver: displayed.length ? displayed[0] : null,
    contributors: displayed,
  }
}

// ── rank a portfolio ──────────────────────────────────────────────────────────
// groups: [{ client_id, client_name, insights:[...] }] — each client with its
// active feed. Returns the same entries enriched with their health verdict, sorted
// WORST-FIRST (lowest score), tie-broken by more criticals, then more total
// findings, then client_name for a stable order. This is the triage roster: where
// to look first, top of the list. Pure — same groups always yield the same roster.
function rankPortfolio(groups) {
  const list = Array.isArray(groups) ? groups : []
  return list
    .map((g) => ({
      client_id:   g && g.client_id != null ? g.client_id : null,
      client_name: g && g.client_name != null ? g.client_name : null,
      ...scoreClient(g && g.insights),
    }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.counts.critical - a.counts.critical ||
        b.counts.total - a.counts.total ||
        String(a.client_name || '').localeCompare(String(b.client_name || ''))
    )
}

module.exports = {
  scoreClient,
  rankPortfolio,
  healthBand,
  confidenceFactor,
  // constants (exported for tests + any consumer that wants the same thresholds)
  SEVERITY_DAMAGE,
  BAND_CUTOFFS,
  FACTOR_FLOOR,
}
