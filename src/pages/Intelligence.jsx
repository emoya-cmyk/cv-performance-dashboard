import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Brain, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Check, Eye,
  Clock, CheckCircle2, Inbox, Plug, ChevronDown, ChevronUp, Target, SlidersHorizontal,
  Crosshair, BarChart3, Scale, Award, TrendingDown, Radar, Users,
} from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  severityMeta, kindMeta, directionIcon, metricLabel, urgencyMeta,
  precisionMeta, hasLearnedPrecision, precisionTooltip,
  forecastRange, FORECAST_RANGE_KEYS, fmtMetricValue, attributionView,
  correlateView, impactsView,
  healthBandMeta, recoveryMeta, timeAgo,
} from '@/lib/insightMeta'

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
  const [health, setHealth]   = useState(null)         // { roster, count, by_band } — triage synthesis
  const [benchmarks, setBenchmarks] = useState(null)   // { period, cohort_size, metrics } — cross-client peer benchmarks
  const [recoveries, setRecoveries] = useState([])     // [{ client_name, recovery_reason, recovered_at, … }] — the win stream
  const [systemic, setSystemic] = useState(null)       // { portfolio_size, signals[] } — cross-client common-cause scan (agency-only)
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
      // Five independent reads: the per-finding feed, the synthesized triage roster, the
      // cross-client peer benchmarks, the "what we fixed" recovery stream, and the systemic
      // common-cause scan. allSettled — not Promise.all — so a synthesis hiccup never blanks
      // the feed. If any of the four synthesis reads stumbles its panel simply hides and the
      // page degrades to exactly what it showed before that layer existed; only a feed
      // failure is fatal.
      const [feed, roster, bench, recov, sys] = await Promise.allSettled([
        api.getInsights(), api.getPortfolioHealth(), api.getBenchmarks(), api.getRecoveries(), api.getSystemic(),
      ])
      if (feed.status !== 'fulfilled') throw feed.reason || new Error('Failed to load insights')
      setInsights(Array.isArray(feed.value?.insights) ? feed.value.insights : [])
      setHealth(roster.status === 'fulfilled' && Array.isArray(roster.value?.roster) ? roster.value : null)
      setBenchmarks(bench.status === 'fulfilled' && bench.value?.metrics ? bench.value : null)
      setRecoveries(recov.status === 'fulfilled' && Array.isArray(recov.value?.recoveries) ? recov.value.recoveries : [])
      setSystemic(sys.status === 'fulfilled' && Array.isArray(sys.value?.signals) ? sys.value : null)
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

      {/* triage roster — the per-client synthesis capstone, worst-first. Clicking a
          row pivots the feed's client filter so "where to look first" and the matching
          findings are one motion apart. Hidden until the synthesis read returns rows. */}
      {health?.roster?.length > 0 && (
        <TriageRoster
          roster={health.roster}
          byBand={health.by_band}
          activeClient={clientFilter}
          onPick={(id) => { if (id) setClientFilter(c => (c === id ? 'all' : id)) }}
        />
      )}

      {/* systemic signals — the cross-client common-cause scan: the SAME adverse channel /
          metric / direction independently hitting ≥ minClients clients, collapsed into one
          row apiece ("leads down across 14 clients, 38% of the book"). Answers "is it us, or
          the platform?" — sits beside triage because it reframes WHO is worst as WHETHER it's
          shared. Agency-only (names peers + book share); hidden until a cluster clears the floor. */}
      {systemic?.signals?.length > 0 && <SystemicPanel data={systemic} />}

      {/* peer benchmarks — the cross-client lens: how each client ranks against the
          live portfolio per KPI. Hidden until at least one metric has a publishable
          cohort (≥ MIN_COHORT finite peers); degrades silently to nothing otherwise. */}
      {benchmarks && <BenchmarkPanel data={benchmarks} />}

      {/* recoveries — the positive mirror of the feed: problems the engine flagged that
          then MEASURABLY cleared (metric back to baseline / channel reconnected), newest
          fix first, each tagged with its client. The "what we fixed lately" proof the work
          lands. Hidden until at least one win exists; degrades silently to nothing. */}
      {recoveries.length > 0 && <RecoveriesPanel recoveries={recoveries} />}

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

/* ── triage roster — the worst-first "where do I look first?" leaderboard ──────
   One read of GET /api/insights/health: every client rolled into a single 0–100
   health score (lib/health.js — multiplicative compounding of its open findings),
   banded and ranked worst-first. Where the feed below is per-FINDING, this is the
   per-CLIENT synthesis — the capstone that turns "47 findings" into "look at these
   three clients, in this order." Clicking a row pivots the feed's client filter to
   that client, so the synthesis and the detail it summarizes stay one motion apart.
   The roster is a snapshot from the last sweep/load; ack/resolve update the feed live
   and the next sweep re-scores — no per-action refetch, no flicker. */
function TriageRoster({ roster, byBand, activeClient, onPick }) {
  const [showAll, setShowAll] = useState(false)

  const needAttention = roster.filter(r => r.band !== 'healthy')
  const healthyCount  = roster.length - needAttention.length
  const allHealthy    = needAttention.length === 0
  // Triage by default: show only the clients that need eyes. An all-green portfolio
  // still shows its top rows as a victory lap. The expander reveals the healthy tail.
  const visible = showAll ? roster : (allHealthy ? roster.slice(0, 3) : needAttention)
  const hidden  = roster.length - visible.length

  // band summary chips, worst-first, only the non-zero bands
  const bandOrder = ['critical', 'at_risk', 'watch', 'healthy']

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      {/* header: title + at-a-glance band tally */}
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Crosshair className="w-4 h-4 text-brand-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Where to look first</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {roster.length} client{roster.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {bandOrder.map(b => {
            const n = byBand?.[b] || 0
            if (!n) return null
            const m = healthBandMeta(b)
            return (
              <span key={b} className={cn('inline-flex items-center gap-1 text-[10px] font-bold rounded-full px-2 py-0.5 border', m.chip)}>
                <span className={cn('w-1.5 h-1.5 rounded-full', m.dot)} /> {n} {m.label}
              </span>
            )
          })}
        </div>
      </div>

      {/* rows, worst-first (server order) */}
      <div className="divide-y divide-slate-50">
        {visible.map(r => (
          <RosterRow
            key={r.client_id || r.client_name}
            entry={r}
            active={!!r.client_id && activeClient === r.client_id}
            onPick={onPick}
          />
        ))}
      </div>

      {/* footer: all-clear note / attention summary + healthy-tail expander */}
      {(hidden > 0 || showAll || allHealthy) && (
        <div className="px-4 py-2.5 bg-slate-50/40 flex items-center gap-2 flex-wrap">
          {allHealthy ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
              <CheckCircle2 className="w-3.5 h-3.5" /> Every client healthy — nothing needs you right now.
            </span>
          ) : healthyCount > 0 ? (
            <span className="text-[11px] font-semibold text-slate-400">
              <span className="text-slate-600 font-bold">{needAttention.length}</span> need{needAttention.length === 1 ? 's' : ''} attention
              <span className="text-slate-300"> · </span>{healthyCount} healthy
            </span>
          ) : null}
          {(hidden > 0 || showAll) && (
            <button
              onClick={() => setShowAll(s => !s)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-brand-500 transition"
            >
              {showAll
                ? <><ChevronUp className="w-3 h-3" /> Show less</>
                : <><ChevronDown className="w-3 h-3" /> Show all {roster.length}</>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* one client in the roster: a band-coloured score gauge, name + band + headline
   driver ("biggest drag: Revenue"), and the severity counts. The whole row is the
   pivot control — click to filter the feed to this client. */
function RosterRow({ entry, active, onPick }) {
  const m     = healthBandMeta(entry.band)
  const score = Math.max(0, Math.min(100, Math.round(Number(entry.score) || 0)))
  const d     = entry.driver
  const dsev  = d ? severityMeta(d.severity) : null
  const c     = entry.counts || {}

  return (
    <button
      onClick={() => onPick?.(entry.client_id)}
      disabled={!entry.client_id}
      title={entry.client_id ? 'Filter the feed to this client' : undefined}
      className={cn(
        'w-full text-left px-4 py-3 flex items-center gap-3.5 transition hover:bg-slate-50/70 disabled:cursor-default',
        active && cn('ring-1 ring-inset', m.ring),
      )}
    >
      {/* score gauge */}
      <div className="shrink-0 w-12">
        <div className={cn('text-2xl font-black tabular-nums leading-none', m.text)}>{score}</div>
        <div className="mt-1 h-1 w-full rounded-full bg-slate-100 overflow-hidden">
          <div className={cn('h-full rounded-full', m.bar)} style={{ width: `${score}%` }} />
        </div>
      </div>

      {/* name + band + driver */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-black text-slate-900 truncate max-w-[14rem]">{entry.client_name || 'Unknown client'}</span>
          <span className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', m.chip)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', m.dot)} /> {m.label}
          </span>
        </div>
        {d ? (
          <p className="text-[11px] font-medium text-slate-500 mt-0.5 truncate">
            <span className={cn('font-bold', dsev.text)}>{dsev.label}</span>
            <span className="text-slate-400"> · biggest drag: </span>
            <span className="font-semibold text-slate-600">{metricLabel(d.metric)}</span>
          </p>
        ) : (
          <p className="text-[11px] font-medium text-emerald-600 mt-0.5">No active findings</p>
        )}
      </div>

      {/* severity counts (each shown only when non-zero) */}
      <div className="shrink-0 flex items-center gap-1.5">
        <CountDot n={c.critical} tone="critical" />
        <CountDot n={c.warning}  tone="warning" />
        <CountDot n={c.info}     tone="info" />
      </div>
    </button>
  )
}

// a single severity count pill, reusing the shared severity palette; renders nothing
// at zero so a clean client shows an empty lane rather than three grey "0"s.
function CountDot({ n, tone }) {
  if (!n) return null
  const m = severityMeta(tone)
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] font-bold rounded-full px-1.5 py-0.5', m.chipBg, m.chipText)} title={`${n} ${tone}`}>
      <span className={cn('w-1.5 h-1.5 rounded-full', m.dot)} /> {n}
    </span>
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

  // Learned confidence — the engine's self-read of how useful THIS client's team has
  // found findings like this. Present only once there's decided history (n > 0); the
  // neutral prior stays silent so a fresh feed looks exactly as it did before.
  const prec     = hasLearnedPrecision(insight) ? precisionMeta(insight.precision.band) : null
  const PrecIcon = prec ? prec.icon : null

  // Self-tuned forecast band — the learned-error interval around the projection,
  // present only on forecast findings that earned one (null otherwise → no line).
  const range = forecastRange(insight)

  // Driver attribution — the model-free "why" the engine stamped onto a trend/anomaly
  // finding (null for non-composite metrics and forecast/pacing → no block). Mutually
  // exclusive with `range` in practice: attribution lives on trend/anomaly, the band on
  // forecast, so at most one of the two blocks renders on any card.
  const attribution = attributionView(insight)

  // Root-cause link (lib/correlate.js): on a symptom (anomaly/trend that fell), the dark
  // channel this drop traces to — caused_by → `cause`; on a coverage_gap, the metrics it's
  // dragging — impacts → `impacts`. Mutually exclusive per card. Either null → no block,
  // so a finding the engine couldn't link renders exactly as before.
  const cause   = correlateView(insight)
  const impacts = impactsView(insight)

  // The band's three keys are surfaced as the prominent range line below, so they're
  // filtered OUT of the raw evidence chips here — shown once, not twice.
  const evidenceEntries = Object.entries(insight.evidence || {})
    .filter(([k, v]) => (typeof v === 'number' || typeof v === 'string') && !FORECAST_RANGE_KEYS.has(k))
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
          {prec && (
            <span
              className={cn('inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 border', prec.chip)}
              title={precisionTooltip(insight)}
            >
              <PrecIcon className="w-3 h-3" /> {prec.label}
            </span>
          )}
          {acked && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-slate-400 bg-slate-100 rounded-full px-1.5 py-0.5">
              <Eye className="w-3 h-3" /> Acknowledged
            </span>
          )}
          {cause && (
            <span
              className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-rose-600 bg-rose-50 border border-rose-100 rounded-full px-1.5 py-0.5"
              title={`Traced to ${cause.channelLabel} going dark${cause.daysDark != null ? ` ${cause.daysDark}d ago` : ''}`}
            >
              <Plug className="w-3 h-3" /> Root cause
            </span>
          )}
        </div>

        {/* title + detail */}
        <p className="text-sm font-black text-slate-900 leading-snug">{insight.title}</p>
        {insight.detail && <p className="text-xs text-slate-500 leading-relaxed mt-1">{insight.detail}</p>}

        {/* self-tuned prediction band — the learned-error interval around the projection.
            Shown only once this client earned a track record (lib/selftune.js#intervalFor);
            the width is the engine's own realized accuracy, no number set by hand. */}
        {range && (
          <div className="mt-2 rounded-xl border border-brand-100 bg-gradient-to-br from-brand-50/60 to-white px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-brand-600 shrink-0" />
              <span className="text-xs font-bold text-slate-700">
                Projected {fmtMetricValue(insight.metric, range.point)}
                <span className="text-slate-400 font-semibold"> · likely </span>
                <span className="tabular-nums">{fmtMetricValue(insight.metric, range.lo)}–{fmtMetricValue(insight.metric, range.hi)}</span>
              </span>
            </div>
            <p className="text-[10px] font-medium text-slate-400 leading-relaxed mt-0.5 pl-5">
              {range.pct != null ? `${range.pct}% confidence · ` : ''}self-tuned from this client&rsquo;s forecast track record
            </p>
            {/* Calibrated alarm (lib/insights.js#detectForecast): when the goal still
                falls inside this band the engine EASED the severity one level — it won't
                cry a confident miss while hitting plan is within the client's own error.
                Surfacing the reason makes the softer call legible instead of a silent
                downgrade an operator would have to reverse-engineer. */}
            {range.goalInBand && (
              <p className="text-[10px] font-semibold text-brand-600 leading-relaxed mt-1 pl-5">
                Goal still sits within this band — alarm eased from a confident miss.
              </p>
            )}
          </div>
        )}

        {/* driver attribution — the model-free "why" behind the move. The engine stamps the
            EXACT decomposition of a composite KPI (revenue ≡ spend×roas, jobs ≡ leads×close_rate)
            onto trend + anomaly findings; this shows which lever actually moved it, the dominant
            lever flagged, and any driver that CUSHIONED the move (moved the other way) labelled
            honestly instead of printed as a negative share. Pure arithmetic — every number traces
            to a stored weekly value, so it's audit-grade, not a model guess. */}
        {attribution && (
          <div className="mt-2 rounded-xl border border-slate-100 bg-gradient-to-br from-slate-50 to-white px-2.5 py-2">
            <div className="flex items-center gap-1.5 mb-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">What moved it</span>
            </div>
            <div className="space-y-1">
              {attribution.drivers.map((d) => {
                const DDir = directionIcon(d.dirWord)
                return (
                  <div key={d.metric} className="flex items-center gap-2 text-xs">
                    <span className={cn('inline-flex items-center gap-1 font-bold', d.isLead ? 'text-slate-800' : 'text-slate-500')}>
                      <DDir className={cn('w-3 h-3', d.dirWord === 'up' ? 'text-emerald-500' : d.dirWord === 'down' ? 'text-rose-500' : 'text-slate-300')} />
                      {d.label}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {d.dirWord === 'flat' ? 'flat' : `${d.dirWord === 'up' ? '+' : '−'}${d.pctAbs}%`}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1.5">
                      <span className="text-[10px] font-semibold text-slate-400 tabular-nums">
                        {d.cushioned ? 'softened the move' : `${d.sharePct}% of the move`}
                      </span>
                      {d.isLead && (
                        <span className="inline-flex items-center text-[8px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 border border-brand-100 rounded-full px-1.5 py-0.5">
                          Biggest lever
                        </span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* root-cause link — the dark channel a fallen metric traces to (symptom side). The
            engine connects an anomaly/trend that FELL to an upstream channel that went dark
            when it materially fed that metric (lib/correlate.js); we name the channel, how long
            it's been dark, and its share of the metric, and point the operator at the matching
            Connection finding to reconnect. Mutually exclusive with the blast-radius block. */}
        {cause && (
          <div className="mt-2 rounded-xl border border-rose-100 bg-gradient-to-br from-rose-50/60 to-white px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5 text-rose-500 shrink-0" />
              <span className="text-xs font-bold text-slate-700">
                Likely cause: <span className="text-rose-700">{cause.channelLabel}</span>
                {cause.daysDark != null ? <> dark <span className="tabular-nums">{cause.daysDark}d</span></> : ' dark'}
                {cause.sharePct != null && cause.metricLabel && (
                  <span className="text-slate-400 font-semibold"> (~{cause.sharePct}% of {cause.metricLabel})</span>
                )}
              </span>
            </div>
            <p className="text-[10px] font-medium text-slate-400 leading-relaxed mt-0.5 pl-5">
              This drop traces to a channel that stopped reporting — reconnect it (see its Connection finding) to restore the feed.
            </p>
          </div>
        )}

        {/* blast radius — the root side. On a dark channel's coverage_gap, every metric it's
            measurably dragging, worst share first (lib/correlate.js#impacts); makes the STAKES
            of the gap legible so the reconnect is prioritized by what it recovers. */}
        {impacts && (
          <div className="mt-2 rounded-xl border border-slate-100 bg-gradient-to-br from-slate-50 to-white px-2.5 py-2">
            <div className="flex items-center gap-1.5 mb-1.5">
              <TrendingDown className="w-3.5 h-3.5 text-rose-500 shrink-0" />
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">What this is dragging</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {impacts.map((m) => (
                <span key={m.metric} className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-600 bg-white border border-slate-100 rounded-md px-1.5 py-0.5">
                  <span className="text-slate-700">{m.label}</span>
                  {m.sharePct != null && <span className="text-rose-500 tabular-nums">~{m.sharePct}%</span>}
                </span>
              ))}
            </div>
          </div>
        )}

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

/* ── peer benchmarks — the cross-client lens ───────────────────────────────────
   One read of GET /api/insights/benchmarks: every KPI's cross-client distribution
   over a trailing window, plus each client's direction-aware standing. Where the
   triage roster ranks CLIENTS by health, this ranks the PORTFOLIO on each metric —
   the box plot is the live cohort spread, and the leader/laggard chips name who's
   winning and who's a triage candidate. This is the agency surface, so naming peers
   is correct; the client's own dashboard gets only its anonymous standing (via
   getClientInsights().benchmark), never a peer's name or number.

   The benchmark self-calibrates with zero config: it IS the connected portfolio, so
   adding an account re-shapes every cohort on the next sweep. Metrics whose cohort is
   too thin to publish (cohort !== 'ok', i.e. < MIN_COHORT finite peers) are withheld
   server-side and simply don't appear — and if none qualify, the whole panel hides. */

// Efficiency (size-neutral) before volume (scales with account size); fixed order
// inside each so the panel reads the same on every load.
const BENCHMARK_METRIC_ORDER = ['roas', 'cpl', 'close_rate', 'revenue', 'leads', 'jobs']

function orderedBenchmarkMetrics(metrics) {
  const rank = (m) => { const i = BENCHMARK_METRIC_ORDER.indexOf(m); return i === -1 ? 99 : i }
  return Object.entries(metrics || {})
    .filter(([, b]) => b && b.cohort === 'ok' && b.distribution)
    .sort(([a], [b]) => rank(a) - rank(b))
}

function BenchmarkPanel({ data }) {
  const metrics = orderedBenchmarkMetrics(data?.metrics)
  if (metrics.length === 0) return null   // nothing publishable → degrade to no panel
  const p = data.period || {}
  const n = data.cohort_size

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <BarChart3 className="w-4 h-4 text-brand-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">How clients stack up</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {n} client{n === 1 ? '' : 's'} benchmarked
        </span>
        {p.from && p.to && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
            <Clock className="w-3 h-3" /> {p.weeks}-week window · {p.from} → {p.to}
          </span>
        )}
      </div>

      <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {metrics.map(([metric, b]) => (
          <MetricDistribution key={metric} metric={metric} b={b} />
        ))}
      </div>

      <div className="px-4 py-2.5 bg-slate-50/40 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The benchmark <span className="font-bold text-slate-500">is</span> your live portfolio — connect another
          account and every cohort re-shapes on the next sweep. Standing is direction-aware:
          <span className="font-bold text-slate-500"> the leader is always the best performer</span>, whichever way the metric runs.
        </p>
      </div>
    </div>
  )
}

// ── recoveries panel — the "what we fixed" win stream ─────────────────────────
// The positive counterpart to the findings feed. Each row is a problem the engine
// flagged that then measurably cleared — promoted to status='recovered' by the engine's
// markRecoveries() with a recovery_reason it can defend. Fixed emerald accent (a recovery
// has no severity axis — it's unambiguously good news); recoveryMeta maps the reason to a
// label + icon, timeAgo stamps the recency. Capped at a tidy few so a busy week of wins
// stays a glance, not a scroll; the tail count says how many more cleared this window.
const RECOVERIES_SHOWN = 8
function RecoveriesPanel({ recoveries }) {
  const rows = Array.isArray(recoveries) ? recoveries : []
  if (rows.length === 0) return null                 // no wins yet → degrade to no panel
  const shown  = rows.slice(0, RECOVERIES_SHOWN)
  const hidden = rows.length - shown.length

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">What we fixed lately</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {rows.length} win{rows.length === 1 ? '' : 's'} · last 30 days
        </span>
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((r) => <RecoveryRow key={r.id} r={r} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more resolved this window</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-emerald-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Recoveries are detected automatically — the engine watches every finding it raised and marks it
          <span className="font-bold text-emerald-600"> resolved</span> the moment the metric returns to baseline
          or a dark channel starts reporting again. Nobody closes these by hand.
        </p>
      </div>
    </div>
  )
}

/* One win: the client, what cleared, why we can say it cleared, and how recently. The
   icon + reason label come from recoveryMeta(recovery_reason); the title is the original
   finding's own headline, struck through, so the row reads as "this exact problem — now
   fixed." `ago` hides itself on an unparseable stamp (timeAgo → ''). */
function RecoveryRow({ r }) {
  const meta = recoveryMeta(r.recovery_reason)
  const Icon = meta.icon
  const ago  = timeAgo(r.recovered_at)
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-emerald-500" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-black text-slate-800 truncate max-w-[12rem]">{r.client_name || 'Unknown'}</span>
          <span
            className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"
            title={`Recovered — ${meta.blurb}`}
          >
            <Check className="w-3 h-3" /> {meta.label}
          </span>
          {ago && (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 shrink-0">
              <Clock className="w-3 h-3" /> {ago}
            </span>
          )}
        </div>
        {r.title && (
          <p className="text-xs text-slate-500 mt-1 leading-snug line-through decoration-slate-300">{r.title}</p>
        )}
      </div>
    </div>
  )
}

/* ── systemic signals — the cross-client common-cause scan ─────────────────────
   The agency's "is it us, or the platform?" panel. GET /api/insights/systemic
   collapses the per-client feed into clusters where the SAME adverse channel /
   metric / direction independently hits ≥ minClients clients — "leads down across
   14 clients, 38% of the book" as one row, not fourteen. Where the triage roster
   ranks WHO is worst and the benchmark ranks the PORTFOLIO per metric, this names a
   shared root cause across accounts — the tell that a problem is systemic (channel
   outage, platform shift, tracking break) rather than any one client's own doing.

   Strictly AGENCY-ONLY: every row names other clients and a book-wide share, so —
   exactly like the named peer benchmark — it must never ride a per-client or shared-
   link payload. It lives here and only here. Self-calibrating and operator-free: the
   share denominator IS the live connected book, the floor is a share of it, and the
   scan re-runs every sweep — connect or resolve an account and every cluster re-shapes
   on its own, no thresholds touched by hand. Hides whole when nothing clears the floor. */
const SYSTEMIC_SHOWN         = 6   // cap the cluster rows so a noisy book stays a glance
const SYSTEMIC_CLIENTS_SHOWN = 8   // names per row before collapsing to a "+N more" tail

function SystemicPanel({ data }) {
  const signals = Array.isArray(data?.signals) ? data.signals : []
  if (signals.length === 0) return null            // nothing systemic → degrade to no panel
  const portfolioSize = Number(data?.portfolio_size) || 0
  const shown  = signals.slice(0, SYSTEMIC_SHOWN)
  const hidden = signals.length - shown.length

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-violet-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Is it us, or the platform?</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {signals.length} systemic signal{signals.length === 1 ? '' : 's'}
        </span>
        {portfolioSize > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
            <Users className="w-3 h-3" /> {portfolioSize} client{portfolioSize === 1 ? '' : 's'} in book
          </span>
        )}
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((s) => <SystemicRow key={s.key} s={s} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more systemic signal{hidden === 1 ? '' : 's'}</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-violet-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          A signal fires when the same adverse pattern hits multiple clients independently — a strong hint the cause is the
          <span className="font-bold text-violet-600"> channel or platform, not any one account</span>. The scan is automatic and
          self-calibrating: the share is of your live book, so connecting or resolving an account re-shapes it on the next sweep.
          Agency-only — clients never see cross-account signals.
        </p>
      </div>
    </div>
  )
}

/* One systemic cluster: what's moving, which way, how much of the book it spans, and
   how sure the engine is it's a single cause. The left rail, the share and the meter all
   read in the cluster's severity (critical when any member is critical, else warning).
   `subject` is the metric when there is one, else the dark channel's label (a channel-only
   cluster is a coverage gap gone systemic). The kind chips say HOW it shows up (anomaly /
   trend / connection); the named roster — capped, with a "+N more" tail — is the blast
   radius the operator can act on. `share_pct` is the headline ("of the book"); confidence
   is the engine's blended share×count×severity score, drawn as a meter so it reads at a glance. */
function SystemicRow({ s }) {
  const sev      = severityMeta(s.severity)
  const Dir      = directionIcon(s.direction)
  const dirWord  = s.direction === 'up' ? 'up' : s.direction === 'down' ? 'down' : 'shifting'
  const subject  = s.metric ? metricLabel(s.metric) : (s.channel_label || 'Signal')
  const conf     = Math.max(0, Math.min(100, Math.round((Number(s.confidence) || 0) * 100)))
  const sharePct = Number.isFinite(Number(s.share_pct)) ? Math.round(Number(s.share_pct)) : null
  const count    = Number(s.affected_count) || 0
  const kinds    = Array.isArray(s.kinds) ? s.kinds : []
  const clients  = Array.isArray(s.affected_clients) ? s.affected_clients : []
  const roster   = clients.slice(0, SYSTEMIC_CLIENTS_SHOWN)
  const moreCli  = clients.length - roster.length
  // a channel chip only when the cluster keys on BOTH a metric and a channel — otherwise
  // the channel already IS the subject and the chip would merely echo it.
  const showChannelChip = !!(s.metric && s.channel_label)

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5', sev.chipBg)}>
          <Dir className={cn('w-4 h-4', sev.chipText)} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800">{subject}</span>
            <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-bold', sev.text)}>
              <Dir className="w-3 h-3" /> {dirWord}
            </span>
            <span className="text-[11px] font-semibold text-slate-400">
              across {count} client{count === 1 ? '' : 's'}
            </span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', sev.chipBg, sev.chipText, sev.border)}>
              {sev.label}
            </span>
          </div>

          {(kinds.length > 0 || showChannelChip) && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              {kinds.map((k) => {
                const m = kindMeta(k); const KIcon = m.icon
                return (
                  <span key={k} className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
                    <KIcon className="w-3 h-3" /> {m.label}
                  </span>
                )
              })}
              {showChannelChip && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold rounded-full px-2 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
                  <Plug className="w-3 h-3" /> {s.channel_label}
                </span>
              )}
            </div>
          )}

          {roster.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-2">
              <Users className="w-3 h-3 text-slate-300 shrink-0" />
              {roster.map((c) => (
                <span key={c.id} className="text-[11px] font-semibold text-slate-500 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5 truncate max-w-[10rem]">
                  {c.name || 'Unknown'}
                </span>
              ))}
              {moreCli > 0 && (
                <span className="text-[11px] font-semibold text-slate-400">+{moreCli} more</span>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 text-right w-24">
          {sharePct != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', sev.text)}>{sharePct}%</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">of the book</div>
            </>
          )}
          <div className="mt-2">
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className={cn('h-full rounded-full', sev.dot)} style={{ width: `${conf}%` }} />
            </div>
            <div className="text-[10px] font-semibold text-slate-400 mt-0.5 tabular-nums">{conf}% confidence</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* One KPI's cross-client distribution: a mini box plot of the cohort spread (min ·
   IQR · median · max) with the agency-only leader and laggard named beneath. Values
   render in metric-native units (ROAS ×, CPL/revenue $, close-rate %, counts plain). */
function MetricDistribution({ metric, b }) {
  const d       = b.distribution
  const kind    = b.kind === 'volume' ? 'volume' : 'efficiency'
  const clients = Array.isArray(b.clients) ? b.clients : []
  const best    = clients[0] || null                       // sorted best-first → rank 1
  const worst   = clients.length > 1 ? clients[clients.length - 1] : null
  // Only name a peer the engine itself flagged a standout (real cohort + genuine spread
  // + top/bottom quarter); when peers are bunched, nobody is singled out.
  const leader  = best && best.standout ? best : null
  const laggard = worst && worst !== best && worst.standout ? worst : null

  return (
    <div className="rounded-xl border border-slate-100 bg-gradient-to-br from-slate-50/40 to-white p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-black text-slate-800">{metricLabel(metric)}</span>
        <BenchmarkKindChip kind={kind} />
        <span className="ml-auto text-[10px] font-semibold text-slate-400 tabular-nums">{b.n} clients</span>
      </div>

      <BoxPlot dist={d} />

      <div className="flex items-center justify-between text-[10px] tabular-nums text-slate-400 mt-0.5">
        <span>{fmtBench(metric, d.min)}</span>
        <span className="font-bold text-slate-600">median {fmtBench(metric, d.median)}</span>
        <span>{fmtBench(metric, d.max)}</span>
      </div>

      {(leader || laggard) && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {leader && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"
              title={`Top performer on ${metricLabel(metric)}`}
            >
              <Award className="w-3 h-3" />
              <span className="truncate max-w-[8rem]">{leader.client_name || 'Unknown'}</span>
              <span className="tabular-nums text-emerald-600">{fmtBench(metric, leader.value)}</span>
            </span>
          )}
          {laggard && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5"
              title={`Lagging the cohort on ${metricLabel(metric)} — a triage candidate`}
            >
              <TrendingDown className="w-3 h-3" />
              <span className="truncate max-w-[8rem]">{laggard.client_name || 'Unknown'}</span>
              <span className="tabular-nums text-rose-600">{fmtBench(metric, laggard.value)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// efficiency = size-neutral (a small account can top it); volume = scales with size.
// The framing keeps a big client from looking "best" on revenue while a lean one
// quietly wins on the efficiency metrics that actually measure the work.
function BenchmarkKindChip({ kind }) {
  if (kind === 'volume') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-sky-50 text-sky-600 border-sky-200"
        title="Volume metric — naturally scales with account size"
      >
        <BarChart3 className="w-3 h-3" /> Volume
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-violet-50 text-violet-600 border-violet-200"
      title="Efficiency metric — size-neutral, compares quality regardless of account size"
    >
      <Scale className="w-3 h-3" /> Efficiency
    </span>
  )
}

/* A minimal Tukey box plot over the cohort distribution, in natural units: a whisker
   from min to max, an inter-quartile box (p25–p75), and the median tick. Positions are
   percentages across [min, max]; a zero-span cohort (everyone identical) collapses to a
   centered mark rather than dividing by zero. */
function BoxPlot({ dist }) {
  if (!dist) return null
  const { min, max, p25, p75, median } = dist
  const span = Number.isFinite(max) && Number.isFinite(min) ? max - min : 0
  const pos  = (v) => (span > 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, ((v - min) / span) * 100)) : 50)
  const boxL = pos(p25)
  const boxR = pos(p75)
  const med  = pos(median)

  return (
    <div className="relative h-7">
      {/* whisker baseline (min → max) */}
      <div className="absolute top-1/2 left-0 right-0 h-px bg-slate-200 -translate-y-1/2" />
      {/* min / max caps */}
      <div className="absolute top-1/2 left-0  w-px h-3 bg-slate-300 -translate-y-1/2" />
      <div className="absolute top-1/2 right-0 w-px h-3 bg-slate-300 -translate-y-1/2" />
      {/* inter-quartile box */}
      <div
        className="absolute top-1/2 h-4 rounded bg-brand-100 border border-brand-200 -translate-y-1/2"
        style={{ left: `${boxL}%`, width: `${Math.max(boxR - boxL, 0)}%` }}
      />
      {/* median tick */}
      <div className="absolute top-1/2 w-0.5 h-4 bg-brand-600 rounded -translate-y-1/2" style={{ left: `${med}%`, marginLeft: '-1px' }} />
    </div>
  )
}

// Metric-native formatter for the benchmark surface. ROAS reads as a multiple (2.5×),
// close-rate as a percent (30%); money and counts defer to the shared fmtMetricValue
// (CPL/revenue → whole $, leads/jobs → grouped int). Kept local so the shared formatter
// keeps its single contract and this surface can speak ratios it doesn't.
function fmtRatio(n, suffix) {
  const r = Math.round(Number(n) * 10) / 10
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1)
  return `${s}${suffix}`
}
function fmtBench(metric, v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (metric === 'roas')       return fmtRatio(n, '×')
  if (metric === 'close_rate') return fmtRatio(n, '%')
  return fmtMetricValue(metric, n)
}
