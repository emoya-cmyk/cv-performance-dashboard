'use strict'

// ============================================================
// lib/scopeNarrative.js — the on-demand bridge between a live scope
// (date range + filters + resolved tenancy) and a freshly narrated
// insight. This is what makes the dashboard's insight text + recommendations
// regenerate when a filter or date changes, not just the numbers.
//
// It does TWO reads through the real semantic compiler and nothing else:
//   1. a totals spec  (groupBy: [])        → the scope's current/previous KPIs
//   2. a channel spec (groupBy: ['channel'])→ the drivers behind the move
// then hands both to the pure narrator in ./scopeInsight.
//
// LEAK INVARIANT (intel-v13): drivers are ALWAYS by channel — a global,
// non-tenant-identifying axis that is safe on BOTH the agency portfolio view
// and a per-client / shared-link payload. We never group drivers by client,
// never honour a client-dim filter from the body, and never read a tenant id
// from the request — tenancy is pinned by the resolved `scope.scopeClientId`
// the route computed, never a body param.
// ============================================================

const { runQuerySpec } = require('../semantic/compile')
const { CHANNEL_LABELS } = require('../semantic/registry')
const { generateScopeInsight } = require('./scopeInsight')

// The six KPIs the narrator speaks. Every id here is valid in BOTH the ask
// vocabulary (labels/units/polarity) and the semantic registry (queryable).
const SCOPE_METRICS = ['revenue', 'leads', 'spend', 'roas', 'cpl', 'close_rate']
const MAX_CHANNELS = 12
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Order-preserving, de-duped intersection of the caller's wish list with
// SCOPE_METRICS. Anything outside the allow-list (e.g. a bare `jobs`) is
// dropped; an empty/garbage request falls back to the full set.
function pickMetrics(requested) {
  if (!Array.isArray(requested) || !requested.length) return SCOPE_METRICS.slice()
  const want = new Set(requested)
  const picked = SCOPE_METRICS.filter(m => want.has(m))
  return picked.length ? picked : SCOPE_METRICS.slice()
}

// Tenancy comes ONLY from the resolved scope, never from the body.
//   null  → agency portfolio (all clients)
//   id    → a single client, as a one-element string array
function clientsForScope(scopeClientId) {
  return scopeClientId == null ? 'all' : [String(scopeClientId)]
}

// Keep only well-formed channel filters from the body. Client-dim filters are
// intentionally discarded — honouring one would (a) re-introduce a client axis
// the leak invariant forbids and (b) let a shared link narrow into a tenant it
// was not scoped to.
function channelFiltersFrom(filters) {
  if (!Array.isArray(filters)) return []
  return filters
    .filter(f =>
      f && typeof f === 'object' && f.dim === 'channel' &&
      (f.op == null || f.op === 'in') && Array.isArray(f.values) && f.values.length)
    .map(f => ({ dim: 'channel', op: 'in', values: f.values.slice() }))
}

function buildTotalsSpec({ metrics, dateRange, clients, channelFilters, compareTo }) {
  return {
    metrics,
    dateRange,
    ...(clients === 'all' ? {} : { clients }),
    groupBy: [],
    filters: channelFilters,
    compareTo,
    limit: 1,
  }
}

function buildChannelDriversSpec({ metrics, dateRange, clients, channelFilters, compareTo }) {
  return {
    metrics,
    dateRange,
    ...(clients === 'all' ? {} : { clients }),
    groupBy: ['channel'],
    filters: channelFilters,
    compareTo,
    limit: MAX_CHANNELS,
  }
}

// A human window label derived from the RESOLVED window the compiler returned
// (meta.dateRange), so it always matches the numbers. Bare phrase, no "vs".
function windowLabelFrom(range) {
  if (!range || !range.start || !range.end) return null
  const [sy, sm, sd] = range.start.split('-').map(Number)
  const [ey, em, ed] = range.end.split('-').map(Number)
  if (range.start === range.end) return `${MONTHS[sm - 1]} ${sd}, ${sy}`
  if (sy === ey && sm === em) return `${MONTHS[sm - 1]} ${sd}–${ed}, ${sy}`
  if (sy === ey) return `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}, ${sy}`
  return `${MONTHS[sm - 1]} ${sd}, ${sy} – ${MONTHS[em - 1]} ${ed}, ${ey}`
}

// Compare-clause label. MUST carry the literal "vs " prefix the narrator
// splices verbatim. null when there is no compare window.
function compareLabelFrom(compareTo, compareWindow) {
  if (!compareWindow) return null
  if (compareTo === 'previous_period') return 'vs the prior period'
  if (compareTo === 'previous_year') return 'vs the same period last year'
  const lbl = windowLabelFrom(compareWindow)
  return lbl ? `vs ${lbl}` : 'vs the prior period'
}

// Pull just the scoped metric ids out of a projected row, coercing to finite
// numbers and skipping anything missing/non-numeric.
function pickMetricValues(src, metrics) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const m of metrics) {
    const v = src[m]
    if (v != null && Number.isFinite(Number(v))) out[m] = Number(v)
  }
  return out
}

// Turn channel-breakdown rows into the narrator's drivers shape, labelling by
// the human channel name (never the raw id). Returns null when there is nothing
// to attribute.
function driversFromChannelRows(rows, metrics) {
  if (!Array.isArray(rows) || !rows.length) return null
  const out = []
  for (const r of rows) {
    if (!r || r.channel == null) continue
    out.push({
      label: CHANNEL_LABELS[r.channel] || String(r.channel),
      current: pickMetricValues(r, metrics),
      previous: r._compare ? pickMetricValues(r._compare, metrics) : undefined,
    })
  }
  return out.length ? { dim: 'channel', rows: out } : null
}

// The entry point the route calls. `input` = request body (metrics?, dateRange,
// filters?, compareTo?); `query` = the shared pg query fn; `scope` = the
// route-resolved tenancy ({scopeClientId, role}). Returns the narrator payload
// plus a small `scope_applied` echo and the resolved windows.
async function runScopeInsight(input, query, scope) {
  const opts = input && typeof input === 'object' ? input : {}
  const sc = scope && typeof scope === 'object' ? scope : {}

  const metrics = pickMetrics(opts.metrics)
  const dateRange = opts.dateRange
  const clients = clientsForScope(sc.scopeClientId)
  const channelFilters = channelFiltersFrom(opts.filters)
  const compareTo = 'compareTo' in opts ? opts.compareTo : 'previous_period'

  const totals = await runQuerySpec(
    buildTotalsSpec({ metrics, dateRange, clients, channelFilters, compareTo }), query)
  const totalRow = totals.rows[0] || null
  const current = totalRow ? pickMetricValues(totalRow, metrics) : {}
  const previous = totalRow && totalRow._compare ? pickMetricValues(totalRow._compare, metrics) : undefined

  let drivers = null
  if (totalRow) {
    const breakdown = await runQuerySpec(
      buildChannelDriversSpec({ metrics, dateRange, clients, channelFilters, compareTo }), query)
    drivers = driversFromChannelRows(breakdown.rows, metrics)
  }

  const windowLabel = windowLabelFrom(totals.meta.dateRange) || undefined
  const compareLabel = compareLabelFrom(compareTo, totals.meta.compareTo)

  const narration = generateScopeInsight({
    metrics, current, previous, windowLabel, compareLabel, drivers, limit: metrics.length,
  })

  return {
    ...narration,
    scope_applied: { role: sc.role || null, clients, metrics },
    window: totals.meta.dateRange,
    compare_window: totals.meta.compareTo,
  }
}

module.exports = {
  runScopeInsight,
  SCOPE_METRICS,
  MAX_CHANNELS,
  pickMetrics,
  clientsForScope,
  channelFiltersFrom,
  buildTotalsSpec,
  buildChannelDriversSpec,
  windowLabelFrom,
  compareLabelFrom,
  pickMetricValues,
  driversFromChannelRows,
}
