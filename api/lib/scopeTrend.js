'use strict'
// lib/scopeTrend.js — intel-v14 D2 (step a): CROSS-READ MICRO-TREND core.
//
// D1 ("since you last looked") narrates a SINGLE hop — the read you were looking at
// vs the read that just replaced it. One hop is a blip. This finds the SIGNAL inside a
// run of hops: a metric that has moved the SAME direction across several consecutive
// live updates — "revenue has climbed 3 straight updates", "CPL has risen 3 straight
// updates — worth a look". A streak is far stronger intelligence than any one delta,
// and it falls straight out of the snapshot buffer D1 already maintains.
//
// It is a PURE reduction of an ORDERED history of scope reads (oldest → newest), each
// read being one of the leak-safe shapes scopeDelta.normalizeSnapshot accepts — the
// compact [{metric,current}] mover-snapshot the FE buffers via snapOf, or a full
// scope-insight payload. Properties it must keep:
//   • leak-safe by construction — every read is an ALREADY leak-safe scope-insight
//     snapshot (metric ids + absolute scope totals + channel-axis driver labels; no
//     tenant identity anywhere). This module never sees a clientId and emits none; its
//     output is metric labels + run shape only, identical on agency and client surfaces.
//   • MOVERS-ONLY, and that is correct — a metric appears in a read only when it surfaced
//     as a card (a mover) that read. A read where it did NOT surface is a GAP that BREAKS
//     the run: we only ever claim a streak over consecutive reads in which the metric was
//     actually notable. A direction reversal or a flat (sub-cent) step breaks it too.
//   • cross-read, NOT period-over-period — like scopeDelta we trend evidence.CURRENT (the
//     absolute scope total per metric, read-to-read), never the compareTo window.
//   • jitter-immune — a step counts only when it moves ≥ 1 cent (toCents, the exact
//     predicate C4/scopeFreshness used to decide "did this scope move"); sub-cent float
//     noise never extends a run.
//   • correct good/bad + byte-identical phrasing — polarity via classifyMove (the shared
//     insights.isAdverse oracle) and magnitudes via signedDelta — the very helpers D1
//     uses, so a trend reads in the same voice as the delta beneath it.
//   • deterministic — no clock, no RNG, no DB; stable salience sort; same input → same
//     output.
//   • fail-safe — malformed / too-short history degrades to status 'insufficient'/'flat'
//     with an empty trends[]; it never throws.
const { normalizeSnapshot, classifyMove, pctChange, signedDelta } = require('./scopeDelta')
const { METRICS } = require('./ask')
const { toCents } = require('./scopeFreshness')

const isNum = (v) => v != null && Number.isFinite(Number(v))
const cap   = (s) => { const t = String(s || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t }

// The maximal same-direction, material run of STEPS ending at the latest read.
// `values` is the per-metric series over reads (oldest→newest); entries are finite
// numbers where the metric surfaced that read, or undefined for a gap. A gap, a flat
// (sub-cent) step, or a direction change all terminate the run. Returns null when the
// latest read is absent or no material trailing step exists.
function trailingRun(values, minStepCents) {
  const n = Array.isArray(values) ? values.length : 0
  if (n < 2 || !isNum(values[n - 1])) return null
  const floor = isNum(minStepCents) ? Math.max(0, Math.trunc(Number(minStepCents))) : 0
  let dir = null
  let steps = 0
  for (let i = n - 1; i >= 1; i--) {
    const a = values[i - 1]
    const b = values[i]
    if (!isNum(a) || !isNum(b)) break                 // gap → run ends
    const dCents = toCents(b) - toCents(a)
    if (dCents === 0) break                            // flat to the cent → run ends
    if (Math.abs(dCents) < floor) break                // below the caller's step floor
    const stepDir = dCents > 0 ? 'up' : 'down'
    if (dir === null) dir = stepDir
    else if (stepDir !== dir) break                    // reversal → run ends
    steps++
  }
  if (steps === 0 || dir === null) return null
  return { runSteps: steps, direction: dir, startIdx: n - 1 - steps }
}

// "Revenue has climbed 3 straight updates (+$2,400)." — one leak-safe sentence whose
// verb encodes direction × polarity, with a soft "worth a look" only on adverse runs.
function buildTrendHeadline({ metric_label, direction, improving, runSteps, delta, metric }) {
  const verb = direction === 'up'
    ? (improving === true ? 'climbed' : 'risen')
    : (improving === true ? 'eased'  : improving === false ? 'slid' : 'fallen')
  const n    = Math.max(1, Number(runSteps) || 1)
  const unit = n === 1 ? 'update' : 'updates'
  const mag  = signedDelta(delta, METRICS[metric])
  const tail = improving === false ? ' — worth a look' : ''
  return `${cap(metric_label)} has ${verb} ${n} straight ${unit} (${mag})${tail}.`
}

// detectScopeTrends(history, opts) — history oldest→newest. opts:
//   { minRunSteps=2 (≥3 reads to be a trend), minStepCents=0, maxReads=12 }
// Returns { status, trends[], headline, meta }.
//   status: 'insufficient' (fewer than minRunSteps+1 reads — can't form a run),
//           'flat'         (enough reads, nothing on a qualifying streak),
//           'trending'     (≥1 metric on a streak ending at the latest read).
function detectScopeTrends(history, opts) {
  const safe = { status: 'flat', trends: [], headline: null, meta: { reads: 0, series: 0, trendingCount: 0, longestRun: 0 } }
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const minRunSteps = Number.isInteger(o.minRunSteps) ? Math.max(1, o.minRunSteps) : 2
    const minStepCents = isNum(o.minStepCents) ? Math.max(0, Math.trunc(Number(o.minStepCents))) : 0
    const maxReads = Number.isInteger(o.maxReads) ? Math.max(2, o.maxReads) : 12

    let reads = Array.isArray(history) ? history.slice(-maxReads) : []
    if (reads.length < minRunSteps + 1) {
      return { ...safe, status: 'insufficient', meta: { ...safe.meta, reads: reads.length } }
    }

    // Normalise every read to metric → { current, label } and collect the metric union.
    const maps = reads.map((r) => normalizeSnapshot(r))
    const metricIds = new Set()
    for (const m of maps) for (const k of m.keys()) metricIds.add(k)

    const trends = []
    for (const metric of metricIds) {
      // Per-metric value series aligned across reads (undefined where it didn't surface).
      const series = maps.map((m) => (m.has(metric) ? m.get(metric).current : undefined))
      const run = trailingRun(series, minStepCents)
      if (!run || run.runSteps < minRunSteps) continue

      const from = Number(series[run.startIdx])
      const to   = Number(series[series.length - 1])
      const delta = to - from
      const { direction, improved } = classifyMove(metric, delta)
      // Latest surfaced label wins (most current); fall back to the registry / id.
      const latest = maps[maps.length - 1].get(metric)
      const metric_label = (latest && latest.label) || (METRICS[metric] && METRICS[metric].label) || metric

      // run values (all finite, no gaps) — leak-safe bare numbers for a sparkline.
      const values = series.slice(run.startIdx).map(Number)
      // step magnitudes in cents across the run → acceleration.
      const stepMags = []
      for (let k = 1; k < values.length; k++) stepMags.push(Math.abs(toCents(values[k]) - toCents(values[k - 1])))
      const accelerating = stepMags.length >= 2 &&
        stepMags.every((m, i) => i === 0 || m >= stepMags[i - 1]) &&
        stepMags[stepMags.length - 1] > stepMags[0]

      const t = {
        metric,
        metric_label,
        direction,
        improving: improved,
        runSteps: run.runSteps,
        runReads: run.runSteps + 1,
        from,
        to,
        delta,
        deltaCents: toCents(to) - toCents(from),
        pct: pctChange(from, to),
        monotonic: run.startIdx === 0,        // the whole available series moved one way
        accelerating,
        values,
        headline: '',
      }
      t.headline = buildTrendHeadline(t)
      trends.push(t)
    }

    // Salience: longest streak first, then biggest absolute cent move, then metric id.
    const byMetric = (a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0)
    trends.sort((a, b) =>
      (b.runSteps - a.runSteps) ||
      (Math.abs(b.deltaCents) - Math.abs(a.deltaCents)) ||
      byMetric(a, b))

    const longestRun = trends.reduce((mx, t) => Math.max(mx, t.runSteps), 0)
    return {
      status: trends.length ? 'trending' : 'flat',
      trends,
      headline: trends.length ? trends[0].headline : null,
      meta: { reads: reads.length, series: metricIds.size, trendingCount: trends.length, longestRun },
    }
  } catch {
    return safe   // any malformed input → a quiet, safe 'flat'
  }
}

module.exports = {
  detectScopeTrends,
  trailingRun,
  buildTrendHeadline,
}
