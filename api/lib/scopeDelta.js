'use strict'
// lib/scopeDelta.js — intel-v14 D1 (step a): "SINCE YOU LAST LOOKED" delta core.
//
// The narrator (scopeInsight) tells you the STATE of a scope right now. This tells
// you what CHANGED about that state between the read you were looking at and the read
// that just replaced it — the session-relative diff. C4 already detects, silently, that
// fresh data landed for the scope you're sitting on and swaps the cards; this turns that
// silent swap into a sentence: which metrics moved and by how much / which way / was it
// good or bad, which cards appeared or settled, whether the channel driver behind a
// metric flipped.
//
// It is a PURE diff of TWO already-narrated scope-insight payloads (or compact
// snapshots of them). Properties it must keep:
//   • leak-safe by construction — both inputs are ALREADY leak-safe scope-insight
//     payloads (drivers attributed only by CHANNEL, a global axis; no tenant identity in
//     either side); this module never sees a clientId and emits none. The `next` side is
//     tenancy-pinned upstream by resolveAskScope; `prev` is only the subtrahend.
//   • period-over-period is a DIFFERENT axis — scopeInsight's evidence.previous is the
//     COMPARISON window (compareTo). We diff evidence.CURRENT (the absolute scope total
//     per metric), so two reads are diffable by metric id. Never confuse the two.
//   • jitter-immune — materiality is decided at CENT granularity via toCents, the exact
//     predicate scopeFreshness used to decide "did this scope move", so "changed" here
//     means precisely what "changed" meant to the C4 refresh gate. Sub-cent float noise
//     never registers; a real ≥ $0.01 move always does.
//   • byte-identical phrasing — magnitudes go through ask.formatValue with the same
//     METRICS descriptor scopeInsight uses, so "+$1,240" reads identically everywhere.
//   • correct good/bad — polarity comes from insights.isAdverse (the one source of
//     truth: revenue/leads/jobs/roas/close_rate good-up, cpl good-down, spend neutral).
//   • deterministic — no clock, no RNG, no DB; stable sort; same inputs → same output.
//   • fail-safe — any malformed input degrades to status 'baseline'/'steady' with empty
//     arrays; it never throws.
const { formatValue, METRICS } = require('./ask')
const { isAdverse }            = require('./insights')
const { toCents }              = require('./scopeFreshness')

const isNum = (v) => v != null && Number.isFinite(Number(v))

// A signed, unit-aware magnitude using a REAL minus sign (matches scopeInsight).
// `descriptor` is a METRICS entry; when absent we fall back to a bare rounded number.
function signedDelta(delta, descriptor) {
  const abs = Math.abs(Number(delta) || 0)
  const mag = descriptor ? formatValue(abs, descriptor) : String(Math.round(abs * 100) / 100)
  return (Number(delta) >= 0 ? '+' : '−') + mag
}

// Reduce either input — a full scope-insight payload ({findings:[...]}), a bare
// findings[] array, or a compact [{metric,current}] snapshot — to a Map keyed by metric
// id of { current, label, driverLabel }. Anything without a metric id or a finite
// current is skipped (so junk can't manufacture a phantom change).
function normalizeSnapshot(x) {
  const list = Array.isArray(x) ? x
    : (x && typeof x === 'object' && Array.isArray(x.findings)) ? x.findings
    : []
  const map = new Map()
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const metric = it.metric != null ? String(it.metric) : null
    if (!metric) continue
    const current = it.evidence && isNum(it.evidence.current) ? Number(it.evidence.current)
      : isNum(it.current) ? Number(it.current)
      : null
    if (current == null) continue
    const label = it.metric_label != null ? String(it.metric_label)
      : (METRICS[metric] && METRICS[metric].label) || metric
    const driverLabel = it.driver && it.driver.label != null ? String(it.driver.label) : null
    if (!map.has(metric)) map.set(metric, { current, label, driverLabel })  // first wins — stable
  }
  return map
}

// Direction of a raw delta + whether that move is GOOD for this metric, via the shared
// polarity oracle. A metric the oracle doesn't recognise yields improved:null (neutral).
function classifyMove(metric, delta) {
  const direction = delta >= 0 ? 'up' : 'down'
  const known = !!(METRICS[metric])
  const improved = known ? !isAdverse({ kind: 'movement', metric, direction }) : null
  return { direction, improved }
}

// Percent change vs the FROM value; null when from is zero/non-finite (can't divide).
// Denominator is |from| so the sign rides entirely on the numerator (direction).
function pctChange(from, to) {
  if (!isNum(from) || Number(from) === 0) return null
  return ((Number(to) - Number(from)) / Math.abs(Number(from))) * 100
}

// The diff. prev = the read the user WAS looking at; next = the read that replaced it.
// opts: { headlineLimit=2, minDeltaCents=0 }. Returns
//   { status, changes[], appeared[], resolved[], headline, meta }.
// status: 'baseline' (no usable prev — nothing to diff against, adopt silently),
//         'steady'   (prev existed, nothing moved materially),
//         'changed'  (at least one material change / appearance / resolution).
function diffScopeInsights(prev, next, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const headlineLimit = Number.isInteger(o.headlineLimit) ? Math.max(1, o.headlineLimit) : 2
  const minDeltaCents = isNum(o.minDeltaCents) ? Math.max(0, Math.trunc(Number(o.minDeltaCents))) : 0

  const prevMap = normalizeSnapshot(prev)
  const nextMap = normalizeSnapshot(next)

  // No baseline to diff against → this read simply BECOMES the baseline; say nothing.
  if (prevMap.size === 0) {
    return {
      status: 'baseline', changes: [], appeared: [], resolved: [], headline: null,
      meta: { comparedMetrics: 0, movedCount: 0, appearedCount: 0, resolvedCount: 0 },
    }
  }

  const changes = []
  let comparedMetrics = 0
  for (const [metric, n] of nextMap) {
    const p = prevMap.get(metric)
    if (!p) continue                                   // not in both → handled as appeared
    comparedMetrics++
    const dCents = toCents(n.current) - toCents(p.current)
    if (dCents === 0) continue                          // identical to the cent → no move
    if (Math.abs(dCents) < minDeltaCents) continue      // below the caller's noise floor
    const delta = Number(n.current) - Number(p.current)
    const { direction, improved } = classifyMove(metric, delta)
    const driverShift = (p.driverLabel || n.driverLabel) && p.driverLabel !== n.driverLabel
      ? { from: p.driverLabel, to: n.driverLabel }
      : null
    changes.push({
      metric,
      metric_label: n.label,
      from: Number(p.current),
      to: Number(n.current),
      delta,
      deltaCents: dCents,
      pct: pctChange(p.current, n.current),
      direction,
      improved,
      driverShift,
    })
  }

  // A metric narrated as a card NOW but not in the prior read (moved into view), and the
  // reverse (settled out of view — was a card, now held steady so scopeInsight dropped it).
  const appeared = []
  for (const [metric, n] of nextMap) {
    if (!prevMap.has(metric)) appeared.push({ metric, metric_label: n.label, to: Number(n.current) })
  }
  const resolved = []
  for (const [metric, p] of prevMap) {
    if (!nextMap.has(metric)) resolved.push({ metric, metric_label: p.label, from: Number(p.current) })
  }

  // Deterministic order: biggest absolute cent move first, metric id as the tiebreak.
  const byMetric = (a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0)
  changes.sort((a, b) => (Math.abs(b.deltaCents) - Math.abs(a.deltaCents)) || byMetric(a, b))
  appeared.sort(byMetric)
  resolved.sort(byMetric)

  const moved = changes.length > 0 || appeared.length > 0 || resolved.length > 0
  return {
    status: moved ? 'changed' : 'steady',
    changes,
    appeared,
    resolved,
    headline: buildDeltaHeadline({ changes, appeared, resolved, headlineLimit }),
    meta: {
      comparedMetrics,
      movedCount: changes.length,
      appearedCount: appeared.length,
      resolvedCount: resolved.length,
    },
  }
}

// One leak-safe sentence leading with the largest moves; falls back to appearance /
// resolution counts when nothing crossed the cent threshold but the card SET shifted.
// Returns null when there is genuinely nothing to say.
function buildDeltaHeadline({ changes, appeared, resolved, headlineLimit }) {
  if (changes.length) {
    const phrase = (c) => `${String(c.metric_label).toLowerCase()} ${signedDelta(c.delta, METRICS[c.metric])}`
    return `Since you last looked: ${changes.slice(0, headlineLimit).map(phrase).join(' and ')}.`
  }
  if (appeared.length) {
    const n = appeared.length
    return `Since you last looked: ${n} new ${n === 1 ? 'mover' : 'movers'} in view.`
  }
  if (resolved.length) {
    const n = resolved.length
    return `Since you last looked: ${n} ${n === 1 ? 'mover' : 'movers'} settled.`
  }
  return null
}

module.exports = {
  diffScopeInsights,
  normalizeSnapshot,
  classifyMove,
  pctChange,
  signedDelta,
  buildDeltaHeadline,
}
