import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Brain, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Check, Eye,
  Clock, CheckCircle2, Inbox, Plug, ChevronDown, ChevronUp, Target, SlidersHorizontal,
  Crosshair, BarChart3, Scale, Award, TrendingDown, Radar, Users, Sparkles, ArrowUpCircle, Activity,
  Gauge, ShieldAlert, AlertOctagon, Wrench, Minus, Scissors, Stethoscope,
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

      {/* morning brief — the spoken capstone, read this first. The DAILY, portfolio-wide
          plain-English narration of the whole book (GET /api/ai/brief), grounded against
          the same daily pulse every panel below is scored from. Self-fetching with its own
          load/error/done; gated on USE_API so it stays absent in the demo (like every other
          agency read here), and degrades to a calm template when no AI key is configured. */}
      {USE_API && <MorningBriefPanel />}

      {/* narration reliability — the morning brief grading its OWN history: how often the
          analyst actually wrote in its own words vs fell back to the safe template (GET
          /api/ai/brief-health, agency-only). Kept orthogonal to the grounded-trust chip —
          "is it still writing?" ≠ "are the numbers still verified?". USE_API-gated like the
          brief above; sits right under it because it's that capstone's self-audit. */}
      {USE_API && <BriefHealthPanel />}

      {/* editorial precision — the THIRD self-audit of the morning brief, and the sharpest:
          not "did we write it" (reliability, above) but "did the call we LED with hold up?"
          Reads GET /api/ai/brief-impact (agency-only) — it replays the same verified day-pulse
          over the mornings that FOLLOWED each shipped lead and grades earned/fair/overcalled.
          A disjoint third vocabulary so it never blurs with narration coverage; USE_API-gated,
          sits under its sibling because the three together are the brief grading its own front page. */}
      {USE_API && <BriefImpactPanel />}

      {/* learned lead policy — the TUNE half of editorial precision (13c). brief-impact above
          MEASURES whether the call we led with held up; this reads GET /api/ai/lead-policy
          (agency-only) and folds that very grade into the bounded per-lane weight the morning
          brief applies when it ranks candidates for the one lead — promote a lane that keeps
          earning the front page, ease one that keeps overcalling, with act_now safety-floored so
          a real emergency is never buried. Sits under its MEASURE sibling so the loop reads as
          one: grade the front page, then quietly rewrite the front-page priorities. USE_API-gated. */}
      {USE_API && <LeadPolicyPanel />}

      {/* lead-policy STABILITY — "watch the watcher". The panel above tunes itself each morning;
          this one reads GET /api/ai/lead-policy-health (agency-only) and judges whether that loop
          is trustworthy right now — a lane oscillating on noise, pinned to its band, or a real
          overcall the safety floor is masking. Oscillation self-reverts to neutral; the rest are
          surfaced for a human. Sits directly under the loop it audits. USE_API-gated. */}
      {USE_API && <LeadPolicyHealthPanel />}

      {/* lead-policy GOVERNANCE — "the governor" (15c). The stability panel above DIAGNOSES the
          tuning loop; this reads GET /api/ai/lead-policy-governance (agency-only) and shows what the
          loop DID about it — the surgeon that consumed the verdict and reset only the thrashing lane
          while keeping every earned one live. Closes the operator gate layer 14 left open: no human
          reads a chip and decides — the safe corrective applies itself, snapshot-backed and
          reversible. Sits directly under the monitor whose verdict it acts on. USE_API-gated. */}
      {USE_API && <LeadPolicyGovernancePanel />}

      {/* lead-policy governance AUDIT — "the auditor" (16c). The governor above ACTS every morning;
          this reads GET /api/ai/lead-policy-governance-audit (agency-only) and grades the GOVERNOR
          across mornings — does its safe corrective actually STICK? When the learner keeps re-
          oscillating a lane the governor keeps neutralising, the fix never reaches the root cause, so
          this escalates that lane to a human instead of letting the loop churn forever. Closes the
          LEARN/ADJUST half of the loop the governor opened: the controller that watches its own track
          record. Recommends, never acts. Sits directly under the governor it audits. USE_API-gated. */}
      {USE_API && <LeadPolicyGovernanceAuditPanel />}

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

      {/* morning briefing — intel-v7's SYNTHESIS capstone, sitting first because it SUBTRACTS:
          one posture word, one grounded headline (the top of the same ranked feed below, by
          construction), and a confidence read on the day's call. Every other pulse panel adds
          detail; this collapses it to "the one thing." Reads quiet books calmly too. Agency-only.
          Shown whenever the pulse loaded — the affirmative "you're clear" is itself a signal. */}
      {pulse?.briefing && <PulseBriefingBanner data={pulse} />}

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

/* ── morning brief — the agency's DAILY plain-English read of the whole book ────
   The daily, portfolio-wide analog of the weekly recap below: where WeeklyRecapPanel
   narrates one client's closed week, this narrates every client's TODAY off the same
   daily-pulse evidence the briefing banner + roster lower on the page are scored from.
   It reads GET /api/ai/brief (agency-only — the prose names peers): a grounded,
   verifier-checked "good morning, here's where the book stands," generated-on-miss and
   cheap on repeat hits. Degrades to a deterministic template when no API key is set, and
   reads a quiet book calmly ("all steady this morning"), so there's no empty/missing-key
   state — only load / error / done. Self-fetching so the page stays a clean set of
   independent reads; a "Regenerate" forces a fresh narration + re-verify in place.
   Grounded means every number in the prose traced back to that same verified pulse pack.
   Sits at the very top because it's the spoken capstone — read this, then read the page. */
function MorningBriefPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [brief, setBrief]   = useState(null)
  const [error, setError]   = useState('')
  const [busy, setBusy]     = useState(false)        // a Regenerate in flight

  const fetchBrief = useCallback(async (regen) => {
    if (regen) { setBusy(true) } else { setStatus('loading'); setError('') }
    try {
      const b = regen ? await api.regeneratePortfolioBrief() : await api.getPortfolioBrief()
      setBrief(b); setStatus('done'); setError('')
    } catch (e) {
      if (regen) setError(e?.message || 'Regenerate failed')
      else { setError(e?.message || 'Could not load the brief'); setStatus('error') }
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { fetchBrief(false) }, [fetchBrief])

  const text       = (brief?.brief_text || '').trim()
  const grounded   = !!brief?.grounded
  const asOf       = brief?.pack?.period?.label || brief?.as_of || ''
  const confidence = brief?.pack?.confidence || null
  const showConf   = status === 'done' && confidence && confidence.label && confidence.label !== 'n/a'

  // "2026-05-18" → "Mon, May 18" for the morning-brief header; raw string on any parse miss.
  const dayLabel = (() => {
    if (!asOf) return ''
    const d = new Date(`${asOf}T00:00:00`)
    if (Number.isNaN(d.getTime())) return asOf
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  })()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Brain className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Good morning — your book today</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The whole portfolio, in plain English{dayLabel ? ` · ${dayLabel}` : ''}
          </p>
        </div>
        {showConf && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-600"
            title={confidence.note || undefined}
          >
            <Gauge className="w-3 h-3" /> {confidence.label} confidence
          </span>
        )}
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
          onClick={() => fetchBrief(true)}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the book…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load the brief'}</p>
            <button
              onClick={() => fetchBrief(false)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            {text ? (
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{text}</p>
            ) : (
              <p className="text-sm text-slate-400 italic">No brief for today yet.</p>
            )}
            {error && (
              <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-rose-500">
                <AlertTriangle className="w-3 h-3" /> {error}
              </p>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Written by the analyst from the same verified daily pulse the rest of this page is scored from.
          {brief?.model ? ` Model ${brief.model}.` : ''}
        </p>
      </div>
    </section>
  )
}

/* ── narration reliability — intel-v7 (10c): the AI grading its OWN brief history ───
   MorningBriefPanel above SPEAKS; this is the panel that says how often it has actually
   been able to. It reads GET /api/ai/brief-health (agency-only — the prose, the model ids,
   and the fallback streak are internal calibration a client must never see) over a PURE
   history audit: listRecentBriefs never regenerates, so reading this can neither mint an
   LLM call nor perturb the history it grades. It reports the ONE honest narration signal —
   coverage, how often the analyst wrote the brief in its own words vs degraded to the safe
   template — and keeps it rigidly ORTHOGONAL to the grounded-trust chip beside it: "is the
   AI still writing?" is a different question from "are the numbers still verified?", and the
   template fallback is grounded-BY-CONSTRUCTION, so the two are never conflated. Quiet
   mornings (a calm book with nothing worth narrating) are template-by-DESIGN and never count
   as misses. Self-fetching, agency-only, USE_API-gated like every other read on this page. */
const BRIEF_HEALTH_TONE = {
  rich:            { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'Writing freely' },
  mixed:           { pill: 'border-sky-200 bg-sky-50 text-sky-700',             dot: 'bg-sky-500',     bar: 'bg-sky-500',     label: 'Mostly its words' },
  'template-only': { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'On the template' },
  quiet:           { pill: 'border-slate-200 bg-slate-50 text-slate-600',       dot: 'bg-slate-400',   bar: 'bg-slate-300',   label: 'Quiet stretch' },
  'no-data':       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   bar: 'bg-slate-200',   label: 'No briefs yet' },
}

// One audience bucket → a compact coverage view for the by-surface split. A null pct means
// nothing in the window was worth narrating — a quiet surface is template-by-design, never a
// miss — so it renders as a calm "Quiet", distinct from a real 0% (everything fell back).
function briefCoverageView(b) {
  if (!b || !b.total) return { state: 'none',  pct: null, narrated: 0, narratable: 0 }
  if (!b.narratable)  return { state: 'quiet', pct: null, narrated: 0, narratable: 0 }
  return { state: 'graded', pct: b.coverage != null ? Math.round(b.coverage * 100) : 0, narrated: b.narrated || 0, narratable: b.narratable }
}

function BriefHealthStat({ label, view }) {
  return (
    <div className="flex-1 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 truncate">{label}</p>
      {view.state === 'none' ? (
        <p className="text-sm font-black text-slate-300 leading-tight">—</p>
      ) : view.state === 'quiet' ? (
        <p className="text-sm font-bold text-slate-400 leading-tight">Quiet</p>
      ) : (
        <p className="text-sm font-black text-slate-800 leading-tight tabular-nums">
          {view.pct}%
          <span className="ml-1 text-[11px] font-semibold text-slate-400">{view.narrated}/{view.narratable}</span>
        </p>
      )}
    </div>
  )
}

/* ── the narrator's own self-check banner (intel-v7 11c) ───────────────────────────
   The panel grades how OFTEN the analyst writes; this banner answers the sharper
   operational question the read endpoint now folds in as `health.delivery`: has narration
   been falling back so persistently that someone should step in? It is the UI face of
   assessBriefDelivery's worst-of-two-stream verdict — amber while the voice is slipping
   (degraded, streak ≥ 2), rose once it has stalled (≥ 3) — carrying the one self-heal step
   to take. Silent BY CONSTRUCTION on a healthy or quiet narrator (delivery.alert === false),
   so a calm book shows nothing here and the alarm never trains anyone to ignore it. Agency-
   only like the whole panel; clients never see it and — because every fallback brief is
   grounded-by-construction — never received a wrong number while the narrator was failing. */
const BRIEF_DELIVERY_TONE = {
  stalled:  { wrap: 'border-rose-200 bg-rose-50',   icon: 'text-rose-500',  kicker: 'text-rose-600',  head: 'text-rose-900',  body: 'text-rose-800/80',  chip: 'border-rose-200 bg-white text-rose-700',  label: 'Narration stalled' },
  degraded: { wrap: 'border-amber-200 bg-amber-50', icon: 'text-amber-500', kicker: 'text-amber-600', head: 'text-amber-900', body: 'text-amber-800/80', chip: 'border-amber-200 bg-white text-amber-700', label: 'Narration degrading' },
}
// The reassurance lib/briefDelivery appends to every alert narrative, restated here so we can
// peel it (and the action) back off the one-line server narrative and lay the three parts out.
const BRIEF_GROUNDED_TAIL = 'Every number stayed grounded throughout.'

function BriefDeliveryBanner({ delivery }) {
  if (!delivery || !delivery.alert) return null
  const t      = BRIEF_DELIVERY_TONE[delivery.status] || BRIEF_DELIVERY_TONE.degraded
  const Icon   = delivery.status === 'stalled' ? AlertOctagon : AlertTriangle
  const action = (delivery.action || '').trim()
  // The server narrative is one line: "<what happened> <self-heal step> <grounded tail>".
  // Peel the two known, deterministic suffixes so the description leads as the headline, the
  // action rides its own chip, and the grounded reassurance gets a quiet footnote — nothing
  // renders twice. If the contract ever drifts, `body` simply keeps the whole sentence.
  let body = (delivery.narrative || '').trim()
  if (body.endsWith(BRIEF_GROUNDED_TAIL)) body = body.slice(0, -BRIEF_GROUNDED_TAIL.length).trim()
  if (action && body.endsWith(action))    body = body.slice(0, -action.length).trim()
  if (!body) body = `The ${delivery.audience === 'agency' ? 'portfolio' : 'client'} morning brief keeps falling back to the safe template.`

  return (
    <div className={cn('mb-4 rounded-xl border px-3.5 py-3', t.wrap)} role="alert">
      <div className="flex items-start gap-2.5">
        <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', t.icon)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[10px] font-black uppercase tracking-wider', t.kicker)}>
            Narrator self-check · {t.label}
          </p>
          <p className={cn('mt-0.5 text-[13px] font-bold leading-snug', t.head)}>{body}</p>
          {action && (
            <div className="mt-2 flex items-start gap-1.5">
              <span className={cn('mt-px inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider shrink-0', t.chip)}>
                <Wrench className="w-2.5 h-2.5" /> Self-heal
              </span>
              <span className={cn('text-[11px] font-medium leading-snug', t.body)}>{action}</span>
            </div>
          )}
          <p className={cn('mt-2 text-[10px] font-medium leading-snug', t.body)}>
            Clients were never affected — their dashboards and digests already fell back to the same safe, fully-grounded template, so every number they saw stayed correct.
          </p>
        </div>
      </div>
    </div>
  )
}

function BriefHealthPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [health, setHealth] = useState(null)
  const [error, setError]   = useState('')

  const fetchHealth = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const h = await api.getBriefHealth()
      setHealth(h); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load narration health'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const o           = health?.overall || null
  const tone        = BRIEF_HEALTH_TONE[o?.health] || BRIEF_HEALTH_TONE['no-data']
  const mode        = !o || o.total === 0 || o.health === 'no-data' ? 'no-data'
                    : o.health === 'quiet' ? 'quiet' : 'graded'
  const coveragePct = o && o.coverage != null ? Math.round(o.coverage * 100) : 0
  const groundedPct = health?.grounded_rate != null ? Math.round(health.grounded_rate * 100) : null
  const streak      = o?.streak_fellback || 0
  const narrative   = (health?.narrative || '').trim()
  const days        = health?.requested?.days || 30
  const win         = health?.window || null
  const models      = o && mode === 'graded'
    ? Object.entries(o.models || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(' · ')
    : ''

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Narration reliability</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            How often the analyst writes the brief itself · last {days} days
          </p>
        </div>
        {status === 'done' && o && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Narration health: ${o.health}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        {status === 'done' && groundedPct != null && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700"
            title="Orthogonal to narration: every brief — even one on the safe template — stays grounded to verified numbers. The trust invariant, not the writing rate."
          >
            <ShieldCheck className="w-3 h-3" /> {groundedPct}% grounded
          </span>
        )}
        <button
          onClick={fetchHealth}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        <BriefDeliveryBanner delivery={health?.delivery} />

        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Grading the brief history…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load narration health'}</p>
            <button
              onClick={fetchHealth}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && mode === 'no-data' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" /> No morning briefs in the last {days} days yet — this fills in as the daily brief runs.
          </div>
        )}

        {status === 'done' && mode !== 'no-data' && (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">
                  {mode === 'quiet' ? '—' : `${coveragePct}%`}
                </span>
                <span className="text-[11px] font-bold text-slate-400">
                  {mode === 'quiet' ? 'nothing to narrate' : 'narrated'}
                </span>
              </div>
              {mode === 'graded' && (
                <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
                  {o.narrated} of {o.narratable} {o.narratable === 1 ? 'brief' : 'briefs'} worth narrating, in its own words
                </p>
              )}
            </div>

            {mode === 'graded' && (
              <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${coveragePct}%` }} />
              </div>
            )}

            {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}

            {mode === 'quiet' && !narrative && (
              <p className="mt-2 text-sm text-slate-400">Nothing needed narrating in this window — a calm book uses the safe template by design.</p>
            )}

            <div className="mt-3 flex items-center gap-4 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2">
              <BriefHealthStat label="Client briefs"   view={briefCoverageView(health?.by_audience?.client)} />
              <span className="w-px self-stretch bg-slate-200" />
              <BriefHealthStat label="Portfolio brief" view={briefCoverageView(health?.by_audience?.agency)} />
            </div>

            {models && (
              <p className="mt-2 text-[10px] font-medium text-slate-400 truncate" title="Which model wrote the narratable briefs (template = deterministic fallback)">
                Writers: {models}
              </p>
            )}

            {/* Legacy raw-streak hint — superseded by the graded <BriefDeliveryBanner> above
                whenever the server sends health.delivery. Kept only as a backward-compatible
                fallback for an older payload, so the two never double up on the same alarm. */}
            {streak >= 2 && !health?.delivery && (
              <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
                <AlertTriangle className="w-3 h-3 shrink-0" /> The last {streak} briefs fell back to the template — the narration model may be unreachable.
              </p>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Two separate questions, never conflated: <span className="font-semibold text-slate-500">coverage</span> is how often the analyst wrote in its own words (vs the safe template);
          {' '}<span className="font-semibold text-emerald-600">grounded</span> is whether every number stayed verified — which holds even when it falls back. Quiet mornings count against neither.
          {win && win.from ? ` Graded over ${o.total} ${o.total === 1 ? 'brief' : 'briefs'}, ${win.from} – ${win.to}.` : ''} Agency-only.
        </p>
      </div>
    </section>
  )
}

/* ── editorial precision — intel-v7 (12c): did the call we LED with hold up? ────────
   The two panels above grade the brief as an ARTIFACT — was it authored in the analyst's
   own words (reliability), did a fresh one land each morning (delivery). This one grades
   the EDITORIAL CHOICE: of all the mornings we put something at the TOP of the brief, how
   often did that exact call actually hold up over the next few mornings? It reads GET
   /api/ai/brief-impact (agency-only) — the engine replays the SAME verified day-pulse over
   the mornings that FOLLOWED each shipped lead and folds them into an earned/fair/overcalled
   hit-rate, with zero human grading. The label band is a deliberate THIRD vocabulary
   (earned/fair/overcalled), disjoint from narration coverage and from pulse accuracy, so a
   strong-narration / weak-aim brief can never read as "good" on a glance. Fair by abstention:
   a young lead whose follow-through hasn't resolved is excluded, never counted against us, so
   the grade only firms up as mornings close — the MEASURE half of the lead-selection loop a
   later layer tunes on. Self-fetching, USE_API-gated, agency-only like every read on this page. */
const BRIEF_IMPACT_TONE = {
  earned:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'Well-aimed' },
  fair:       { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'A fair record' },
  overcalled: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    bar: 'bg-rose-400',    label: 'Overcalling' },
  'no-data':  { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   bar: 'bg-slate-200',   label: 'Building record' },
}

// One impact bucket (overall / by_audience[k] / by_lane[k]) → a compact view. A bucket with
// no leads is 'none' (—); one with leads but none RESOLVED yet is 'pending' (young calls still
// abstaining, not a 0%); a resolved bucket carries its hit-rate %. Mirrors briefCoverageView's
// three-state shape so the stat atoms read identically across the two panels.
function briefImpactView(b) {
  if (!b || !b.sample)  return { state: 'none',    pct: null, hits: 0, judged: 0, sample: 0 }
  if (!b.judged)        return { state: 'pending',  pct: null, hits: 0, judged: 0, sample: b.sample }
  return { state: 'graded', pct: b.hit_rate != null ? Math.round(b.hit_rate * 100) : 0, hits: b.hits, judged: b.judged, sample: b.sample }
}

// Humanize a triage-lane key for the by-lane breakdown ('act_now'→'Act now',
// 'worth_a_look'→'Worth a look', ''→'Unspecified'). Sentence case, underscores → spaces.
function laneLabel(key) {
  const s = String(key || '').trim().replace(/_/g, ' ')
  if (!s) return 'Unspecified'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function BriefImpactStat({ label, view }) {
  return (
    <div className="flex-1 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 truncate">{label}</p>
      {view.state === 'none' ? (
        <p className="text-sm font-black text-slate-300 leading-tight">—</p>
      ) : view.state === 'pending' ? (
        <p className="text-sm font-bold text-slate-400 leading-tight" title="Leads logged, none resolved yet — still abstaining">Building</p>
      ) : (
        <p className="text-sm font-black text-slate-800 leading-tight tabular-nums">
          {view.pct}%
          <span className="ml-1 text-[11px] font-semibold text-slate-400">{view.hits}/{view.judged}</span>
        </p>
      )}
    </div>
  )
}

// One lane row in the by-channel breakdown: name · mini hit-rate bar · pct · hits/judged. A
// lane still abstaining (pending) shows an empty track and a calm "—", never a misleading 0%.
function BriefImpactLaneRow({ name, bucket }) {
  const view = briefImpactView(bucket)
  const tone = BRIEF_IMPACT_TONE[bucket?.label] || BRIEF_IMPACT_TONE['no-data']
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] font-semibold text-slate-500 truncate" title={name}>{name}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        {view.state === 'graded' && <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${view.pct}%` }} />}
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-700">
        {view.state === 'graded' ? `${view.pct}%` : '—'}
      </span>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold text-slate-400 tabular-nums">
        {view.state === 'graded' ? `${view.hits}/${view.judged}` : `0/${view.sample}`}
      </span>
    </div>
  )
}

function BriefImpactPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [impact, setImpact] = useState(null)
  const [error, setError]   = useState('')

  const fetchImpact = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const i = await api.getBriefImpact()
      setImpact(i); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load editorial precision'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchImpact() }, [fetchImpact])

  const graded    = impact?.status === 'graded'
  const tone      = BRIEF_IMPACT_TONE[impact?.label] || BRIEF_IMPACT_TONE['no-data']
  const hitPct    = graded && impact.hit_rate != null ? Math.round(impact.hit_rate * 100) : null
  const narrative = (impact?.narrative || '').trim()
  const days      = impact?.requested?.days || 30
  const window    = impact?.window || 7
  // by_lane resolved-first, then still-building, so the channels that earned the lead lead the eye.
  const lanes     = Object.entries(impact?.by_lane || {})
    .sort((a, b) => {
      const ra = a[1]?.hit_rate, rb = b[1]?.hit_rate
      if (ra == null && rb == null) return (b[1]?.sample || 0) - (a[1]?.sample || 0)
      if (ra == null) return 1
      if (rb == null) return -1
      return rb - ra
    })
    .slice(0, 6)
  // 'insufficient' splits two ways: no trackable leads at all, vs some logged but too few resolved.
  const reason    = impact?.reason || 'insufficient_history'

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Crosshair className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Editorial precision</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Did the call we led with hold up · last {days} days
          </p>
        </div>
        {status === 'done' && graded && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Editorial precision: ${impact.label}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        {status === 'done' && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500"
            title={`Each lead is graded over the ${window} mornings that followed it — a call still firing the same way confirms, a reverted one refutes.`}
          >
            <Clock className="w-3 h-3" /> {window}-morning follow-through
          </span>
        )}
        <button
          onClick={fetchImpact}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Grading our front-page calls…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load editorial precision'}</p>
            <button
              onClick={fetchImpact}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && !graded && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            {reason === 'insufficient_sample'
              ? `Only ${impact?.judged || 0} of ${impact?.sample || 0} leads have resolved so far — ${impact?.min_sample || 4} are needed before grading. The record firms up as mornings close.`
              : `No morning brief has led with a trackable call in the last ${days} days yet — this fills in as the daily brief leads with movements worth following.`}
          </div>
        )}

        {status === 'done' && graded && (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{hitPct}%</span>
                <span className="text-[11px] font-bold text-slate-400">held up</span>
              </div>
              <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
                {impact.hits} of {impact.judged} {impact.judged === 1 ? 'lead' : 'leads'} held up over the following mornings
                {impact.unknown > 0 ? ` · ${impact.unknown} still abstaining` : ''}
              </p>
            </div>

            <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${hitPct}%` }} />
            </div>

            {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}

            <div className="mt-3 flex items-center gap-4 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2">
              <BriefImpactStat label="Client leads"    view={briefImpactView(impact?.by_audience?.client)} />
              <span className="w-px self-stretch bg-slate-200" />
              <BriefImpactStat label="Portfolio leads" view={briefImpactView(impact?.by_audience?.agency)} />
            </div>

            {lanes.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Which lanes earned the lead</p>
                <div className="space-y-1.5">
                  {lanes.map(([key, bucket]) => (
                    <BriefImpactLaneRow key={key} name={laneLabel(key)} bucket={bucket} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          A third, separate question — not did we <span className="font-semibold text-slate-500">write</span> the brief or <span className="font-semibold text-slate-500">deliver</span> it, but did the call we
          {' '}<span className="font-semibold text-slate-500">led with</span> hold up. A lead is graded only once its {window}-morning follow-through resolves — young calls abstain, never count against us.
          {' '}<span className="font-semibold text-emerald-600">earned</span> ≥70% · <span className="font-semibold text-amber-600">fair</span> 40–69% · <span className="font-semibold text-rose-600">overcalled</span> &lt;40%. Agency-only.
        </p>
      </div>
    </section>
  )
}

/* ── learned lead policy — intel-v7 (13c): lead with the lanes that have EARNED it ─────────────
   Editorial precision (above) MEASURES whether the call we led with held up. This is the TUNE
   half of that same loop: it reads GET /api/ai/lead-policy (agency-only), where the engine folds
   each triage lane's recent front-page hit-rate — the very grade above — into a bounded weight in
   [0.8, 1.2] that the morning brief applies when it ranks candidates for the one lead slot. A lane
   that keeps earning the front page is nudged UP; one that keeps overcalling is eased DOWN. Two
   disciplines keep it safe: BOUNDED (±20% — a reprioritisation, never a silencer) and SAFETY-
   ASYMMETRIC (act_now is FLOORED at neutral — promotable, never demotable, because burying a live
   emergency is worse than the odd false alarm). Fair by abstention: the whole policy holds neutral
   until the grade itself is 'graded', and any lane under min_sample resolved leads stays at ×1.00.
   The brief grading its own front page, then quietly rewriting its own editorial priorities from
   the result — no human, no model, no new stat. Self-fetching, USE_API-gated, agency-only. */
const LEAD_POLICY_TONE = {
  tuned:     { pill: 'border-teal-200 bg-teal-50 text-teal-700',    dot: 'bg-teal-500',  label: 'Self-tuned' },
  idle:      { pill: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-300', label: 'Holding neutral' },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-300', label: 'Abstaining' },
}

// A lane's learned DIRECTION drives its colour — promote (we lead MORE with it) lifts emerald,
// demote (we ease off) trims amber, neutral stays slate. Deliberately the DIRECTION axis, not the
// lane's own triage severity: this panel answers "which way did we retune each lane", not "how bad".
const LEAD_DIR_TONE = {
  promote: { fill: 'bg-emerald-500', text: 'text-emerald-700', label: 'Lead more' },
  demote:  { fill: 'bg-amber-400',   text: 'text-amber-600',   label: 'Ease off' },
  neutral: { fill: 'bg-slate-300',   text: 'text-slate-400',   label: 'Even' },
}

// ── lead-policy STABILITY monitor (14c) — "watch the watcher" ─────────────────
// A vocabulary DISJOINT from LEAD_POLICY_TONE: that grades the policy itself; this grades
// whether the TUNING LOOP that produced it is trustworthy right now. Health verdict status →
// the header pill, its dot, its headline-icon tint. (briefLeadPolicyHealth.js statuses.)
const LEAD_HEALTH_TONE = {
  unstable:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',       dot: 'bg-rose-500',    text: 'text-rose-500',    label: 'Oscillating',   Icon: AlertOctagon },
  constrained: { pill: 'border-amber-200 bg-amber-50 text-amber-700',    dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'At its bounds', Icon: Gauge },
  flagged:     { pill: 'border-orange-200 bg-orange-50 text-orange-700', dot: 'bg-orange-500',  text: 'text-orange-500',  label: 'Floor masking', Icon: ShieldAlert },
  settling:    { pill: 'border-sky-200 bg-sky-50 text-sky-700',          dot: 'bg-sky-500',     text: 'text-sky-500',     label: 'Settling',      Icon: Activity },
  stable:      { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Stable',     Icon: ShieldCheck },
  idle:        { pill: 'border-slate-200 bg-slate-50 text-slate-500',    dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Idle',          Icon: Minus },
  abstained:   { pill: 'border-slate-200 bg-slate-50 text-slate-500',    dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining',    Icon: Minus },
}

// recommended_action → an agency-facing chip. revert_to_neutral is the ONE the loop applies
// itself (past tense — already done, no human in the path); the rest are advisories a person weighs.
const LEAD_HEALTH_ACTION = {
  revert_to_neutral: { tone: 'border-rose-200 bg-rose-50 text-rose-700',       Icon: Wrench,      label: 'Reverted to neutral',        auto: true },
  widen_bounds:      { tone: 'border-amber-200 bg-amber-50 text-amber-700',    Icon: Scale,       label: 'Consider widening the band', auto: false },
  investigate_floor: { tone: 'border-orange-200 bg-orange-50 text-orange-700', Icon: ShieldAlert, label: 'Investigate the floor',      auto: false },
  hold:              { tone: 'border-sky-200 bg-sky-50 text-sky-700',          Icon: Activity,    label: 'Hold steady',                auto: false },
  trust:             { tone: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: Check,    label: 'Trust the loop',             auto: false },
  none:              null,
}

// per-lane verdict state → small badge + the divergent sparkline's colour. The SHAPE of the
// sparkline carries the diagnosis (a zigzag is oscillation, a flat-topped run is saturation,
// a calm flat line is convergence); the colour carries its severity.
const LEAD_HEALTH_LANE = {
  oscillating:    { fill: 'bg-rose-500',    text: 'text-rose-700',    badge: 'border-rose-200 bg-rose-50 text-rose-600',       label: 'Oscillating' },
  saturated_high: { fill: 'bg-amber-500',   text: 'text-amber-700',   badge: 'border-amber-200 bg-amber-50 text-amber-600',    label: 'Pinned high' },
  saturated_low:  { fill: 'bg-amber-500',   text: 'text-amber-700',   badge: 'border-amber-200 bg-amber-50 text-amber-600',    label: 'Pinned low' },
  floor_masked:   { fill: 'bg-orange-500',  text: 'text-orange-700',  badge: 'border-orange-200 bg-orange-50 text-orange-600', label: 'Floor-masked' },
  settling:       { fill: 'bg-sky-400',     text: 'text-sky-600',     badge: 'border-sky-200 bg-sky-50 text-sky-600',          label: 'Settling' },
  stable:         { fill: 'bg-emerald-500', text: 'text-emerald-700', badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', label: 'Stable' },
  idle:           { fill: 'bg-slate-300',   text: 'text-slate-400',   badge: 'border-slate-200 bg-slate-50 text-slate-500',    label: 'Idle' },
}

// urgency order for the lane list — most-concerning first, exactly the verdict precedence.
const LEAD_HEALTH_RANK = { oscillating: 0, saturated_high: 1, saturated_low: 1, floor_masked: 2, settling: 3, stable: 4, idle: 5 }

// One lane's per-morning EVIDENCE line — the very figure the verdict counted to reach its state.
function leadHealthEvidence(lane) {
  const n = (k) => (lane && Number.isFinite(lane[k]) ? lane[k] : 0)
  const mornings = (v) => `${v} ${v === 1 ? 'morning' : 'mornings'}`
  switch (lane?.state) {
    case 'oscillating':    return `${n('flips')} reversals across ${mornings(n('present'))}`
    case 'saturated_high': return `pinned at the ceiling · ${mornings(n('high_run'))}`
    case 'saturated_low':  return `pinned at the floor · ${mornings(n('low_run'))}`
    case 'floor_masked':   return `floor-caught · ${mornings(n('mask_runs'))} running`
    case 'settling':       return `still converging · spread ${n('spread').toFixed(2)}`
    case 'stable':         return `converged · holding ×${(Number.isFinite(lane?.last_weight) ? lane.last_weight : 1).toFixed(2)}`
    default:               return 'even weight — never tuned'
  }
}

// Headline shown above the narration — present even when narrate() stays silent (settling/idle/
// abstained), so the panel never reads empty on a healthy-but-quiet loop.
function leadHealthHeadline(status) {
  switch (status) {
    case 'unstable':    return 'The loop is chasing noise — reverted to a neutral lead order'
    case 'constrained': return 'A lane has run out of band — the nudge has become a wall'
    case 'flagged':     return 'The safety floor is masking a persistent overcall'
    case 'settling':    return 'Still converging on its learned priorities'
    case 'stable':      return 'Holding steady — the learned priorities have settled'
    case 'idle':        return 'Nothing has tuned off neutral yet — nothing to watch'
    default:            return 'Not enough graded history yet to judge the loop'
  }
}

// One policy lane → the human record beneath its name: the hit-rate and resolved count that
// EARNED the weight, or a calm "building" while it's still under the sample bar. Display fields stay
// truthful even when the weight is held neutral, so a thin or safety-floored lane reads honestly.
function leadLaneSub(entry) {
  const judged = entry && Number.isFinite(entry.judged) ? entry.judged : 0
  const hr = entry && Number.isFinite(entry.hit_rate) ? entry.hit_rate : null
  if (judged > 0 && hr != null) return `${Math.round(hr * 100)}% held · ${judged} resolved`
  if (judged > 0) return `${judged} resolved`
  return 'building'
}

// One lane row: name (+ a shield when safety-floored) over its record · a divergent tuning bar that
// deflects RIGHT from centre for a promotion and LEFT for an easing (each side normalised to its own
// half-band) · the weight multiplier in the direction's colour. A neutral lane shows just the centre
// tick on an empty track — honestly "no nudge", never a misleading fill.
function LeadPolicyLaneRow({ name, entry, bounds }) {
  const dir = entry?.direction || 'neutral'
  const tone = LEAD_DIR_TONE[dir] || LEAD_DIR_TONE.neutral
  const w = Number.isFinite(entry?.weight) ? entry.weight : 1
  const min = Number.isFinite(bounds?.min) ? bounds.min : 0.8
  const max = Number.isFinite(bounds?.max) ? bounds.max : 1.2
  // each half of the track maps its own range: [1, max] → right 50%, [min, 1] → left 50%.
  const rightPct = max > 1 ? Math.min(1, Math.max(0, (w - 1) / (max - 1))) * 50 : 0
  const leftPct = min < 1 ? Math.min(1, Math.max(0, (1 - w) / (1 - min))) * 50 : 0
  const Icon = dir === 'promote' ? ArrowUpCircle : dir === 'demote' ? TrendingDown : Minus
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 leading-tight" title={name}>
          <span className="truncate">{name}</span>
          {entry?.safetyFloored && (
            <ShieldCheck className="w-3 h-3 text-indigo-500 shrink-0" title="Safety lane — promotable, never eased" />
          )}
        </div>
        <p className="text-[10px] font-medium text-slate-400 leading-tight tabular-nums truncate">{leadLaneSub(entry)}</p>
      </div>
      <div
        className="relative flex-1 h-2 rounded-full bg-slate-100 overflow-hidden"
        title={`weight ×${w.toFixed(2)} · neutral 1.00 · band ${min.toFixed(2)}–${max.toFixed(2)}`}
      >
        <div className="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-slate-300" />
        {rightPct > 0 && <div className={cn('absolute inset-y-0 left-1/2 rounded-r-full transition-all', tone.fill)} style={{ width: `${rightPct}%` }} />}
        {leftPct > 0 && <div className={cn('absolute inset-y-0 rounded-l-full transition-all', tone.fill)} style={{ right: '50%', width: `${leftPct}%` }} />}
      </div>
      <span className={cn('w-12 shrink-0 inline-flex items-center justify-end gap-0.5 text-[11px] font-black tabular-nums', tone.text)}>
        <Icon className="w-3 h-3 shrink-0" />×{w.toFixed(2)}
      </span>
    </div>
  )
}

function LeadPolicyPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [policy, setPolicy] = useState(null)
  const [error, setError] = useState('')

  const fetchPolicy = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const p = await api.getLeadPolicy()
      setPolicy(p); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load lead policy'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchPolicy() }, [fetchPolicy])

  const st = policy?.status || 'abstained'
  const tuned = st === 'tuned'
  const tone = LEAD_POLICY_TONE[st] || LEAD_POLICY_TONE.abstained
  const narrative = (policy?.narrative || '').trim()
  const days = policy?.requested?.days || 30
  const bounds = policy?.bounds || { min: 0.8, max: 1.2 }
  const bandPct = Math.round(((bounds.max ?? 1.2) - 1) * 100)
  const minSample = policy?.min_sample || 4
  // lanes ranked by how far each moved off neutral (the retuned ones lead the eye), then floored
  // lanes (their shield is worth seeing), then by the weight of evidence behind them.
  const lanes = Object.entries(policy?.lanes || {})
    .sort((a, b) => {
      const da = Math.abs((a[1]?.weight ?? 1) - 1), db = Math.abs((b[1]?.weight ?? 1) - 1)
      if (db !== da) return db - da
      const fa = a[1]?.safetyFloored ? 1 : 0, fb = b[1]?.safetyFloored ? 1 : 0
      if (fb !== fa) return fb - fa
      return (b[1]?.judged || 0) - (a[1]?.judged || 0)
    })
    .slice(0, 6)
  const promoted = policy?.promoted || 0, demoted = policy?.demoted || 0, floored = policy?.floored || 0
  const adjusted = policy?.adjusted_count || 0

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Lead-selection policy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            How the brief weights each lane for the lead · last {days} days
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Lead policy: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        {status === 'done' && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500"
            title={`Each lane's weight is bounded to ±${bandPct}% of neutral — a reprioritisation, never a silencer.`}
          >
            <Scale className="w-3 h-3" /> ±{bandPct}% band
          </span>
        )}
        <button
          onClick={fetchPolicy}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Retuning the front-page lanes…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load lead policy'}</p>
            <button onClick={fetchPolicy} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            {tuned ? (
              <>
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{adjusted}</span>
                    <span className="text-[11px] font-bold text-slate-400">{adjusted === 1 ? 'lane retuned' : 'lanes retuned'}</span>
                  </div>
                  <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
                    {[
                      promoted > 0 ? `${promoted} promoted` : null,
                      demoted > 0 ? `${demoted} eased` : null,
                      floored > 0 ? `${floored} safety-floored` : null,
                    ].filter(Boolean).join(' · ')}
                    {' '}within a ±{bandPct}% band
                  </p>
                </div>
                {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </>
            ) : (
              <div className="flex items-start gap-2 text-sm text-slate-500">
                <Minus className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
                <p className="leading-relaxed">
                  {st === 'idle'
                    ? `Every lane holds at even weight — nothing has crossed the bar to move off neutral yet. A lane needs ${minSample}+ resolved leads to tune, and the safety lane only ever lifts. It sharpens as mornings close.`
                    : `Holding the front page byte-for-byte with the live pulse — the editorial-precision record isn't graded yet, so nothing is reprioritised. It fills in as leads resolve.`}
                </p>
              </div>
            )}

            {lanes.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Per-lane weight</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />ease</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />lead more</span>
                  </span>
                </div>
                <div className="space-y-2">
                  {lanes.map(([key, entry]) => (
                    <LeadPolicyLaneRow key={key} name={laneLabel(key)} entry={entry} bounds={bounds} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <Inbox className="w-4 h-4 shrink-0" />
                No trackable lead lanes yet — this fills in as the brief leads with movements worth following.
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">tune</span> half of editorial precision: each lane's recent hit-rate becomes a bounded weight the brief applies when it picks the one lead — <span className="font-semibold text-emerald-600">lead more</span> with a lane that keeps earning the front page, <span className="font-semibold text-amber-600">ease off</span> one that keeps overcalling. Neutral = <span className="tabular-nums font-semibold text-slate-500">×1.00</span>; the band is ±{bandPct}%, so it reprioritises but never silences. <span className="font-semibold text-indigo-600">act_now is safety-floored</span> — promotable, never eased, because burying a real emergency is worse than crying wolf. Abstains until the record is graded. Agency-only.
        </p>
      </div>
    </section>
  )
}

// One lane's weight history as a DIVERGENT sparkline — the shape is the diagnosis a single
// snapshot can't show. Bars deflect UP from the centre baseline for a weight above neutral and
// DOWN for below, each side normalised to its own half-band; a neutral morning is a centre tick,
// an ungraded one a gap. Oscillation reads as a zigzag, saturation as a flat-topped run, a
// converging lane as bars shrinking toward the line.
function LeadHealthSeries({ series, bounds, state }) {
  const vals = Array.isArray(series) ? series : []
  const min = Number.isFinite(bounds?.min) ? bounds.min : 0.8
  const max = Number.isFinite(bounds?.max) ? bounds.max : 1.2
  const fill = (LEAD_HEALTH_LANE[state] || LEAD_HEALTH_LANE.idle).fill
  if (!vals.length) return null
  return (
    <div className="relative h-7 w-full flex items-stretch gap-px" title="Per-morning weight — up = led more, down = eased, tick = neutral, gap = ungraded">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-slate-200" />
      {vals.map((w, i) => {
        if (!Number.isFinite(w)) return <div key={i} className="flex-1" />
        if (w === 1) {
          return (
            <div key={i} className="relative flex-1">
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-slate-300" />
            </div>
          )
        }
        const up = w > 1
        const mag = up ? (max > 1 ? (w - 1) / (max - 1) : 0) : (min < 1 ? (1 - w) / (1 - min) : 0)
        const h = Math.max(Math.min(1, Math.max(0, mag)) * 50, 4)
        return (
          <div key={i} className="relative flex-1">
            <div
              className={cn('absolute left-1/2 -translate-x-1/2 w-[60%] min-w-[3px]', fill, up ? 'bottom-1/2 rounded-t-sm' : 'top-1/2 rounded-b-sm')}
              style={{ height: `${h}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

// One stability lane row: name over its verdict-state badge · the divergent sparkline · the very
// figure the verdict counted to reach that state (reversals, run length, spread). State drives the
// badge tone, the bar colour, and the evidence colour — one lane, one severity, read three ways.
function LeadHealthLaneRow({ name, lane, bounds }) {
  const tone = LEAD_HEALTH_LANE[lane?.state] || LEAD_HEALTH_LANE.idle
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={name}>{name}</div>
        <span className={cn('mt-0.5 inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', tone.badge)}>
          {tone.label}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <LeadHealthSeries series={lane?.series} bounds={bounds} state={lane?.state} />
      </div>
      <span className={cn('w-28 shrink-0 text-right text-[10px] font-semibold leading-tight tabular-nums', tone.text)}>
        {leadHealthEvidence(lane)}
      </span>
    </div>
  )
}

// The self-aware stability monitor over the lead-policy loop — "watch the watcher" (layer 14).
// Reads GET /api/ai/lead-policy-health (agency-only): the verdict that grades not the policy but
// whether the LOOP that produced it is trustworthy right now. Oscillation reverts a lane to
// neutral on its own (the one self-healing action); saturation and floor-masking are surfaced for
// a human. Never client-facing — the whole tuning machinery stays behind the agency wall.
function LeadPolicyHealthPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [health, setHealth] = useState(null)
  const [error, setError] = useState('')

  const fetchHealth = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const h = await api.getLeadPolicyHealth()
      setHealth(h); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load policy stability'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const st = health?.status || 'abstained'
  const tone = LEAD_HEALTH_TONE[st] || LEAD_HEALTH_TONE.abstained
  const HeadIcon = tone.Icon
  const action = LEAD_HEALTH_ACTION[health?.recommended_action] || null
  const ActionIcon = action?.Icon
  const narrative = (health?.narrative || '').trim()
  const headline = leadHealthHeadline(st)
  const windowUsed = health?.window_used || health?.requested?.days || 6
  const historyLen = health?.history_len || 0
  const bounds = health?.bounds || { min: 0.8, max: 1.2 }
  const counts = health?.counts || {}
  // concern figures, most-urgent first — only the non-zero ones, so a calm loop reads calm.
  const concerns = [
    counts.oscillating > 0 ? `${counts.oscillating} oscillating` : null,
    counts.saturated > 0 ? `${counts.saturated} at bounds` : null,
    counts.masked > 0 ? `${counts.masked} floor-masked` : null,
    counts.settling > 0 ? `${counts.settling} settling` : null,
    counts.stable > 0 ? `${counts.stable} stable` : null,
  ].filter(Boolean)
  // lanes ranked by verdict precedence (most-concerning first), sliced to the panel's depth.
  const lanes = Object.entries(health?.lanes || {})
    .sort((a, b) => {
      const ra = LEAD_HEALTH_RANK[a[1]?.state] ?? 9, rb = LEAD_HEALTH_RANK[b[1]?.state] ?? 9
      if (ra !== rb) return ra - rb
      return (b[1]?.present || 0) - (a[1]?.present || 0)
    })
    .slice(0, 6)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Lead-policy stability</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Watching the tuning loop for thrash · last {windowUsed} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Loop stability: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchHealth}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Auditing the tuning loop…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load policy stability'}</p>
            <button onClick={fetchHealth} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {action && (
              <div className="mt-3">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold', action.tone)}>
                  <ActionIcon className="w-3.5 h-3.5" /> {action.label}
                </span>
                <p className="mt-1 text-[11px] font-medium text-slate-400 leading-relaxed">
                  {action.auto
                    ? 'Applied automatically — the loop reverted itself to a neutral lead order this run; no action needed.'
                    : 'Agency advisory — surfaced for a human to weigh, never auto-applied.'}
                </p>
              </div>
            )}

            {concerns.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {concerns.join(' · ')} <span className="text-slate-300">across {historyLen} graded {historyLen === 1 ? 'morning' : 'mornings'}</span>
              </p>
            )}

            {lanes.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Per-lane trajectory</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />thrash</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />settled</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {lanes.map(([key, lane]) => (
                    <LeadHealthLaneRow key={key} name={laneLabel(key)} lane={lane} bounds={bounds} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <Inbox className="w-4 h-4 shrink-0" />
                No lanes have moved off neutral yet — nothing to watch until the loop starts tuning.
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">Watch the watcher.</span> The lead-policy loop tunes itself each morning; this reads its last {windowUsed} weights per lane and flags the failure one snapshot hides — a lane <span className="font-semibold text-rose-600">oscillating</span> on noise, one <span className="font-semibold text-amber-600">pinned to its band</span>, or a real overcall the <span className="font-semibold text-orange-600">safety floor is masking</span>. Oscillation reverts that lane to neutral on its own; the rest are surfaced for a human. Agency-only.
        </p>
      </div>
    </section>
  )
}

// ── lead-policy GOVERNANCE (15c) — "the governor" ────────────────────────────
// A vocabulary DISJOINT from both the policy grade and the stability verdict: the panel above
// DIAGNOSES the loop; this grades what the loop DID about it. Governance status → the header pill,
// its dot, its headline-icon tint. (briefLeadPolicyGovernor.js statuses.)
const LEAD_GOV_TONE = {
  corrected: { pill: 'border-violet-200 bg-violet-50 text-violet-700',    dot: 'bg-violet-500',  text: 'text-violet-500',  label: 'Corrected',  Icon: Wrench },
  advised:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'Advisories', Icon: Scale },
  clean:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Steady',     Icon: ShieldCheck },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining', Icon: Minus },
}

// intervention action → the badge it wears in the per-lane list + the colour of its weight delta.
// neutralize is the ONE that changed a weight (the surgeon's cut, applied — no human in the path);
// hold_at_bound and respect_floor changed nothing — they're logged for a human, never auto-applied.
const LEAD_GOV_ACTION = {
  neutralize:    { badge: 'border-violet-200 bg-violet-50 text-violet-600', text: 'text-violet-600', Icon: Scissors,    label: 'Reset',      changed: true },
  hold_at_bound: { badge: 'border-amber-200 bg-amber-50 text-amber-600',    text: 'text-amber-600',  Icon: Gauge,       label: 'Held',       changed: false },
  respect_floor: { badge: 'border-indigo-200 bg-indigo-50 text-indigo-600', text: 'text-indigo-600', Icon: ShieldCheck, label: 'Floor kept', changed: false },
}

// most-consequential first — a reset weight outranks an advisory hold outranks a floor-respect.
const LEAD_GOV_RANK = { neutralize: 0, hold_at_bound: 1, respect_floor: 2 }

// the verdict STATE that triggered each intervention, in plain words — the reason the governor acted.
function govStateReason(state) {
  switch (state) {
    case 'oscillating':    return 'was thrashing morning to morning'
    case 'saturated_high': return 'pinned at the ceiling of its band'
    case 'saturated_low':  return 'pinned at the floor of its band'
    case 'floor_masked':   return 'the safety floor was masking an overcall'
    default:               return state ? String(state).replace(/_/g, ' ') : 'flagged by the monitor'
  }
}

function leadGovHeadline(status, governedStatus) {
  switch (status) {
    case 'corrected':
      return governedStatus === 'tuned'
        ? 'Reset the lane that was thrashing — the rest of the learned order stands'
        : 'Reset the only thrashing lane — the order rides neutral until it settles'
    case 'advised': return 'Nothing reset — held the pinned lanes and kept the floor for a human to weigh'
    case 'clean':   return 'Nothing to correct — the tuning loop is steady this morning'
    default:        return 'No trustworthy verdict to act on — the policy rides exactly as learned'
  }
}

// One intervention row: lane name over its action badge · the reason the governor acted · the weight
// transition. neutralize shows the cut (×1.10 → ×1.00); hold/floor show the weight it left untouched.
// Action drives the badge tone, the icon, and the delta colour — one lane, read across in one line.
function LeadGovInterventionRow({ intervention }) {
  const meta = LEAD_GOV_ACTION[intervention?.action] || LEAD_GOV_ACTION.hold_at_bound
  const Icon = meta.Icon
  const fw = Number.isFinite(intervention?.from_weight) ? intervention.from_weight : 1
  const tw = Number.isFinite(intervention?.to_weight) ? intervention.to_weight : fw
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(intervention?.lane)}>{laneLabel(intervention?.lane)}</div>
        <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">
        {govStateReason(intervention?.state)}
      </div>
      <span className={cn('w-24 shrink-0 text-right text-[11px] font-black tabular-nums', meta.text)}>
        {meta.changed
          ? <>×{fw.toFixed(2)} <span className="text-slate-300">→</span> ×{tw.toFixed(2)}</>
          : <>held ×{fw.toFixed(2)}</>}
      </span>
    </div>
  )
}

// The self-governing controller that closes the loop the stability monitor opens — "the governor"
// (layer 15). Reads GET /api/ai/lead-policy-governance (agency-only): not a diagnosis but the ACTION
// taken on it — the surgeon that consumes the stability verdict and autonomously applies the safe
// per-lane corrective. It neutralises ONLY a thrashing lane and keeps every earned lane live (so a
// learned order can still apply where layer 14's blunt revert would have lost it); saturation and
// floor-masking it logs for a human, never auto-widening the band. Every reset is snapshot-backed
// and reversible. Never client-facing — the whole governance machinery stays behind the agency wall.
function LeadPolicyGovernancePanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [gov, setGov] = useState(null)
  const [error, setError] = useState('')

  const fetchGov = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const g = await api.getLeadPolicyGovernance()
      setGov(g); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load policy governance'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchGov() }, [fetchGov])

  const st = gov?.status || 'abstained'
  const tone = LEAD_GOV_TONE[st] || LEAD_GOV_TONE.abstained
  const HeadIcon = tone.Icon
  const governedStatus = gov?.governed?.status || 'idle'
  const narrative = (gov?.narrative || '').trim()
  const headline = leadGovHeadline(st, governedStatus)
  const windowUsed = gov?.requested?.days || 6
  const counts = gov?.counts || {}
  const interventions = Array.isArray(gov?.interventions) ? gov.interventions : []
  const laneTotal = Object.keys(gov?.snapshot?.lanes || {}).length
  // action tally, most-consequential first — only the non-zero buckets so a calm loop reads calm.
  const tally = [
    counts.neutralized > 0 ? `${counts.neutralized} reset to neutral` : null,
    counts.held > 0 ? `${counts.held} held at bound` : null,
    counts.floored_respected > 0 ? `${counts.floored_respected} floor-respected` : null,
    counts.passed > 0 ? `${counts.passed} left untouched` : null,
  ].filter(Boolean)
  // interventions ranked by consequence (a reset outranks a hold outranks a floor-respect).
  const ordered = interventions
    .slice()
    .sort((a, b) => (LEAD_GOV_RANK[a?.action] ?? 9) - (LEAD_GOV_RANK[b?.action] ?? 9))
    .slice(0, 6)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Stethoscope className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Lead-policy governance</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            What the loop did about the verdict · last {windowUsed} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Governance: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchGov}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading what the governor did…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load policy governance'}</p>
            <button onClick={fetchGov} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {st === 'corrected' && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-violet-100 bg-violet-50/50 px-2.5 py-2">
                <Scissors className="w-3.5 h-3.5 text-violet-500 shrink-0 mt-0.5" />
                <p className="text-[11px] font-medium text-slate-500 leading-relaxed">
                  {governedStatus === 'tuned'
                    ? <><span className="font-semibold text-violet-700">A learned order still applies.</span> Only the thrashing lane snapped to neutral — the lanes that earned their lift ride untouched, where the blunt all-or-nothing revert would have lost them.</>
                    : <><span className="font-semibold text-violet-700">The order rides neutral for now.</span> The reset lane was the only one carrying weight, so the brief leads in its default order until the loop settles.</>}
                  {' '}The pre-governance weights are kept in the snapshot — every reset is reversible.
                </p>
              </div>
            )}

            {tally.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {tally.join(' · ')} <span className="text-slate-300">across {laneTotal} {laneTotal === 1 ? 'lane' : 'lanes'}</span>
              </p>
            )}

            {ordered.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">What the governor touched</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-violet-500" />reset</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />held</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {ordered.map((iv, i) => (
                    <LeadGovInterventionRow key={`${iv?.lane || 'lane'}-${i}`} intervention={iv} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {st === 'abstained'
                  ? 'No verdict to act on yet — the governor stays its hand until the loop can be judged.'
                  : 'Nothing needed correcting — every lane is learning cleanly.'}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The governor.</span> The monitor above diagnoses the loop; this <span className="font-semibold text-violet-600">acts</span> on the verdict — surgically, per lane, with no human in the path. It <span className="font-semibold text-violet-600">resets</span> only a thrashing lane to neutral and keeps every earned lane live; a lane <span className="font-semibold text-amber-600">pinned to its band</span> or one the <span className="font-semibold text-indigo-600">floor is protecting</span> it logs for a human rather than auto-widening anything. Idempotent, snapshot-backed, reversible. Agency-only.
        </p>
      </div>
    </section>
  )
}

// ── lead-policy governance AUDIT (16c) — "the auditor" ───────────────────────
// A vocabulary DISJOINT from the policy grade, the stability verdict, AND the governance status: the
// governor (15) grades what the loop DID each morning; this grades the GOVERNOR — across mornings.
// Audit roll-up status → the header pill, its dot, its headline-icon tint. (briefLeadPolicyAudit.js.)
const LEAD_AUDIT_TONE = {
  churning:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    text: 'text-rose-500',    label: 'Churning',   Icon: AlertOctagon },
  effective: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Effective',  Icon: ShieldCheck },
  quiet:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Quiet',      Icon: Minus },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining', Icon: Clock },
}

// per-lane intervention OUTCOME → the badge it wears in the per-lane list + the colour of its run stat.
// recurring is the ONE that escalates (the safe corrective keeps not sticking — a human is needed);
// resolved / intermittent / one_off are track-record context, never escalated.
const LEAD_AUDIT_OUTCOME = {
  recurring:    { badge: 'border-rose-200 bg-rose-50 text-rose-600',          text: 'text-rose-600',    Icon: AlertOctagon, label: 'Recurring',    escalate: true,  rank: 0 },
  intermittent: { badge: 'border-amber-200 bg-amber-50 text-amber-600',       text: 'text-amber-600',   Icon: Activity,     label: 'Intermittent', escalate: false, rank: 1 },
  resolved:     { badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', text: 'text-emerald-600', Icon: CheckCircle2, label: 'Resolved',     escalate: false, rank: 2 },
  one_off:      { badge: 'border-slate-200 bg-slate-50 text-slate-500',       text: 'text-slate-500',   Icon: Minus,        label: 'One-off',      escalate: false, rank: 3 },
}

// most-consequential first — a recurring lane outranks intermittent outranks resolved outranks one-off.
const LEAD_AUDIT_RANK = { recurring: 0, intermittent: 1, resolved: 2, one_off: 3 }

// the per-lane outcome in plain words — what the governor's track record on this lane actually shows.
function auditOutcomeReason(outcome, info) {
  const runs = Number.isFinite(info?.current_run) ? info.current_run : 0
  const corr = Number.isFinite(info?.corrections) ? info.corrections : 0
  switch (outcome) {
    case 'recurring':    return `needed the same reset ${runs} morning${runs === 1 ? '' : 's'} running`
    case 'resolved':     return 'the reset stuck — it stopped needing one'
    case 'intermittent': return `reset ${corr} time${corr === 1 ? '' : 's'}, on and off — never cleanly settled`
    case 'one_off':      return 'reset once, no recurrence since'
    default:             return 'no clear pattern yet'
  }
}

function leadAuditHeadline(status, recurringCount) {
  switch (status) {
    case 'churning':
      return recurringCount === 1
        ? 'A lane keeps needing the same reset — the safe corrective is not sticking, time for a human'
        : `${recurringCount} lanes keep needing the same reset — the safe corrective is not sticking, time for a human`
    case 'effective': return "The governor's resets are sticking — corrected lanes settled and stayed settled"
    case 'quiet':     return 'Nothing to second-guess — the governor has not had to correct anything'
    default:          return "Not enough governed mornings yet to judge the governor's own track record"
  }
}

// One lane row: lane name over its outcome badge · the track-record reason · the run stat. recurring
// shows the consecutive-morning streak (the escalation driver); the rest show total corrections so a
// settled lane reads as context, not alarm. Outcome drives the badge tone, the icon, and the stat tint.
function LeadAuditLaneRow({ lane, info }) {
  const meta = LEAD_AUDIT_OUTCOME[info?.outcome] || LEAD_AUDIT_OUTCOME.one_off
  const Icon = meta.Icon
  const runs = Number.isFinite(info?.current_run) ? info.current_run : 0
  const corr = Number.isFinite(info?.corrections) ? info.corrections : 0
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(lane)}>{laneLabel(lane)}</div>
        <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">
        {auditOutcomeReason(info?.outcome, info)}
      </div>
      <span className={cn('w-24 shrink-0 text-right text-[11px] font-black tabular-nums', meta.text)}>
        {meta.escalate
          ? <>{runs}× running</>
          : <>{corr}× total</>}
      </span>
    </div>
  )
}

// The auditor that closes the loop the governor opens — "the auditor" (layer 16). Reads GET
// /api/ai/lead-policy-governance-audit (agency-only): not what the loop did this morning but how the
// GOVERNOR itself is doing across mornings. The governor acts and moves on — it never grades its own
// homework; a lane the learner keeps re-oscillating and the governor keeps neutralising looks handled
// each single morning while the underlying cause never resolves. This watches the governor's OWN track
// record, classifies each lane's intervention outcome, and when the safe corrective keeps NOT sticking
// recommends escalating that lane to a human rather than letting the loop churn forever. The governor
// keeps holding the line meanwhile; the auditor only recommends, never acts. Never client-facing.
function LeadPolicyGovernanceAuditPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [audit, setAudit] = useState(null)
  const [error, setError] = useState('')

  const fetchAudit = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const a = await api.getLeadPolicyGovernanceAudit()
      setAudit(a); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load governance audit'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchAudit() }, [fetchAudit])

  const st = audit?.status || 'abstained'
  const tone = LEAD_AUDIT_TONE[st] || LEAD_AUDIT_TONE.abstained
  const HeadIcon = tone.Icon
  const rec = audit?.recommendation || { action: 'none', lanes: [] }
  const escalate = rec.action === 'escalate'
  const escalateLanes = Array.isArray(rec.lanes) ? rec.lanes : []
  const escalateLaneText = escalateLanes.map(laneLabel).join(', ')
  const narrative = (audit?.narrative || '').trim()
  const windowUsed = audit?.requested?.days || audit?.window_used || 8
  const counts = audit?.counts || {}
  const recurringCount = Number.isFinite(counts.recurring) ? counts.recurring : escalateLanes.length
  const correctedMornings = Number.isFinite(counts.corrected_mornings) ? counts.corrected_mornings : 0
  const headline = leadAuditHeadline(st, recurringCount || 1)
  const lanes = audit?.lanes && typeof audit.lanes === 'object' ? audit.lanes : {}
  // lane-outcome tally, most-consequential first — only the non-zero buckets so a steady governor reads steady.
  const tally = [
    counts.recurring > 0 ? `${counts.recurring} recurring` : null,
    counts.intermittent > 0 ? `${counts.intermittent} intermittent` : null,
    counts.resolved > 0 ? `${counts.resolved} resolved` : null,
    counts.one_off > 0 ? `${counts.one_off} one-off` : null,
  ].filter(Boolean)
  // lanes ranked by consequence (recurring outranks intermittent outranks resolved outranks one-off).
  const ordered = Object.entries(lanes)
    .sort((a, b) => (LEAD_AUDIT_RANK[a[1]?.outcome] ?? 9) - (LEAD_AUDIT_RANK[b[1]?.outcome] ?? 9))
    .slice(0, 6)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Governance audit</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Is the governor's fix sticking? · last {windowUsed} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Audit: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchAudit}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Auditing the governor's track record…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load governance audit'}</p>
            <button onClick={fetchAudit} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {escalate && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50/50 px-2.5 py-2">
                <ArrowUpCircle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <p className="text-[11px] font-medium text-slate-500 leading-relaxed">
                  <span className="font-semibold text-rose-700">Escalating to a human.</span> The governor keeps applying the one safe corrective to {escalateLanes.length === 1 ? 'this lane' : 'these lanes'} and it keeps coming back. {escalateLaneText && <><span className="font-semibold text-slate-600">{escalateLaneText}</span> — </>}the fix it can make on its own is not enough to reach the root cause. It will keep holding the line every morning; this only flags that a person should look.
                </p>
              </div>
            )}

            {tally.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {tally.join(' · ')} <span className="text-slate-300">· {correctedMornings} corrected {correctedMornings === 1 ? 'morning' : 'mornings'}</span>
              </p>
            )}

            {ordered.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">The governor's track record, by lane</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />recurring</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />resolved</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {ordered.map(([lane, info], i) => (
                    <LeadAuditLaneRow key={`${lane}-${i}`} lane={lane} info={info} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {st === 'abstained'
                  ? 'No governed history to audit yet — the auditor waits until the governor has a track record.'
                  : 'No lane has needed correcting — there is nothing for the auditor to second-guess.'}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The auditor.</span> The governor acts every morning; this checks whether its fix <span className="font-semibold text-emerald-600">stuck</span>. When the same lane keeps needing the same reset morning after morning, the safe corrective is not reaching the root cause — so it <span className="font-semibold text-rose-600">escalates that lane to a human</span> rather than letting the loop churn forever. The governor keeps holding the line meanwhile. Recommends, never acts. Agency-only.
        </p>
      </div>
    </section>
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

          {/* MORNING MEMORY (intel-v7 8) — this row's OWN continuity across mornings,
              the per-signal read behind the banner ribbon above. Agency-toned by the
              engine (lib/pulseContinuity.narrateContinuity): "New this morning." on a
              fresh firing, "3rd morning running — and worsening." as it persists. Only
              attached to firing rows; silent otherwise. Ties the row to the book's memory. */}
          {r.continuity_note && (
            <div className="flex items-center gap-1 mt-1 text-[10px] font-semibold text-slate-400">
              <Clock className="w-3 h-3 shrink-0" />
              <span>{r.continuity_note}</span>
            </div>
          )}
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
/* ── the morning briefing — intel-v7 (7c): the ONE thing, synthesised on top ─────
   The capstone of the whole daily-pulse loop. Layers 1–6 each ADDED earned detail
   (a severity, a confidence, a foresight grade, a tuning act, a rank). This banner
   SUBTRACTS: it reads the SAME ranked feed `Act today` is built from and answers one
   question — "if you do exactly one thing this morning, do this, and here's how much
   to trust that call." It never invents a parallel notion of important: the engine
   guarantees briefing.headline === act_today[0] (lib/pulseBriefing re-ranks with the
   identical pulseTriage call), so the hero sentence can never disagree with the list
   directly below it. Sits FIRST so the page reads top-down: "the one thing" (banner) →
   "the ranked few" (Act today) → "everyone moving" (pulse) → "headed for trouble"
   (trajectory) → "off pace" (pacing). Quiet books still get a calm affirmative read —
   the synthesis saying "you're clear" is itself a signal. Agency-only; the client gets
   the machinery-free one-liner on its own dashboard (7d). */

// posture → the one-word morning call, fill matching its urgency. act (rose, "touch
// something now") · watch (amber, "nothing on fire, but eyes up") · steady (emerald,
// "clear"). Mirrors the lane heat so posture and the feed beneath it read as one scale.
const PULSE_POSTURE = {
  act:    { pill: 'bg-rose-500 text-white',    Icon: AlertTriangle, label: 'Act' },
  watch:  { pill: 'bg-amber-500 text-white',   Icon: Eye,           label: 'Watch' },
  steady: { pill: 'bg-emerald-500 text-white', Icon: CheckCircle2,  label: 'Steady' },
}

// the system grading its OWN briefing — what share of today's calls come from sensors
// that have earned credibility (accuracy 'proven' / reliability 'reliable') vs ones
// still building a record. high (emerald, well-grounded) · moderate (amber, confirm the
// unproven) · building (slate, treat as directional). The meta-honesty is the point:
// the tool says when it's sure and when it's guessing. Keyed by the engine's own label.
const CONFIDENCE_TONE = {
  high:     { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: ShieldCheck, label: 'High confidence'     },
  moderate: { chip: 'bg-amber-50 text-amber-700 border-amber-200',       Icon: Gauge,       label: 'Moderate confidence' },
  building: { chip: 'bg-slate-100 text-slate-500 border-slate-200',      Icon: Radar,       label: 'Building confidence' },
  'n/a':    { chip: 'bg-slate-50 text-slate-400 border-slate-200',       Icon: Radar,       label: 'No calls today'      },
}

const BRIEFING_STAT_TONE = {
  rose:    'bg-rose-50 text-rose-600 border-rose-200',
  amber:   'bg-amber-50 text-amber-600 border-amber-200',
  emerald: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  slate:   'bg-slate-50 text-slate-500 border-slate-200',
}
function BriefingStat({ tone, label }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold', BRIEFING_STAT_TONE[tone] || BRIEFING_STAT_TONE.slate)}>
      {label}
    </span>
  )
}

/* ── the morning-memory ribbon — intel-v7 (8c): continuity, not severity ──────────
   The briefing above answers "what's the ONE thing this morning". This answers what
   the system REMEMBERS from yesterday — the SAME daily-pulse feed read across two
   mornings (lib/pulseContinuity.summarizePortfolioContinuity). Four reads, ordered as
   an alert's LIFECYCLE so the row tells a story left-to-right: new today (indigo, just
   appeared) → ongoing (amber, firing a 2nd morning+) → worsening (rose, the slice of
   ongoing that's deteriorating — escalating ⊆ persisting, so it's a SHARPENING of
   ongoing, never summed with it) → resolved overnight (emerald, the win the page earns).
   It never invents a parallel notion: the counts are the engine's exact aggregate and
   the eyebrow carries narratePortfolioContinuity's canonical sentence on hover. Degrades
   to nothing on a calm morning (every count 0). Agency-only — a portfolio roll-up. */
const CONTINUITY_CHIP = {
  new:       { chip: 'bg-indigo-50 text-indigo-600 border-indigo-200',   Icon: Sparkles },
  ongoing:   { chip: 'bg-amber-50 text-amber-600 border-amber-200',      Icon: Radar },
  worsening: { chip: 'bg-rose-50 text-rose-600 border-rose-200',         Icon: AlertTriangle },
  resolved:  { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
}
function ContinuityChip({ tone, label, title }) {
  const t = CONTINUITY_CHIP[tone] || CONTINUITY_CHIP.ongoing
  return (
    <span
      title={title || undefined}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', t.chip)}
    >
      <t.Icon className="w-3 h-3" /> {label}
    </span>
  )
}
function ContinuityRibbon({ cont }) {
  if (!cont) return null
  const nw = Number(cont.new_count) || 0
  const pe = Number(cont.persisting_count) || 0          // all persisting (includes worsening)
  const es = Number(cont.escalating_count) || 0          // ⊆ persisting — a sharpening, never summed
  const rc = Number(cont.resolved_count) || 0
  if (nw + pe + rc === 0) return null                    // calm morning → no ribbon
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const resolvedNames = Array.isArray(cont.resolved) && cont.resolved.length
    ? cont.resolved.map((r) => `${r.client_name || 'Unknown'} — ${(r.label || r.metric || '').toLowerCase()}`).join(', ')
    : ''
  return (
    <div className="mt-3 flex items-center gap-1.5 flex-wrap">
      <span
        title={cont.note || undefined}
        className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-400"
      >
        <Clock className="w-3 h-3" /> Morning memory
      </span>
      {nw > 0 && (
        <ContinuityChip tone="new" label={`${nw} new today`}
          title={cont.clients_new ? `${plural(cont.clients_new, 'client')} with a fresh alert this morning` : undefined} />
      )}
      {pe > 0 && (
        <ContinuityChip tone="ongoing" label={`${pe} ongoing`}
          title="Firing a second morning or more — carried over from yesterday" />
      )}
      {es > 0 && (
        <ContinuityChip tone="worsening" label={`${es} worsening`}
          title={`Of those ongoing, ${plural(es, 'metric')} ${es === 1 ? 'is' : 'are'} trending worse than yesterday${cont.clients_escalating ? ` · ${plural(cont.clients_escalating, 'client')}` : ''}`} />
      )}
      {rc > 0 && (
        <ContinuityChip tone="resolved" label={`${rc} resolved overnight`}
          title={resolvedNames || undefined} />
      )}
    </div>
  )
}

function PulseBriefingBanner({ data }) {
  const b = data?.briefing
  if (!b || !b.headline_text) return null                  // no synthesis → degrade to no banner
  const quiet   = b.status !== 'briefing'
  const posture = PULSE_POSTURE[b.posture] || PULSE_POSTURE.steady
  const conf    = CONFIDENCE_TONE[b.confidence?.label] || CONFIDENCE_TONE['n/a']
  const c       = b.counts || {}

  return (
    <div className={cn(
      'rounded-2xl border shadow-sm overflow-hidden',
      quiet ? 'border-emerald-100 bg-gradient-to-br from-emerald-50/70 to-white'
            : 'border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-white',
    )}>
      <div className="px-5 pt-4 pb-4">
        {/* eyebrow: the synthesis label, the one-word posture, and the confidence read */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-indigo-500">
            <Activity className="w-3.5 h-3.5" /> Today's pulse
          </span>
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider', posture.pill)}>
            <posture.Icon className="w-3 h-3" /> {posture.label}
          </span>
          {!quiet && (
            <span
              title={b.confidence?.note || undefined}
              className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider', conf.chip)}
            >
              <conf.Icon className="w-3 h-3" /> {conf.label}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
            <Sparkles className="w-3 h-3" /> the one thing first
          </span>
        </div>

        {/* the hero — the morning's ONE sentence, the top of the same ranked feed below */}
        <p className={cn('mt-3 font-black leading-snug', quiet ? 'text-base text-slate-700' : 'text-lg text-slate-900')}>
          {b.headline_text}
        </p>

        {/* the supporting cast — muted, only when more than the headline fired */}
        {b.also_text && (
          <p className="mt-1.5 text-xs font-medium text-slate-500 leading-relaxed">{b.also_text}</p>
        )}

        {/* the book at a glance — only when something's adverse; counts the engine already produced */}
        {!quiet && (
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            <BriefingStat tone="rose" label={`${c.adverse} to act on`} />
            {c.clients > 1   && <BriefingStat tone="slate"   label={`${c.clients} clients`} />}
            {c.proven > 0    && <BriefingStat tone="emerald" label={`${c.proven} proven`} />}
            {c.learning > 0  && <BriefingStat tone="slate"   label={`${c.learning} still learning`} />}
            {c.tailwinds > 0 && <BriefingStat tone="emerald" label={`${c.tailwinds} pacing ahead`} />}
          </div>
        )}

        {/* the morning-memory ribbon — continuity across mornings. Rides in BOTH modes:
            a quiet book that RESOLVED something overnight is exactly the win to surface. */}
        <ContinuityRibbon cont={data.continuity} />
      </div>

      {/* the confidence note as a grounding footer — the system explaining its own call */}
      {!quiet && b.confidence?.note && (
        <div className="px-5 py-2.5 bg-white/60 border-t border-indigo-50">
          <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
            <span className="font-bold text-slate-500">How sure: </span>{b.confidence.note}
          </p>
        </div>
      )}
    </div>
  )
}

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
