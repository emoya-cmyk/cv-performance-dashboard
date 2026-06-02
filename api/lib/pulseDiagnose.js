'use strict'

// ============================================================
// lib/pulseDiagnose.js — the "why" behind an intra-week pulse.
//
// dayPulse.js says a client's trailing-week LEVEL has slid out of band — days
// before the ISO week closes. The natural next question, the one a human asks
// the moment they see the flag, is WHY: is jobs sliding because LEADS dried up
// (a top-of-funnel problem) or because the CLOSE RATE fell (a sales problem)?
// The weekly engine already answers this for completed weeks — attribution.js
// decomposes a composite KPI into its exact drivers in log space — but ONLY on
// the weekly grain, inside the Monday recap. Between Mondays the pulse fires
// each flow metric INDEPENDENTLY and never connects them, so the early warning
// names the symptom without the cause.
//
// This module closes that gap WITHOUT a second definition of "why": it reuses
// attribution.attributeChange UNCHANGED, feeding it TRAILING-WINDOW SUMS of the
// composite and its drivers instead of weekly totals. Because revenue ≡
// spend × roas and jobs ≡ leads × (close_rate / 100) are EXACT identities, the
// decomposition is exact arithmetic at the daily grain too — "jobs are down 22%
// this week, and it's leads (down 15%), not your close rate (held)" — every
// figure traceable to a stored daily fact, no model, no tuning, no LLM.
//
// SELF-CONSISTENT BASELINE. attributeChange needs ONE "from" endpoint where the
// identity holds across every driver at once, so a per-metric median (a median
// is not multiplicative — per-metric medians need not satisfy spend × roas =
// revenue) won't do. We pick the single PRIOR non-overlapping window whose
// COMPOSITE sum is closest to the median of the prior composite sums — the
// "typical recent week" — and read EVERY driver from that same real week, so the
// identity holds exactly at the "from" endpoint. That median target is the SAME
// canonical median (baselines.median) dayPulse measures the latest week against,
// so the diagnosed move lines up with the pulse that triggered it rather than
// telling a second, slightly different story.
//
// WINDOW MATH MIRRORS dayPulse. Latest = the trailing W-day sum ending at the
// last day; prior windows step straight back by W (…, two weeks ago, last week),
// never overlapping the latest — the identical enumeration dayPulse judges, so
// the two organs always reason over the same weeks (pinned by a cross-check
// test against dayPulse). Needs the same minimum prior-window count to speak.
//
// PURE, GROUNDED, ABSTAINING. Dense daily series in, a decomposition (+ optional
// sentence) out. No DB, no clock, no network, no mutation — exactly like
// attribution/baselines/dayPulse. Any window with a non-positive driver (a
// zero-spend or zero-lead week, where the log is undefined) or a composite that
// didn't really move yields null — attributeChange's own contract — and the
// caller simply omits the "why," leaving the pulse signal byte-identical to
// before this module existed. narratePulseDiagnosis takes the display labels as
// a parameter (like narrateDayPulse(label)) so this module imports no metric
// catalogue and stays trivially testable on plain number arrays.
// ============================================================

const { median } = require('./baselines')
const { attributeChange, isComposite, IDENTITIES } = require('./attribution')

// Mirror dayPulse's defaults so the diagnosis speaks under exactly the same
// conditions the pulse does.
const DEFAULT_WINDOW = 7
const DEFAULT_MIN_WINDOWS = 3

// How each composite's RATIO driver is recovered from window SUMS. The flow
// driver is summed straight from its daily series; the ratio driver is the
// catalogue identity solved for the ratio (roas = revenue / spend;
// close_rate = 100 · jobs / leads — the /100 cancels inside attributeChange's
// ratio of ratios, but we keep it so any surfaced value reads as a sensible
// percentage). Keys and driver ORDER mirror attribution.IDENTITIES (flow first)
// — see that module; a load-time guard below fails fast if the two drift apart.
const DECOMP = {
  revenue: { flow: 'spend', ratio: 'roas',       ratioOf: (comp, flow) => comp / flow },
  jobs:    { flow: 'leads', ratio: 'close_rate', ratioOf: (comp, flow) => (100 * comp) / flow },
}

// Drift guard: every DECOMP entry must match attribution's identity exactly
// (same composites, same [flow, ratio] order). A mismatch is a programming error
// — fail at require() time, not silently mis-attribute at runtime.
for (const m of Object.keys(DECOMP)) {
  const id = IDENTITIES[m]
  const { flow, ratio } = DECOMP[m]
  if (!id || id[0] !== flow || id[1] !== ratio) {
    throw new Error(`pulseDiagnose: DECOMP[${m}] drifted from attribution.IDENTITIES`)
  }
}

// A missing / non-finite day is no activity, which for a FLOW sum is a true 0.
const finiteAt = (values, i) => {
  const v = Number(values[i])
  return Number.isFinite(v) ? v : 0
}

// Sum of the `w` values ENDING at index `end` (inclusive); null when the window
// runs off the front. Identical to dayPulse.windowSum (pinned by a cross-check
// test) so the diagnosis reasons over exactly the weeks the pulse judged.
function windowSum(values, end, w) {
  const start = end - w + 1
  if (start < 0) return null
  let s = 0
  for (let i = start; i <= end; i++) s += finiteAt(values, i)
  return s
}

/**
 * diagnoseComposite(series, metric, opts) → a daily-grain driver decomposition
 * of ONE composite flow metric's trailing-window move, or null.
 *
 *   series : { <metricKey>: number[] } dense daily series, oldest→newest — must
 *            contain the composite AND its flow driver (e.g. revenue + spend).
 *   metric : 'revenue' | 'jobs' (a composite in attribution.IDENTITIES).
 *   opts   : { window=7, minWindows=3 } — mirror the pulse's window math.
 *
 * Returns attributeChange's object EXTENDED with the window positions used:
 *   { metric, direction, pct, lead, drivers:[…],
 *     window, latest_index, baseline_index, n_windows }
 * or null when: metric isn't a known composite, the series are too short / have
 * too few prior windows, or attributeChange abstains (a non-positive driver, or
 * a composite that didn't really move). Never throws.
 */
function diagnoseComposite(series, metric, opts = {}) {
  if (!isComposite(metric) || !DECOMP[metric] || !series) return null
  const w    = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : DEFAULT_WINDOW
  const minW = Number.isInteger(opts.minWindows) && opts.minWindows > 0 ? opts.minWindows : DEFAULT_MIN_WINDOWS

  const { flow, ratio, ratioOf } = DECOMP[metric]
  const comp = Array.isArray(series[metric]) ? series[metric] : null
  const flw  = Array.isArray(series[flow])   ? series[flow]   : null
  if (!comp || !flw) return null

  const n = Math.min(comp.length, flw.length)
  const L = n - 1
  if (windowSum(comp, L, w) == null) return null   // series shorter than one window

  // Prior NON-OVERLAPPING windows, stepping straight back by w (most-recent
  // prior first) — the SAME enumeration dayPulse uses.
  const priorEnds = []
  for (let end = L - w; end - w + 1 >= 0; end -= w) priorEnds.push(end)
  if (priorEnds.length < minW) return null

  // Choose the baseline "from" window: the prior window whose COMPOSITE sum is
  // closest to the median prior composite sum — the typical recent week — using
  // the same canonical median dayPulse compares the latest week against. Reading
  // ALL drivers from this one real week keeps the identity exact at "from". Ties
  // keep the more recent window (priorEnds is most-recent-first; strict-less-than
  // never displaces the earlier entry).
  const priorCompSums = priorEnds.map((end) => windowSum(comp, end, w))
  const target = median(priorCompSums)
  let baseEnd  = priorEnds[0]
  let bestDist = Math.abs(priorCompSums[0] - target)
  for (let k = 1; k < priorEnds.length; k++) {
    const dist = Math.abs(priorCompSums[k] - target)
    if (dist < bestDist) { bestDist = dist; baseEnd = priorEnds[k] }
  }

  // Build a driver endpoint from a window end: the flow driver is the window sum;
  // the ratio driver is the identity solved over that same window's sums.
  const endpoint = (end) => {
    const c = windowSum(comp, end, w)
    const f = windowSum(flw, end, w)
    return { [flow]: f, [ratio]: ratioOf(c, f) }
  }

  const diag = attributeChange(metric, endpoint(baseEnd), endpoint(L))
  if (!diag) return null

  return {
    ...diag,
    window: w,
    latest_index: L,
    baseline_index: baseEnd,
    n_windows: priorEnds.length,
  }
}

/**
 * pulseDiagnose(series, opts) → { window, diagnoses } where `diagnoses` is a map
 * { revenue?: <diag>, jobs?: <diag> } carrying ONLY the composites that produced
 * a decomposition. A thin fan-out over diagnoseComposite for callers wanting
 * every composite at once; a per-signal caller can call diagnoseComposite directly.
 */
function pulseDiagnose(series, opts = {}) {
  const w = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : DEFAULT_WINDOW
  const diagnoses = {}
  for (const m of Object.keys(DECOMP)) {
    const d = diagnoseComposite(series, m, opts)
    if (d) diagnoses[m] = d
  }
  return { window: w, diagnoses }
}

// One grounded sentence naming the LEVER behind a composite's intra-week move —
// deterministic, no LLM, every figure copied off the decomposition so it can't
// disagree with the numbers. Returns '' for a null/empty diagnosis. `labels`
// maps metric keys → display names (passed in, so this module imports no metric
// catalogue, exactly like narrateDayPulse(label)). Percentages are rounded to
// whole numbers for prose — the exact 1-dp figures stay in diag.drivers for the UI.
//   agency : "Jobs won is down 50% — the driver is Leads (down 50%), while Close rate held."
//   client : "Your revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop."
function narratePulseDiagnosis(diag, opts = {}) {
  if (!diag || !Array.isArray(diag.drivers) || diag.drivers.length === 0) return ''
  const labels = opts.labels || {}
  const nameOf = (k) => labels[k] || k
  const r0 = (n) => Math.round(Math.abs(Number(n) || 0))
  const moveWord = (pct) => (Number(pct) < 0 ? 'down' : 'up')

  const compDir = diag.direction === 'down' ? 'down' : 'up'
  const compPct = r0(diag.pct)
  const lead  = diag.drivers.find((d) => d.metric === diag.lead) || diag.drivers[0]
  const other = diag.drivers.find((d) => d.metric !== diag.lead)

  const leadClause = `the driver is ${nameOf(lead.metric)} (${moveWord(lead.pct)} ${r0(lead.pct)}%)`

  let otherClause = ''
  if (other) {
    if (r0(other.pct) === 0) {
      // moved a fraction the prose would round to 0% — call it held
      otherClause = `, while ${nameOf(other.metric)} held`
    } else if (other.share < 0) {
      // moved OPPOSITE the composite — it cushioned the move rather than caused it
      const verb = Number(other.pct) > 0 ? 'rose' : 'fell'
      const soft = compDir === 'down' ? 'softened the drop' : 'tempered the rise'
      otherClause = `, while ${nameOf(other.metric)} actually ${verb} ${r0(other.pct)}% and ${soft}`
    } else {
      // moved WITH the composite — a secondary contributor
      otherClause = `, with ${nameOf(other.metric)} also ${moveWord(other.pct)} ${r0(other.pct)}%`
    }
  }

  const subject = opts.audience === 'client'
    ? `Your ${nameOf(diag.metric).toLowerCase()}`
    : nameOf(diag.metric)

  return `${subject} is ${compDir} ${compPct}% — ${leadClause}${otherClause}.`
}

module.exports = {
  pulseDiagnose,
  diagnoseComposite,
  narratePulseDiagnosis,
  DEFAULT_WINDOW,
  DEFAULT_MIN_WINDOWS,
}
