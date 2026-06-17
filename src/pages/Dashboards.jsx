import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import {
  LayoutDashboard, Loader2, AlertTriangle, Plus, Trash2, Pencil,
  ArrowLeft, ShieldCheck, RefreshCw, GripVertical, X, Search,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn, fmtN, fmtPct, fmtX, fmtDollar, fmtDollarShort } from '@/lib/utils'
import { widgetGroupBy, reorderWidgets, buildDrillSpec, drillTitle } from '@/lib/dashboards'

/*
 * Dashboards — the persistence half of Phase 3. Explore builds an ad-hoc view;
 * here those views are SAVED (a dashboard = a named bag of widgets) and replayed.
 *
 * Every figure is the server's: each widget's saved query spec is re-run through
 * POST /api/dashboards/:id/run, which compiles it through the SAME semantic engine
 * and the SAME tenant clamp as POST /api/query — so a saved spec can never read
 * another tenant. This page never computes a number; it only renders what the
 * verified run returned.
 */

const PALETTE = ['#6366f1', '#e53935', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6']

function fmtValue(v, format) {
  if (v === null || v === undefined || isNaN(v)) return '—'
  switch (format) {
    case 'currency': return fmtDollar(v)
    case 'percent':  return fmtPct(v)
    case 'multiple': return fmtX(v)
    default:         return fmtN(v)
  }
}
function fmtShort(v, format) {
  if (format === 'currency') return fmtDollarShort(v)
  if (format === 'percent')  return fmtPct(v, 0)
  if (format === 'multiple') return fmtX(v, 1)
  if (Math.abs(v) >= 1000)   return `${(v / 1000).toFixed(1)}k`
  return fmtN(v)
}
const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
function fmtDateLabel(dateStr, grain) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  if (isNaN(d)) return dateStr
  if (grain === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// A small grip used as the drag handle for reordering a widget tile.
function DragHandle(props) {
  return (
    <span
      {...props}
      className="shrink-0 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 transition -ml-1"
      title="Drag to reorder"
      aria-label="Drag to reorder"
    >
      <GripVertical className="w-3.5 h-3.5" />
    </span>
  )
}

// Drill-down detail: runs the EXISTING POST /api/query (same tenant clamp as the
// widget run) for the clicked slice and renders its time series as a table. No
// new data source — every figure traces to the verified query layer.
function DrillPanel({ title, spec, onClose }) {
  const [state, setState] = useState({ status: 'loading', result: null, error: null })
  useEffect(() => {
    let alive = true
    setState({ status: 'loading', result: null, error: null })
    api.query(spec)
      .then((r) => { if (alive) setState({ status: 'done', result: r, error: null }) })
      .catch((e) => { if (alive) setState({ status: 'error', result: null, error: e.message || 'Query failed' }) })
    return () => { alive = false }
  }, [spec])

  const result = state.result || { columns: [], rows: [], meta: {} }
  const metricCols = (result.columns || []).filter((c) => c.type === 'metric')
  const grain = result.meta?.grain
  const isDate = Boolean(grain)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-100">
          <div className="flex items-center gap-2 min-w-0">
            <Search className="w-4 h-4 text-brand-500 shrink-0" />
            <p className="text-sm font-black text-slate-900 truncate">{title}</p>
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5 shrink-0">
              <ShieldCheck className="w-3 h-3" /> Verified
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition shrink-0" aria-label="Close drill-down">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">
          {state.status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-10 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Running detail query…
            </div>
          )}
          {state.status === 'error' && (
            <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">{state.error}</p>
            </div>
          )}
          {state.status === 'done' && (
            !result.rows.length ? (
              <p className="text-sm text-slate-400 py-8 text-center">No data for this slice.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50/70 border-b border-slate-100">
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-widest text-slate-400">
                        {isDate ? (grain === 'month' ? 'Month' : grain === 'week' ? 'Week' : 'Day') : 'Channel'}
                      </th>
                      {metricCols.map((m) => (
                        <th key={m.key} className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-widest text-slate-400">{m.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 last:border-0">
                        <td className="px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">
                          {isDate ? fmtDateLabel(r.date, grain) : titleCase(r.channel || '')}
                        </td>
                        {metricCols.map((m) => (
                          <td key={m.key} className="px-3 py-2 text-right tabular-nums font-bold text-slate-900">{fmtValue(r[m.key], m.format)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// One widget result → a small chart + table. Reads the verified run output;
// the first metric column is charted, every column is tabled. When `onDrill` is
// provided and the widget has a categorical/date breakdown, table rows become
// click-to-drill (open a grounded detail query for the clicked slice). Drag
// props (when supplied) hang off the grip handle so reordering persists.
function WidgetCard({ widget, onDrill, dragProps }) {
  if (widget.error) {
    return (
      <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 h-full">
        <div className="flex items-center gap-1.5 mb-1">
          {dragProps && <DragHandle {...dragProps} />}
          <p className="text-xs font-bold text-slate-700 truncate">{widget.title || 'Widget'}</p>
        </div>
        <div className="flex items-center gap-2 text-amber-700 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {widget.error}
        </div>
      </div>
    )
  }
  const result = widget.result || { columns: [], rows: [], meta: {} }
  const metricCols = (result.columns || []).filter((c) => c.type === 'metric')
  const firstMetric = metricCols[0]
  const groupBy = widgetGroupBy(widget)
  const isDate = typeof groupBy === 'string' && groupBy.startsWith('date:')
  const canDrill = Boolean(onDrill)

  const dimCell = (r) => isDate
    ? fmtDateLabel(r.date, result.meta?.grain)
    : groupBy === 'channel' ? titleCase(r.channel || '') : (r.client_name || r.client)

  const chartData = firstMetric
    ? result.rows.map((r, i) => ({ name: dimCell(r), value: Number(r[firstMetric.key]) || 0, _i: i }))
    : []

  return (
    <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-4 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {dragProps && <DragHandle {...dragProps} />}
          <p className="text-xs font-black text-slate-800 truncate">{widget.title || 'Widget'}</p>
        </div>
        <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5 shrink-0">
          <ShieldCheck className="w-3 h-3" /> Verified
        </span>
      </div>

      {!result.rows.length ? (
        <p className="text-xs text-slate-400 py-8 text-center">No data for this view.</p>
      ) : (
        <>
          {firstMetric && (
            <div className="h-44 w-full">
              <ResponsiveContainer width="100%" height="100%">
                {isDate ? (
                  <AreaChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id={`dashGrad-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis tickFormatter={(v) => fmtShort(v, firstMetric.format)} tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip formatter={(v) => [fmtValue(v, firstMetric.format), firstMetric.label]} contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid #eef2f7' }} />
                    <Area type="monotone" dataKey="value" name={firstMetric.label} stroke="#6366f1" strokeWidth={2} fill={`url(#dashGrad-${widget.id})`} dot={false} />
                  </AreaChart>
                ) : (
                  <BarChart data={chartData} layout="vertical" margin={{ top: 2, right: 12, bottom: 2, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => fmtShort(v, firstMetric.format)} tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} width={90} />
                    <Tooltip formatter={(v) => [fmtValue(v, firstMetric.format), firstMetric.label]} contentStyle={{ fontSize: 11, borderRadius: 10, border: '1px solid #eef2f7' }} />
                    <Bar dataKey="value" name={firstMetric.label} radius={[0, 6, 6, 0]} maxBarSize={22}>
                      {chartData.map((d) => <Cell key={d._i} fill={PALETTE[d._i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-100 max-h-40 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50/70 border-b border-slate-100">
                  <th className="text-left px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400">
                    {isDate ? (result.meta?.grain === 'month' ? 'Month' : result.meta?.grain === 'week' ? 'Week' : 'Day') : groupBy === 'channel' ? 'Channel' : 'Client'}
                  </th>
                  {metricCols.map((m) => (
                    <th key={m.key} className="text-right px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400">{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr
                    key={i}
                    onClick={canDrill ? () => onDrill(widget, r) : undefined}
                    className={cn(
                      'border-b border-slate-50 last:border-0',
                      canDrill && 'cursor-pointer hover:bg-brand-50/50 transition-colors',
                    )}
                    title={canDrill ? 'Drill into this row' : undefined}
                  >
                    <td className="px-2.5 py-1.5 font-semibold text-slate-700 whitespace-nowrap">
                      {canDrill && <Search className="inline w-3 h-3 text-slate-300 mr-1 -mt-0.5" />}
                      {dimCell(r)}
                    </td>
                    {metricCols.map((m) => (
                      <td key={m.key} className="px-2.5 py-1.5 text-right tabular-nums font-bold text-slate-900">{fmtValue(r[m.key], m.format)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── one opened dashboard: run + render its widgets in a grid ──────────────────
function DashboardDetail({ id, onBack, onChanged }) {
  const [run, setRun] = useState(null)
  const [savedWidgets, setSavedWidgets] = useState([]) // raw saved specs (for reorder-persist)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)
  const [dragId, setDragId] = useState(null)           // widget id being dragged
  const [savingOrder, setSavingOrder] = useState(false)
  const [drill, setDrill] = useState(null)             // { title, spec } | null

  const load = useCallback(() => {
    setStatus('loading'); setError(null)
    // Load the saved spec array (so a reorder can be persisted) AND the verified
    // server run (the rendered figures) together.
    Promise.all([api.getDashboard(id), api.runDashboard(id)])
      .then(([d, r]) => { setSavedWidgets(d?.dashboard?.widgets || []); setRun(r); setStatus('done') })
      .catch((e) => { setError(e.message || 'Failed to load dashboard'); setStatus('error') })
  }, [id])

  useEffect(() => { load() }, [load])

  // Persist a drag-drop reorder: the widget ARRAY ORDER is the layout, so we move
  // the saved spec into its new slot and PUT the whole array back through the
  // tenant-guarded PUT /api/dashboards/:id, then mirror the order locally so the
  // grid reflows immediately without a full re-run.
  async function commitReorder(fromId, toId) {
    const next = reorderWidgets(savedWidgets, fromId, toId)
    if (next === savedWidgets) return
    const prev = savedWidgets
    const prevRun = run
    // optimistic: reflow both the saved array and the rendered run results
    setSavedWidgets(next)
    if (run?.widgets) {
      const byId = new Map(run.widgets.map((w) => [w.id, w]))
      setRun({ ...run, widgets: next.map((w) => byId.get(w.id)).filter(Boolean) })
    }
    setSavingOrder(true)
    try {
      await api.updateDashboard(id, { widgets: next })
      onChanged?.()
    } catch (e) {
      setSavedWidgets(prev); setRun(prevRun) // roll back on failure
      window.alert(e.message || 'Could not save the new order')
    } finally {
      setSavingOrder(false)
    }
  }

  function openDrill(widget, row) {
    const spec = buildDrillSpec(widget, row)
    if (!spec) return
    setDrill({ title: drillTitle(widget, row), spec })
  }

  async function rename() {
    const name = window.prompt('Rename dashboard', run?.name || '')
    if (name == null) return
    const trimmed = name.trim()
    if (!trimmed) return
    try { await api.updateDashboard(id, { name: trimmed }); setRun((r) => ({ ...r, name: trimmed })); onChanged?.() }
    catch (e) { window.alert(e.message || 'Rename failed') }
  }
  async function remove() {
    if (!window.confirm('Delete this dashboard? This cannot be undone.')) return
    try { await api.deleteDashboard(id); onChanged?.(); onBack() }
    catch (e) { window.alert(e.message || 'Delete failed') }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-800 transition">
            <ArrowLeft className="w-4 h-4" /> All dashboards
          </button>
          <h1 className="text-lg font-black text-slate-900 truncate">{run?.name || 'Dashboard'}</h1>
          {savingOrder && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-300 shrink-0" />}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={load} title="Refresh" className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 border border-slate-200 bg-white rounded-xl px-2.5 py-1.5 hover:border-slate-300 transition">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={rename} className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 border border-slate-200 bg-white rounded-xl px-2.5 py-1.5 hover:border-slate-300 transition">
            <Pencil className="w-3.5 h-3.5" /> Rename
          </button>
          <button onClick={remove} className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-500 border border-rose-100 bg-white rounded-xl px-2.5 py-1.5 hover:bg-rose-50 transition">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-slate-400 py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Running widgets…
        </div>
      )}
      {status === 'error' && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700">{error}</p>
        </div>
      )}
      {status === 'done' && run && (
        (run.widgets || []).length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-10 text-center">
            <p className="text-sm text-slate-400">This dashboard has no widgets yet. Add one from <span className="font-semibold text-slate-600">Explore → Save as widget</span>.</p>
          </div>
        ) : (
          <>
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <GripVertical className="w-3 h-3 text-slate-300" /> Drag a tile to reorder (saved automatically).
              <Search className="w-3 h-3 text-slate-300 ml-1" /> Click a row to drill in.
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {run.widgets.map((w) => (
                <div
                  key={w.id}
                  onDragOver={(e) => { if (dragId && dragId !== w.id) e.preventDefault() }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragId && dragId !== w.id) commitReorder(dragId, w.id)
                    setDragId(null)
                  }}
                  className={cn('transition', dragId && dragId !== w.id && 'rounded-2xl ring-2 ring-dashed ring-brand-200')}
                >
                  <WidgetCard
                    widget={w}
                    onDrill={openDrill}
                    dragProps={{
                      draggable: true,
                      onDragStart: (e) => { setDragId(w.id); e.dataTransfer.effectAllowed = 'move' },
                      onDragEnd: () => setDragId(null),
                    }}
                  />
                </div>
              ))}
            </div>
          </>
        )
      )}

      {drill && <DrillPanel title={drill.title} spec={drill.spec} onClose={() => setDrill(null)} />}
    </div>
  )
}

// ── the list page ────────────────────────────────────────────────────────────
export default function Dashboards() {
  const [searchParams, setSearchParams] = useSearchParams()
  const openId = searchParams.get('id')

  const [list, setList] = useState(null)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setStatus('loading'); setError(null)
    api.listDashboards()
      .then((r) => { setList(r.dashboards || []); setStatus('done') })
      .catch((e) => { setError(e.message || 'Failed to load dashboards'); setStatus('error') })
  }, [])

  useEffect(() => { load() }, [load])

  function open(id) { setSearchParams({ id: String(id) }) }
  function back() { setSearchParams({}) }

  async function create() {
    const name = window.prompt('New dashboard name')
    if (name == null) return
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const r = await api.createDashboard({ name: trimmed, widgets: [] })
      load()
      open(r.dashboard.id)
    } catch (e) { window.alert(e.message || 'Create failed') }
  }

  if (openId) {
    return <DashboardDetail id={openId} onBack={back} onChanged={load} />
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
            <LayoutDashboard className="w-5 h-5 text-brand-500" />
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-900 leading-tight">Dashboards</h1>
            <p className="text-sm text-slate-400">Saved, composable views — every figure replayed from the verified query layer.</p>
          </div>
        </div>
        <button onClick={create} className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-brand-500 hover:bg-brand-600 rounded-xl px-3.5 py-2 transition shadow-sm">
          <Plus className="w-4 h-4" /> New dashboard
        </button>
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-slate-400 py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading dashboards…
        </div>
      )}
      {status === 'error' && (
        <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700">{error}</p>
        </div>
      )}
      {status === 'done' && (
        (list || []).length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-12 text-center">
            <p className="text-sm text-slate-500 font-semibold">No saved dashboards yet.</p>
            <p className="text-xs text-slate-400 mt-1">Create one here, then add widgets from Explore’s “Save as widget”.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {list.map((d) => (
              <button
                key={d.id}
                onClick={() => open(d.id)}
                className="text-left rounded-2xl border border-slate-100 bg-white shadow-sm p-4 hover:border-brand-300 hover:shadow transition group"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-black text-slate-800 truncate group-hover:text-brand-600 transition">{d.name}</p>
                  {d.client_id == null && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400 bg-slate-50 rounded-full px-2 py-0.5 shrink-0">Agency</span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {(d.widgets || []).length} widget{(d.widgets || []).length === 1 ? '' : 's'}
                </p>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  )
}
