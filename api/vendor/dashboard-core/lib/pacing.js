'use strict'

// ============================================================
// lib/pacing.js — goal-pacing intelligence (PURE).
//
// Every other layer in the stack measures a client against ITSELF — its own baseline,
// its own health band, its own recent slope. None of them know the one number the client
// and the agency actually shook hands on: the monthly GOAL. A client can be perfectly
// healthy by every internal yardstick and still be quietly walking toward a missed target
// — and nobody finds out until the month closes and the number is short. By then it is a
// post-mortem, not a save. This module is the missing yardstick: it watches the human-set
// monthly target (client_goals: revenue / leads / jobs) and answers, every single day,
// "at the rate this client is actually going, do they hit it — and if not, by how much,
// and how hard would they have to push to still make it?"
//
// The model is the legible one on purpose: linear run-rate. You have `actual` so far with
// `daysElapsed` of `daysInMonth` gone, so your daily rate is actual/daysElapsed and your
// projected month-end is that rate carried to the end (actual / elapsed). attainment is
// projected/target — 0.88 means "on pace for 88% of goal." This is exactly what "on pace
// for X" means in plain English, which is the whole point: a client reads it without a
// data-science degree, and an account lead can defend every digit. The trend-aware Holt
// projection already lives in trajectory.js for health; pacing is deliberately the simple,
// explainable target model, not a second forecaster.
//
// HONESTY BY CONSTRUCTION — the projection is noisiest exactly when the month is youngest,
// so one slow opening day cannot scream "at risk." Below MIN_ELAPSED of the month the verdict
// reports its numbers but withholds the alarm band, returning status 'early' (the pacing twin
// of trajectory.js refusing a crossing before MIN_HISTORY). confidence is simply the share of
// the month actually observed — 0 at the start, 1 at the close — so a projection earns trust
// as evidence accrues. A client with no target set for the month has nothing to pace against
// and returns a quiet 'none' no-op: it never appears, never alarms, renders exactly as before.
//
// AGENCY-grade as a ranked ROSTER (who will miss goal, worst first), but a single verdict is
// computed from that client's own actual-vs-target alone and leaks nothing cross-tenant — so
// the very same verdict is safe to show a client about themselves ("you're pacing to 88% of
// your leads goal"), the way trajectory's per-client warning is. Only the roster is agency-only.
//
// PURE: numbers in, verdict out. No DB, no clock (the caller passes daysElapsed/daysInMonth —
// the engine supplies the real date, tests supply fixed ones), no network, no LLM, no mutation
// of inputs (matching trajectory.js / health.js / forecast.js). Missing target / zero-length
// month / garbage → a quiet no-op verdict, never a throw.
// ============================================================

const MIN_ELAPSED = 0.15   // below this share of the month, withhold the alarm band ('early')

// attainment (projected ÷ target) → status band. Dead-zones keep a client a hair under
// target reading 'on_track', not falsely alarmed; the floors map straight to UI urgency.
const AHEAD_AT    = 1.05   // projecting ≥105% of goal → 'ahead'
const ON_TRACK_AT = 0.92   // ≥92% (and < ahead) → 'on_track' — close enough to defend
const BEHIND_AT   = 0.75   // ≥75% (and < on_track) → 'behind'; below → 'at_risk'

// roster ordering: which needs a human first. (Bands not in this map — ahead/on_track/
// early/none — never reach the roster.)
const STATUS_RANK = { at_risk: 2, behind: 1 }

const clamp  = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)
const num    = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const nonneg = (n) => (n < 0 ? 0 : n)
const round0 = (x) => Math.round(x)
const round2 = (x) => Math.round(x * 100) / 100
const round3 = (x) => Math.round(x * 1000) / 1000

// attainment → band (only reached once the month is past MIN_ELAPSED and a target exists).
function paceStatus(attainment) {
  if (attainment >= AHEAD_AT)    return 'ahead'
  if (attainment >= ON_TRACK_AT) return 'on_track'
  if (attainment >= BEHIND_AT)   return 'behind'
  return 'at_risk'
}

// A (client, metric) with no goal to pace against, or a degenerate month: a quiet, alarm-free
// verdict carrying whatever facts we have, so it renders as "nothing to pace" and never ranks.
function noVerdict(metric, target, actual) {
  const t = Number.isFinite(target) ? nonneg(round0(target)) : null
  const a = Number.isFinite(actual) ? nonneg(round0(actual)) : null
  return {
    metric: metric || null,
    target: t, actual: a,
    projected: null, attainment: null, gap: null,
    remaining: t != null && a != null ? nonneg(t - a) : null, shortfall: null,
    current_rate: null, required_rate: null, catchup: null,
    days_elapsed: 0, days_in_month: 0, days_remaining: 0, elapsed: 0,
    status: 'none', confidence: null,
  }
}

// ── classify ONE (client, metric) against its monthly goal ────────────────────────
// input: { metric, target, actual, daysElapsed, daysInMonth }
//   metric       : 'revenue' | 'leads' | 'jobs' (echoed back; the module is metric-agnostic)
//   target       : the month's goal for that metric (> 0, else a 'none' no-op)
//   actual       : month-to-date total of that metric (0 is a real, possibly-alarming value)
//   daysElapsed  : whole days of the month already observed (> 0)
//   daysInMonth  : length of the month in days (28–31; > 0)
// opts: { minElapsed = 0.15 } — override the early-month alarm guard (mainly for tests).
// Returns, for ANY input:
//   metric, target, actual                  : echoed / normalized (non-negative integers)
//   projected     : run-rate month-end estimate (actual / elapsed), non-negative, rounded
//   attainment    : projected / target (2dp) — 0.88 = "on pace for 88% of goal"; >1 = ahead
//   gap           : projected − target (signed, rounded) — projected over/undershoot
//   remaining     : max(0, target − actual) — still to do to reach goal
//   shortfall     : max(0, target − projected) — projected MISS amount (0 when on/ahead)
//   current_rate  : actual / daysElapsed, per day (2dp)
//   required_rate : remaining / daysRemaining, per day (2dp), or null when no days remain
//   catchup       : required_rate / current_rate (2dp) — "push this much harder"; null when
//                   already on/ahead of pace, no days remain, or rate is undefined
//   days_elapsed, days_in_month, days_remaining, elapsed (fraction, 3dp)
//   status        : 'ahead' | 'on_track' | 'behind' | 'at_risk' | 'early' | 'none'
//   confidence    : share of the month observed ∈ [0,1] (2dp), or null for a 'none' no-op
function classifyPacing(input = {}, opts = {}) {
  if (!input || typeof input !== 'object') input = {}   // null/garbage → no-op, never a throw
  if (!opts  || typeof opts  !== 'object') opts  = {}
  const metric = input.metric != null ? input.metric : null
  const target = num(input.target, NaN)
  const actual = nonneg(num(input.actual, NaN))
  const dElapsed = Math.trunc(num(input.daysElapsed, NaN))
  const dMonth   = Math.trunc(num(input.daysInMonth, NaN))
  const minElapsed = clamp(num(opts.minElapsed, MIN_ELAPSED), 0, 1)

  // no real goal, or a degenerate month → quiet no-op (mirrors trajectory.noVerdict).
  if (!Number.isFinite(target) || target <= 0) return noVerdict(metric, target, input.actual)
  if (!Number.isFinite(actual) || dMonth <= 0 || dElapsed <= 0) return noVerdict(metric, target, input.actual)

  const daysElapsed   = Math.min(dElapsed, dMonth)        // a closed month caps elapsed at full
  const daysInMonth   = dMonth
  const daysRemaining = nonneg(daysInMonth - daysElapsed)
  const elapsed       = clamp(daysElapsed / daysInMonth, 0, 1)

  const projected   = nonneg(actual / elapsed)            // run-rate carried to month-end
  const attainment  = projected / target                  // == actual/(target·elapsed): pace index
  const gap         = projected - target
  const remaining   = nonneg(target - actual)
  const shortfall   = nonneg(target - projected)
  const currentRate = actual / daysElapsed
  const requiredRate = daysRemaining > 0 ? remaining / daysRemaining : null
  // how much harder you must go to still hit goal; only meaningful when you're behind pace,
  // there's road left, and you've got a rate to multiply.
  const catchup =
    (requiredRate != null && currentRate > 0 && requiredRate > currentRate)
      ? round2(requiredRate / currentRate)
      : null

  // honesty guard: too early in the month to stand behind a band — report numbers, hold the alarm.
  const status     = elapsed < minElapsed ? 'early' : paceStatus(attainment)
  const confidence = round2(elapsed)        // evidence accrued = share of the month observed

  return {
    metric,
    target: round0(target), actual: round0(actual),
    projected: round0(projected),
    attainment: round2(attainment),
    gap: round0(gap),
    remaining: round0(remaining),
    shortfall: round0(shortfall),
    current_rate: round2(currentRate),
    required_rate: requiredRate == null ? null : round2(requiredRate),
    catchup,
    days_elapsed: daysElapsed, days_in_month: daysInMonth, days_remaining: daysRemaining,
    elapsed: round3(elapsed),
    status, confidence,
  }
}

// ── rank a portfolio's at-risk goals ──────────────────────────────────────────────
// rows: [{ client_id, client_name, metric, target, actual, daysElapsed, daysInMonth }] — one
// row per (client, metric) that carries a goal this month. Returns ONLY the rows that need a
// human — 'behind' or 'at_risk' — each enriched with its full pacing verdict, ordered
// most-urgent-first:
//   at_risk before behind → lowest attainment first (cross-metric-fair, it's a ratio) →
//   hardest catch-up first → name.
// 'ahead' / 'on_track' / 'early' (too soon to call) / 'none' (no goal) never appear. An empty
// array means every goal with a target is on pace. Pure: same rows → same roster, inputs intact.
function rankPacing(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  for (const r of list) {
    if (!r) continue
    const v = classifyPacing(r, opts)
    if (v.status !== 'behind' && v.status !== 'at_risk') continue
    out.push({
      client_id:   r.client_id != null ? r.client_id : null,
      client_name: r.client_name != null ? r.client_name : null,
      ...v,
    })
  }
  out.sort((a, b) =>
    ((STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0)) ||   // at_risk before behind
    (a.attainment - b.attainment) ||                                  // worst pace first (ratio)
    ((b.catchup || 0) - (a.catchup || 0)) ||                          // hardest catch-up first
    String(a.client_name || '').localeCompare(String(b.client_name || '')))
  return out
}

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
