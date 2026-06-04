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
const { CHANNEL_LABELS, metricKeyDeps, channelId } = require('../semantic/registry')
const { generateScopeInsight } = require('./scopeInsight')
const scopeFreshness = require('./scopeFreshness')

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

// ── intel-v13 C4 (step b): the CHEAP per-scope data-version probe ────────────
// runScopeInsight does two grouped reads and a narration; this does ONE tiny
// aggregate over the SAME scoped rows (GROUP BY metric_key → a handful of
// partials) and folds them into an opaque token via lib/scopeFreshness. The FE
// polls this on a live tick, compares the token to its baseline, and only fires
// the expensive re-narration when it MOVED — so a global SSE broadcast (which
// carries no tenant id) costs one cheap query here, not a full re-narrate, for
// the tenants whose data did not actually change.
//
// It mirrors the compiler's WHERE exactly so the token tracks PRECISELY the rows
// the insight would read: same tenancy pin (scope.scopeClientId only, never a
// body param), same current window, same channel-filter INTERSECT semantics, and
// the same metric_key restriction (the union of metricKeyDeps over the picked
// metrics — close_rate → closed_won+raw_leads, roas → revenue+spend, …).
//
// LEAK-SAFE: the response is ONLY { version, freshAt }. The token embeds no
// tenant identity and no peer data (it is a content fingerprint of the caller's
// already-tenant-scoped rows), and is only ever compared against an earlier
// probe of the SAME scope.
const SCOPE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function badScopeRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

// Resolve the body's channel filters to a concrete, INTERSECTED set of integer
// channel_ids — exactly as the semantic compiler does (sequential intersect; an
// unknown channel key is a 400, never a silent empty result). Returns null when
// no channel filter was supplied (→ no channel_id predicate, i.e. all channels).
function resolveChannelIds(channelFilters) {
  let ids = null
  for (const f of channelFilters) {
    const these = f.values.map(v => channelId(v))
    if (these.some(x => x == null)) throw badScopeRequest('filter on channel contains an unknown channel key')
    ids = ids ? ids.filter(x => these.includes(x)) : these
  }
  return ids
}

async function runScopeFreshness(input, query, scope) {
  const opts = input && typeof input === 'object' ? input : {}
  const sc = scope && typeof scope === 'object' ? scope : {}

  // The window is always concrete on this path (the FE only probes once it has a
  // start+end). Validate strictly — a malformed window is a 400, never a silent
  // full-table scan.
  const dr = opts.dateRange
  const start = dr && dr.start
  const end = dr && dr.end
  if (!SCOPE_DATE_RE.test(String(start)) || !SCOPE_DATE_RE.test(String(end))) {
    throw badScopeRequest('dateRange.start and dateRange.end must be YYYY-MM-DD')
  }
  if (start > end) throw badScopeRequest('dateRange.start must be on or before dateRange.end')

  const metrics = pickMetrics(opts.metrics)
  const clients = clientsForScope(sc.scopeClientId)
  const channelIds = resolveChannelIds(channelFiltersFrom(opts.filters))

  // The base metric_keys behind the picked metrics — the SAME union the compiler
  // fetches. pickMetrics never returns empty and every scope metric has deps, so
  // metricKeys is always non-empty (no degenerate `IN ()`).
  const metricKeys = [...new Set(metrics.flatMap(metricKeyDeps))]

  // Build the cheap aggregate with the compiler's positional-param helper, in the
  // compiler's WHERE order: clients → window → channels → metric_keys.
  const params = []
  const P = (v) => { params.push(v); return '$' + params.length }
  const where = []
  if (clients !== 'all') {
    where.push(`client_id IN (${clients.map(c => P(c)).join(', ')})`)
  }
  where.push(`date >= ${P(start)}`)
  where.push(`date <= ${P(end)}`)
  if (channelIds && channelIds.length) {
    where.push(`channel_id IN (${channelIds.map(id => P(id)).join(', ')})`)
  }
  where.push(`metric_key IN (${metricKeys.map(k => P(k)).join(', ')})`)

  // CAST(MAX(date) AS TEXT): fact_metric.date is DATE in Postgres (node-pg hands
  // back a JS Date) but TEXT in SQLite — the cast yields a portable bare
  // 'YYYY-MM-DD' in BOTH drivers, which is what scopeFreshness.normDate expects.
  // COUNT/SUM may arrive as strings under pg; the fold coerces them.
  const sql =
    `SELECT metric_key,
            COUNT(*) AS rows,
            CAST(MAX(date) AS TEXT) AS max_date,
            SUM(metric_value) AS sum_value
       FROM fact_metric
      WHERE ${where.join('\n        AND ')}
      GROUP BY metric_key`

  const result = await query(sql, params)
  const rows = (result && result.rows) || []

  return {
    version: scopeFreshness.versionFromAggregate(rows),
    freshAt: new Date().toISOString(),
  }
}

module.exports = {
  runScopeInsight,
  runScopeFreshness,
  resolveChannelIds,
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
