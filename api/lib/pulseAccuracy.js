'use strict'

// ============================================================
// lib/pulseAccuracy.js — does the early warning actually predict the week?
//
// THE GAP THIS CLOSES
// -------------------
// [[dayPulse]] raises an intra-week alarm the day a client's trailing-week level
// slides out of band; [[pulseReliability]] grades whether a firing PERSISTS (is
// the same signal still firing a horizon later). Both are about the SIGNAL'S OWN
// shape. Neither answers the question a skeptical agency owner — or our own
// internal team — actually asks of an early-warning system: "when it warns me on
// a Wednesday, how often does the week REALLY end bad, and how much head-start
// did it buy me?" That is PREDICTIVE PRECISION against the canonical weekly
// verdict the whole dashboard already reports every Monday — a different, harder,
// more valuable claim than persistence. This module is that self-audit: it
// replays the sensor's mid-week call against the completed-week outcome across a
// client's history and reports precision / recall / F1 / average lead-time. The
// tool grading its own forecasts, with no human input and no model.
//
// ONE DEFINITION OF "UNUSUAL", REUSED TWICE
// -----------------------------------------
// Both halves are the SAME dayPulse, so the score can never drift from the live
// sensor or from the weekly engine:
//   • EARLY CALL  — dayPulse over the DAILY series (window W, default 7) evaluated
//     as of the lead day within a week (default ⌈2W/3⌉ = day 5 of 7, "by Friday").
//     This is exactly what the live trailing-week sensor shows mid-week.
//   • GROUND TRUTH — dayPulse with window:1 over the WEEKLY-TOTALS series. A
//     trailing-1 window IS one week's total, and the prior non-overlapping
//     1-windows ARE the preceding weeks, so this reproduces the weekly engine's
//     robust-z anomaly verdict for that week — no second statistics path.
// `adverse` (set from the metric's polarity via adverseWhen) carries direction on
// BOTH sides, so a true positive is "warned adverse early AND the week closed
// adverse in that same bad direction."
//
//   confusion over gradeable weeks:
//     TP early-fired & week-adverse   FP early-fired & week-fine
//     FN missed     & week-adverse   TN missed     & week-fine
//   precision = TP / (TP+FP)   "when we warned, how often was it real"  ← headline
//   recall    = TP / (TP+FN)   "of the bad weeks, how many we caught early"
//   F1        = harmonic mean  ·  avg_lead_days = mean head-start over the TPs
//
// FAIR + HONEST BY ABSTENTION
// ---------------------------
// A week counts ONLY if BOTH verdicts are computable: the weekly ground truth is
// definite (≥ minWindows prior weeks) AND the early sensor had enough history to
// speak (its lead-day call is not 'insufficient'). We never score a prediction
// the sensor had no basis to make — a young account is excluded, not punished.
// Fewer than `minWeeks` gradeable weeks → status:'insufficient' (too thin to
// audit); graded but fewer than `minFires` early warnings → 'insufficient_fires'
// (precision off one or two calls is not a track record) — the same discipline as
// dayPulse's minWindows and pulseReliability's minFires. Every return path still
// reports the raw tally, so "it warned twice, I need three" stays visible.
//
// SELF-IMPROVING: precision is measured fresh from the client's own maturing
// history every run, so it sharpens automatically as more weeks close — the
// natural empirical companion to pulseReliability's persistence grade, and a
// credibility number the triage layer (or a portfolio self-audit) can lean on.
//
// PURE: a dense daily numeric array in, a grade out. It only REPLAYS the existing
// pure dayPulse over prefixes — no DB, no clock, no network, no LLM, no mutation,
// never throws. Reasons in array POSITIONS only, so it stays trivially testable on
// plain number arrays, exactly like [[pulseReliability]].
// ============================================================

const { dayPulse, DEFAULT_WINDOW, DEFAULT_MIN_WINDOWS } = require('./dayPulse')

// Minimum gradeable weeks before an audit is trustworthy, and minimum matured
// early warnings before a PRECISION ratio is — mirrors pulseReliability so the
// abstention discipline is identical across the self-grading family.
const DEFAULT_MIN_WEEKS = 3
const DEFAULT_MIN_FIRES = 3

// Default lead day within a week: ⌈2W/3⌉ (day 5 of a 7-day week, "by Friday") —
// late enough that the rolling-week sensor has real signal, early enough that
// catching it is a genuine head-start before the week closes. Clamped to [1,W].
function defaultLeadDay(w) {
  return Math.max(1, Math.min(w, Math.ceil((2 * w) / 3)))
}

// A missing / non-finite day is no activity → a true 0 for a flow sum (same rule
// as dayPulse.finiteAt); keeps a stray null from poisoning a weekly total.
function finite(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// accuracyLabel(p) — the plain band for a precision ratio in [0,1]. Deliberately a
// DIFFERENT vocabulary from reliabilityLabel (reliable/mixed/noisy) so a surface
// never confuses "this signal persists" with "this signal predicts the week":
//   proven ≥0.70 · developing 0.40–0.69 · learning <0.40 · null (un-graded) → null.
function accuracyLabel(p) {
  if (p == null || !Number.isFinite(p)) return null
  if (p >= 0.7) return 'proven'
  if (p >= 0.4) return 'developing'
  return 'learning'
}

// End-aligned non-overlapping weekly totals from a daily series: the most recent W
// days form the last week; any leading remainder (< W days) is dropped (it is not
// a complete week). totals[j] is the sum of week j's W days, oldest kept week first.
function weeklyTotals(values, w) {
  const n = values.length
  const numWeeks = Math.floor(n / w)
  const offset = n - numWeeks * w
  const totals = new Array(numWeeks)
  for (let j = 0; j < numWeeks; j++) {
    let s = 0
    const lo = offset + j * w
    for (let i = lo; i < lo + w; i++) s += finite(values[i])
    totals[j] = s
  }
  return { totals, offset, numWeeks }
}

/**
 * pulseAccuracy(values, opts)
 *   values : a dense daily numeric series for ONE flow metric, oldest→newest (the
 *            SAME shape dayPulse/pulseReliability consume; missing days zero-filled
 *            by the caller). The audit replays dayPulse over its prefixes.
 *   opts   : { window=7, minWindows=3, warn, crit, adverseWhen,
 *              leadDay=⌈2W/3⌉, minWeeks=3, minFires=3 }
 *            window / minWindows / warn / crit / adverseWhen forward VERBATIM to
 *            dayPulse so both the early call and the window:1 weekly verdict match
 *            the live sensor and the weekly engine; leadDay sets the mid-week
 *            decision point; minWeeks / minFires set the abstention floors.
 *
 * Returns a grade (never throws):
 *   { status:'graded'|'insufficient', window, lead_day, min_weeks, min_fires,
 *     weeks_graded, fires, adverse_weeks, tp, fp, fn, tn,
 *     precision, recall, f1, avg_lead_days, label, reason }
 *   • 'insufficient' — 'insufficient_history' (no gradeable week at all),
 *      'insufficient_weeks' (some, but < minWeeks), or 'insufficient_fires'
 *      (≥ minWeeks gradeable but < minFires early warnings); precision/recall/f1/
 *      label all null on these paths, with the raw confusion tally still reported.
 *   • 'graded' — precision = TP/(TP+FP) (null if no fires — but then we'd have
 *      abstained), recall = TP/(TP+FN) (null when no adverse weeks to catch),
 *      f1 = harmonic mean (null if either is null/zero), avg_lead_days = mean
 *      head-start over the TP weeks (null if no TP).
 *   Invariants: tp+fp === fires; tp+fn === adverse_weeks;
 *               tp+fp+fn+tn === weeks_graded.
 */
function pulseAccuracy(values, opts = {}) {
  const w = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : DEFAULT_WINDOW
  const minW = Number.isInteger(opts.minWindows) && opts.minWindows > 0 ? opts.minWindows : DEFAULT_MIN_WINDOWS
  const minWeeks = Number.isInteger(opts.minWeeks) && opts.minWeeks > 0 ? opts.minWeeks : DEFAULT_MIN_WEEKS
  const minFires = Number.isInteger(opts.minFires) && opts.minFires > 0 ? opts.minFires : DEFAULT_MIN_FIRES
  const leadDay = Number.isInteger(opts.leadDay) && opts.leadDay > 0 ? Math.min(opts.leadDay, w) : defaultLeadDay(w)
  const xs = Array.isArray(values) ? values : []

  // Forward dayPulse's knobs verbatim so every replayed verdict — early AND
  // weekly — is byte-identical to the one the live sensor / weekly engine raised.
  const dailyOpts = { window: w, minWindows: minW, warn: opts.warn, crit: opts.crit, adverseWhen: opts.adverseWhen }
  const weeklyOpts = { window: 1, minWindows: minW, warn: opts.warn, crit: opts.crit, adverseWhen: opts.adverseWhen }

  const { totals, offset, numWeeks } = weeklyTotals(xs, w)

  // Ground truth, once: replay the weekly anomaly verdict "as of week j" over the
  // weekly-totals prefixes (window:1) — the canonical robust-z weekly call.
  const wkVerdicts = new Array(numWeeks)
  for (let j = 0; j < numWeeks; j++) {
    wkVerdicts[j] = dayPulse(totals.slice(0, j + 1), weeklyOpts)
  }

  let tp = 0, fp = 0, fn = 0, tn = 0
  let leadSum = 0 // sum of head-start days over TP weeks → avg_lead_days

  for (let j = 0; j < numWeeks; j++) {
    const wk = wkVerdicts[j]
    if (wk.status !== 'signal' && wk.status !== 'normal') continue // weekly truth not yet definite

    // The early sensor must have had history to speak by the lead day; if its
    // lead-day call is itself 'insufficient', this week is NOT gradeable — we do
    // not score a prediction the sensor had no basis to make.
    const lo = offset + j * w
    const leadIdx = lo + leadDay - 1
    const leadCall = dayPulse(xs.slice(0, leadIdx + 1), dailyOpts)
    if (leadCall.status === 'insufficient') continue

    // Walk day 1..leadDay; the FIRST adverse firing is the early warning, and the
    // earlier it lands the bigger the head-start (W − day). Once warned, warned.
    let firstAdverseDay = null
    for (let d = 1; d <= leadDay; d++) {
      const idx = lo + d - 1
      const v = d === leadDay ? leadCall : dayPulse(xs.slice(0, idx + 1), dailyOpts)
      if (v.status === 'signal' && v.adverse) { firstAdverseDay = d; break }
    }
    const earlyFired = firstAdverseDay !== null
    const weekAdverse = wk.status === 'signal' && wk.adverse

    if (earlyFired && weekAdverse) { tp++; leadSum += (w - firstAdverseDay) }
    else if (earlyFired && !weekAdverse) fp++
    else if (!earlyFired && weekAdverse) fn++
    else tn++
  }

  const weeksGraded = tp + fp + fn + tn
  const fires = tp + fp
  const adverseWeeks = tp + fn

  // The bookkeeping every return path carries verbatim — a consumer always sees
  // how thin (or thick) the record is, even when we abstain.
  const counts = {
    window: w, lead_day: leadDay, min_weeks: minWeeks, min_fires: minFires,
    weeks_graded: weeksGraded, fires, adverse_weeks: adverseWeeks, tp, fp, fn, tn,
  }
  const abstain = (reason) => ({
    status: 'insufficient', ...counts,
    precision: null, recall: null, f1: null, avg_lead_days: null, label: null, reason,
  })

  if (weeksGraded === 0) return abstain('insufficient_history')
  if (weeksGraded < minWeeks) return abstain('insufficient_weeks')
  if (fires < minFires) return abstain('insufficient_fires')

  const precision = fires > 0 ? tp / fires : null
  const recall = adverseWeeks > 0 ? tp / adverseWeeks : null
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null
  const avg_lead_days = tp > 0 ? leadSum / tp : null

  return {
    status: 'graded', ...counts,
    precision, recall, f1, avg_lead_days,
    label: accuracyLabel(precision), reason: 'graded',
  }
}

// One grounded sentence for a GRADED audit — deterministic, no LLM. Every figure
// (the TP count, the early-warning count, the % precision, the average head-start)
// is copied straight off the grade, so it can never disagree with the score.
// Returns '' for an un-graded / missing grade, exactly as the sibling narrators
// fall silent when there is nothing trustworthy to say.
//   agency proven   : "Leads early-warnings for this client have called the week right 8 of 10 times recently (~80%), about 3 days before it closed — a proven lead."
//   agency learning : "Spend early-warnings for this client have called the week right 2 of 7 times recently (~29%) — still learning."
//   client          : only REINFORCES a proven track record; never volunteers a weak
//                     one (developing/learning stay silent for the client).
function narratePulseAccuracy(acc, opts = {}) {
  if (!acc || acc.status !== 'graded' || acc.precision == null) return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  const label = opts.label || 'Activity'
  const pct = Math.round(acc.precision * 100)

  if (audience === 'client') {
    return acc.label === 'proven'
      ? "We've been spotting shifts like this early — and they've usually proven out."
      : ''
  }

  const lead = acc.avg_lead_days
  const leadClause =
    lead != null && Math.round(lead) >= 1
      ? `, about ${Math.round(lead)} day${Math.round(lead) === 1 ? '' : 's'} before it closed`
      : ''
  const phrase =
    acc.label === 'proven' ? 'a proven lead' :
    acc.label === 'developing' ? 'developing' :
    'still learning'
  return `${label} early-warnings for this client have called the week right ${acc.tp} of ${acc.fires} times recently (~${pct}%)${leadClause} — ${phrase}.`
}

module.exports = {
  pulseAccuracy,
  narratePulseAccuracy,
  accuracyLabel,
  DEFAULT_MIN_WEEKS,
  DEFAULT_MIN_FIRES,
}
