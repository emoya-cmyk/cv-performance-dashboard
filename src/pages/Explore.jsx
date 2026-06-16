import { useState, useEffect, useMemo, useRef } from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import {
  Compass, Loader2, AlertTriangle, ShieldCheck, GitCompareArrows,
  ArrowUpRight, ArrowDownRight, Sparkles, Download, Link2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn, fmtN, fmtPct, fmtX, fmtDollar, fmtDollarShort, delta } from '@/lib/utils'
import ScopeNarrative from '@/components/ScopeNarrative'

/*
 * Explore — the visible payoff of the Phase-1 atomic grain.
 *
 * The weekly table bakes channel into the column name (ads_spend, meta_spend)
 * and throws the day away, so it can answer neither "spend by channel" nor
 * "leads by day". fact_metric still has channel_id and date, and POST /api/query
 * surfaces them. This page is a thin, honest renderer over that endpoint: it
 * builds its controls from GET /api/query/schema (so it can never offer a metric
 * the server would reject) and never computes a number itself — every figure on
 * screen is exactly what the verified query returned.
 */

// ── date helpers (local calendar, ISO out) ───────────────────────────────────
function isoLocal(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return z.toISOString().slice(0, 10)
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }
function monthStart() { const d = new Date(); return isoLocal(new Date(d.getFullYear(), d.getMonth(), 1)) }
function yearStart() { const d = new Date(); return isoLocal(new Date(d.getFullYear(), 0, 1)) }
const TODAY = isoLocal(new Date())

const RANGE_PRESETS = [
  { key: '7d',    label: 'Last 7d',   start: () => daysAgo(6),   end: () => TODAY },
  { key: '28d',   label: 'Last 28d',  start: () => daysAgo(27),  end: () => TODAY },
  { key: '90d',   label: 'Last 90d',  start: () => daysAgo(89),  end: () => TODAY },
  { key: 'mtd',   label: 'This month',start: () => monthStart(), end: () => TODAY },
  { key: 'ytd',   label: 'This year', start: () => yearStart(),  end: () => TODAY },
]

// Group-by choices, assembled from the schema at render time.
function groupOptions(schema) {
  const dims   = (schema?.dimensions || []).map(d => ({ value: d.id, label: d.label }))
  const grains = (schema?.dateGrains || []).map(g => ({
    value: `date:${g}`,
    label: g === 'day' ? 'Day' : g === 'week' ? 'Week' : g === 'month' ? 'Month' : g,
  }))
  return [...dims, ...grains]
}

// Cost-efficiency ratios where a DECREASE is the good outcome — used only to
// colour the period-over-period delta badge correctly.
const LOWER_IS_BETTER = new Set(['cpl', 'cpc', 'cpa'])

// Curated launch scenarios — one click sets several controls at once to show
// off the breakdowns the weekly table can't express.
const SCENARIOS = [
  { label: 'Spend by channel',  metrics: ['spend', 'leads', 'roas'], groupBy: 'channel',    range: '28d' },
  { label: 'Leads by week',     metrics: ['leads', 'spend', 'cpl'],  groupBy: 'date:week',  range: '90d' },
  { label: 'ROAS by client',    metrics: ['roas', 'revenue', 'spend'], groupBy: 'client',   range: '28d' },
  { label: 'Sessions by day',   metrics: ['sessions', 'conversions'], groupBy: 'date:day',  range: '28d' },
]

const PALETTE = ['#6366f1', '#e53935', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6']

// Format a value for display from its registry `format`. Mirrors the formats the
// server advertises; never does unit math, just presentation.
function fmtValue(v, format) {
  if (v === null || v === undefined || isNaN(v)) return '—'
  switch (format) {
    case 'currency': return fmtDollar(v)
    case 'percent':  return fmtPct(v)
    case 'multiple': return fmtX(v)
    default:         return fmtN(v)
  }
}
// Compact axis label.
function fmtShort(v, format) {
  if (format === 'currency') return fmtDollarShort(v)
  if (format === 'percent')  return fmtPct(v, 0)
  if (format === 'multiple') return fmtX(v, 1)
  if (Math.abs(v) >= 1000)   return `${(v / 1000).toFixed(1)}k`
  return fmtN(v)
}
// Date bucket → friendly label.
function fmtDateLabel(dateStr, grain) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  if (isNaN(d)) return dateStr
  if (grain === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const titleCase = s => String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// ── CSV export ─────────────────────────────────────────────────────────────────
// Exports exactly the rows the verified query returned, as RAW numerics (not the
// $/%/× presentation) so they drop straight into a spreadsheet — the figures stay
// the server's, never re-derived here. When comparing, a "(prev)" column is
// appended per metric. No dependency: a Blob + object URL.
function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function buildCsv({ rows, groupBy, meta, metricsMeta, channelLabel }) {
  const isDate    = groupBy.startsWith('date:')
  const comparing = Boolean(meta.compareTo)
  const dimHeader = isDate
    ? (meta.grain === 'month' ? 'Month' : meta.grain === 'week' ? 'Week' : 'Day')
    : groupBy === 'channel' ? 'Channel' : 'Client'
  const dimCell = (r) => isDate
    ? r.date
    : groupBy === 'channel' ? channelLabel(r.channel) : (r.client_name || r.client)
  const header = [dimHeader, ...metricsMeta.flatMap(m => comparing ? [m.label, `${m.label} (prev)`] : [m.label])]
  const lines  = [header.map(csvCell).join(',')]
  for (const r of rows) {
    const cells = [dimCell(r)]
    for (const m of metricsMeta) {
      cells.push(r[m.id])
      if (comparing) cells.push(r._compare ? r._compare[m.id] : '')
    }
    lines.push(cells.map(csvCell).join(','))
  }
  return lines.join('\n')
}
function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── shareable deep-links ───────────────────────────────────────────────────────
// The whole Explore state lives in the query string so a view is bookmarkable and
// shareable ("spend by channel, last 90d" → paste a link). We read the URL ONCE at
// first render (lazy initialisers below) and write it back with history.replaceState
// — which React Router ignores and which never triggers a re-render, so there is no
// effect loop. Invalid ids from a hand-edited URL are clamped once the schema loads.
function readSpecFromUrl() {
  if (typeof window === 'undefined') return {}
  const p   = new URLSearchParams(window.location.search)
  const out = {}
  if (p.has('m'))  out.metrics       = p.get('m').split(',').map(s => s.trim()).filter(Boolean)
  if (p.has('g'))  out.groupBy       = p.get('g')
  if (p.has('s'))  out.start         = p.get('s')
  if (p.has('e'))  out.end           = p.get('e')
  if (p.has('ch')) out.channelFilter = p.get('ch').split(',').map(s => s.trim()).filter(Boolean)
  if (p.has('c'))  out.compare       = p.get('c') === '1'
  return out
}
function writeSpecToUrl({ metrics, groupBy, start, end, channelFilter, compare }) {
  if (typeof window === 'undefined') return
  const p = new URLSearchParams()
  if (metrics.length) p.set('m', metrics.join(','))
  p.set('g', groupBy)
  p.set('s', start)
  p.set('e', end)
  if (channelFilter.length) p.set('ch', channelFilter.join(','))
  if (compare) p.set('c', '1')
  window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`)
}

// ── delta badge (compare mode) ───────────────────────────────────────────────
function DeltaBadge({ current, previous, metricId }) {
  const d = delta(current, previous)
  if (d.pct === null) {
    return <span className="text-[10px] font-semibold text-slate-300">— new</span>
  }
  const up   = d.pct >= 0
  const good = LOWER_IS_BETTER.has(metricId) ? !up : up
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 text-[10px] font-bold tabular-nums',
      good ? 'text-emerald-600' : 'text-rose-500',
    )}>
      <Icon className="w-3 h-3" />
      {Math.abs(d.pct)}%
    </span>
  )
}

// ── small UI atoms ────────────────────────────────────────────────────────────
function Pill({ active, onClick, children, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-full px-3 py-1 text-xs font-semibold border transition',
        active
          ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
          : 'bg-white text-slate-500 border-slate-200 hover:border-brand-300 hover:text-brand-600',
      )}
    >
      {children}
    </button>
  )
}

function FieldLabel({ children, hint }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5">
      <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{children}</span>
      {hint && <span className="text-[10px] text-slate-300">{hint}</span>}
    </div>
  )
}

// ── result chart ──────────────────────────────────────────────────────────────
function ResultChart({ rows, groupBy, meta, metric, channelLabel }) {
  const isDate = groupBy.startsWith('date:')
  const fmt    = metric.format

  const data = rows.map((r, i) => {
    const name = isDate
      ? fmtDateLabel(r.date, meta.grain)
      : groupBy === 'channel'
        ? channelLabel(r.channel)
        : (r.client_name || r.client)
    return { name, value: Number(r[metric.id]) || 0, _i: i }
  })

  if (!data.length) return null

  const tooltip = (
    <Tooltip
      cursor={{ fill: 'rgba(99,102,241,0.06)' }}
      formatter={(v) => [fmtValue(v, fmt), metric.label]}
      contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid #eef2f7' }}
    />
  )

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {isDate ? (
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="exploreGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.28} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
            <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} minTickGap={16} />
            <YAxis tickFormatter={(v) => fmtShort(v, fmt)} tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={48} />
            {tooltip}
            <Area type="monotone" dataKey="value" name={metric.label} stroke="#6366f1" strokeWidth={2} fill="url(#exploreGrad)" dot={false} />
          </AreaChart>
        ) : (
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
            <XAxis type="number" tickFormatter={(v) => fmtShort(v, fmt)} tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} width={110} />
            {tooltip}
            <Bar dataKey="value" name={metric.label} radius={[0, 6, 6, 0]} maxBarSize={28}>
              {data.map((d) => <Cell key={d._i} fill={PALETTE[d._i % PALETTE.length]} />)}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

// ── result table ──────────────────────────────────────────────────────────────
function ResultTable({ result, groupBy, metricsMeta, channelLabel }) {
  const { rows, meta } = result
  const isDate  = groupBy.startsWith('date:')
  const compare = Boolean(meta.compareTo)
  const dimHeader = isDate
    ? (meta.grain === 'month' ? 'Month' : meta.grain === 'week' ? 'Week' : 'Day')
    : groupBy === 'channel' ? 'Channel' : 'Client'

  const dimCell = (r) => isDate
    ? fmtDateLabel(r.date, meta.grain)
    : groupBy === 'channel' ? channelLabel(r.channel) : (r.client_name || r.client)

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50/70 border-b border-slate-100">
            <th className="text-left px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">{dimHeader}</th>
            {metricsMeta.map(m => (
              <th key={m.id} className="text-right px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400">{m.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
              <td className="px-4 py-2.5 font-semibold text-slate-700 whitespace-nowrap">{dimCell(r)}</td>
              {metricsMeta.map(m => (
                <td key={m.id} className="px-4 py-2.5 text-right tabular-nums">
                  <div className="font-bold text-slate-900">{fmtValue(r[m.id], m.format)}</div>
                  {compare && r._compare && (
                    <div className="mt-0.5">
                      <DeltaBadge current={Number(r[m.id]) || 0} previous={Number(r._compare[m.id]) || 0} metricId={m.id} />
                    </div>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── headline KPI cards ────────────────────────────────────────────────────────
// Driven by a parallel groupBy:[] query so every figure — including ratios like
// ROAS / CPL that must NOT be summed — is aggregated server-side. The first
// metric (the one charted below) is highlighted to tie the cards to the chart.
function SummaryCards({ totals, metricsMeta, firstMetricId }) {
  if (!totals?.rows?.length) return null
  const row       = totals.rows[0]
  const comparing = Boolean(totals.meta?.compareTo) && row._compare
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {metricsMeta.map(m => {
        const charted = m.id === firstMetricId
        return (
          <div key={m.id} className={cn('rounded-xl border p-3.5 transition', charted ? 'border-brand-200 bg-brand-50/40 ring-1 ring-brand-100' : 'border-slate-100 bg-white')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 truncate">{m.label}</span>
              {charted && <span className="text-[9px] font-bold text-brand-500 uppercase shrink-0">charted</span>}
            </div>
            <div className="mt-1 text-2xl font-black text-slate-900 tabular-nums leading-none">{fmtValue(row[m.id], m.format)}</div>
            {comparing && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <DeltaBadge current={Number(row[m.id]) || 0} previous={Number(row._compare[m.id]) || 0} metricId={m.id} />
                <span className="text-[10px] text-slate-400">vs prev</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function Explore() {
  const [schema, setSchema]       = useState(null)
  const [schemaErr, setSchemaErr] = useState(null)

  // Hydrate initial control state from the URL once (deep-link support).
  const url0 = useMemo(readSpecFromUrl, [])

  const [metrics, setMetrics]   = useState(url0.metrics?.length ? url0.metrics : ['spend', 'leads', 'roas'])
  const [groupBy, setGroupBy]   = useState(url0.groupBy || 'channel')
  const [start, setStart]       = useState(url0.start || daysAgo(27))
  const [end, setEnd]           = useState(url0.end || TODAY)
  const [channelFilter, setChannelFilter] = useState(url0.channelFilter || [])
  const [compare, setCompare]   = useState(url0.compare || false)
  // If the URL pinned an explicit range, no preset chip is "active".
  const [activePreset, setActivePreset]   = useState(url0.start || url0.end ? null : '28d')

  const [status, setStatus] = useState('idle') // idle | loading | done | error
  const [result, setResult] = useState(null)
  const [totals, setTotals] = useState(null)   // parallel groupBy:[] all-up totals → KPI cards
  const [error, setError]   = useState(null)
  const [copied, setCopied] = useState(false)  // transient "Copied" state for the share button
  const runSeq = useRef(0)

  // Load the self-describing vocabulary once.
  useEffect(() => {
    let alive = true
    api.querySchema()
      .then(s => { if (alive) setSchema(s) })
      .catch(e => { if (alive) setSchemaErr(e.message || 'Could not load query schema') })
    return () => { alive = false }
  }, [])

  const metaById = useMemo(() => {
    const m = {}
    for (const x of schema?.metrics || []) m[x.id] = x
    return m
  }, [schema])

  const channelLabel = useMemo(() => {
    const map = {}
    for (const c of schema?.channels || []) map[c.key] = c.label
    return (key) => map[key] || titleCase(key)
  }, [schema])

  const isDateGrain = groupBy.startsWith('date:')

  // Assemble the (validated server-side) query spec from the controls.
  const spec = useMemo(() => {
    const s = { metrics, dateRange: { start, end }, groupBy: [groupBy] }
    if (channelFilter.length) s.filters = [{ dim: 'channel', op: 'in', values: channelFilter }]
    if (compare && !isDateGrain) s.compareTo = 'previous_period'
    return s
  }, [metrics, start, end, groupBy, channelFilter, compare, isDateGrain])

  const specKey = useMemo(() => JSON.stringify(spec), [spec])

  // Headline totals: the SAME metrics/range/filters but groupBy:[] so the server
  // collapses every fact into one all-up row. Ratios (ROAS/CPL/CPA) come back as
  // SUM(num)/SUM(den) — correct in a way client-side summation never could be —
  // and because there's no date grouping, compareTo IS honoured, so the cards can
  // carry a period-over-period delta even when the breakdown below is a time series.
  const totalsSpec = useMemo(() => {
    const s = { metrics, dateRange: { start, end }, groupBy: [] }
    if (channelFilter.length) s.filters = [{ dim: 'channel', op: 'in', values: channelFilter }]
    if (compare) s.compareTo = 'previous_period'
    return s
  }, [metrics, start, end, channelFilter, compare])
  const totalsKey = useMemo(() => JSON.stringify(totalsSpec), [totalsSpec])

  // The body for the always-on "Live read" narration panel (intel-v13 C3). It is
  // the SAME scope the breakdown uses — metrics, window, channel filter — handed to
  // POST /api/ai/ask/scope-insight, which re-narrates it server-side whenever this
  // memo changes (the panel debounces). compareTo is intentionally omitted so the
  // server defaults it to the prior period: this panel is an always-on "what changed
  // and what to do" surface, so it always tells a change story; the Compare toggle
  // still governs the table/card per-row deltas, not this read. No clientId → the
  // whole agency portfolio (an agency token); drivers come back by channel only.
  const scopeInsightBody = useMemo(() => {
    const b = { metrics, dateRange: { start, end } }
    if (channelFilter.length) b.filters = [{ dim: 'channel', op: 'in', values: channelFilter }]
    return b
  }, [metrics, start, end, channelFilter])

  // Auto-run whenever the spec changes (and the schema is ready). A monotonic
  // runId drops stale responses so fast control changes can't race. We fire the
  // breakdown and the all-up totals in parallel; the totals are best-effort (the
  // cards just hide if that leg fails) so they never block the primary result.
  useEffect(() => {
    if (!schema || !metrics.length) return
    const myId = ++runSeq.current
    setStatus('loading'); setError(null)
    Promise.all([
      api.query(spec),
      api.query(totalsSpec).catch(() => null),
    ])
      .then(([res, tot]) => {
        if (myId !== runSeq.current) return
        setResult(res)
        setTotals(tot && tot.rows && tot.rows.length ? tot : null)
        setStatus('done')
      })
      .catch(err => {
        if (myId !== runSeq.current) return
        setError(err.message || 'Query failed'); setResult(null); setTotals(null); setStatus('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, totalsKey, schema])

  // Mirror the live control state into the URL (replaceState → no re-render, no
  // router navigation, no loop). Runs on mount too, canonicalising the link.
  useEffect(() => {
    writeSpecToUrl({ metrics, groupBy, start, end, channelFilter, compare })
  }, [metrics, groupBy, start, end, channelFilter, compare])

  // Clamp ids that came from a hand-edited / stale URL to the schema's vocabulary,
  // exactly once — so a bad link degrades gracefully instead of 400-ing every query.
  const didClamp = useRef(false)
  useEffect(() => {
    if (!schema || didClamp.current) return
    didClamp.current = true
    const validM = new Set(schema.metrics.map(x => x.id))
    setMetrics(prev => {
      const f = prev.filter(id => validM.has(id))
      return f.length ? f : ['spend', 'leads', 'roas'].filter(id => validM.has(id))
    })
    const validG = new Set([
      ...(schema.dimensions || []).map(d => d.id),
      ...(schema.dateGrains || []).map(g => `date:${g}`),
    ])
    setGroupBy(prev => (validG.has(prev) ? prev : 'channel'))
    const validCh = new Set((schema.channels || []).map(c => c.key))
    setChannelFilter(prev => prev.filter(k => validCh.has(k)))
  }, [schema])

  function toggleMetric(id) {
    setMetrics(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }
  function toggleChannel(key) {
    setChannelFilter(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key])
  }
  function applyPreset(p) {
    setActivePreset(p.key); setStart(p.start()); setEnd(p.end())
  }
  function applyScenario(sc) {
    const present = sc.metrics.filter(id => metaById[id] || !schema) // keep valid ids
    setMetrics(present.length ? present : sc.metrics)
    setGroupBy(sc.groupBy)
    const preset = RANGE_PRESETS.find(p => p.key === sc.range)
    if (preset) applyPreset(preset)
  }

  const firstMetric = metrics[0] && metaById[metrics[0]]
  const metricsMeta = metrics.map(id => metaById[id]).filter(Boolean)
  const groupLabel = groupOptions(schema).find(o => o.value === groupBy)?.label || groupBy
  const busy = status === 'loading'

  function exportCsv() {
    if (!result?.rows?.length) return
    const csv  = buildCsv({ rows: result.rows, groupBy, meta: result.meta, metricsMeta, channelLabel })
    const safe = groupBy.replace(':', '-')
    downloadCsv(`explore_${safe}_${start}_${end}.csv`, csv)
  }

  function copyLink() {
    writeSpecToUrl({ metrics, groupBy, start, end, channelFilter, compare }) // canonicalise first
    try {
      navigator.clipboard?.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked — the link is still in the address bar */ }
  }

  if (schemaErr) {
    return (
      <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-6 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div>
          <p className="font-bold text-amber-800">Explore is unavailable</p>
          <p className="text-sm text-amber-700 mt-1">{schemaErr}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
          <Compass className="w-5 h-5 text-brand-500" />
        </div>
        <div>
          <h1 className="text-xl font-black text-slate-900 leading-tight">Explore</h1>
          <p className="text-sm text-slate-400">
            Any metric, any breakdown, any range — straight from the daily fact grain the weekly view can’t reach.
          </p>
        </div>
      </div>

      {/* Scenario quick-launch */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">
          <Sparkles className="w-3 h-3" /> Try
        </span>
        {SCENARIOS.map(sc => (
          <button
            key={sc.label}
            onClick={() => applyScenario(sc)}
            className="text-[11px] font-medium text-slate-500 bg-slate-50 hover:bg-brand-50 hover:text-brand-600 border border-slate-100 rounded-full px-3 py-1 transition"
          >
            {sc.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
        {/* Metrics */}
        <div>
          <FieldLabel hint={firstMetric ? `chart shows ${firstMetric.label}` : 'pick at least one'}>Metrics</FieldLabel>
          {schema ? (
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
              {schema.metrics.map(m => (
                <Pill key={m.id} active={metrics.includes(m.id)} onClick={() => toggleMetric(m.id)} title={m.id}>
                  {m.label}
                </Pill>
              ))}
            </div>
          ) : (
            <div className="h-8 flex items-center text-xs text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading vocabulary…
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Group by */}
          <div>
            <FieldLabel>Break down by</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {groupOptions(schema).map(o => (
                <Pill key={o.value} active={groupBy === o.value} onClick={() => setGroupBy(o.value)}>
                  {o.label}
                </Pill>
              ))}
            </div>
          </div>

          {/* Date range */}
          <div>
            <FieldLabel hint={`${start} → ${end}`}>Date range</FieldLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              {RANGE_PRESETS.map(p => (
                <Pill key={p.key} active={activePreset === p.key} onClick={() => applyPreset(p)}>{p.label}</Pill>
              ))}
              <input
                type="date" value={start} max={end}
                onChange={(e) => { setStart(e.target.value); setActivePreset(null) }}
                className="rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <span className="text-slate-300 text-xs">→</span>
              <input
                type="date" value={end} min={start} max={TODAY}
                onChange={(e) => { setEnd(e.target.value); setActivePreset(null) }}
                className="rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Channel filter */}
          <div>
            <FieldLabel hint={channelFilter.length ? `${channelFilter.length} selected` : 'all channels'}>Filter channels</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {(schema?.channels || []).map(c => (
                <Pill key={c.key} active={channelFilter.includes(c.key)} onClick={() => toggleChannel(c.key)}>
                  {c.label}
                </Pill>
              ))}
            </div>
          </div>

          {/* Compare */}
          <div>
            <FieldLabel>Compare</FieldLabel>
            <button
              type="button"
              onClick={() => setCompare(v => !v)}
              title="Compare to the previous period — always reflected in the headline cards; per-row deltas also show on channel/client breakdowns"
              className={cn(
                'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold border transition',
                compare
                  ? 'bg-indigo-500 text-white border-indigo-500 shadow-sm'
                  : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-300 hover:text-indigo-600',
              )}
            >
              <GitCompareArrows className="w-4 h-4" />
              {compare ? 'vs previous period' : 'Previous period'}
            </button>
          </div>
        </div>
      </div>

      {/* Live read — on-demand narrated insight that regenerates with the controls */}
      <ScopeNarrative
        input={scopeInsightBody}
        tone="agency"
        enabled={Boolean(schema) && metrics.length > 0}
      />

      {/* Result */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 min-h-[20rem]">
        {/* Status / meta bar */}
        <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            {firstMetric && metricsMeta.length > 0 && (
              <span className="font-bold text-slate-700">
                {metricsMeta.map(m => m.label).join(' · ')} by {groupLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {result && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5">
                <ShieldCheck className="w-3 h-3" /> Verified figures
              </span>
            )}
            {schema && (
              <button
                type="button"
                onClick={copyLink}
                title="Copy a shareable link to this exact view"
                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 bg-slate-50 hover:bg-slate-100 hover:text-slate-700 border border-slate-200 rounded-full px-2 py-0.5 transition"
              >
                <Link2 className="w-3 h-3" /> {copied ? 'Copied' : 'Link'}
              </button>
            )}
            {result && result.rows.length > 0 && (
              <button
                type="button"
                onClick={exportCsv}
                title="Download these rows as CSV (raw values)"
                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 bg-slate-50 hover:bg-slate-100 hover:text-slate-700 border border-slate-200 rounded-full px-2 py-0.5 transition"
              >
                <Download className="w-3 h-3" /> CSV
              </button>
            )}
            {busy && <Loader2 className="w-4 h-4 animate-spin text-brand-500" />}
          </div>
        </div>

        {/* Empty: no metrics chosen */}
        {!metrics.length && (
          <p className="text-sm text-slate-400 py-10 text-center">Pick at least one metric to begin.</p>
        )}

        {/* Error */}
        {status === 'error' && error && (
          <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-amber-800">Couldn’t run that query</p>
              <p className="text-xs text-amber-700 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Result */}
        {status !== 'error' && metrics.length > 0 && result && firstMetric && (
          <div className={cn('space-y-5 transition-opacity', busy && 'opacity-50')}>
            <SummaryCards totals={totals} metricsMeta={metricsMeta} firstMetricId={firstMetric.id} />
            {result.rows.length === 0 ? (
              <p className="text-sm text-slate-400 py-10 text-center">
                No data for this metric and range. Try a wider date range or a different breakdown.
              </p>
            ) : (
              <>
                <ResultChart
                  rows={result.rows}
                  groupBy={groupBy}
                  meta={result.meta}
                  metric={firstMetric}
                  channelLabel={channelLabel}
                />
                <ResultTable
                  result={result}
                  groupBy={groupBy}
                  metricsMeta={metricsMeta}
                  channelLabel={channelLabel}
                />
              </>
            )}

            {/* Footnotes: compare window + the honest "ignored" note */}
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-400 pt-1">
              <span>
                {result.meta.rowCount} {result.meta.rowCount === 1 ? 'row' : 'rows'} ·{' '}
                {result.meta.channels?.length ? `${result.meta.channels.length} channel${result.meta.channels.length === 1 ? '' : 's'}` : 'no channels'} ·{' '}
                {result.meta.dateRange.start} → {result.meta.dateRange.end}
                {result.meta.compareTo && (
                  <> · <span className="text-indigo-500 font-semibold">vs {result.meta.compareTo.start} → {result.meta.compareTo.end}</span></>
                )}
              </span>
              {compare && isDateGrain
                ? <span className="italic">Deltas shown on the headline cards (time-series rows can’t carry period-over-period).</span>
                : result.meta.note && <span className="italic">{result.meta.note}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
