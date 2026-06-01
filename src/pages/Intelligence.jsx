import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Brain, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Check, Eye,
  Clock, CheckCircle2, Inbox, Plug, ChevronDown, ChevronUp,
} from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { severityMeta, kindMeta, directionIcon, metricLabel, urgencyMeta } from '@/lib/insightMeta'

/**
 * Intelligence — the agency-wide window into the autonomous analyst.
 *
 * The whole feed is one read: GET /api/insights returns every active finding
 * (open + acknowledged) across the portfolio, already ranked by the engine's
 * deterministic feedSort (severity → status → score). Everything on this page —
 * the stat band, the severity / kind / client filters — operates client-side on
 * that single loaded list, so it's the one source of truth and filtering is
 * instant. The only writes are the human lifecycle decisions (ack / resolve) and
 * a manual "Run sweep" that re-runs the engine on demand; the nightly scheduler
 * keeps it fresh without anyone here. Style mirrors Explore (hero + white cards +
 * Pill atoms) so the app feels of-a-piece.
 */
export default function Intelligence() {
  const [status, setStatus]   = useState('loading')   // loading | done | error
  const [insights, setInsights] = useState([])
  const [error, setError]     = useState(null)
  const [running, setRunning] = useState(false)
  const [busyIds, setBusyIds] = useState(() => new Set())

  // filters (all client-side over the loaded feed)
  const [sevFilter, setSevFilter]       = useState('all')   // all | critical | warning | info
  const [kindFilter, setKindFilter]     = useState('all')   // all | <kind>
  const [clientFilter, setClientFilter] = useState('all')   // all | <client_id>
  const [showAcked, setShowAcked]       = useState(true)

  const load = useCallback(async () => {
    setStatus('loading'); setError(null)
    try {
      const data = await api.getInsights()
      setInsights(Array.isArray(data?.insights) ? data.insights : [])
      setStatus('done')
    } catch (e) {
      setError(e?.message || 'Failed to load insights')
      setStatus('error')
    }
  }, [])

  useEffect(() => { if (USE_API) load() }, [load])

  async function runSweep() {
    setRunning(true); setError(null)
    try {
      await api.runInsights()   // no arg = whole portfolio
      await load()
    } catch (e) {
      setError(e?.message || 'Sweep failed')
    } finally {
      setRunning(false)
    }
  }

  // ack/resolve with optimistic local update. The lifecycle routes return the bare
  // updated row (no JOINed client_name), so we preserve the name we already have.
  async function act(id, action) {
    setBusyIds(prev => new Set(prev).add(id))
    try {
      const updated = action === 'ack' ? await api.ackInsight(id) : await api.resolveInsight(id)
      setInsights(prev => action === 'resolve'
        ? prev.filter(i => i.id !== id)
        : prev.map(i => (i.id === id ? { ...i, ...updated, client_name: i.client_name } : i)))
    } catch (e) {
      setError(e?.message || 'Action failed')
    } finally {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  // Counts derived from the live list so they stay correct after optimistic edits.
  const counts = useMemo(() => {
    const t = { total: insights.length, critical: 0, warning: 0, info: 0 }
    for (const i of insights) if (t[i.severity] != null) t[i.severity]++
    return t
  }, [insights])

  const clients = useMemo(() => {
    const m = new Map()
    for (const i of insights) if (i.client_id && !m.has(i.client_id)) m.set(i.client_id, i.client_name || 'Unknown')
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [insights])

  const kinds = useMemo(() => {
    const present = [...new Set(insights.map(i => i.kind))]
    return present.sort((a, b) => kindMeta(a).label.localeCompare(kindMeta(b).label))
  }, [insights])

  const filtered = useMemo(() => insights.filter(i =>
    (sevFilter === 'all'  || i.severity === sevFilter) &&
    (kindFilter === 'all' || i.kind === kindFilter) &&
    (clientFilter === 'all' || i.client_id === clientFilter) &&
    (showAcked || i.status !== 'acknowledged')
  ), [insights, sevFilter, kindFilter, clientFilter, showAcked])

  // ── not-connected state ─────────────────────────────────────────────────────
  if (!USE_API) {
    return (
      <div className="space-y-4">
        <Hero running={false} onRun={() => {}} disabled />
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 text-center">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-3">
            <Plug className="w-6 h-6 text-brand-500" />
          </div>
          <p className="text-sm font-black text-slate-900">Connect your data to switch the analyst on</p>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            Intelligence runs against the live API. Once accounts are connected, the engine
            sweeps every client nightly and surfaces what needs you here — no setup beyond the connection.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Hero running={running} onRun={runSweep} />

      {/* severity stat band — doubles as the severity filter */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active findings" value={counts.total}    tone="brand" active={sevFilter === 'all'}      onClick={() => setSevFilter('all')} />
        <StatCard label="Critical"        value={counts.critical} tone="rose"  active={sevFilter === 'critical'} onClick={() => setSevFilter(sevFilter === 'critical' ? 'all' : 'critical')} />
        <StatCard label="Warning"         value={counts.warning}  tone="amber" active={sevFilter === 'warning'}  onClick={() => setSevFilter(sevFilter === 'warning' ? 'all' : 'warning')} />
        <StatCard label="Info"            value={counts.info}     tone="sky"   active={sevFilter === 'info'}      onClick={() => setSevFilter(sevFilter === 'info' ? 'all' : 'info')} />
      </div>

      {/* filters */}
      {status === 'done' && insights.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <FieldLabel>Type</FieldLabel>
            <Pill active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>All</Pill>
            {kinds.map(k => {
              const m = kindMeta(k); const KIcon = m.icon
              return (
                <Pill key={k} active={kindFilter === k} onClick={() => setKindFilter(kindFilter === k ? 'all' : k)}>
                  <KIcon className="w-3 h-3" /> {m.label}
                </Pill>
              )
            })}
          </div>

          {clients.length > 1 && (
            <div className="flex items-center gap-2">
              <FieldLabel>Client</FieldLabel>
              <select
                value={clientFilter}
                onChange={e => setClientFilter(e.target.value)}
                className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-full px-3 py-1 hover:border-brand-300 focus:outline-none focus:border-brand-400 transition"
              >
                <option value="all">All clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          <div className="ml-auto">
            <Pill active={!showAcked} onClick={() => setShowAcked(s => !s)} title="Hide findings you've already acknowledged">
              <Eye className="w-3 h-3" /> {showAcked ? 'Hide acknowledged' : 'Show acknowledged'}
            </Pill>
          </div>
        </div>
      )}

      {/* error */}
      {error && (
        <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-black text-amber-700">Something went sideways</p>
            <p className="text-xs text-amber-600/80 mt-0.5 break-words">{error}</p>
          </div>
        </div>
      )}

      {/* body */}
      {status === 'loading' ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-brand-400" />
          <p className="text-xs font-semibold text-slate-400">Reading the portfolio…</p>
        </div>
      ) : insights.length === 0 && !error ? (
        <EmptyAllClear />
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-10 text-center">
          <Inbox className="w-7 h-7 text-slate-300 mx-auto mb-2" />
          <p className="text-sm font-black text-slate-600">Nothing matches these filters</p>
          <p className="text-xs text-slate-400 mt-1">Loosen the type, client or severity filter to see more.</p>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            {filtered.map(i => (
              <InsightCard
                key={i.id}
                insight={i}
                busy={busyIds.has(i.id)}
                onAck={() => act(i.id, 'ack')}
                onResolve={() => act(i.id, 'resolve')}
              />
            ))}
          </div>
          <p className="text-[11px] text-slate-400 text-center pt-1">
            Showing {filtered.length} of {insights.length} active finding{insights.length === 1 ? '' : 's'} ·
            swept nightly · resolved items drop off automatically when reality clears
          </p>
        </>
      )}
    </div>
  )
}

/* ── hero ───────────────────────────────────────────────────────────────────── */
function Hero({ running, onRun, disabled }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
        <Brain className="w-5 h-5 text-brand-500" />
      </div>
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-black text-slate-900 leading-tight">Intelligence</h1>
        <p className="text-sm text-slate-400">
          Your portfolio's autonomous analyst — anomalies, trends, pacing and forecasts, swept nightly and ranked by what needs you most.
        </p>
      </div>
      {!disabled && (
        <button
          onClick={onRun}
          disabled={running}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-bold text-brand-600 bg-brand-50 hover:bg-brand-100 border border-brand-100 rounded-xl px-3 py-2 transition disabled:opacity-50"
          title="Re-run the engine across every client right now"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {running ? 'Sweeping…' : 'Run sweep'}
        </button>
      )}
    </div>
  )
}

/* ── stat card (also the severity filter) ───────────────────────────────────── */
const TONES = {
  brand: { v: 'text-brand-600', dot: 'bg-brand-500', ring: 'ring-brand-200 border-brand-200 bg-brand-50/40' },
  rose:  { v: 'text-rose-600',  dot: 'bg-rose-500',  ring: 'ring-rose-200 border-rose-200 bg-rose-50/40' },
  amber: { v: 'text-amber-600', dot: 'bg-amber-500', ring: 'ring-amber-200 border-amber-200 bg-amber-50/40' },
  sky:   { v: 'text-sky-600',   dot: 'bg-sky-500',   ring: 'ring-sky-200 border-sky-200 bg-sky-50/40' },
}
function StatCard({ label, value, tone, active, onClick }) {
  const t = TONES[tone] || TONES.brand
  return (
    <button
      onClick={onClick}
      className={cn(
        'text-left rounded-2xl border p-4 bg-white shadow-sm transition',
        active ? cn('ring-1', t.ring) : 'border-slate-100 hover:border-slate-200',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('w-2 h-2 rounded-full', t.dot)} />
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
      </div>
      <p className={cn('mt-1.5 text-3xl font-black tabular-nums leading-none', value > 0 ? t.v : 'text-slate-300')}>{value}</p>
    </button>
  )
}

/* ── one finding ────────────────────────────────────────────────────────────── */
function InsightCard({ insight, busy, onAck, onResolve }) {
  const [showEvidence, setShowEvidence] = useState(false)
  const sev  = severityMeta(insight.severity)
  const kind = kindMeta(insight.kind)
  const KindIcon = kind.icon
  const Dir  = directionIcon(insight.direction)
  const acked = insight.status === 'acknowledged'

  // The engine's advice — what to DO about this finding, not just what happened.
  // Derived server-side on every row, so it's always present and always current.
  const action  = insight.recommended_action
  const urg     = action ? urgencyMeta(action.urgency) : null
  const UrgIcon = urg ? urg.icon : null

  const evidenceEntries = Object.entries(insight.evidence || {})
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
    .slice(0, 8)

  return (
    <div
      className={cn('rounded-2xl border bg-white shadow-sm p-4 flex gap-3.5 transition hover:shadow-md', acked ? 'border-slate-100 opacity-75' : 'border-slate-100')}
      style={{ borderLeftWidth: 4, borderLeftColor: sev.accent }}
    >
      <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', sev.chipBg)}>
        <KindIcon className={cn('w-4 h-4', sev.chipText)} />
      </div>

      <div className="min-w-0 flex-1">
        {/* meta row */}
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={cn('text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded', sev.chipBg, sev.chipText)}>{sev.label}</span>
          <span className="text-[11px] font-bold text-slate-600 truncate max-w-[12rem]">{insight.client_name || '—'}</span>
          <span className="text-slate-300">·</span>
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
            <KindIcon className="w-3 h-3" /> {kind.label}
          </span>
          {insight.grounded && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 rounded-full px-1.5 py-0.5" title="Narrative verified against the numbers">
              <ShieldCheck className="w-3 h-3" /> AI-verified
            </span>
          )}
          {acked && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-slate-400 bg-slate-100 rounded-full px-1.5 py-0.5">
              <Eye className="w-3 h-3" /> Acknowledged
            </span>
          )}
        </div>

        {/* title + detail */}
        <p className="text-sm font-black text-slate-900 leading-snug">{insight.title}</p>
        {insight.detail && <p className="text-xs text-slate-500 leading-relaxed mt-1">{insight.detail}</p>}

        {/* recommended action — turns the observation into a next step */}
        {action?.text && (
          <div className="mt-2 rounded-xl border border-slate-100 bg-gradient-to-br from-slate-50 to-white px-2.5 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <span className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border', urg.chip)}>
                <UrgIcon className="w-3 h-3" /> {urg.label}
              </span>
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Recommended action</span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed font-medium">{action.text}</p>
          </div>
        )}

        {/* evidence (collapsible, for auditability) */}
        {evidenceEntries.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setShowEvidence(s => !s)}
              className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400 hover:text-brand-500 transition"
            >
              {showEvidence ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Evidence
            </button>
            {showEvidence && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {evidenceEntries.map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 bg-slate-50 border border-slate-100 rounded-md px-1.5 py-0.5">
                    <span className="text-slate-400">{metricLabel(k)}</span>
                    <span className="text-slate-700 tabular-nums">{fmtEv(v)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* footer */}
        <div className="flex items-center gap-2 flex-wrap mt-2.5">
          {insight.metric && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5">
              <Dir className={cn('w-3 h-3', insight.direction === 'up' ? 'text-emerald-500' : insight.direction === 'down' ? 'text-rose-500' : 'text-slate-400')} />
              {metricLabel(insight.metric)}
            </span>
          )}
          {insight.period_start && (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
              <Clock className="w-3 h-3" /> {insight.period_start}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {!acked && (
              <button
                onClick={onAck}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-amber-600 bg-slate-50 hover:bg-amber-50 border border-slate-200 hover:border-amber-200 rounded-lg px-2.5 py-1 transition disabled:opacity-40"
                title="Mute this — we're on it, but don't auto-resolve"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />} Ack
              </button>
            )}
            <button
              onClick={onResolve}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-brand-500 hover:bg-brand-600 rounded-lg px-2.5 py-1 transition disabled:opacity-40"
              title="Close this finding"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Resolve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── all-clear empty state ──────────────────────────────────────────────────── */
function EmptyAllClear() {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center">
      <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-3">
        <CheckCircle2 className="w-6 h-6 text-emerald-500" />
      </div>
      <p className="text-sm font-black text-slate-900">All clear across the portfolio</p>
      <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
        The analyst swept every client and found nothing that needs you. New findings will
        appear here the moment the numbers move — or hit Run sweep to check now.
      </p>
    </div>
  )
}

/* ── atoms (mirrors Explore) ────────────────────────────────────────────────── */
function Pill({ active, onClick, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold border transition',
        active
          ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
          : 'bg-white text-slate-500 border-slate-200 hover:border-brand-300 hover:text-brand-600',
      )}
    >
      {children}
    </button>
  )
}

function FieldLabel({ children }) {
  return <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{children}</span>
}

function fmtEv(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
  return String(v)
}
