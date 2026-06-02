'use strict'

// ============================================================
// lib/dayPulse.js — the intra-week early-warning sensor.
//
// THE GAP THIS CLOSES
// -------------------
// The autonomous engine (lib/insights.js) measures each client's latest
// COMPLETED ISO week against that client's own weekly baseline. That is the
// right grain for "what happened" — but it is BLIND between Mondays. A client
// can crater on a Tuesday and nothing is said until the week closes and the
// Monday recap fires: up to six days of silence while the problem compounds.
// The atomic daily facts (fact_metric) needed to see it sooner are already
// ingested — but today they are used ONLY to check channel FRESHNESS
// (coverage.js — "did a channel go quiet?") and to attribute an already-raised
// weekly anomaly to a channel (correlate.js). Nothing yet watches the daily
// LEVEL. This module is that missing organ: a daily-updated watch on the
// trailing-week level so a collapse (or a runaway spike) is flagged the day it
// shows up, not the Monday after.
//
// WHY A ROLLING WINDOW, NOT A SINGLE DAY
// --------------------------------------
// Single-day counts for an SMB are sparse and zero-inflated (0,0,1,0,3,0…): a
// per-day median/MAD band degenerates and would cry wolf on every quiet day.
// So the unit of observation is the TRAILING W-DAY SUM (default 7). It is
// recomputed every day — on Tuesday it is Wed→Tue, on Wednesday Thu→Wed — so
// the sensor still updates daily, but the quantity it judges (a whole week of
// activity) is dense enough for a stable band. As a bad week accumulates, the
// trailing sum slides out of the band within a day or two; that is the early
// warning, days before the ISO week closes.
//
// HONEST, INDEPENDENT BASELINE
// ----------------------------
// The latest trailing window is compared against prior NON-OVERLAPPING W-day
// windows stepping straight back from it (…, two weeks ago, last week, [now]).
// Non-overlapping ⇒ the baseline samples don't share days, so the robust z is
// not inflated by autocorrelation; and stepping back by exactly W lands each
// window on the same weekdays, which quietly controls for weekday seasonality
// too. The latest window is EXCLUDED from its own baseline — an extreme week
// can't widen the very band meant to catch it (the same discipline
// baselines.summarizeSeries already applies to the weekly series).
//
// SELF-CALIBRATING, GROUNDED, NO LLM. The band is "this client's own normal
// week," learned from its own history with the SAME robust median/MAD machinery
// the weekly engine uses — robustStats / robustZ / classifyZ / direction are
// imported from lib/baselines so there is ONE definition of "unusual" across
// the whole system, no drift. No human-set threshold, no model, no arithmetic
// the caller can't reproduce. Honest by abstention: too little history →
// status:'insufficient', never a guess.
//
// SENSE-NEUTRAL BY DEFAULT. The module reports a signed direction + severity and
// leaves the value judgement to the caller, because "bad" depends on the metric:
// a leads/revenue DROP is bad, a spend/cost-per-lead SPIKE is bad. Pass
// adverseWhen:'drop'|'spike'|'either' to have it set an `adverse` flag for the
// metric's polarity; omit it to stay neutral.
//
// PURE: a dense daily numeric array in, a verdict (+ optional sentence) out. No
// DB, no clock, no network, no mutation — exactly like pacingAnswer/
// forecastAnswer/baselines. The caller (the engine / a read route) densifies
// the metric's daily fact_metric series (one row per calendar day, missing days
// zero-filled — a no-activity day really IS a 0 for a flow metric), restricts to
// sum-aggregable FLOW metrics (leads, revenue, spend, jobs, calls — not ratios
// like roas/cpl, where a rolling SUM is meaningless), and attaches the calendar
// dates to the verdict for display. This module reasons in window POSITIONS
// only, so it stays trivially testable on plain number arrays.
// ============================================================

const { robustStats, robustZ, classifyZ, direction } = require('./baselines')

// Trailing window length in days. A week smooths daily sparsity AND aligns the
// non-overlapping baseline windows on matching weekdays.
const DEFAULT_WINDOW = 7
// Minimum PRIOR (non-overlapping) windows required before a band is trustworthy
// — mirrors baselines' minN. 3 prior weeks + the latest ⇒ at least ~4 weeks
// (≈ 28 dense daily points) before the sensor will speak.
const DEFAULT_MIN_WINDOWS = 3

// A missing / non-finite day is no activity, which for a FLOW sum is a true 0
// (not a gap to interpolate). The caller is expected to pass a dense series, but
// this keeps a stray null from poisoning a window sum.
function finiteAt(values, i) {
  const v = Number(values[i])
  return Number.isFinite(v) ? v : 0
}

// Sum of the `w` values ENDING at index `end` (inclusive). null when the window
// would run off the front of the array (not enough history for a full window).
function windowSum(values, end, w) {
  const start = end - w + 1
  if (start < 0) return null
  let s = 0
  for (let i = start; i <= end; i++) s += finiteAt(values, i)
  return s
}

/**
 * dayPulse(values, opts)
 *   values : a dense daily numeric series for ONE flow metric, oldest→newest,
 *            one entry per calendar day (missing days zero-filled by the caller).
 *   opts   : { window=7, minWindows=3, warn, crit, adverseWhen }
 *            • window      — trailing window length in days;
 *            • minWindows  — prior non-overlapping windows required to judge;
 *            • warn / crit — |z| thresholds, forwarded to classifyZ (default 2/3);
 *            • adverseWhen — 'drop' | 'spike' | 'either'; when set, marks a signal
 *              `adverse` only if its direction matches the metric's bad polarity
 *              (omit to stay sense-neutral).
 *
 * Returns a verdict (never throws):
 *   { status:'signal'|'normal'|'insufficient', window,
 *     latest, baseline:{ median, robustStd, n }, z, direction, severity,
 *     delta_pct, adverse, latest_index, reason }
 *   • 'insufficient' — series shorter than the window, or fewer than `minWindows`
 *                      prior windows (too little history → abstain, never guess);
 *   • 'normal'       — the latest trailing window sits inside the learned band;
 *   • 'signal'       — the latest trailing window is outside the band (severity set).
 *   delta_pct is the latest window's % distance from the baseline median (null when
 *   that median is 0 — a divide we refuse rather than fake).
 */
function dayPulse(values, opts = {}) {
  const w    = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : DEFAULT_WINDOW
  const minW = Number.isInteger(opts.minWindows) && opts.minWindows > 0 ? opts.minWindows : DEFAULT_MIN_WINDOWS
  const xs   = Array.isArray(values) ? values : []
  const n    = xs.length
  const L    = n - 1

  const insufficient = (reason) => ({
    status: 'insufficient',
    window: w,
    latest: null,
    baseline: { median: null, robustStd: null, n: 0 },
    z: null,
    direction: 'flat',
    severity: null,
    delta_pct: null,
    adverse: false,
    latest_index: L,
    reason,
  })

  const latest = windowSum(xs, L, w)
  if (latest == null) return insufficient('series_shorter_than_window')

  // Prior NON-OVERLAPPING windows: end at L-w, L-2w, … while a full window still
  // fits. These never include the latest window's days, so an extreme latest
  // point cannot widen the band built to detect it.
  const baseline = []
  for (let end = L - w; end - w + 1 >= 0; end -= w) {
    baseline.push(windowSum(xs, end, w))
  }
  if (baseline.length < minW) return insufficient('insufficient_history')

  const stats = robustStats(baseline)
  const z     = robustZ(latest, stats)
  const sev   = classifyZ(z, { warn: opts.warn, crit: opts.crit })
  const dir   = direction(latest - stats.median)
  const delta_pct =
    stats.median !== 0 ? ((latest - stats.median) / Math.abs(stats.median)) * 100 : null

  let adverse = false
  if (sev) {
    if (opts.adverseWhen === 'drop') adverse = dir === 'down'
    else if (opts.adverseWhen === 'spike') adverse = dir === 'up'
    else if (opts.adverseWhen === 'either') adverse = true
  }

  return {
    status: sev ? 'signal' : 'normal',
    window: w,
    latest,
    baseline: { median: stats.median, robustStd: stats.robustStd, n: stats.n },
    z,
    direction: dir,
    severity: sev,
    delta_pct,
    adverse,
    latest_index: L,
    reason: sev ? 'out_of_band' : 'within_band',
  }
}

// One grounded lead sentence for a signal — deterministic, no LLM. Every figure
// (the trailing total, the % gap, the baseline level) is copied straight off the
// verdict, so the sentence can never disagree with the numbers it summarizes.
// Returns '' for a normal/insufficient/missing verdict (nothing worth saying),
// exactly as narratePacing/narrateAdvice fall silent when there's no story.
//   drop  : "Leads over the last 7 days total 42 — about 60% below this client's usual week (≈105). Flagged today."
//   spike : "Ad spend over the last 7 days total 5,400 — about 80% above your usual week (≈3,000). Flagged today."
function narrateDayPulse(verdict, opts = {}) {
  if (!verdict || verdict.status !== 'signal') return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  const label = opts.label || 'Activity'
  const w = verdict.window
  const lat = Math.round(verdict.latest)
  const base = Math.round(verdict.baseline.median)
  const whose = audience === 'client' ? 'your usual' : "this client's usual"
  const span = w === 7 ? 'week' : `${w}-day window`
  const dirWord = verdict.direction === 'down' ? 'below' : 'above'
  const pct = verdict.delta_pct == null ? null : Math.round(Math.abs(verdict.delta_pct))
  const cmp = pct != null ? `about ${pct}% ${dirWord}` : dirWord
  return `${label} over the last ${w} days total ${lat.toLocaleString('en-US')} — ${cmp} ${whose} ${span} (≈${base.toLocaleString('en-US')}). Flagged today.`
}

module.exports = { dayPulse, narrateDayPulse, DEFAULT_WINDOW, DEFAULT_MIN_WINDOWS }
