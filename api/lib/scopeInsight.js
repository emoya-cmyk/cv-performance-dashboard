'use strict'

// ============================================================================
// lib/scopeInsight.js — intel-v13 C3: NARRATE the scoped query result.
//
// THE PROBLEM. The numeric layer (Explore → POST /api/query → semantic/compile)
// already recomputes live whenever a filter or date changes, and with `compareTo`
// it returns a period-over-period delta per row. But the *insight narrative* and
// *recommendations* a user reads come from the nightly sweep (detectFindings over
// a DEFAULT 26-week, all-channel window) — persisted, then read back. So the words
// go stale the instant you slice to "last 30 days, Google Ads only": the numbers
// move, the story doesn't.
//
// THE FIX (Design B — narrate, don't recompute). This is a PURE function that turns
// an ALREADY-COMPUTED scoped comparison ({current totals} vs {previous totals},
// plus optional per-dimension drivers) into finding-like cards + recommendations,
// scoped BY CONSTRUCTION to whatever window/filter the caller measured. It computes
// nothing about the world: every figure it prints traces straight back to an input
// number. That makes it:
//   • deterministic + clock-free + DB-free + HTTP-free  → trivially unit-tested;
//   • scoped               → it only ever sees the caller's scoped totals;
//   • leak-safe            → on a client surface the caller passes only that client's
//                            own scoped totals, so there is no peer data in scope to
//                            print — the same discipline the rest of intel-v13 follows.
//
// WHY REUSE, NOT REINVENT. The movement math + formatting come from ask.js
// (computeComparison / formatValue / METRICS) so a delta here reads byte-identically
// to the Ask box. The ADVICE comes from insights.js (isAdverse + the leverFor/keepFor
// plays + urgencyFor lane) so a scoped recommendation is the SAME play the nightly
// engine would prescribe for that metric moving that way — only the lead clause is
// re-voiced for an arbitrary window (recommendedAction hardcodes "this week", which is
// wrong for "last 90 days"). Narrate-don't-compute, DRY on both the numbers and the plays.
// ============================================================================

const { computeComparison, formatValue, METRICS } = require('./ask')
const { isAdverse, leverFor, keepFor, urgencyFor } = require('./insights')

// ── movement bands (scoped period-over-period, NOT weekly slope) ───────────────
// A move smaller than MIN is "held steady" — informative for the headline, but not
// worth a card. Only ADVERSE moves escalate past 'info': good news is never an alarm.
const MOVE_MIN_PCT = 5
const WARN_PCT     = 15
const CRIT_PCT     = 30

const DEFAULT_LIMIT = 6
const MAX_LIMIT     = 7
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 }

// round to 1 dp, drop a trailing zero ("4.0"→"4", "4.20"→"4.2") — matches suggest.js
// trim1 / ask.js's private trim, so a scoped pct reads the same as everywhere else.
const trim1 = (n) => String(Math.round(Number(n) * 10) / 10)

const isNum = (v) => v != null && Number.isFinite(Number(v))
const asStr = (v) => (v == null ? null : String(v))

// classify an adverse move's magnitude into a severity band. pctMag may be null
// (baseline was 0 → no percentage); we can't prove "critical" without it, so an
// adverse from-zero move degrades to 'warning' rather than over- or under-stating.
function severityFor(adverse, pctMag) {
  if (!adverse) return 'info'
  if (pctMag == null) return 'warning'
  if (pctMag >= CRIT_PCT) return 'critical'
  if (pctMag >= WARN_PCT) return 'warning'
  return 'info'
}

// "+$1,200" / "−14" — a signed, unit-aware delta for a driver clause. Uses a real
// minus sign so it never reads as a stray hyphen mid-sentence.
function signedDelta(delta, descriptor) {
  const mag = formatValue(Math.abs(Number(delta) || 0), descriptor)
  return (Number(delta) >= 0 ? '+' : '−') + mag
}

// Find the single biggest contributor to a metric's move among the caller's driver
// rows, by absolute period-over-period delta. Pure; returns null when drivers are
// absent/unusable. NEVER invents a label — only echoes one the caller supplied.
function topDriverFor(metric, drivers, descriptor) {
  if (!drivers || !Array.isArray(drivers.rows) || !drivers.rows.length) return null
  let best = null
  for (const row of drivers.rows) {
    if (!row || row.label == null) continue
    const cur = Number(row.current && row.current[metric]) || 0
    const prev = row.previous != null ? Number(row.previous[metric]) || 0 : null
    const delta = prev == null ? cur : cur - prev
    if (!Number.isFinite(delta) || delta === 0) continue
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { label: String(row.label), delta }
    }
  }
  if (!best) return null
  return { label: best.label, delta: best.delta, display: signedDelta(best.delta, descriptor) }
}

// ── the one public entry point ─────────────────────────────────────────────────
// generateScopeInsight({ metrics?, current, previous?, windowLabel?, compareLabel?,
//                        drivers?, limit? }) → { headline, scope, findings[], meta }
//
// `current` / `previous` are { [metricId]: number } total maps for the active window
// and (optionally) the comparison window — exactly what a groupBy:[] + compareTo spec
// yields. `drivers` is an OPTIONAL { dim, rows:[{label, current:{}, previous?:{}}] }
// breakdown (e.g. by channel) used only to name the top contributor. Everything is
// junk-safe: missing/garbage inputs degrade to an empty, honest result, never a throw.
function generateScopeInsight(input) {
  const opts = input && typeof input === 'object' ? input : {}
  const current = opts.current && typeof opts.current === 'object' ? opts.current : {}
  const hasPrev = opts.previous && typeof opts.previous === 'object'
  const previous = hasPrev ? opts.previous : null
  const windowLabel = asStr(opts.windowLabel) || 'this window'
  const compareLabel = asStr(opts.compareLabel)              // null ⇒ no comparison voice
  const drivers = opts.drivers && typeof opts.drivers === 'object' ? opts.drivers : null

  const limInt = Number.isInteger(opts.limit) ? opts.limit : parseInt(opts.limit, 10)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(limInt) ? limInt : DEFAULT_LIMIT))

  // metric order: caller subset (filtered to known + de-duped) or all 7 in catalogue order.
  const known = Object.keys(METRICS)
  let order = known
  if (Array.isArray(opts.metrics) && opts.metrics.length) {
    const seen = new Set()
    order = opts.metrics.filter(m => known.includes(m) && !seen.has(m) && seen.add(m))
  }

  const findings = []
  let steady = 0          // moved, but below MOVE_MIN_PCT → "held steady"
  let withData = 0
  let withCompare = 0

  for (const m of order) {
    if (!isNum(current[m])) continue                      // no figure this window → nothing to say
    withData++
    const descriptor = METRICS[m]
    const label = descriptor.label
    const cur = Number(current[m])
    const curDisplay = formatValue(cur, descriptor)
    const prevRaw = previous ? previous[m] : null

    // ── no comparison figure: report the level, prompt for a comparison ──────────
    if (!isNum(prevRaw)) {
      findings.push({
        kind: 'movement', metric: m, metric_label: label,
        direction: cur > 0 ? 'up' : 'flat', improved: null, severity: 'info',
        title: `${label}: ${curDisplay}`,
        detail: `${label} for ${windowLabel} is ${curDisplay}. No comparable prior-period figure in scope.`,
        driver: null,
        evidence: { current: cur, previous: null, delta: null, pct_change: null },
        recommendation: null,
      })
      continue
    }

    // ── period-over-period: reuse the Ask box's exact comparison math ────────────
    withCompare++
    const prev = Number(prevRaw)
    const cmp = computeComparison(cur, prev, m)           // {delta, pct_change, direction, improved}
    const direction = cmp.direction
    const pctMag = cmp.pct_change == null ? null : Math.abs(cmp.pct_change)
    const prevDisplay = formatValue(prev, descriptor)

    // flat, or a move too small to mention → steady (feeds the headline, no card)
    if (direction === 'flat' || (pctMag != null && pctMag < MOVE_MIN_PCT)) {
      steady++
      continue
    }

    const word = direction === 'up' ? 'up' : 'down'
    const rose = direction === 'up' ? 'rose' : 'fell'
    const pctDisplay = pctMag != null ? `${trim1(pctMag)}%` : null
    const deltaDisplay = formatValue(Math.abs(cmp.delta), descriptor)
    const moveDisplay = pctDisplay || deltaDisplay        // % when we have it, else the raw delta
    const adverse = isAdverse({ kind: 'movement', metric: m, direction })
    const severity = severityFor(adverse, pctMag)
    const cmpClause = compareLabel || 'vs the prior period'
    const driver = topDriverFor(m, drivers, descriptor)
    const driverClause = driver ? `, led by ${driver.label} (${driver.display})` : ''

    // title — the headline figure (matches the Ask box's "up 23.1% to $X" phrasing)
    const title = pctDisplay
      ? `${label} ${word} ${pctDisplay} to ${curDisplay}`
      : `${label} ${word} to ${curDisplay} (from ${prevDisplay})`

    // detail — one grounded sentence, every number from the inputs
    const detail = `${label} ${rose} ${moveDisplay} from ${prevDisplay} ${cmpClause} to ${curDisplay}${driverClause}.`

    // recommendation — the SAME lever/keep play the engine prescribes, re-voiced for
    // an arbitrary window. Favorable ⇒ keep the gain; adverse ⇒ pull the lever.
    const play = adverse ? leverFor(m) : keepFor(m)
    const recommendation = {
      text: `${label} is ${word} ${moveDisplay} ${cmpClause} — ${play}.`,
      urgency: urgencyFor(severity),
    }

    findings.push({
      kind: 'movement', metric: m, metric_label: label,
      direction, improved: cmp.improved, severity,
      title, detail, driver: driver ? { label: driver.label, delta: driver.delta, display: driver.display } : null,
      evidence: { current: cur, previous: prev, delta: cmp.delta, pct_change: cmp.pct_change },
      recommendation,
    })
  }

  // most important first: severity band, then magnitude (null pct sinks below known
  // magnitudes), so a truncated list keeps the cards that matter.
  findings.sort((a, b) => {
    const sr = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (sr !== 0) return sr
    const am = a.evidence.pct_change == null ? -1 : Math.abs(a.evidence.pct_change)
    const bm = b.evidence.pct_change == null ? -1 : Math.abs(b.evidence.pct_change)
    return bm - am
  })
  const kept = findings.slice(0, limit)

  return {
    headline: buildHeadline({ kept, steady, withData, withCompare, windowLabel, compareLabel }),
    scope: { windowLabel, compareLabel, hasCompare: withCompare > 0 },
    findings: kept,
    meta: {
      metrics_considered: withData,
      with_compare: withCompare,
      movers: findings.length,
      shown: kept.length,
      steady,
      generated_from: 'scope-narration',
    },
  }
}

// One scoped sentence over the whole result — leads with the most important adverse
// move and the strongest favorable move, so the reader gets the gist before the cards.
function buildHeadline({ kept, steady, withData, withCompare, windowLabel, compareLabel }) {
  if (!withData) return `No data in scope for ${windowLabel}.`
  const cmpClause = compareLabel || 'vs the prior period'

  if (!withCompare) {
    return `Showing ${windowLabel}. Add a comparison to see what changed and what to do about it.`
  }
  if (!kept.length) {
    return `For ${windowLabel}, all tracked metrics held steady ${cmpClause}.`
  }

  const phrase = (f) => {
    const pct = f.evidence.pct_change == null ? null : `${trim1(Math.abs(f.evidence.pct_change))}%`
    return `${f.metric_label.toLowerCase()} ${f.direction} ${pct || formatValue(Math.abs(f.evidence.delta), METRICS[f.metric])}`
  }
  const adverse = kept.find(f => f.severity === 'critical' || f.severity === 'warning')
  const favorable = kept.find(f => f.severity === 'info' && f.improved === true)

  const parts = []
  if (adverse) parts.push(phrase(adverse))
  if (favorable && favorable !== adverse) parts.push(phrase(favorable))
  if (!parts.length) parts.push(phrase(kept[0]))         // all small/neutral movers

  const lead = parts.join(' and ')
  const tail = steady ? ` (${steady} held steady)` : ''
  return `For ${windowLabel}, ${lead} ${cmpClause}${tail}.`
}

module.exports = {
  generateScopeInsight,
  // exported for focused unit tests / reuse
  severityFor, topDriverFor, buildHeadline,
  MOVE_MIN_PCT, WARN_PCT, CRIT_PCT, DEFAULT_LIMIT, MAX_LIMIT,
}
