import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Brain, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Check, Eye,
  Clock, CheckCircle2, Inbox, Plug, ChevronDown, ChevronUp, Target, SlidersHorizontal,
  Crosshair, BarChart3, Scale, Award, TrendingDown, Radar, Users, Sparkles, ArrowUpCircle, Activity,
  Gauge, ShieldAlert,
} from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  severityMeta, kindMeta, directionIcon, metricLabel, urgencyMeta,
  precisionMeta, hasLearnedPrecision, precisionTooltip,
  forecastRange, FORECAST_RANGE_KEYS, fmtMetricValue, attributionView,
  correlateView, impactsView, escalationView,
  healthBandMeta, recoveryMeta, timeAgo, recapPosture,
} from '@/lib/insightMeta'
import DriverBreakdown from '@/components/DriverBreakdown'

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
  const [trajectory, setTrajectory] = useState(null)   // { warnings[], count } — predictive early-warning roster (agency-only)
  const [pacing, setPacing]   = useState(null)         // { roster[], month, days_elapsed, days_in_month } — goal-pacing roster (agency-only)
  const [efficacy, setEfficacy] = useState(null)       // { base, plays[], count } — action→recovery efficacy ledger (pooled, anonymous)
  const [pulse, setPulse]     = useState(null)         // { roster[], as_of, window, lookback_days } — intra-week daily-pulse early warning (agency-only)
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
      // Nine independent reads: the per-finding feed, the synthesized triage roster, the
      // cross-client peer benchmarks, the "what we fixed" recovery stream, the systemic
      // common-cause scan, the predictive early-warning roster, the goal-pacing roster, the
      // action→recovery efficacy ledger (which of our OWN plays actually fix it), and the
      // intra-week daily-pulse roster (who's sliding RIGHT NOW, days before the week closes).
      // allSettled — not Promise.all — so a synthesis hiccup never blanks the feed. If any
      // of the eight synthesis reads stumbles its panel simply hides and the page degrades to
      // exactly what it showed before that layer existed; only a feed failure is fatal.
      const [feed, roster, bench, recov, sys, traj, pace, eff, pls] = await Promise.allSettled([
        api.getInsights(), api.getPortfolioHealth(), api.getBenchmarks(), api.getRecoveries(), api.getSystemic(), api.getTrajectory(), api.getPacing(), api.getEfficacy(), api.getPulse(),
      ])
      if (feed.status !== 'fulfilled') throw feed.reason || new Error('Failed to load insights')
      setInsights(Array.isArray(feed.value?.insights) ? feed.value.insights : [])
      setHealth(roster.status === 'fulfilled' && Array.isArray(roster.value?.roster) ? roster.value : null)
      setBenchmarks(bench.status === 'fulfilled' && bench.value?.metrics ? bench.value : null)
      setRecoveries(recov.status === 'fulfilled' && Array.isArray(recov.value?.recoveries) ? recov.value.recoveries : [])
      setSystemic(sys.status === 'fulfilled' && Array.isArray(sys.value?.signals) ? sys.value : null)
      setTrajectory(traj.status === 'fulfilled' && Array.isArray(traj.value?.warnings) ? traj.value : null)
      setPacing(pace.status === 'fulfilled' && Array.isArray(pace.value?.roster) ? pace.value : null)
      setEfficacy(eff.status === 'fulfilled' && Array.isArray(eff.value?.plays) ? eff.value : null)
      setPulse(pls.status === 'fulfilled' && Array.isArray(pls.value?.roster) ? pls.value : null)
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

      {/* weekly AI recap — the grounded narrative for the client in focus. Reads the same
          clientFilter the roster pivots, so picking a client (click or dropdown) turns "look
          here first" into "and here's the AI's plain-English read of their week" in one motion.
          Self-fetching + keyed on the client id so it remounts clean on every focus change; the
          keystone no-op is the all-clients view, where it simply isn't rendered. */}
      {clientFilter !== 'all' && (
        <WeeklyRecapPanel
          key={clientFilter}
          clientId={clientFilter}
          clientName={
            health?.roster?.find(r => r.client_id === clientFilter)?.client_name ||
            clients.find(c => c.id === clientFilter)?.name ||
            'this client'
          }
        />
      )}

      {/* act today — the DECISION strip atop the daily pulse: the SAME adverse signals, re-ranked
          by severity × the pulse's own LEARNED reliability (lib/pulseTriage), each tagged with an
          action lane and a 1-based priority rank. A reliable Warning can outrank a noisy Critical,
          so the agency's first hour lands by evidence, not just by how loud the alarm is. Agency-
          only; hidden until one signal fires. The full worst-first roster follows directly below. */}
      {pulse?.act_today?.length > 0 && <ActTodayStrip data={pulse} />}

      {/* daily pulse — the INTRA-WEEK early warning, and the freshest read on the page. Every
          other panel here is weekly-grain: the engine only speaks once an ISO week closes, blind
          between Mondays. This watches each client's trailing-7-day LEVEL on the atomic DAILY
          facts and surfaces the moment it slides out of that client's OWN recent band — a Tuesday
          collapse, or a runaway spend, days before the Monday recap names it. Sits first among
          the portfolio roster panels because it's the most time-sensitive: read down the page and
          it goes "moving RIGHT NOW" (pulse) → "headed for trouble" (trajectory) → "off goal pace"
          (pacing). Computed live off the daily grain, ranked worst-first. Agency-only (names
          peers, like the rest); a client sees only its OWN pulse, folded into its dashboard.
          Hidden until at least one client × metric fires. */}
      {pulse?.roster?.length > 0 && <PulsePanel data={pulse} />}

      {/* heading for trouble — the PREDICTIVE companion to the triage roster. Triage ranks
          who is worst TODAY; this ranks who is still inside a safe band but, by the slope of
          their OWN recent health scores, projected to slide THROUGH a band floor within the
          horizon. Read top-to-bottom the page goes "look here now" → "and here next". Agency-
          only (names peers, like triage + systemic); hidden until at least one client slides. */}
      {trajectory?.warnings?.length > 0 && <TrajectoryPanel data={trajectory} />}

      {/* off goal pace — the GOAL-anchored companion to trajectory. Trajectory reads the slope
          of a client's health; this reads month-to-date actual against the human-set monthly
          GOAL by linear run-rate, and lists everyone who at today's pace will MISS — worst
          first ("on pace for 24% of the leads goal, must run 4× to still hit it"). The save
          before the month closes, not the post-mortem after. Agency-only (names peers + their
          targets, like triage + systemic + trajectory); hidden until at least one goal is off pace. */}
      {pacing?.roster?.length > 0 && <PacingPanel data={pacing} />}

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

      {/* playbook efficacy — the self-improving grain, and the natural next read after recoveries:
          recoveries are the INSTANCES we fixed, this is the PATTERN learned across them. Per play
          archetype (the recommendation we attach to a kind of problem) it pools every decided,
          recoverable finding the book over and asks "did this play actually clear it?" — the
          measured rate shrunk toward the pooled base rate, ranked by a Wilson lower bound so a
          deep 9/10 outranks a lucky 1/1, plus the median days it took. Pooled + anonymous (a
          rate names no client). Hidden until a play earns enough evidence to rank. */}
      {efficacy?.plays?.length > 0 && <EfficacyPanel data={efficacy} />}

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

/* ── weekly AI recap — the grounded narrative for the client in focus ──────────
   The whole intelligence stack on this page is per-FINDING and per-CLIENT scoring;
   this is the one surface where the autonomous analyst speaks in plain English. It
   reads GET /api/ai/recap/:clientId — the verifier-checked narration of that client's
   most recently completed week, whose evidence pack now carries the intelligence
   posture digest (lib/intelDigest.js). The recap layer degrades to a deterministic
   template when no API key is set, so there's no missing-key state to handle — only
   load / error. Self-fetching so the roster stays a single read; a "Regenerate" forces
   a fresh narration + re-verify in place. Grounded means every number in the prose was
   checked against the same evidence the rest of the page is scored from. */
function WeeklyRecapPanel({ clientId, clientName }) {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [recap, setRecap]   = useState(null)
  const [error, setError]   = useState('')
  const [busy, setBusy]     = useState(false)        // a Regenerate in flight

  const fetchRecap = useCallback(async (regen) => {
    if (regen) { setBusy(true) } else { setStatus('loading'); setError('') }
    try {
      const r = regen ? await api.regenerateRecap(clientId) : await api.getRecap(clientId)
      setRecap(r); setStatus('done'); setError('')
    } catch (e) {
      if (regen) setError(e?.message || 'Regenerate failed')
      else { setError(e?.message || 'Could not load the recap'); setStatus('error') }
    } finally { setBusy(false) }
  }, [clientId])

  useEffect(() => { fetchRecap(false) }, [fetchRecap])

  const posture  = status === 'done' && recap ? recapPosture(recap.evidence_pack) : null
  const period   = recap?.evidence_pack?.period?.label || recap?.week_start || ''
  const text     = (recap?.recap_text || '').trim()
  const grounded = !!recap?.grounded

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">This week, in plain English</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">{clientName}</p>
        </div>
        {status === 'done' && (
          grounded ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              <ShieldCheck className="w-3 h-3" /> AI-verified
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              <AlertTriangle className="w-3 h-3" /> Unverified draft
            </span>
          )
        )}
        <button
          onClick={() => fetchRecap(true)}
          disabled={busy || status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Regenerate
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the week…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load the recap'}</p>
            <button
              onClick={() => fetchRecap(false)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            {period && (
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                <Clock className="w-3 h-3" /> {period}
              </div>
            )}
            {text ? (
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{text}</p>
            ) : (
              <p className="text-sm text-slate-400 italic">No recap text for this week yet.</p>
            )}
            {error && (
              <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-rose-500">
                <AlertTriangle className="w-3 h-3" /> {error}
              </p>
            )}
            {posture && <RecapPostureStrip p={posture} />}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Written by the analyst from the same verified numbers the rest of this page is scored from.
          {recap?.model ? ` Model ${recap.model}.` : ''}
        </p>
      </div>
    </section>
  )
}

/* The posture strip — a compact "where things stand now" read of the recap's
   intelligence digest, the same self-improving signals the feed exposes per-finding,
   rolled to client level: how many findings are open (and the critical/warning split),
   which areas the loop is actively re-strategising, which measurably cleared, and the
   goal-pace split. Every chip is conditional, so a quiet week renders nothing. */
function RecapPostureStrip({ p }) {
  return (
    <div className="mt-4 pt-3 border-t border-slate-50">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Where things stand now</p>
      <div className="flex flex-wrap gap-1.5">
        {p.active > 0 && (
          <PostureChip
            icon={Radar} tone="slate" label={`${p.active} open`}
            detail={[p.critical ? `${p.critical} critical` : '', p.warning ? `${p.warning} warning` : '']
              .filter(Boolean).join(' · ')}
          />
        )}
        {p.adjustingCount > 0 && (
          <PostureChip
            icon={SlidersHorizontal} tone="amber" label={`Adjusting ${p.adjustingCount}`}
            detail={p.adjusting.join(', ')}
          />
        )}
        {p.improvingCount > 0 && (
          <PostureChip
            icon={ArrowUpCircle} tone="emerald" label={`Improving ${p.improvingCount}`}
            detail={p.improving.join(', ')}
          />
        )}
        {p.onTrack > 0 && (
          <PostureChip icon={Target} tone="emerald" label={`${p.onTrack} on pace`} />
        )}
        {p.atRisk > 0 && (
          <PostureChip icon={TrendingDown} tone="rose" label={`${p.atRisk} off pace`} />
        )}
      </div>
    </div>
  )
}

const POSTURE_TONES = {
  slate:   'text-slate-600 bg-slate-50 border-slate-200',
  amber:   'text-amber-700 bg-amber-50 border-amber-200',
  emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  rose:    'text-rose-700 bg-rose-50 border-rose-200',
}
function PostureChip({ icon: Icon, tone, label, detail }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold', POSTURE_TONES[tone] || POSTURE_TONES.slate)}>
      <Icon className="w-3 h-3 shrink-0" />{label}
      {detail ? <span className="font-medium opacity-70">· {detail}</span> : null}
    </span>
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

  // Escalation (lib/escalation.js, read-time): present only once the pooled efficacy
  // ledger has PROVEN this play ineffective (band 'low' on n ≥ ESCALATE_MIN_N decided
  // outcomes). When set, the engine already rewrote `action.text` to switch levers and
  // bumped `action.urgency` a lane — both render through the blocks below automatically.
  // This view drives the at-a-glance signals unique to the agency surface: the candid
  // "Escalated" chip and the reason banner with the recovery statistic. null → no-op.
  const escalation = escalationView(insight)

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
          {escalation && (
            <span
              className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-orange-600 bg-orange-50 border border-orange-200 rounded-full px-1.5 py-0.5"
              title={escalation.hasStat
                ? `Auto-escalated — this play has cleared the problem only ${escalation.pct}% of the time (${escalation.successes ?? '?'} of ${escalation.n}); urgency raised and lever switched`
                : 'Auto-escalated — the usual fix hasn’t been recovering this; urgency raised and lever switched'}
            >
              <ArrowUpCircle className="w-3 h-3" /> Escalated
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

        {/* auto-escalation (lib/escalation.js, read-time) — surfaces ONLY once the pooled
            efficacy ledger has PROVEN this play ineffective (band 'low' on n ≥ ESCALATE_MIN_N
            decided outcomes). The engine has already bumped action.urgency one lane and rewritten
            action.text to switch levers — both render in the block below automatically. This banner
            is the agency/internal-only WHY: the candid recovery statistic (pct% cleared, s of n)
            and the lane the urgency was raised to. The client surface shows escalation.client_text
            instead, never the failure number. null → renders nothing (the keystone no-op). */}
        {escalation && (
          <div className="mt-2 rounded-xl border border-orange-200 bg-gradient-to-br from-orange-50 to-white px-2.5 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <ArrowUpCircle className="w-3.5 h-3.5 text-orange-500 shrink-0" />
              <span className="text-[9px] font-bold uppercase tracking-wider text-orange-700">Auto-escalated — the usual fix isn’t working</span>
            </div>
            <p className="text-xs leading-relaxed font-medium text-orange-800/90">
              {escalation.hasStat
                ? `This play has cleared the problem only ${escalation.pct}% of the time (${escalation.successes ?? '?'} of ${escalation.n} tracked) — switching levers rather than repeating it.`
                : 'This play hasn’t been recovering the metric across tracked attempts — switching levers rather than repeating it.'}
            </p>
            {escalation.bumped && (
              <div className="flex items-center gap-1.5 mt-1.5 text-[10px] font-semibold text-orange-700">
                <span className="uppercase tracking-wider text-orange-400">Urgency raised</span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <span className="text-orange-500/80">{urgencyMeta(escalation.fromUrgency).label}</span>
                  <span className="text-orange-400">→</span>
                  <span className="font-bold text-orange-700">{urgencyMeta(escalation.toUrgency).label}</span>
                </span>
              </div>
            )}
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

/* ── Daily pulse — the INTRA-WEEK early-warning roster ─────────────────────────
   The only panel here that doesn't wait for an ISO week to close. Every weekly synthesis
   (triage, trajectory, pacing, systemic) is blind between Mondays; this reads each client's
   trailing-7-day LEVEL on the ATOMIC DAILY facts and flags the moment a flow metric (revenue /
   leads / jobs / spend) slides out of that client's OWN recent band — a Tuesday collapse, or a
   runaway spend spike, surfaced days before the Monday recap names it. The engine
   (getPortfolioPulse) already ranks the roster worst-first (adverse before tailwind, then by
   how far out of band) and bakes each row its own agency-toned `message`; this just paints it
   in the family chrome. Computed live off the daily grain — no migration, no nightly sweep, no
   thresholds touched by hand. STRICTLY AGENCY-ONLY: a row names another client, the same
   cross-tenant boundary triage / systemic / trajectory / pacing respect — a client sees only
   its OWN pulse, folded into its dashboard payload. Hides whole until one client × metric fires. */
const PULSE_SHOWN = 6   // cap the rows so a moving book stays a glance

// adverse + severity → chip. A flagged metric moving the WRONG way reads as an alarm (critical =
// rose, the strongest call; warning = amber); a metric moving the client's WAY is a 'Tailwind'
// (emerald) — surfaced too, because "lean into what's suddenly working" is as actionable
// intra-week as "catch what's breaking," just ranked last by the engine's adverse-first order.
const PULSE_TONE = {
  critical: { chip: 'bg-rose-50 text-rose-600 border-rose-200',         text: 'text-rose-600',    dot: 'bg-rose-500',    accent: '#f43f5e', label: 'Critical' },
  warning:  { chip: 'bg-amber-50 text-amber-600 border-amber-200',      text: 'text-amber-600',   dot: 'bg-amber-500',   accent: '#f59e0b', label: 'Warning'  },
  good:     { chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', text: 'text-emerald-600', dot: 'bg-emerald-500', accent: '#10b981', label: 'Tailwind' },
}
function pulseTone(r) {
  if (!r?.adverse) return PULSE_TONE.good
  return r.severity === 'critical' ? PULSE_TONE.critical : PULSE_TONE.warning
}

/* The CONFIDENCE chip that rides alongside the SEVERITY chip — the pulse's own
   learned track record for this client × metric (lib/pulseReliability, attached by
   getClientPulse). It answers a different question than severity: not "how bad" but
   "how often has this alarm actually held up for THIS client" — so a Critical+Reliable
   row means act now, a Critical+Noisy row means watch without over-reacting. Given its
   own shield-family treatment (reliable = trust green, mixed/noisy = muted slate) so it
   never competes with the rose/amber severity fill. Keyed by the engine's reliability
   label; absent (un-graded, too thin a record) → no chip at all. */
const RELIABILITY_TONE = {
  reliable: { chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', Icon: ShieldCheck, label: 'Reliable' },
  mixed:    { chip: 'bg-slate-50 text-slate-500 border-slate-200',       Icon: Gauge,       label: 'Mixed'    },
  noisy:    { chip: 'bg-slate-100 text-slate-400 border-slate-200',      Icon: ShieldAlert, label: 'Noisy'    },
}

/* The third, FORESIGHT axis riding beside severity and reliability — the pulse's own
   PREDICTIVE-PRECISION self-audit (lib/pulseAccuracy, attached by getClientPulse): of all
   the times this client × metric's early warning fired N days before an ISO week closed,
   how often did that week actually close adverse, and how far ahead did the call land. It
   answers neither "how bad" (severity) nor "how often does this alarm hold up" (reliability)
   but "when this sensor calls a week early, does the week prove it right." Given a target/
   crosshair family in violet so it reads as a track record of the EARLY call and never
   competes with the shield-family reliability chip or the rose/amber severity fill. Keyed by
   the engine's accuracy label; absent (too thin a history to grade) → no chip at all. */
const ACCURACY_TONE = {
  proven:     { chip: 'bg-violet-50 text-violet-600 border-violet-200',  Icon: Target,    label: 'Proven'     },
  developing: { chip: 'bg-violet-50/60 text-violet-500 border-violet-100', Icon: Crosshair, label: 'Developing' },
  learning:   { chip: 'bg-slate-50 text-slate-400 border-slate-200',     Icon: Radar,     label: 'Learning'   },
}

/* The FOURTH, SELF-TUNING axis — the only chip that reports an action the system took ON
   ITSELF, not just a grade it assigned. lib/pulseTuning reads pulseAccuracy's precision and,
   where the early call has earned it, moves THIS client × metric's live trigger band: a proven
   sensor trips on LESS movement ('Sharper' — buys an earlier head-start where the false-alarm
   cost is low because precision is high), a mixed one needs MORE before it speaks ('Calmer' —
   spends less of the client's attention on noise). It answers none of the other three questions
   — not "how bad" (severity), not "how often does it hold up" (reliability), not "did the early
   call prove out" (accuracy) — but "given all that, how has the sensor RECALIBRATED itself."
   Given a teal slider family so it reads as a dial the system turned, distinct from the violet
   foresight, the emerald/slate shield, and the rose/amber severity. Keyed by the engine's tuning
   direction; absent (no earned adjustment → the canonical band, unchanged) → no chip at all. The
   precision that drives it is always measured at the canonical band, so the loop can't chase its
   own tail. Hover for the grounded one-sentence reason. Agency-only — never surfaced to a client. */
const TUNING_TONE = {
  sensitize: { chip: 'bg-teal-50 text-teal-600 border-teal-200',    Icon: SlidersHorizontal, label: 'Sharper' },
  tighten:   { chip: 'bg-teal-50/60 text-teal-500 border-teal-100', Icon: SlidersHorizontal, label: 'Calmer'  },
}

function PulsePanel({ data }) {
  const roster = Array.isArray(data?.roster) ? data.roster : []
  if (roster.length === 0) return null              // nobody moving → degrade to no panel
  const shown   = roster.slice(0, PULSE_SHOWN)
  const hidden  = roster.length - shown.length
  const adverse = roster.filter(r => r?.adverse).length
  const asOf    = data?.as_of

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-sky-50 flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-sky-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Daily pulse</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {adverse > 0
            ? `${adverse} client${adverse === 1 ? '' : 's'} off their usual week`
            : `${roster.length} moving this week`}
        </span>
        {asOf && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
            <Clock className="w-3 h-3" /> trailing 7 days · through {asOf}
          </span>
        )}
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((r) => <PulseRow key={`${r.client_id}:${r.metric}`} r={r} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more moving this week</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-sky-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The weekly engine only speaks once an ISO week closes; this watches each client's
          <span className="font-bold text-sky-600"> trailing-7-day level every day</span> and flags the moment it
          slides out of that client's own recent band — a Tuesday collapse, or a runaway spend, days before the Monday
          recap. Computed live off the daily numbers, ranked worst-first. Agency-only — a client sees only its own pulse.
        </p>
      </div>
    </div>
  )
}

/* One client × one flow metric whose trailing week has broken out of that client's OWN recent
   band. The left rail and the headline read in the tone of the move — rose/amber when it's
   adverse (a leads collapse, a spend spike), emerald when it's a tailwind (a surge, or spend
   easing). The walk is the whole story in numbers: {this past week} vs {≈usual}, over the
   N-week base the engine measured against; the right rail is the swing off that usual week. */
function PulseRow({ r }) {
  const tone  = pulseTone(r)
  const Dir   = directionIcon(r.direction)
  const delta = Math.round(Number(r.delta_pct))
  const deltaStr = Number.isFinite(delta) ? `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%` : null
  const baseN = Number(r.baseline?.n)
  // The pulse's own learned confidence for this client × metric (lib/pulseReliability,
  // attached by getClientPulse). null when the record was too thin to grade → no chip.
  const rel   = RELIABILITY_TONE[r.reliability_label] || null
  // The pulse's own predictive-precision track record (lib/pulseAccuracy) — how often the
  // early call proved out by week-close. Same null-safe contract: absent until gradeable.
  const acc   = ACCURACY_TONE[r.accuracy_label] || null
  // The pulse's own SELF-TUNING action (lib/pulseTuning) — where that precision has earned it,
  // this client × metric's live trigger band has actually MOVED. Keyed by direction; null when
  // nothing was earned (canonical band, unchanged) → no chip. The one axis that's an act, not a grade.
  const tun   = (r.tuning && TUNING_TONE[r.tuning.direction]) || null

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border', tone.chip)}>
          <Dir className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{r.client_name || 'Unknown'}</span>
            <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
              {r.label || metricLabel(r.metric)}
            </span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', tone.chip)}>
              {tone.label}
            </span>
            {/* CONFIDENCE rides beside SEVERITY: how often this client's pulse on this
                metric has actually held up — the "act now" vs "watch, don't over-react"
                read. Hover for the grounded count. Silent until there's a track record. */}
            {rel && (
              <span
                title={r.reliability_note || undefined}
                className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', rel.chip)}
              >
                <rel.Icon className="w-2.5 h-2.5" />
                {rel.label}
              </span>
            )}
            {/* FORESIGHT rides beside both: how often this early call has actually proven
                out by week-close, and how far ahead. Hover for the grounded precision +
                lead-days. Silent until there's enough graded history. */}
            {acc && (
              <span
                title={r.accuracy_note || undefined}
                className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', acc.chip)}
              >
                <acc.Icon className="w-2.5 h-2.5" />
                {acc.label}
              </span>
            )}
            {/* SELF-TUNING rides last — the one chip that reports an ACT, not a grade: where
                the foresight has earned it, the live trigger has actually MOVED. Sharper (trips
                on less movement) or Calmer (needs more before it speaks). Hover for the grounded
                reason. Silent until an adjustment is earned (canonical band → no chip). */}
            {tun && (
              <span
                title={r.tuning_note || undefined}
                className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', tun.chip)}
              >
                <tun.Icon className="w-2.5 h-2.5" />
                {tun.label}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span className={cn('tabular-nums font-bold', tone.text)}>{fmtMetricValue(r.metric, r.latest)}</span>
            <span className="text-slate-300">this past week · usual ≈</span>
            <span className="tabular-nums font-bold text-slate-600">{fmtMetricValue(r.metric, r.baseline?.median)}</span>
            {Number.isFinite(baseN) && baseN > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="tabular-nums">{baseN}-wk base</span>
              </>
            )}
          </div>

          {/* The "why" — only present when the engine decomposed a composite move
              (revenue ≡ spend × roas, jobs ≡ leads × close_rate); inert otherwise. */}
          <DriverBreakdown message={r.diagnosis_message} diagnosis={r.diagnosis} tone={tone} audience="agency" />
        </div>

        <div className="shrink-0 text-right w-24">
          {deltaStr != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', tone.text)}>{deltaStr}</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">vs usual week</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Act today — the DECISION strip on top of the daily pulse ───────────────────
   The pulse roster below ranks worst-first by RAW severity (adverse, then |z|). This
   re-ranks the SAME adverse signals by severity × the pulse's own LEARNED reliability
   for each client × metric (lib/pulseTriage.rankPulseSignals, adverseOnly), so a Warning
   the sensor has been right about repeatedly can outrank a Critical it keeps crying wolf
   on. Each row carries an action LANE (act now / verify / worth a look / monitor) — the
   cross of how-bad × how-sure — and a 1-based priority_rank. It's the "what do I touch
   first this morning" list, not the full read: adverse-only and capped. Agency-only, the
   same cross-tenant boundary as the rest of the page. Hidden until one signal fires.
   Self-improving: as more alarms mature, the reliability term re-weights the order on its
   own — no thresholds, no model, the same numbers dayPulse + pulseReliability produced. */
const ACT_TODAY_SHOWN = 5

// The action lane → chrome. A clean heat gradient that doubles as the decision: act_now
// (rose, strongest) → verify (amber, "critical but unproven — confirm") → worth_a_look
// (sky, "slipping and the alarm has held") → monitor (slate, "slipping but the alarm
// flickers"). The numbered rank badge carries the same fill, so ORDER and DECISION read
// in one glance. Lane is the cross of severity × learned reliability, computed by the engine.
const LANE_TONE = {
  act_now:      { badge: 'bg-rose-500 text-white',  chip: 'bg-rose-50 text-rose-600 border-rose-200',    text: 'text-rose-600',  Icon: AlertTriangle, label: 'Act now' },
  verify:       { badge: 'bg-amber-500 text-white', chip: 'bg-amber-50 text-amber-600 border-amber-200', text: 'text-amber-600', Icon: Crosshair,     label: 'Verify' },
  worth_a_look: { badge: 'bg-sky-500 text-white',   chip: 'bg-sky-50 text-sky-600 border-sky-200',       text: 'text-sky-600',   Icon: Eye,           label: 'Worth a look' },
  monitor:      { badge: 'bg-slate-400 text-white', chip: 'bg-slate-50 text-slate-500 border-slate-200', text: 'text-slate-500', Icon: Radar,         label: 'Monitor' },
}
function laneTone(r) { return LANE_TONE[r?.lane] || LANE_TONE.monitor }

function ActTodayStrip({ data }) {
  const feed = Array.isArray(data?.act_today) ? data.act_today : []
  if (feed.length === 0) return null                 // nothing adverse → degrade to no strip
  const shown  = feed.slice(0, ACT_TODAY_SHOWN)
  const hidden = feed.length - shown.length
  const urgent = feed.filter(r => r?.lane === 'act_now').length

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50 bg-indigo-50/30">
        <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Crosshair className="w-4 h-4 text-indigo-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Act today</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {urgent > 0
            ? `${urgent} need${urgent === 1 ? 's' : ''} action now · ${feed.length} ranked`
            : `${feed.length} ranked by severity × reliability`}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
          <Sparkles className="w-3 h-3" /> reliability-weighted
        </span>
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((r) => <ActTodayRow key={`${r.client_id}:${r.metric}`} r={r} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more ranked below in the full pulse</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-indigo-50/20 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The same adverse signals as the pulse below, re-ranked by
          <span className="font-bold text-indigo-600"> how bad × how sure</span> — each alarm's severity crossed with the
          pulse's own learned track record for that client × metric. A Warning we've been right about can outrank a Critical
          that keeps crying wolf, so your first hour lands where the evidence says it should. Sharpens as more alarms mature.
        </p>
      </div>
    </div>
  )
}

/* One ranked decision: the lane-tinted rank badge (order + call in one glance), the client
   and metric, the action LANE chip, and — the reason this row is where it is — the learned
   CONFIDENCE chip (why a Critical may sit in 'verify', or a Warning climb above one). The
   grounded one-liner is the engine's own agency-toned narration of the lane. Right rail is
   the swing off the client's usual week, painted in the lane tone. */
function ActTodayRow({ r }) {
  const lane     = laneTone(r)
  const rel      = RELIABILITY_TONE[r.reliability_label] || null   // null when too thin to grade → no chip
  const acc      = ACCURACY_TONE[r.accuracy_label] || null         // predictive track record; null until gradeable
  const tun      = (r.tuning && TUNING_TONE[r.tuning.direction]) || null  // self-tuning act; null until earned
  const delta    = Math.round(Number(r.delta_pct))
  const deltaStr = Number.isFinite(delta) ? `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%` : null
  const rank     = Number(r.priority_rank)

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        {/* the rank badge carries the lane color — ORDER and DECISION in one glance */}
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 text-xs font-black tabular-nums', lane.badge)}>
          {Number.isFinite(rank) ? rank : '·'}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{r.client_name || 'Unknown'}</span>
            <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
              {r.label || metricLabel(r.metric)}
            </span>
            <span className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', lane.chip)}>
              <lane.Icon className="w-2.5 h-2.5" />
              {lane.label}
            </span>
            {/* the CONFIDENCE that drove this rank — the cross made visible. Hover for the count. */}
            {rel && (
              <span
                title={r.reliability_note || undefined}
                className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', rel.chip)}
              >
                <rel.Icon className="w-2.5 h-2.5" />
                {rel.label}
              </span>
            )}
            {/* the FORESIGHT behind the reliability: has this early call actually proven out
                by week-close, and how far ahead. Hover for precision + lead-days. */}
            {acc && (
              <span
                title={r.accuracy_note || undefined}
                className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', acc.chip)}
              >
                <acc.Icon className="w-2.5 h-2.5" />
                {acc.label}
              </span>
            )}
            {/* the SELF-TUNING act that foresight earned: this row's live trigger has actually
                moved — Sharper or Calmer. Hover for the grounded reason. Silent until earned. */}
            {tun && (
              <span
                title={r.tuning_note || undefined}
                className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', tun.chip)}
              >
                <tun.Icon className="w-2.5 h-2.5" />
                {tun.label}
              </span>
            )}
          </div>

          {/* the grounded one-liner: the lane, explained in the engine's own words */}
          {r.triage_reason && (
            <p className="mt-1.5 text-[11px] font-semibold text-slate-500 leading-relaxed">{r.triage_reason}</p>
          )}
        </div>

        <div className="shrink-0 text-right w-20">
          {deltaStr != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', lane.text)}>{deltaStr}</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">vs usual</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── early-warning trajectory — the PREDICTIVE roster ──────────────────────────
   Triage ranks who is worst TODAY; this ranks who is still inside a safe band but, by
   the slope of their OWN recent health scores, projected to slide THROUGH a band floor
   within the horizon — "will churn unless you act this week," not "churned." The forward-
   looking companion to the triage roster: read the page top-to-bottom and it goes "look
   here now" (triage) → "and here next" (this). Each verdict is a Holt projection over one
   client's score history alone (lib/trajectory.js) with a calibrated band, but the RANKED
   roster names other clients and is therefore STRICTLY AGENCY-ONLY — the same cross-tenant
   boundary triage and systemic respect; it never rides a per-client or shared-link payload.
   Self-calibrating and operator-free: the series IS the per-sweep health history, the floors
   ARE health.js's own band cutoffs, and every nightly sweep appends one more point — the
   projections sharpen on their own as history deepens, no thresholds touched by hand. Hides
   whole when nobody is sliding. */
const TRAJECTORY_SHOWN = 6   // cap the rows so a sliding book stays a glance

// crossing strength → chip. 'likely' = the central forecast itself falls through the floor
// within the horizon (the stronger call, rose); 'possible' = only the pessimistic edge of
// the prediction band reaches it (a softer maybe, amber). Mirrors trajectory.js's two kinds.
const CROSSING_KIND = {
  likely:   { label: 'Likely',   cls: 'bg-rose-50 text-rose-600 border-rose-200' },
  possible: { label: 'Possible', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
}

function TrajectoryPanel({ data }) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings : []
  if (warnings.length === 0) return null            // nobody sliding → degrade to no panel
  const shown  = warnings.slice(0, TRAJECTORY_SHOWN)
  const hidden = warnings.length - shown.length

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
          <TrendingDown className="w-4 h-4 text-amber-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Heading for trouble</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {warnings.length} client{warnings.length === 1 ? '' : 's'} projected to slide
        </span>
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((w) => <TrajectoryRow key={w.client_id} w={w} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more sliding client{hidden === 1 ? '' : 's'}</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-amber-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          A client lands here while still inside a safe band when the slope of its own recent health scores projects it
          <span className="font-bold text-amber-600"> through the floor within the horizon</span> — runway to act before it
          crosses, not after. Self-calibrating: the floors are the engine's own band cutoffs and every nightly sweep
          sharpens the projection. Agency-only — clients never see the cross-account roster.
        </p>
      </div>
    </div>
  )
}

/* One sliding client: where its health sits today, the band it's projected to fall INTO,
   how soon, and how sure. The left rail and the projected score read in the DESTINATION
   band's color — the stakes, not the status quo. `current band → destination band` is the
   heart of the row; the kind chip says how strong the call is (likely = the central forecast
   crosses, possible = only the band's pessimistic edge does); the right rail is the runway
   ("~N sweeps to the floor") over a confidence meter the engine WITHHOLDS until it has enough
   history to trust the fit (confidence null → no meter, never a guessed bar). */
function TrajectoryRow({ w }) {
  const cur   = healthBandMeta(w.current_band)
  const dest  = healthBandMeta(w.crossing?.to_band)
  const kind  = CROSSING_KIND[w.crossing?.kind] || CROSSING_KIND.possible
  const conf  = w.confidence == null ? null : Math.max(0, Math.min(100, Math.round(Number(w.confidence) * 100)))
  const curScore  = Math.round(Number(w.current))
  const projScore = Math.round(Number(w.projected))
  const trend = Number(w.trend)
  const cutoff = w.crossing?.cutoff
  // 'likely' carries a central-line ETA; 'possible' only the band's earliest plausible step.
  // crossing always sets eta_worst (it's the gate to even forming a crossing), so this is
  // finite for every warning — the runway headline always renders.
  const etaRaw = w.crossing?.eta != null ? w.crossing.eta : w.crossing?.eta_worst
  const etaN   = Number.isFinite(Number(etaRaw)) ? Number(etaRaw) : null

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border', dest.chip)}>
          <TrendingDown className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{w.client_name || 'Unknown'}</span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', cur.chip)}>
              {cur.label}
            </span>
            <span className="text-slate-300 text-xs font-black leading-none">→</span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', dest.chip)}>
              {dest.label}
            </span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', kind.cls)}>
              {kind.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span>Health <span className="tabular-nums font-bold text-slate-600">{curScore}</span></span>
            <span className="text-slate-300">→</span>
            <span className={cn('tabular-nums font-bold', dest.text)}>{projScore}</span>
            {Number.isFinite(trend) && (
              <>
                <span className="text-slate-300">·</span>
                <span className="tabular-nums">{trend > 0 ? '+' : ''}{trend}/sweep</span>
              </>
            )}
            {Number.isFinite(Number(cutoff)) && (
              <>
                <span className="text-slate-300">·</span>
                <span>floor {cutoff}</span>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right w-24">
          {etaN != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', dest.text)}>~{etaN}</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">sweep{etaN === 1 ? '' : 's'} to floor</div>
            </>
          )}
          {conf != null && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className={cn('h-full rounded-full', dest.dot)} style={{ width: `${conf}%` }} />
              </div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5 tabular-nums">{conf}% confidence</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Goal pacing (agency roster) ─────────────────────────────────────────────
   Forward-looking like trajectory, but anchored to the human-set monthly GOAL rather than the
   slope of health. Only the off-pace verdicts reach here (engine's rankPacing keeps behind /
   at_risk, worst-first), so the panel is the agency's "who will miss their number this month,
   and how hard must they push to still hit it" — runway to act before the month closes. */
const PACE_SHOWN = 6   // cap the rows so an off-pace book stays a glance

// pacing status → chip + accent. Only at_risk / behind ever reach the roster (rankPacing drops
// ahead / on_track / early), but the map is total so an unexpected status still renders a sane
// neutral row rather than crashing. at_risk = the run-rate misses the goal outright (rose, the
// sharper alarm); behind = tracking under pace but still reachable (amber). Mirrors pacing.js.
const PACE_STATUS_META = {
  at_risk: { label: 'At risk', chip: 'bg-rose-50 text-rose-600 border-rose-200',   text: 'text-rose-600',  dot: 'bg-rose-500' },
  behind:  { label: 'Behind',  chip: 'bg-amber-50 text-amber-600 border-amber-200', text: 'text-amber-600', dot: 'bg-amber-500' },
  none:    { label: 'No goal', chip: 'bg-slate-50 text-slate-500 border-slate-200', text: 'text-slate-500', dot: 'bg-slate-400' },
}
const paceStatusMeta = (s) => PACE_STATUS_META[s] || PACE_STATUS_META.none

const PACE_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// 'YYYY-MM-01' → 'July 2026'. String-sliced, never `new Date('YYYY-MM-01')` (that parses as UTC
// midnight and renders the prior month in negative-offset zones — the same trap the engine avoids).
function fmtMonthLabel(monthFirst) {
  if (typeof monthFirst !== 'string') return null
  const m = monthFirst.match(/^(\d{4})-(\d{2})/)
  if (!m) return null
  const name = PACE_MONTH_NAMES[Number(m[2]) - 1]
  return name ? `${name} ${m[1]}` : null
}
// catchup multiplier → "4.2×" / "2×". The engine already rounds to 2 dp; show 1 dp and drop a
// trailing .0 so the "push this much harder" headline reads clean. null when there's no catchup
// (already at/over pace, which can't reach this roster anyway) → caller hides the clause.
function fmtCatchup(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  const r = Math.round(v * 10) / 10
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '×'
}

function PacingPanel({ data }) {
  const roster = Array.isArray(data?.roster) ? data.roster : []
  if (roster.length === 0) return null               // nobody off pace → degrade to no panel
  const shown   = roster.slice(0, PACE_SHOWN)
  const hidden  = roster.length - shown.length
  const monthLabel = fmtMonthLabel(data?.month)
  const daysLeft   = Number(data?.days_in_month) - Number(data?.days_elapsed)
  const runway = Number.isFinite(daysLeft) && daysLeft >= 0 ? ` · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : ''

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-rose-50 flex items-center justify-center shrink-0">
          <Target className="w-4 h-4 text-rose-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Off goal pace</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {roster.length} goal{roster.length === 1 ? '' : 's'} projected to miss{monthLabel ? ` · ${monthLabel}` : ''}{runway}
        </span>
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((r) => <PacingRow key={`${r.client_id}:${r.metric}`} r={r} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more off-pace goal{hidden === 1 ? '' : 's'}</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-rose-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          A goal lands here when its month-to-date actual, projected to month-end at the
          <span className="font-bold text-rose-600"> current run-rate</span>, falls short of the target — ranked by how
          far. The multiplier is how much harder the remaining days must run to still hit it. Early in the month the
          engine withholds the call until enough of it has elapsed to trust. Agency-only — clients never see the
          cross-account roster, only their own pace.
        </p>
      </div>
    </div>
  )
}

/* One off-pace goal: whose, which metric, how far behind, and the push needed to recover. The
   left rail + projected value read in the status color (the stakes); the metric line walks
   actual-so-far → projected → target so the gap is legible at a glance, with the catchup
   multiplier as the call to action; the right rail is the headline "% of goal pace" over a
   confidence meter that fills with how much of the month has elapsed (more month = surer call). */
function PacingRow({ r }) {
  const meta    = paceStatusMeta(r.status)
  const pct     = Number.isFinite(Number(r.attainment)) ? Math.round(Number(r.attainment) * 100) : null
  const conf    = r.confidence == null ? null : Math.max(0, Math.min(100, Math.round(Number(r.confidence) * 100)))
  const catchup = fmtCatchup(r.catchup)

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border', meta.chip)}>
          <Target className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{r.client_name || 'Unknown'}</span>
            <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
              {metricLabel(r.metric)}
            </span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', meta.chip)}>
              {meta.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span className="tabular-nums font-bold text-slate-600">{fmtMetricValue(r.metric, r.actual)}</span>
            <span className="text-slate-300">so far →</span>
            <span className={cn('tabular-nums font-bold', meta.text)}>{fmtMetricValue(r.metric, r.projected)}</span>
            <span className="text-slate-300">proj. vs</span>
            <span className="tabular-nums font-bold text-slate-600">{fmtMetricValue(r.metric, r.target)} goal</span>
            {catchup && (
              <>
                <span className="text-slate-300">·</span>
                <span>needs <span className="tabular-nums font-bold text-slate-600">{catchup}</span> the pace</span>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right w-24">
          {pct != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', meta.text)}>{pct}%</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">of goal pace</div>
            </>
          )}
          {conf != null && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className={cn('h-full rounded-full', meta.dot)} style={{ width: `${conf}%` }} />
              </div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5 tabular-nums">month {conf}% in</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Playbook efficacy (agency, pooled + anonymous) ──────────────────────────
   The self-improving grain made visible: does the action the engine RECOMMENDS for a kind of
   problem actually fix it? efficacyTable pools every decided, recoverable finding across the
   whole book per play archetype (kind::metric) and reports the measured recovery rate — shrunk
   toward the pooled base rate so a thin sample can't boast — ranked by a Wilson 95% lower bound
   (a deep 9/10 beats a lucky 1/1), plus the median days to recover. Best-first: a leaderboard of
   the system's OWN advice — the row that earns its place on top, the play to reconsider at the
   bottom. Pooled + anonymous — a rate names no client — so it's agency-only without exposing any
   account; the loop that turns "we recommend this" into "this is what works." */
const EFF_SHOWN = 8   // cap so a mature playbook stays a glance; the rest collapse into a footer count

// band → chip + accent. high = the play reliably clears the problem (emerald); medium = works
// often enough to keep (amber); low = rarely clears it, a candidate to rethink (rose). Mirrors
// efficacy.bandOf (EFF_HIGH .66 / EFF_LOW .40); total map so an odd value still renders neutral.
const EFF_BAND_META = {
  high:   { label: 'Reliable', chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', text: 'text-emerald-600', dot: 'bg-emerald-500' },
  medium: { label: 'Mixed',    chip: 'bg-amber-50 text-amber-600 border-amber-200',       text: 'text-amber-600',   dot: 'bg-amber-500' },
  low:    { label: 'Weak',     chip: 'bg-rose-50 text-rose-600 border-rose-200',          text: 'text-rose-600',    dot: 'bg-rose-500' },
}
const effBandMeta = (b) => EFF_BAND_META[b] || EFF_BAND_META.medium

// median recovery days → "usually within 2 days" / "within a day". null (no successes timed) →
// caller drops the clause rather than print a hollow "within null days". round3 applied server-side.
function fmtRecoverDays(d) {
  const v = Number(d)
  if (!Number.isFinite(v) || v < 0) return null
  if (v < 1) return 'within a day'
  const r = Math.round(v * 10) / 10
  return `within ${Number.isInteger(r) ? r : r.toFixed(1)} day${r === 1 ? '' : 's'}`
}

function EfficacyPanel({ data }) {
  const plays = Array.isArray(data?.plays) ? data.plays : []
  if (plays.length === 0) return null               // no play has earned enough evidence → no panel
  const shown    = plays.slice(0, EFF_SHOWN)
  const hidden   = plays.length - shown.length
  const baseN    = Number(data?.base?.n)
  const baseRate = data?.base?.rate == null ? null : Math.round(Number(data.base.rate) * 100)
  const sub = Number.isFinite(baseN) && baseN > 0
    ? `${plays.length} play${plays.length === 1 ? '' : 's'} learned from ${baseN} decided outcome${baseN === 1 ? '' : 's'}${baseRate != null ? ` · ${baseRate}% clear overall` : ''}`
    : `${plays.length} play${plays.length === 1 ? '' : 's'}`

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-violet-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Playbook efficacy</h2>
        <span className="text-[11px] font-semibold text-slate-400">{sub}</span>
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((p) => <EfficacyRow key={p.play} p={p} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more play{hidden === 1 ? '' : 's'}</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-violet-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Each row is a recommended action measured against what happened next: the share of decided,
          recoverable findings it <span className="font-bold text-violet-600">actually cleared</span>, shrunk toward the
          book-wide base rate so a thin sample can't boast, and ranked by a 95% lower bound — a deep record
          outranks a lucky streak. The meter shows how much the estimate has earned over the prior. Pooled and
          anonymous — the system grading its own advice so the next recommendation is the one that works.
        </p>
      </div>
    </div>
  )
}

/* One play archetype: the problem it answers (kind + metric), how reliably it has cleared that
   problem, and how fast. Left rail in the band color (the verdict); the middle reads "cleared X
   of N · usually within Md · ≥ F% floor"; the right rail is the headline clear-rate % over a
   credibility meter that fills with how much the estimate has earned over the prior (more
   evidence = surer call). Mirrors PacingRow so the agency boards read as one family. */
function EfficacyRow({ p }) {
  const meta  = effBandMeta(p.band)
  const km    = kindMeta(p.kind); const KIcon = km.icon || Sparkles
  const pct   = Number.isFinite(Number(p.efficacy)) ? Math.round(Number(p.efficacy) * 100) : null
  const floor = Number.isFinite(Number(p.lower)) ? Math.round(Number(p.lower) * 100) : null
  const cred  = p.credibility == null ? null : Math.max(0, Math.min(100, Math.round(Number(p.credibility) * 100)))
  const days  = fmtRecoverDays(p.median_days)
  const hasMetric = p.metric != null && p.metric !== '*'

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border', meta.chip)}>
          <KIcon className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800">{km.label}</span>
            {hasMetric && (
              <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
                {metricLabel(p.metric)}
              </span>
            )}
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', meta.chip)}>
              {meta.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span>cleared</span>
            <span className={cn('tabular-nums font-bold', meta.text)}>{p.successes} of {p.n}</span>
            {days && (
              <>
                <span className="text-slate-300">·</span>
                <span>usually <span className="font-bold text-slate-600">{days}</span></span>
              </>
            )}
            {floor != null && (
              <>
                <span className="text-slate-300">·</span>
                <span title="95% lower confidence bound — the proven floor the ranking trusts">≥ <span className="tabular-nums font-bold text-slate-600">{floor}%</span> floor</span>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right w-24">
          {pct != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', meta.text)}>{pct}%</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">clear rate</div>
            </>
          )}
          {cred != null && (
            <div className="mt-2" title={`Credibility — how much this estimate has earned over the prior (n=${p.n})`}>
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className={cn('h-full rounded-full', meta.dot)} style={{ width: `${cred}%` }} />
              </div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5 tabular-nums">{cred}% earned</div>
            </div>
          )}
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
