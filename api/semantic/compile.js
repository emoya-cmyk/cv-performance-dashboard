// ============================================================
// semantic/compile.js — validate, compile and run a query spec against the
// atomic fact_metric grain. This is the engine behind POST /api/query.
//
// Pipeline:  validateQuerySpec → buildReadPlan → (db) → projectRows → assemble
//
// Why a JS pivot instead of GROUP BY in SQL?  Identical reason to lib/rollup.js,
// whose semantics this mirrors exactly so the two always agree:
//   • one grouped read pulls (client, channel, date, metric_key) → SUM + AVG
//   • JS buckets each raw row into the requested grain (day/week/month) and the
//     requested dims (channel/client), then per metric:
//       sum   → add the SUM
//       avg   → unweighted mean of the per-(channel,date) values  (rollup's AVG)
//       ratio → SUM(num)/SUM(den) computed AFTER aggregation, never per-row
// Aggregating ratios post-hoc is the only correct way — averaging daily ROAS
// would be wrong; SUM(rev)/SUM(spend) is right, and it is exactly what the
// rollup writes into ads_roas / meta_roas. The golden test cross-checks this.
//
// SAFETY: the only identifiers ever placed into SQL are the fixed fact_metric
// column names and metric_key strings taken from the registry allow-list. Every
// runtime value — client ids, channel ids, dates, metric_key filter — is bound
// as $N. A caller cannot inject through metrics, dims, filters or clients.
// ============================================================

'use strict'

const registry = require('./registry')
const { METRICS, metricKeyDeps, parseGroupByToken, dimOutputKey, channelKey } = registry
const { weekStartOf } = require('../lib/rollup')

// ── errors ──────────────────────────────────────────────────────────────────
class QuerySpecError extends Error {
  constructor(message) { super(message); this.name = 'QuerySpecError'; this.status = 400 }
}

// ── small date helpers (UTC, string in / string out) ────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const round2  = (n) => Math.round(n * 100) / 100
const round6  = (n) => Math.round(n * 1e6) / 1e6
const roundDp = (n, dp) => { const f = Math.pow(10, dp); return Math.round(n * f) / f }

function monthStartOf(dateStr) { return dateStr.slice(0, 7) + '-01' }
function bucketDate(dateStr, grain) {
  return grain === 'week' ? weekStartOf(dateStr)
    : grain === 'month'   ? monthStartOf(dateStr)
    : dateStr // 'day'
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function shiftYear(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCFullYear(d.getUTCFullYear() + n)
  return d.toISOString().slice(0, 10)
}
function daysInclusive(start, end) {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000)
}

// Resolve a compareTo directive → the comparison window {start,end} or null.
function resolveCompareWindow(compareTo, window) {
  if (!compareTo) return null
  if (compareTo === 'previous_period') {
    const span    = daysInclusive(window.start, window.end) // 0 for a single day
    const prevEnd = addDays(window.start, -1)
    return { start: addDays(prevEnd, -span), end: prevEnd }
  }
  if (compareTo === 'previous_year') {
    return { start: shiftYear(window.start, -1), end: shiftYear(window.end, -1) }
  }
  // explicit { start, end } — already validated
  return { start: compareTo.start, end: compareTo.end }
}

// ── validation → normalized spec ────────────────────────────────────────────
// Returns: { metrics:[id], dims:[{type,grain?}], dateGrain, clients:'all'|[id],
//            channelIds:[int]|null, dateRange:{start,end}, compareTo, orderBy, limit }
function validateQuerySpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new QuerySpecError('request body must be a JSON object')
  }

  // metrics — required, all from the registry
  const metrics = spec.metrics
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new QuerySpecError('metrics must be a non-empty array')
  }
  for (const id of metrics) {
    if (typeof id !== 'string' || !METRICS[id]) throw new QuerySpecError(`unknown metric: ${JSON.stringify(id)}`)
  }

  // dateRange — required, ISO, ordered
  const dr = spec.dateRange || {}
  if (!DATE_RE.test(dr.start || '') || !DATE_RE.test(dr.end || '')) {
    throw new QuerySpecError('dateRange.start and dateRange.end must be "YYYY-MM-DD"')
  }
  if (dr.start > dr.end) throw new QuerySpecError('dateRange.start must be <= dateRange.end')

  // clients — "all" or a non-empty array of opaque id strings (bound as params)
  let clients = spec.clients == null ? 'all' : spec.clients
  if (clients !== 'all') {
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new QuerySpecError('clients must be "all" or a non-empty array of client ids')
    }
    if (!clients.every(c => typeof c === 'string')) throw new QuerySpecError('client ids must be strings')
  }

  // groupBy — channel | client | date:<grain>, at most one date dim
  const groupBy = spec.groupBy || []
  if (!Array.isArray(groupBy)) throw new QuerySpecError('groupBy must be an array')
  const dims = []
  let dateGrain = null
  for (const tok of groupBy) {
    const dim = parseGroupByToken(tok)
    if (!dim) throw new QuerySpecError(`unknown groupBy: ${JSON.stringify(tok)}`)
    if (dim.type === 'date') {
      if (dateGrain) throw new QuerySpecError('only one date grouping is allowed')
      dateGrain = dim.grain
    }
    if (dims.some(d => d.type === dim.type)) continue // ignore duplicate dim
    dims.push(dim)
  }

  // filters — { dim:'channel'|'client', op:'in', values:[...] }
  const filters = spec.filters || []
  if (!Array.isArray(filters)) throw new QuerySpecError('filters must be an array')
  let channelIds = null
  for (const f of filters) {
    if (!f || typeof f !== 'object') throw new QuerySpecError('each filter must be an object')
    if (f.op != null && f.op !== 'in') throw new QuerySpecError(`unsupported filter op: ${JSON.stringify(f.op)} (only "in")`)
    if (!Array.isArray(f.values) || f.values.length === 0) throw new QuerySpecError('filter.values must be a non-empty array')
    if (f.dim === 'channel') {
      const ids = f.values.map(v => registry.channelId(v))
      if (ids.some(x => x == null)) throw new QuerySpecError('filter on channel contains an unknown channel key')
      channelIds = channelIds ? channelIds.filter(x => ids.includes(x)) : ids
    } else if (f.dim === 'client') {
      if (!f.values.every(v => typeof v === 'string')) throw new QuerySpecError('client filter values must be strings')
      clients = clients === 'all' ? f.values.slice() : clients.filter(c => f.values.includes(c))
    } else {
      throw new QuerySpecError(`unknown filter dim: ${JSON.stringify(f.dim)}`)
    }
  }

  // compareTo — null | "previous_period" | "previous_year" | { start, end }
  let compareTo = spec.compareTo == null ? null : spec.compareTo
  if (compareTo !== null && compareTo !== 'previous_period' && compareTo !== 'previous_year') {
    const ok = compareTo && typeof compareTo === 'object' &&
      DATE_RE.test(compareTo.start || '') && DATE_RE.test(compareTo.end || '')
    if (!ok) throw new QuerySpecError('compareTo must be null, "previous_period", "previous_year", or {start,end}')
  }

  // orderBy — [{ key, dir }]; key must be a requested metric or a grouped dim
  const orderBy = spec.orderBy || []
  if (!Array.isArray(orderBy)) throw new QuerySpecError('orderBy must be an array')
  const orderable = new Set([...metrics, ...dims.map(dimOutputKey)])
  for (const o of orderBy) {
    if (!o || typeof o.key !== 'string' || !orderable.has(o.key)) {
      throw new QuerySpecError(`orderBy.key must be a requested metric or groupBy dim: ${JSON.stringify(o && o.key)}`)
    }
    if (o.dir != null && o.dir !== 'asc' && o.dir !== 'desc') throw new QuerySpecError('orderBy.dir must be "asc" or "desc"')
  }

  // limit — positive integer, clamped
  let limit = spec.limit == null ? 1000 : spec.limit
  if (!Number.isInteger(limit) || limit < 1) throw new QuerySpecError('limit must be a positive integer')
  limit = Math.min(limit, 5000)

  return { metrics, dims, dateGrain, clients, channelIds, dateRange: { start: dr.start, end: dr.end }, compareTo, orderBy, limit }
}

// ── compile: one grouped read of fact_metric over a window ──────────────────
function buildReadPlan(norm, window) {
  const keys = new Set()
  for (const id of norm.metrics) for (const k of metricKeyDeps(id)) keys.add(k)
  const metricKeys = [...keys]

  const params = []
  const P = (v) => { params.push(v); return '$' + params.length }
  const where = []

  if (norm.clients !== 'all') {
    where.push(`client_id IN (${norm.clients.map(c => P(c)).join(', ')})`)
  }
  where.push(`date >= ${P(window.start)}`)
  where.push(`date <= ${P(window.end)}`)
  if (norm.channelIds && norm.channelIds.length) {
    where.push(`channel_id IN (${norm.channelIds.map(id => P(id)).join(', ')})`)
  }
  where.push(`metric_key IN (${metricKeys.map(k => P(k)).join(', ')})`)

  const sql =
    `SELECT client_id, channel_id, date, metric_key,
            SUM(metric_value) AS sum_v,
            AVG(metric_value) AS avg_v
       FROM fact_metric
      WHERE ${where.join('\n        AND ')}
      GROUP BY client_id, channel_id, date, metric_key`

  return { sql, params, metricKeys }
}

// ── project: pivot raw grouped rows into output rows at the requested grain ──
function rowDims(raw, norm) {
  const dimVals = {}
  for (const d of norm.dims) {
    if (d.type === 'channel') dimVals.channel = channelKey(Number(raw.channel_id)) || String(raw.channel_id)
    else if (d.type === 'client') dimVals.client = raw.client_id
    else if (d.type === 'date') dimVals.date = bucketDate(raw.date, d.grain)
  }
  const key = norm.dims.map(d => dimVals[dimOutputKey(d)]).join(' ')
  return { key, dimVals }
}

function projectRows(rawRows, norm) {
  // bucketKey → { dimVals, sum:{mk:Σ}, avgv:{mk:[vals]} }
  const buckets = new Map()
  for (const raw of rawRows) {
    const { key, dimVals } = rowDims(raw, norm)
    let b = buckets.get(key)
    if (!b) { b = { dimVals, sum: Object.create(null), avgv: Object.create(null) }; buckets.set(key, b) }
    const mk = raw.metric_key
    b.sum[mk] = (b.sum[mk] || 0) + (Number(raw.sum_v) || 0)
    if (raw.avg_v != null) (b.avgv[mk] || (b.avgv[mk] = [])).push(Number(raw.avg_v))
  }

  const rows = []
  for (const b of buckets.values()) {
    const row = { ...b.dimVals }
    for (const id of norm.metrics) {
      const m = METRICS[id]
      if (m.kind === 'sum') {
        row[id] = round6(b.sum[m.metric_key] || 0)
      } else if (m.kind === 'avg') {
        const arr = b.avgv[m.metric_key]
        row[id] = arr && arr.length ? round2(arr.reduce((x, y) => x + y, 0) / arr.length) : 0
      } else { // ratio
        const num = b.sum[m.num] || 0
        const den = b.sum[m.den] || 0
        row[id] = den > 0 ? roundDp((num / den) * (m.scale || 1), m.dp == null ? 2 : m.dp) : 0
      }
    }
    rows.push(row)
  }
  return rows
}

// Stable identity of a row by its dimension values (for zipping compare windows).
function rowKey(row, norm) {
  return norm.dims.map(d => row[dimOutputKey(d)]).join(' ')
}

// ── ordering ────────────────────────────────────────────────────────────────
function applyOrder(rows, norm) {
  if (norm.orderBy && norm.orderBy.length) {
    const ords = norm.orderBy.map(o => ({ key: o.key, mul: o.dir === 'asc' ? 1 : -1 }))
    rows.sort((a, b) => {
      for (const { key, mul } of ords) {
        const av = a[key], bv = b[key]
        if (av < bv) return -1 * mul
        if (av > bv) return 1 * mul
      }
      return 0
    })
    return
  }
  // sensible defaults: time series ascending by date; otherwise biggest first metric
  const dateDim = norm.dims.find(d => d.type === 'date')
  if (dateDim) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  } else if (norm.metrics.length) {
    const k = norm.metrics[0]
    rows.sort((a, b) => (Number(b[k]) || 0) - (Number(a[k]) || 0))
  }
}

// ── output framing ──────────────────────────────────────────────────────────
function buildColumns(norm) {
  const cols = []
  for (const d of norm.dims) {
    const key = dimOutputKey(d)
    cols.push({ key, label: d.type === 'date' ? 'Date' : registry.DIMENSIONS[d.type].label, type: 'dimension', ...(d.grain ? { grain: d.grain } : {}) })
  }
  for (const id of norm.metrics) {
    const m = METRICS[id]
    cols.push({ key: id, label: m.label, type: 'metric', format: m.format, agg: m.kind })
  }
  return cols
}

function distinctChannelKeys(rawRows) {
  const seen = new Set()
  for (const r of rawRows) { const k = channelKey(Number(r.channel_id)); if (k) seen.add(k) }
  return [...seen]
}

// ── orchestrator — validate → read → project → (compare) → frame ────────────
// `query` is injected (db.query) so this is unit-testable without HTTP or a
// fixed backend. compareTo is honored only when there is no date grouping —
// aligning shifted daily/weekly buckets across windows is deferred; meta.note
// says so rather than returning a confusing series.
async function runQuerySpec(spec, query) {
  const norm   = validateQuerySpec(spec)
  const window = norm.dateRange

  const plan = buildReadPlan(norm, window)
  const { rows: raw } = await query(plan.sql, plan.params)
  let rows = projectRows(raw, norm)

  // period-over-period compare (no date grain only)
  const hasDateDim = norm.dims.some(d => d.type === 'date')
  let compareWindow = null
  let compareSkipped = null
  if (norm.compareTo) {
    if (hasDateDim) {
      compareSkipped = 'compareTo is ignored when grouping by date'
    } else {
      compareWindow = resolveCompareWindow(norm.compareTo, window)
      const plan2 = buildReadPlan(norm, compareWindow)
      const { rows: raw2 } = await query(plan2.sql, plan2.params)
      const prevByKey = new Map(projectRows(raw2, norm).map(r => [rowKey(r, norm), r]))
      for (const r of rows) {
        const prev = prevByKey.get(rowKey(r, norm))
        const cmp = {}, delta = {}
        for (const id of norm.metrics) {
          const prevVal = prev ? prev[id] : 0
          cmp[id] = prevVal
          delta[id] = round6((Number(r[id]) || 0) - (Number(prevVal) || 0))
        }
        r._compare = cmp
        r._delta = delta
      }
    }
  }

  // decorate client rows with names (one small lookup)
  if (norm.dims.some(d => d.type === 'client')) {
    const ids = [...new Set(rows.map(r => r.client))]
    if (ids.length) {
      const ph = ids.map((_, i) => '$' + (i + 1)).join(', ')
      const { rows: names } = await query(`SELECT id, name FROM clients WHERE id IN (${ph})`, ids)
      const nameMap = new Map(names.map(n => [n.id, n.name]))
      for (const r of rows) r.client_name = nameMap.get(r.client) || null
    }
  }

  applyOrder(rows, norm)
  rows = rows.slice(0, norm.limit)

  const meta = {
    grain: norm.dateGrain || (hasDateDim ? 'day' : 'period'),
    rowCount: rows.length,
    clients: norm.clients === 'all' ? 'all' : norm.clients.length,
    channels: distinctChannelKeys(raw),
    dateRange: window,
    compareTo: compareWindow,
    generatedAt: new Date().toISOString(),
  }
  if (compareSkipped) meta.note = compareSkipped

  return { columns: buildColumns(norm), rows, meta }
}

module.exports = {
  QuerySpecError,
  validateQuerySpec,
  buildReadPlan,
  projectRows,
  resolveCompareWindow,
  runQuerySpec,
  // exported for tests / reuse
  bucketDate,
  weekStartOf,
}
