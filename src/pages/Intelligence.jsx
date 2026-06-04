import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Brain, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Check, Eye,
  Clock, CheckCircle2, Inbox, Plug, ChevronDown, ChevronUp, Target, SlidersHorizontal,
  Crosshair, BarChart3, Scale, Award, TrendingDown, Radar, Users, Sparkles, ArrowUpCircle, Activity,
  Gauge, ShieldAlert, AlertOctagon, Wrench, Minus, Scissors, Stethoscope, RotateCcw, ThumbsUp,
  ArrowRight, ArrowLeftRight,
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
import ImpactBanner from '@/components/ImpactBanner'

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
  const [reallocation, setReallocation] = useState(null) // { roster[], as_of } — channel-reallocation roster (agency-only, prescriptive)
  const [reallocationEfficacy, setReallocationEfficacy] = useState(null) // { calibration, overall, ranked[], by_strength[], by_pair[], by_client[] } — reallocation feedback loop / calibration (agency-only)
  const [reallocationEfficacyHealth, setReallocationEfficacyHealth] = useState(null) // { status, recommended_action, stability_score, applied_factor, raw_factor, distrust, narration, calibration:{flips,high_run,low_run,settled_run,series[]} } — stability watchdog over the calibration tuner (agency-only)
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
      // Eleven independent reads: the per-finding feed, the synthesized triage roster, the
      // cross-client peer benchmarks, the "what we fixed" recovery stream, the systemic
      // common-cause scan, the predictive early-warning roster, the goal-pacing roster, the
      // action→recovery efficacy ledger (which of our OWN plays actually fix it), the
      // intra-week daily-pulse roster (who's sliding RIGHT NOW, days before the week closes),
      // the channel-reallocation roster (one defensible, reversible budget shift per client),
      // and the reallocation-efficacy calibration (does the proposer's hypothesis actually pay
      // off? — the feedback loop that grades past shifts and tunes the next one's confidence).
      // allSettled — not Promise.all — so a synthesis hiccup never blanks the feed. If any
      // of the ten synthesis reads stumbles its panel simply hides and the page degrades to
      // exactly what it showed before that layer existed; only a feed failure is fatal.
      const [feed, roster, bench, recov, sys, traj, pace, eff, pls, realloc, realloEff, realloEffHealth] = await Promise.allSettled([
        api.getInsights(), api.getPortfolioHealth(), api.getBenchmarks(), api.getRecoveries(), api.getSystemic(), api.getTrajectory(), api.getPacing(), api.getEfficacy(), api.getPulse(), api.getReallocation(), api.getReallocationEfficacy(), api.getReallocationEfficacyHealth(),
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
      setReallocation(realloc.status === 'fulfilled' && Array.isArray(realloc.value?.roster) ? realloc.value : null)
      setReallocationEfficacy(realloEff.status === 'fulfilled' && realloEff.value?.calibration ? realloEff.value : null)
      setReallocationEfficacyHealth(realloEffHealth.status === 'fulfilled' && realloEffHealth.value?.status ? realloEffHealth.value : null)
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

      {/* influence hero (intel-v12 B3) — the honest, weighted tally of what the autonomous
          analyst actually MOVED: leads recovered, jobs protected, dollars defended (risk-
          adjusted), with the named clients behind it and the agency narration. It makes the
          whole intelligence layer's value legible at a glance, and earns the slot right under
          the run control. Self-fetching the PORTFOLIO ledger, USE_API-gated, and SILENT until
          there's a real, non-empty headline — never a "$0 delivered" hero on a fresh portfolio.
          Agency-only by construction (dollars + per-client attribution); the client's vaguer
          "your wins" line is the separate leak-proof B4 seam. */}
      {USE_API && <ImpactBanner />}

      {/* pipeline health — the foundation everything else stands on (intel-v11 A3). Every
          panel below is only as true as the feeds behind it, so this watchdog sits at the TOP:
          per client × channel it shows each sync's state and what the self-healing loop is doing
          about it — auto-resyncing stale data and retrying transient errors on a plateauing
          backoff, while surfacing the ONE thing it must never self-heal (an expired sign-in) as
          a human Reconnect. Its degraded-mode banner earns the prime slot. Agency-only, USE_API-
          gated; the client's own degraded note (A4) is leak-proof and lives on their surface. */}
      {USE_API && <PipelineHealthPanel />}

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

      {/* lead-policy governance REMEDIATION — "the remediator" (17c). The auditor above only
          ESCALATES a churning lane; this reads GET /api/ai/lead-policy-governance-remediation
          (agency-only) and stages the concrete STRUCTURAL fix that answers it — widen the lane's
          dead-band, tighten its bounds, or pin it to neutral, escalating by what's already been
          tried. The per-morning reset can't fix a churn because it resets the output, not the knobs
          that re-derive it; this changes the derivation. Bounded, reversible, one agency click,
          never auto-applied, never on the safety floor. Closes the loop the auditor opened —
          SENSE→ACT→AUDIT→REMEDIATE. Sits directly under the auditor whose escalation it answers. USE_API-gated. */}
      {USE_API && <LeadPolicyGovernanceRemediationPanel />}

      {/* consumer engagement — intel-v8 (18c). The capstone of a different KIND. Everything
          above — narration health, delivery, editorial precision, and the whole lead-policy
          tower that tunes/governs/audits/remediates ITSELF — is the system grading the system.
          This is the first and only OUTWARD loop: it reads GET /api/ai/brief-engagement
          (agency-only) — the rollup of the 👍/👎 a client leaves on a morning brief — into a
          portfolio reception rate + trend, a per-client board, and a watch list of clients
          whose brief is landing flat or slipping. The consumer-side early-warning the inward
          loops can structurally never see. Privacy is load-bearing: the aggregate is
          agency-only by construction; a client only ever sees their own vote reflected back.
          Sits last in the intelligence stack so the page reads "the system grading itself" →
          "and finally, the reader grading the system." USE_API-gated. */}
      {USE_API && <BriefEngagementPanel />}

      {/* emphasis efficacy (20c) — grades whether the engagement loop's own flexes paid off, then
          tunes the next one. Sits right after the engagement panel so the page reads "the reader
          grading the brief" → "and the brief grading its own self-tuning." Agency-only, USE_API-gated. */}
      {USE_API && <BriefEmphasisEfficacyPanel />}

      {/* emphasis control (21c) — the controller that CLOSES the loop: it feeds the measured
          step-scale above back into the magnitude of tomorrow's reception flex (lean in / ease
          off / hold). Sits right after efficacy so the page reads "the brief grading its own
          self-tuning" → "and the self-tuning re-tuning itself from the grade." Agency-only, USE_API-gated. */}
      {USE_API && <BriefEmphasisControlPanel />}

      {/* controller stability (22c) — the GOVERNOR on the self-tuning loop: watches the
          controller (21) across mornings for HUNTING / SATURATION and self-heals a runaway
          tuner by benching it to baseline. Sits right after the controller it polices so the
          page reads "the self-tuning re-tuning itself" → "and the governor watching that
          re-tuning for instability, stepping in when it won't settle." Agency-only, USE_API-gated. */}
      {USE_API && <BriefEmphasisControlHealthPanel />}

      {/* adaptive gain (23c) — the CHRONIC schedule sitting over the governor (22): it reads a
          HISTORY of the governor's verdicts and, when hunting RECURS across mornings, narrows how
          far the controller may swing at all — then hands the full range back once the loop proves
          it has converged. Sits right after the governor it schedules so the page reads "the governor
          watching the re-tuning for instability" → "and the gain schedule narrowing the controller's
          authority when that instability keeps recurring." Agency-only, USE_API-gated. */}
      {USE_API && <BriefEmphasisControlTuningPanel />}

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

      {/* budget reallocation — the first PRESCRIPTIVE layer. Where pacing says WHO will miss,
          this says WHAT to do about it: among a client's paid channels measuring the SAME
          outcome, it compares realized cost-per-outcome, reads each channel's spend↔cost TREND
          (is cost climbing as we feed it?), and proposes ONE small, reversible test shift —
          "Google Ads is turning out leads ~31% cheaper than Facebook/Meta; test moving $180/wk."
          Correlational hypotheses to test and watch, never guarantees. Agency-only (cross-account
          roster + dollar moves); hidden until at least one defensible shift clears the floor. */}
      {reallocation?.roster?.length > 0 && <ReallocationPanel data={reallocation} />}

      {/* reallocation calibration — the FEEDBACK LOOP that closes the prescriptive layer above.
          Where reallocation PROPOSES a budget shift and prints a confidence, this looks BACK:
          it reconstructs every past proposal, re-measures what the cost-per-outcome gap actually
          DID over the weeks that followed, and grades each bet vindicated (the edge held) /
          refuted (it collapsed). From the pooled record it derives the ONE knob the engine
          consumes — a confidence CALIBRATION that DAMPENS the next proposal when past bets held
          up LESS often than their confidence implied, EMBOLDENS it when they beat it, and stays
          neutral until evidence earns a move. The system grading its own money moves and tuning
          the next one. Agency-only (an internal media-buying instrument, never a client
          scoreboard); hidden until at least one past shift is old enough to grade. */}
      {reallocationEfficacy?.overall?.n > 0 && <ReallocationEfficacyPanel data={reallocationEfficacy} />}

      {/* calibration-stability watchdog (Layer 26) — the meta-monitor that sits ABOVE the
          reallocation confidence tuner and watches the tuner itself across time for the two
          failures a single setting can't reveal: HUNTING (the factor thrashing without ever
          settling → self-healed by benching the tuner to a neutral ×1.00 until it calms) and
          PINNED (the factor stuck against a clamp rail → chronically mis-calibrated, surfaced
          but never auto-touched). Agency-only internal instrument; hidden while abstained
          (too little history) so it only appears once there's a verdict worth showing. */}
      {reallocationEfficacyHealth && reallocationEfficacyHealth.status !== 'abstained' && <ReallocationEfficacyHealthPanel data={reallocationEfficacyHealth} />}

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

/* ── pipeline health — intel-v11 (A3): the self-healing sync layer, made visible ─────
   Every panel below this one is only as trustworthy as the data feeding it: a dark channel
   makes every number on the page quietly wrong. This is the panel that watches the FEEDS
   themselves. It reads GET /api/insights/connection-health — the agency-only roll-up of the
   self-healing watchdog (connectionHealth = the brain that classifies each sync, connection-
   Watchdog = the hand that acts) — and shows, per client × channel, exactly what state each
   sync is in and what the machine is doing about it. The whole design turns on ONE invariant:
   the system self-heals everything it safely can (stale data → resync, transient errors →
   retry on a deterministic backoff that plateaus but never gives up) and "heals" the one
   thing it must never touch — an expired credential — precisely by NOT touching it. AUTH
   failures are surfaced here as a human Reconnect, never silently retried against a revoked
   token. So the banner has exactly two voices: amber "we're already fixing it" (auto-healing,
   no action) and rose "we need you" (reconnect). Self-fetching, agency-only, USE_API-gated
   like every read on this page — a client never sees a feed name, a credential state, or any
   of this machinery; their own degraded note (A4) is leak-proof and lives elsewhere. */
const PIPELINE_STATUS_TONE = {
  HEALTHY:      { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-700', label: 'Healthy',         Icon: CheckCircle2 },
  STALE:        { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   chip: 'bg-amber-100 text-amber-700',     label: 'Stale',           Icon: Clock },
  ERRORING:     { pill: 'border-orange-200 bg-orange-50 text-orange-700',    dot: 'bg-orange-500',  chip: 'bg-orange-100 text-orange-700',   label: 'Erroring',        Icon: AlertTriangle },
  AUTH_EXPIRED: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    chip: 'bg-rose-100 text-rose-700',       label: 'Sign-in expired', Icon: ShieldAlert },
  NEVER_SYNCED: { pill: 'border-violet-200 bg-violet-50 text-violet-700',    dot: 'bg-violet-500',  chip: 'bg-violet-100 text-violet-700',   label: 'Never synced',    Icon: Plug },
  DISABLED:     { pill: 'border-slate-200 bg-slate-100 text-slate-500',      dot: 'bg-slate-300',   chip: 'bg-slate-100 text-slate-500',     label: 'Disabled',        Icon: Minus },
}
const PIPELINE_COUNT_ORDER = ['HEALTHY', 'STALE', 'ERRORING', 'AUTH_EXPIRED', 'NEVER_SYNCED', 'DISABLED']

// Forward-looking ETA — timeAgo is past-only ("3m ago"); the watchdog's next_attempt_at /
// next_wake_at are in the FUTURE, so render them as "in 4m" / "due now". Same humane buckets.
function pipelineEta(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const secs = (t - Date.now()) / 1000
  if (secs <= 30) return 'due now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `in ${Math.max(1, mins)}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `in ${hrs}h`
  return `in ${Math.round(hrs / 24)}d`
}

/* The degraded-mode banner — the panel's headline alarm. Two voices, never more: rose
   when any feed needs a human (operator_required > 0 — an expired sign-in the machine will
   never retry on its own), amber when feeds are merely degraded (needs_attention > 0) and
   the watchdog is already healing them. Silent BY CONSTRUCTION on a clean portfolio, so the
   alarm never trains anyone to ignore it. Reconnect outranks healing when both are present,
   but we still reassure that the amber set needs nothing — so a busy morning reads at a glance
   as "do these N reconnects; the rest is handled." */
function PipelineHealthBanner({ summary }) {
  if (!summary) return null
  const opReq = summary.operator_required || 0
  const attn  = summary.needs_attention   || 0
  if (opReq === 0 && attn === 0) return null

  const reconnect = opReq > 0
  const t = reconnect
    ? { wrap: 'border-rose-200 bg-rose-50',  icon: 'text-rose-500',  kicker: 'text-rose-600',  head: 'text-rose-900',  body: 'text-rose-800/80',  Icon: ShieldAlert, label: 'Action needed · reconnect' }
    : { wrap: 'border-amber-200 bg-amber-50', icon: 'text-amber-500', kicker: 'text-amber-600', head: 'text-amber-900', body: 'text-amber-800/80', Icon: Wrench,      label: 'Self-healing · no action needed' }

  const head = reconnect
    ? `${opReq} ${opReq === 1 ? 'feed needs' : 'feeds need'} a human reconnect`
    : `${attn} ${attn === 1 ? 'feed is healing' : 'feeds are healing'} automatically`
  const detail = reconnect
    ? 'Their sign-in expired, so auto-sync is paused until someone re-authorizes — the one fault the system will never retry on its own. Use the Reconnect button on each feed below.'
    : 'The watchdog is already re-syncing them on a deterministic backoff — stale data refreshes and transient errors retry without anyone stepping in. Nothing to do but watch.'
  const alsoHealing = reconnect && attn > opReq

  return (
    <div className={cn('mb-4 rounded-xl border px-3.5 py-3', t.wrap)} role="alert">
      <div className="flex items-start gap-2.5">
        <t.Icon className={cn('w-4 h-4 mt-0.5 shrink-0', t.icon)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[10px] font-black uppercase tracking-wider', t.kicker)}>
            Pipeline watchdog · {t.label}
          </p>
          <p className={cn('mt-0.5 text-[13px] font-bold leading-snug', t.head)}>{head}</p>
          <p className={cn('mt-1 text-[11px] font-medium leading-snug', t.body)}>{detail}</p>
          {alsoHealing && (
            <p className={cn('mt-1.5 text-[10px] font-semibold leading-snug', t.body)}>
              The other {attn - opReq} degraded {attn - opReq === 1 ? 'feed is' : 'feeds are'} already self-healing — no action needed there.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/* One connection row. Tone follows the worst thing about it: rose-tinted when it needs a
   human, amber when degraded-but-healing, plain when calm. The agency narration (already
   audience-scoped server-side) carries the plain-English "what + why"; the meta line carries
   the receipts (last good sync, failure count, the watchdog's next auto-retry ETA). The
   Reconnect CTA appears ONLY on operator_required rows — the Class-C gate made visible — and
   deep-links to that exact client's Connections page so the fix is one click away. */
function PipelineConnRow({ conn, names }) {
  const tone   = PIPELINE_STATUS_TONE[conn.status] || PIPELINE_STATUS_TONE.DISABLED
  const Icon   = tone.Icon
  const cname  = names[String(conn.client_id)] || (conn.client_id != null ? `Client ${conn.client_id}` : 'Unknown client')
  const rec    = conn.recovery || {}
  const opReq  = !!conn.operator_required
  const eta    = pipelineEta(rec.next_attempt_at)
  const lastOk = conn.last_success_at ? timeAgo(conn.last_success_at) : ''

  return (
    <div className={cn('rounded-xl border px-3 py-2.5', opReq ? 'border-rose-200 bg-rose-50/40' : conn.needs_attention ? 'border-amber-200 bg-amber-50/30' : 'border-slate-100 bg-white')}>
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center shrink-0', tone.chip)}>
          <Icon className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-black text-slate-900">{conn.label || conn.channel}</span>
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500">
              <Users className="w-3 h-3" /> {cname}
            </span>
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide', tone.pill)}>
              <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
            </span>
          </div>
          {conn.narration && <p className="mt-1 text-[12px] font-medium text-slate-600 leading-snug">{conn.narration}</p>}
          <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
            {lastOk && <span className="inline-flex items-center gap-1"><Check className="w-2.5 h-2.5" /> last ok {lastOk}</span>}
            {conn.failures > 0 && (
              <span className="inline-flex items-center gap-1 text-slate-500">
                <AlertTriangle className="w-2.5 h-2.5" /> {conn.failures} {conn.failures === 1 ? 'failure' : 'failures'}
              </span>
            )}
            {!opReq && rec.retryable && eta && (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <RotateCcw className="w-2.5 h-2.5" /> auto-retry {eta}{rec.exhausted ? ' · slow cadence' : ''}
              </span>
            )}
          </div>
        </div>
        {opReq && (
          <a
            href={`/connections?client=${encodeURIComponent(conn.client_id)}`}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-[11px] font-black text-rose-700 hover:bg-rose-50 transition"
            title={`Reconnect ${conn.label || conn.channel} for ${cname}`}
          >
            <Plug className="w-3.5 h-3.5" /> Reconnect
          </a>
        )}
      </div>
    </div>
  )
}

function PipelineHealthPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [data, setData]     = useState(null)
  const [names, setNames]   = useState({})          // client_id → name (presentation nicety)
  const [error, setError]   = useState('')

  const fetchPipeline = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      // Connection health is the payload; client names are a presentation nicety fetched
      // alongside it — if that read fails we still render, falling back to the client id.
      const [health, clients] = await Promise.all([
        api.getConnectionHealth(),
        api.clients().catch(() => []),
      ])
      const map = {}
      for (const c of (clients || [])) if (c && c.id != null) map[String(c.id)] = c.name
      setNames(map); setData(health); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load pipeline health'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchPipeline() }, [fetchPipeline])

  const s         = data?.summary || null
  const worst     = s?.worst_status || null
  const worstTone = worst ? (PIPELINE_STATUS_TONE[worst] || null) : null
  const conns     = Array.isArray(data?.connections) ? data.connections : []
  const roster    = conns.filter(c => c && c.status !== 'HEALTHY')
  const ROSTER_CAP = 12
  const shown     = roster.slice(0, ROSTER_CAP)
  const overflow  = roster.length - shown.length
  const healthyN  = s?.counts?.HEALTHY || 0
  const allOk     = !!(s && s.ok && roster.length === 0)
  const nextWake  = pipelineEta(s?.next_wake_at)
  const checked   = data?.as_of ? timeAgo(data.as_of) : ''

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Plug className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Pipeline health</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Live sync status across every client feed · self-healing watchdog
          </p>
        </div>
        {status === 'done' && s && worstTone && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', allOk ? PIPELINE_STATUS_TONE.HEALTHY.pill : worstTone.pill)} title={`Worst connection state: ${worst}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', allOk ? PIPELINE_STATUS_TONE.HEALTHY.dot : worstTone.dot)} /> {allOk ? 'All healthy' : worstTone.label}
          </span>
        )}
        {status === 'done' && s && s.self_healing > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700" title="Connections the watchdog is auto-recovering right now, no operator involved">
            <Wrench className="w-3 h-3" /> {s.self_healing} self-healing
          </span>
        )}
        <button onClick={fetchPipeline} disabled={status === 'loading'} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition">
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'done' && s && <PipelineHealthBanner summary={s} />}

        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking every connection…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load pipeline health'}</p>
            <button onClick={fetchPipeline} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (!s || s.total === 0) && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" /> No connections yet — this fills in as clients link their data sources.
          </div>
        )}

        {status === 'done' && s && s.total > 0 && (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              {PIPELINE_COUNT_ORDER.filter(k => (s.counts?.[k] || 0) > 0).map(k => {
                const tone = PIPELINE_STATUS_TONE[k]
                return (
                  <span key={k} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-bold', tone.pill)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} />
                    <span className="tabular-nums">{s.counts[k]}</span> {tone.label}
                  </span>
                )
              })}
            </div>

            {(s.self_healing > 0 || s.exhausted > 0) && (
              <div className="mt-2.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
                {s.self_healing > 0 && <span className="inline-flex items-center gap-1 text-emerald-600"><Wrench className="w-2.5 h-2.5" /> {s.self_healing} auto-recovering</span>}
                {s.exhausted > 0 && <span className="inline-flex items-center gap-1 text-slate-500"><Clock className="w-2.5 h-2.5" /> {s.exhausted} on slow retry</span>}
                {nextWake && s.self_healing > 0 && <span className="inline-flex items-center gap-1"><RotateCcw className="w-2.5 h-2.5" /> next attempt {nextWake}</span>}
              </div>
            )}

            {allOk ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/40 px-3 py-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-[12px] font-semibold text-emerald-800">
                  All {s.total} {s.total === 1 ? 'feed is' : 'feeds are'} healthy and syncing on schedule — nothing needs attention.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {shown.map((c, i) => <PipelineConnRow key={`${c.client_id}:${c.channel}:${i}`} conn={c} names={names} />)}
                {overflow > 0 && (
                  <p className="text-[11px] font-semibold text-slate-400 pl-1">+ {overflow} more {overflow === 1 ? 'connection' : 'connections'} needing attention</p>
                )}
                {healthyN > 0 && (
                  <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 pl-1">
                    <CheckCircle2 className="w-3 h-3" /> {healthyN} other {healthyN === 1 ? 'feed' : 'feeds'} healthy and syncing
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The watchdog self-heals what it safely can — stale feeds resync, transient errors retry on a backoff that plateaus but never gives up. The one thing it never touches is an expired sign-in: a revoked credential is surfaced here for a human <span className="font-semibold text-slate-500">Reconnect</span>, never retried against a dead token.
          {checked ? ` Checked ${checked}.` : ''} Agency-only.
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

/* ── consumer engagement — intel-v8 (18c): did the HUMAN find the brief useful? ─────────────────
   Every panel above — narration reliability, delivery, editorial precision, and the whole
   lead-policy tower that governs/audits/remediates its OWN tuning — is the system grading
   itself. Not one asks the question a consumer product ultimately lives or dies on: did the
   person who READ the brief find it useful? This is the first and only OUTWARD loop. It reads
   GET /api/ai/brief-engagement (agency-only) — the rollup of the lightweight 👍/👎 a client
   leaves on a morning brief — into a portfolio reception rate + label + trend, a per-client
   board (worst reception first), and a watch list of clients whose brief is landing flat or
   slipping: the consumer-side early-warning the inward loops can never see. Honest by
   abstention: a client with fewer than a handful of votes abstains, never a rate off noise.
   PRIVACY (load-bearing): the aggregate is AGENCY-ONLY by construction — a client only ever
   sees their own vote reflected back (the pure narrator returns '' for the client audience
   unconditionally), never the rate, the board, or the watch list. Sits as the capstone right
   after the inward self-governance chain — read down the page and it goes "the system grading
   itself" → "and finally, the reader grading the system." Self-fetching, USE_API-gated, agency-only. */
const BRIEF_ENGAGEMENT_TONE = {
  well_received:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'Well received' },
  fair:            { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'A fair reception' },
  poorly_received: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    bar: 'bg-rose-400',    label: 'Landing flat' },
  'no-data':       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   bar: 'bg-slate-200',   label: 'Listening' },
}

// intel-v9 layer 19c — the ACT half of the engagement loop, by direction. The panel above shows
// the GRADE (how the reader received the brief); this palette dresses the RESPONSE the grade earned:
// how wide a supporting cast tomorrow's brief will carry. widen = the brief EARNED room to say a
// little more (emerald, Sparkles); tighten = it's landing flat, lead with the essentials (amber,
// Scissors — the safe direction); neutral = graded but held at the usual depth (slate, Minus).
const BRIEF_EMPHASIS_TONE = {
  widen:   { wrap: 'border-emerald-100 bg-emerald-50/50', chip: 'bg-emerald-100 text-emerald-700', accent: 'text-emerald-700', icon: Sparkles, verb: 'Carrying a little more' },
  tighten: { wrap: 'border-amber-100 bg-amber-50/50',     chip: 'bg-amber-100 text-amber-700',     accent: 'text-amber-700',   icon: Scissors, verb: 'Leading tighter' },
  neutral: { wrap: 'border-slate-100 bg-slate-50/60',     chip: 'bg-slate-100 text-slate-600',     accent: 'text-slate-600',   icon: Minus,    verb: 'Holding steady' },
}

// One per-client engagement grade → a compact three-state view, mirroring briefImpactView.
// A client with no votes is 'none' (—); one with votes but below the grading floor is
// 'pending' (still abstaining, never a misleading 0%); a graded client carries its rate %.
function engagementClientView(c) {
  if (!c || !c.n)            return { state: 'none',    pct: null, helpful: 0, n: 0 }
  if (c.status !== 'graded') return { state: 'pending', pct: null, helpful: c.helpful || 0, n: c.n }
  return { state: 'graded', pct: c.helpful_rate != null ? Math.round(c.helpful_rate * 100) : 0, helpful: c.helpful || 0, n: c.n }
}

// One client row in the per-client reception board: a worst-first dot · name · mini helpful-rate
// bar · pct · helpful/n. A watch-listed client (landing flat or slipping) carries a rose dot so
// the eye catches it; a still-abstaining client shows an empty track and a calm "·", never a 0%.
function BriefEngagementClientRow({ client, watched }) {
  const view = engagementClientView(client)
  const tone = BRIEF_ENGAGEMENT_TONE[client?.label] || BRIEF_ENGAGEMENT_TONE['no-data']
  return (
    <div className="flex items-center gap-2">
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', watched ? 'bg-rose-500' : 'bg-slate-200')} />
      <span className="w-24 shrink-0 text-[11px] font-semibold text-slate-500 truncate" title={client?.name || 'Unnamed client'}>
        {client?.name || 'Unnamed client'}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        {view.state === 'graded' && <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${view.pct}%` }} />}
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-700">
        {view.state === 'graded' ? `${view.pct}%` : view.state === 'pending' ? '·' : '—'}
      </span>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold text-slate-400 tabular-nums">
        {view.helpful}/{view.n}
      </span>
    </div>
  )
}

// intel-v9 layer 19c — the engagement loop's RESPONSE, made visible. Everything above this strip
// is the GRADE (did the reader find the brief useful); this is what that grade EARNED for tomorrow:
// the supporting-cast breadth the morning brief will carry beneath its one headline. It reads the
// emphasis object the engine already folded into the /brief-engagement payload (deriveBriefEmphasis:
// { status, direction, also_cap, base_cap, ... }) plus the agency narrator sentence — no second
// fetch. 'tuned' = the cap moved (widen earned a richer brief / tighten trims to the essentials);
// 'idle' = graded but held at the neutral base, so the brief keeps its usual depth. 'abstained'
// never renders here — the parent only mounts this inside the graded block, where a real rate
// exists. The headline NEVER flexes — only the tail — so reception can make the brief richer or
// leaner but can never bury what matters most. Agency-only by construction: narrateBriefEmphasis
// returns '' for the client audience and the knob never crosses the client egress (proven in 19d).
function BriefEmphasisStrip({ emphasis, narrative }) {
  if (!emphasis || emphasis.status === 'abstained') return null
  const dir  = emphasis.direction === 'widen' || emphasis.direction === 'tighten' ? emphasis.direction : 'neutral'
  const tone = BRIEF_EMPHASIS_TONE[dir]
  const Icon = tone.icon
  const cap  = emphasis.also_cap
  const base = emphasis.base_cap
  const item = (n) => (n === 1 ? 'item' : 'items')
  // The narrator is intentionally '' for idle/neutral (it only speaks when the cap actually moved);
  // synthesize a calm steady-state line so the strip never reads empty when reception holds.
  const line = (narrative || '').trim() ||
    `Reception is steady, so tomorrow's brief keeps its usual depth — ${cap} supporting ${item(cap)} beneath the headline.`
  return (
    <div className={cn('mt-3 rounded-xl border px-3 py-2.5', tone.wrap)}>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5 flex items-center gap-1">
        <SlidersHorizontal className="w-3 h-3" /> What reception earns tomorrow's brief
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', tone.chip)}>
          <Icon className="w-3 h-3" /> {tone.verb}
        </span>
        {dir === 'neutral' ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
            <span className={cn('tabular-nums font-black', tone.accent)}>{cap}</span>
            <span className="text-slate-400">supporting {item(cap)} · unchanged</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
            <span className="tabular-nums text-slate-400">{base}</span>
            <span className={cn('font-black', tone.accent)}>→</span>
            <span className={cn('tabular-nums font-black', tone.accent)}>{cap}</span>
            <span className="text-slate-400">supporting {item(cap)}</span>
          </span>
        )}
        <span className="ml-auto text-[10px] font-medium text-slate-400">headline never moves</span>
      </div>
      <p className="mt-2 text-[12px] text-slate-500 leading-relaxed">{line}</p>
    </div>
  )
}

function BriefEngagementPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [eng, setEng]       = useState(null)
  const [error, setError]   = useState('')

  const fetchEngagement = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const e = await api.getBriefEngagement()
      setEng(e); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load consumer engagement'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchEngagement() }, [fetchEngagement])

  const graded    = eng?.status === 'graded'
  const tone      = BRIEF_ENGAGEMENT_TONE[eng?.label] || BRIEF_ENGAGEMENT_TONE['no-data']
  const pct       = graded && eng.helpful_rate != null ? Math.round(eng.helpful_rate * 100) : null
  const narrative = (eng?.narrative || '').trim()
  const days      = eng?.requested?.days || 90
  const minVotes  = eng?.requested_min_votes || 3
  const reason    = eng?.reason || 'insufficient_history'
  const watch     = Array.isArray(eng?.watch) ? eng.watch : []
  const watchIds  = new Set(watch.map((c) => c.client_id))
  // by_client arrives worst-reception-first (ungraded last); cap the board so it stays scannable.
  const board     = (Array.isArray(eng?.by_client) ? eng.by_client : []).slice(0, 6)
  const trend     = eng?.trend

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <ThumbsUp className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Consumer engagement</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Did the reader find the brief useful · last {days} days
          </p>
        </div>
        {status === 'done' && graded && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Reception: ${eng.label}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        {status === 'done' && graded && trend === 'improving' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700" title="Reception has been improving lately">
            <ArrowUpCircle className="w-3 h-3" /> Improving
          </span>
        )}
        {status === 'done' && graded && trend === 'declining' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700" title="Reception has been slipping lately">
            <TrendingDown className="w-3 h-3" /> Slipping
          </span>
        )}
        <button
          onClick={fetchEngagement}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Listening for reader feedback…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load consumer engagement'}</p>
            <button
              onClick={fetchEngagement}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && !graded && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            {reason === 'insufficient_votes'
              ? `Only ${eng?.n || 0} of ${minVotes} ratings needed have come in — the reception score firms up as readers leave 👍 / 👎 on the brief.`
              : `No reader has rated a morning brief in the last ${days} days yet — this fills in as clients leave 👍 / 👎 on the brief they receive.`}
          </div>
        )}

        {status === 'done' && graded && (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{pct}%</span>
                <span className="text-[11px] font-bold text-slate-400">found it useful</span>
              </div>
              <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
                {eng.helpful} of {eng.n} {eng.n === 1 ? 'rating' : 'ratings'} were 👍
                {eng.clients_graded > 0 ? ` · ${eng.clients_graded} of ${eng.clients_total} ${eng.clients_total === 1 ? 'client' : 'clients'} rated` : ''}
              </p>
            </div>

            <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${pct}%` }} />
            </div>

            {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}

            {watch.length > 0 && (
              <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/50 px-3 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-rose-500 mb-1.5 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Needs a look · {watch.length}
                </p>
                <div className="space-y-1">
                  {watch.slice(0, 5).map((c) => (
                    <div key={c.client_id} className="flex items-center gap-2 text-[11px]">
                      <span className="flex-1 truncate font-semibold text-slate-700" title={c.name || 'Unnamed client'}>{c.name || 'Unnamed client'}</span>
                      <span className="shrink-0 font-medium text-rose-600">
                        {c.label === 'poorly_received'
                          ? `landing flat · ${c.helpful_rate != null ? Math.round(c.helpful_rate * 100) : 0}%`
                          : 'reception slipping'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {board.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Who it's landing with</p>
                <div className="space-y-1.5">
                  {board.map((c) => (
                    <BriefEngagementClientRow key={c.client_id} client={c} watched={watchIds.has(c.client_id)} />
                  ))}
                </div>
              </div>
            )}

            <BriefEmphasisStrip emphasis={eng.emphasis} narrative={eng.emphasis_narrative} />
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The one <span className="font-semibold text-slate-500">outward</span> loop — every panel above is the system grading itself; this is the reader grading the brief.
          {' '}A client is graded once {minVotes}+ ratings land — thinner records abstain, never a rate off noise.
          {' '}<span className="font-semibold text-emerald-600">well received</span> ≥75% · <span className="font-semibold text-amber-600">fair</span> 50–74% · <span className="font-semibold text-rose-600">landing flat</span> &lt;50%.
          {' '}The aggregate is <span className="font-semibold text-slate-500">agency-only</span>; a client only ever sees their own vote.
        </p>
      </div>
    </section>
  )
}

/* ── emphasis efficacy — intel-v9 (20c): is the brief's self-tuning actually paying off? ────────
   The panel above is the ACT half of the engagement loop: layer 19 flexes tomorrow's supporting-
   cast cap on every reception grade — widen when well-received, tighten when fading. But it flexes
   with FIXED steps and never checks whether the flex WORKED. It could widen into a slow decline
   forever, or tighten when tightening does nothing. This is the rung that closes that gap — the
   first one that LEARNS WHETHER LAYER 19'S ACTIONS WORK. It reads GET /api/ai/brief-emphasis-
   efficacy (agency-only), where the engine pairs each persisted morning's emphasis DECISION with
   the reception that FOLLOWED — free, off history already on disk — and grades each direction
   against the control of mornings the brief held steady: widening should SUSTAIN reception,
   tightening should RECOVER it. From that it emits a BOUNDED, shrunk step-scale per direction
   (0.5×–1.25×) — temper aggressively on a bet that underperforms the control, endorse only modestly
   on one that beats it with confidence — the very knob a future controller feeds back to make
   layer 19 self-improving. Honest by abstention: a direction under a handful of decided outcomes
   abstains (no %, base step), and a thin history reads 'Listening', never a verdict off noise.
   PRIVACY (load-bearing): this is pure meta-telemetry over per-client reception no client may see —
   the narrator returns '' for the client audience unconditionally and none of the efficacy
   machinery crosses the client egress (proven in 20d). Sits right after the engagement panel so
   the page reads "the reader grading the brief" → "and the brief grading its own self-tuning."
   Self-fetching, USE_API-gated, agency-only. */
const EMPHASIS_EFFICACY_TONE = {
  endorsed:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', icon: ArrowUpCircle, label: 'Leaning in' },
  tempered:     { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   icon: RotateCcw,     label: 'Easing off' },
  steady:       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   icon: Minus,         label: 'Holding calibration' },
  insufficient: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   icon: Inbox,         label: 'Listening' },
}

// A direction's LEARNED step-scale, toned relative to the neutral base 1.0× (what layer 21 would
// feed back into deriveBriefEmphasis): >1 the loop is leaning into that bet (emerald), <1 it's
// easing off (amber), ==1 holding (slate). Mirrors the recommendation.{widen,tighten}_step_scale.
function stepScaleTone(scale) {
  const s = Number(scale)
  if (Number.isFinite(s) && s > 1.0) return { chip: 'bg-emerald-100 text-emerald-700', verb: 'leaning in', Icon: ArrowUpCircle }
  if (Number.isFinite(s) && s < 1.0) return { chip: 'bg-amber-100 text-amber-700',     verb: 'easing off', Icon: RotateCcw }
  return { chip: 'bg-slate-100 text-slate-600', verb: 'holding', Icon: Minus }
}

// widen is played from strength (carrying more should SUSTAIN reception); tighten from weakness
// (trimming to essentials should RECOVER it). The asymmetry is deliberate — it mirrors the bets
// layer 19 actually makes — so each card names what its direction was actually betting on.
const EMPHASIS_DIRECTION_META = {
  widen:   { icon: Sparkles, label: 'Widening',   verbed: 'sustained' },
  tighten: { icon: Scissors, label: 'Tightening', verbed: 'recovered' },
}

// Mirrors NOTE_MIN_N in briefEmphasisEfficacy.js — a direction is only graded (real %, real lift)
// once it has this many decided outcomes; thinner records abstain so we never show a rate off noise.
const EFFICACY_MIN_N = 4

// One direction's score → a three-state view, mirroring engagementClientView: 'none' (no mornings
// of that kind, —), 'thin' (a few but under the grading floor — still building, never a 0%),
// 'graded' (carries its shrunk efficacy % + point lift over the control).
function efficacyDirectionView(d) {
  const n = d?.n || 0
  if (!n)                 return { state: 'none',  n: 0, successes: 0 }
  if (n < EFFICACY_MIN_N) return { state: 'thin',  n, successes: d?.successes || 0 }
  return {
    state: 'graded', n,
    successes: d?.successes || 0,
    pct:    d?.efficacy != null ? Math.round(d.efficacy * 100) : null,
    liftPp: d?.lift != null ? Math.round(d.lift * 100) : null,
  }
}

// One per-direction card: the bet's icon · label · its LEARNED step-scale chip (always shown — it's
// the whole point of layer 20), then the shrunk efficacy %, the successes/mornings tally, and the
// point lift over the held-steady control. A direction below the grading floor shows a calm
// "building" line and a base ×1.00 chip; one with no mornings of its kind reads "none yet".
function EmphasisDirectionCard({ dir, score, stepScale, hasControl }) {
  const meta = EMPHASIS_DIRECTION_META[dir]
  const Icon = meta.icon
  const view = efficacyDirectionView(score)
  const st   = stepScaleTone(stepScale)
  const StepIcon = st.Icon
  const scaleLabel = Number.isFinite(Number(stepScale)) ? `×${Number(stepScale).toFixed(2)}` : '×1.00'
  return (
    <div className={cn('rounded-xl border px-3 py-2.5', view.state === 'graded' ? 'border-slate-100 bg-slate-50/40' : 'border-slate-100 bg-white')}>
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-[11px] font-black text-slate-700">{meta.label}</span>
        <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums', st.chip)} title={`Learned step-scale — the loop is ${st.verb}`}>
          <StepIcon className="w-2.5 h-2.5" /> {scaleLabel}
        </span>
      </div>
      {view.state === 'graded' ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-slate-900 leading-none tabular-nums">{view.pct}%</span>
            <span className="text-[10px] font-bold text-slate-400">{meta.verbed}</span>
          </div>
          <p className="mt-0.5 text-[10px] font-semibold text-slate-400 tabular-nums">{view.successes} of {view.n} mornings</p>
          {hasControl && view.liftPp != null && (
            <p className="mt-1 text-[10px] font-medium">
              <span className={cn('font-black tabular-nums', view.liftPp > 0 ? 'text-emerald-600' : view.liftPp < 0 ? 'text-amber-600' : 'text-slate-400')}>
                {view.liftPp > 0 ? '+' : ''}{view.liftPp} pp
              </span>
              <span className="text-slate-400"> vs holding steady</span>
            </p>
          )}
        </>
      ) : view.state === 'thin' ? (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400">{view.n} decided so far · building</p>
      ) : (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400">No {meta.label.toLowerCase()} mornings yet</p>
      )}
    </div>
  )
}

function BriefEmphasisEfficacyPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [eff, setEff]       = useState(null)
  const [error, setError]   = useState('')

  const fetchEfficacy = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const e = await api.getBriefEmphasisEfficacy()
      setEff(e); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load emphasis efficacy'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchEfficacy() }, [fetchEfficacy])

  const graded      = eff?.status === 'graded'
  const verdict     = eff?.recommendation?.verdict || 'insufficient'
  const tone        = EMPHASIS_EFFICACY_TONE[verdict] || EMPHASIS_EFFICACY_TONE.insufficient
  const VerdictIcon = tone.icon
  const narrative   = (eff?.narrative || '').trim()
  const days        = eff?.requested?.days || 90
  const dirs        = eff?.directions || {}
  const rec         = eff?.recommendation || {}
  const controlRate = eff?.control_rate
  const controlN    = eff?.control_n || 0
  const ctrlPct     = controlRate != null ? Math.round(controlRate * 100) : null

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Gauge className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Emphasis efficacy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Is the brief's self-tuning paying off · last {days} days
          </p>
        </div>
        {status === 'done' && graded && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Loop verdict: ${verdict}`}>
            <VerdictIcon className="w-3 h-3" /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchEfficacy}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Grading the loop's own moves…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load emphasis efficacy'}</p>
            <button
              onClick={fetchEfficacy}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && !graded && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            The reception loop hasn't flexed enough to grade yet — this fills in as widen / tighten mornings accrue the reception that follows.
            {controlN > 0 ? ` (${controlN} held-steady ${controlN === 1 ? 'morning' : 'mornings'} logged so far.)` : ''}
          </div>
        )}

        {status === 'done' && graded && (
          <>
            {narrative && <p className="text-sm text-slate-600 leading-relaxed">{narrative}</p>}

            <div className={cn('grid grid-cols-2 gap-2', narrative ? 'mt-3' : '')}>
              <EmphasisDirectionCard dir="widen"   score={dirs.widen}   stepScale={rec.widen_step_scale}   hasControl={controlRate != null} />
              <EmphasisDirectionCard dir="tighten" score={dirs.tighten} stepScale={rec.tighten_step_scale} hasControl={controlRate != null} />
            </div>

            {controlN > 0 && (
              <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 flex items-center gap-2">
                <Scale className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <p className="text-[11px] font-medium text-slate-500 leading-snug">
                  <span className="font-black text-slate-700 tabular-nums">{ctrlPct}%</span> of the{' '}
                  <span className="font-black text-slate-700 tabular-nums">{controlN}</span> {controlN === 1 ? 'morning' : 'mornings'} the brief held steady saw reception improve — the control every flex is measured against.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">self-improving</span> rung — the loop above flexes the brief's breadth on every reception grade; this grades whether the flex paid off and tunes the next one.
          {' '}<span className="font-semibold text-emerald-600">Widening</span> should sustain reception · <span className="font-semibold text-amber-600">tightening</span> should recover it.
          {' '}The learned step-scale stays bounded <span className="tabular-nums">0.5×–1.25×</span> — easy to ease off, earned to lean in.
          {' '}Agency-only; a reader never sees their attention being tuned.
        </p>
      </div>
    </section>
  )
}

/* ── emphasis control — intel-v9 (21c): the rung that CLOSES the second-order loop ──────────────
   The two panels above are the ACT and MEASURE halves of the engagement loop: layer 19 flexes
   tomorrow's supporting-cast cap on every reception grade, and layer 20 grades whether that flex
   paid off — emitting a bounded step-scale per direction. But until now nothing fed that grade
   BACK: layer 19 kept flexing with the same fixed ±1 step forever, deaf to its own measured track
   record. This is the rung that feeds it back — the CONTROLLER. It reads GET /api/ai/brief-
   emphasis-control (agency-only), pairs layer 19's reception-driven flex with layer 20's measured
   step-scale for that same direction, and adjusts the flex's MAGNITUDE by one gentle step: lean in
   (reach one row further) when the direction is measured to be paying off, ease off (pull one row
   back) when it isn't, hold (identity) when the measurement is neutral or not yet graded. So the
   system stops reacting to reception once and grading it forever — the grade re-shapes the next
   reaction. reception → flex (19) → efficacy (20) → scaled flex (21), the loop closed. SAFETY is
   asymmetric by design: leaning in is earned twice (reception says widen AND past widening measured
   as sustaining), easing off is always free, and the cap never leaves the [MIN_CAP, MAX_CAP] rails
   — the headline plus one row always survive. Honest by abstention: no flex to scale, or no measured
   efficacy → it passes 19's call through untouched and says so. PRIVACY (load-bearing): pure
   second-order meta-telemetry no client may see — the narrator returns '' for the client audience
   and none of the control vocabulary crosses the client egress (proven in 21d). Sits right after the
   efficacy panel so the page reads "the brief grading its own self-tuning" → "and the self-tuning
   re-tuning itself from that grade." Self-fetching, USE_API-gated, agency-only. */
const EMPHASIS_CONTROL_TONE = {
  lean_in:  { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: ArrowUpCircle, label: 'Leaning in',  shipText: 'text-emerald-700', shipBox: 'border-emerald-200 bg-emerald-50' },
  ease_off: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: RotateCcw,     label: 'Easing off',  shipText: 'text-amber-700',   shipBox: 'border-amber-200 bg-amber-50' },
  hold:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Minus,         label: 'Holding',     shipText: 'text-slate-500',   shipBox: 'border-slate-200 bg-slate-50' },
  none:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Inbox,         label: 'Standing by', shipText: 'text-slate-500',   shipBox: 'border-slate-200 bg-slate-50' },
}

// control_reason → one plain-English clause for the line beneath the pipeline. Kept free of every
// machine token (no step_scale / control_* / lean_in / ease_off) so it can ride the agency surface
// and reads as prose to a non-technical operator — the controller explaining itself in words.
const EMPHASIS_CONTROL_REASON = {
  efficacy_endorsed:     'past flexes this direction measured as paying off, so it reaches one row further',
  efficacy_tempered:     'past flexes this direction measured as not paying off, so it pulls one row back',
  efficacy_neutral:      'the measured outcome sits right at the neutral mark, so it holds the flex as it stands',
  no_flex_to_scale:      'the reception loop is holding the brief at its baseline breadth, so there is no flex to scale yet',
  insufficient_efficacy: 'not enough measured outcomes yet to know whether to lean in or ease off, so it holds 19’s call untouched',
}

// Layer 19's pre-control flex, as a short label: how far it moved the cap off the baseline, which way.
function preFlexLabel(ctrl) {
  const base = ctrl?.base_cap
  const pre  = ctrl?.emphasis_also_cap
  if (base == null || pre == null) return 'steady'
  if (pre > base) return `widen +${pre - base}`
  if (pre < base) return `tighten −${base - pre}`
  return 'steady'
}

function BriefEmphasisControlPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [ctrl, setCtrl]     = useState(null)
  const [error, setError]   = useState('')

  const fetchControl = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const c = await api.getBriefEmphasisControl()
      setCtrl(c); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load emphasis control'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchControl() }, [fetchControl])

  const move       = ctrl?.control_move || 'none'
  const tone       = EMPHASIS_CONTROL_TONE[move] || EMPHASIS_CONTROL_TONE.none
  const MoveIcon   = tone.icon
  const days       = ctrl?.requested?.days || 90
  const narrative  = (ctrl?.narrative || '').trim()
  const reasonText = EMPHASIS_CONTROL_REASON[ctrl?.control_reason] || ''
  // The controller ENGAGED (efficacy was graded → it ran the scale) on lean_in / ease_off / hold.
  // 'none' means it had nothing to act on (no flex, or efficacy not yet graded) — a calm standby.
  const engaged    = move === 'lean_in' || move === 'ease_off' || move === 'hold'
  const scale      = Number(ctrl?.step_scale)
  const scaleLabel = Number.isFinite(scale) ? `×${scale.toFixed(2)}` : '×1.00'
  const scaleColor = Number.isFinite(scale) && scale > 1 ? 'text-emerald-700'
    : Number.isFinite(scale) && scale < 1 ? 'text-amber-700' : 'text-slate-500'
  const preCap     = ctrl?.emphasis_also_cap
  const cap        = ctrl?.also_cap
  const reasonCap  = reasonText ? reasonText.charAt(0).toUpperCase() + reasonText.slice(1) + '.' : ''

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Emphasis control</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The self-tuning, re-tuned from its own grade · last {days} days
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Controller move: ${move}`}>
            <MoveIcon className="w-3 h-3" /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchControl}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Feeding the grade back into the next flex…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load emphasis control'}</p>
            <button
              onClick={fetchControl}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && !engaged && (
          <div className="flex items-start gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{reasonCap || 'The controller is standing by — it engages once the reception loop flexes and that flex earns a measured grade.'}</p>
          </div>
        )}

        {status === 'done' && engaged && (
          <>
            {/* the loop closing, left → right: 19 proposed → 20 measured → 21 shipped */}
            <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1.5">
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Reception flex</p>
                <p className="mt-1 text-2xl font-black text-slate-900 tabular-nums leading-none">{preCap}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">{preFlexLabel(ctrl)}</p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-300 shrink-0 mx-auto" />
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Measured</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', scaleColor)}>{scaleLabel}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">efficacy</p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-300 shrink-0 mx-auto" />
              <div className={cn('rounded-xl border-2 px-2 py-2.5 text-center', tone.shipBox)}>
                <p className={cn('text-[9px] font-bold uppercase tracking-wide', tone.shipText)}>Shipped</p>
                <p className="mt-1 text-2xl font-black text-slate-900 tabular-nums leading-none">{cap}</p>
                <p className={cn('mt-1 text-[10px] font-bold', tone.shipText)}>{tone.label}</p>
              </div>
            </div>

            {(narrative || reasonCap) && (
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative || reasonCap}</p>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The rung that <span className="font-semibold text-slate-500">closes the loop</span> — reception flexes the brief's breadth, efficacy grades the flex, and this feeds that grade back into the next flex's size.
          {' '}<span className="font-semibold text-emerald-600">Lean in</span> when a direction is paying off · <span className="font-semibold text-amber-600">ease off</span> when it isn't · hold otherwise.
          {' '}Leaning in is earned twice, easing off is always free, and the cap never leaves its rails.
          {' '}Agency-only; a reader never sees their attention being tuned.
        </p>
      </div>
    </section>
  )
}

/* ── controller stability — intel-v9 (22c): the GOVERNOR watching the controller ──────────────
   Layers 19→20→21 are a closed second-order loop: reception flexes the brief's breadth (19),
   efficacy grades the flex (20), the controller re-tunes the flex from that grade (21). A closed
   feedback loop can still misbehave over TIME — a controller that keeps reversing itself (HUNTING)
   or one pinned to a rail for days (SATURATION) is unstable even when each single move looked
   reasonable. This is the rung that watches the controller ACROSS mornings and, when it won't
   settle, self-heals by benching the tuner back to baseline (the 'damp' action the engine applies
   before it serializes tomorrow's policy). It reads GET /api/ai/brief-emphasis-control-health,
   agency-only. The hero is the controller's chosen breadth stepped across the trailing window
   against its [min, base, max] rails — instability is legible at a glance: a hunt zig-zags, a pin
   rides a rail, convergence flattens onto one row. PRIVACY (load-bearing): this verdict speaks
   pure control vocabulary (hunting / saturate / damp) and therefore rides NO serialized pack — it
   is recomputed only here, at read time, and the narrator returns '' for the client audience
   (proven in 22d). Sits right after the controller it polices. Self-fetching, USE_API-gated,
   agency-only. */
const CONTROL_HEALTH_TONE = {
  unstable:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',          icon: Activity,      label: 'Hunting',   line: 'stroke-rose-500' },
  constrained: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: AlertTriangle, label: 'Pinned',    line: 'stroke-amber-500' },
  stable:      { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: CheckCircle2,  label: 'Converged', line: 'stroke-emerald-500' },
  settling:    { pill: 'border-sky-200 bg-sky-50 text-sky-700',             icon: Gauge,         label: 'Settling',  line: 'stroke-sky-500' },
  idle:        { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Inbox,         label: 'Idle',      line: 'stroke-slate-300' },
  abstained:   { pill: 'border-slate-200 bg-slate-50 text-slate-400',       icon: Clock,         label: 'Building',  line: 'stroke-slate-300' },
}

// recommended_action → the self-heal lane, shown as a tile. 'damp' is the one autonomous repair:
// it benches the tuner to baseline. The rest are advisory postures the engine takes no action on.
const CONTROL_HEALTH_ACTION = {
  damp:          { label: 'Self-healing',  icon: Wrench,        cls: 'text-rose-700',    box: 'border-rose-200 bg-rose-50' },
  review_bounds: { label: 'Review bounds', icon: AlertTriangle, cls: 'text-amber-700',   box: 'border-amber-200 bg-amber-50' },
  trust:         { label: 'Trust',         icon: ShieldCheck,   cls: 'text-emerald-700', box: 'border-emerald-200 bg-emerald-50' },
  hold:          { label: 'Hold',          icon: Minus,         cls: 'text-slate-500',   box: 'border-slate-200 bg-slate-50' },
  none:          { label: 'Standing by',   icon: Inbox,         cls: 'text-slate-400',   box: 'border-slate-200 bg-slate-50' },
}

// move on each morning's node → dot fill on the track, so the eye reads WHY a step moved.
const CONTROL_MOVE_DOT = { lean_in: 'fill-emerald-500', ease_off: 'fill-amber-500', hold: 'fill-slate-300', none: 'fill-slate-200' }

// verdict_reason → one plain clause for the calm/abstained states (engaged states speak via the
// agency narrative). Kept free of machine tokens so it reads as prose on the agency surface.
const CONTROL_HEALTH_REASON = {
  control_settling:     'The tuner is mid-search — adjusting, but neither swinging nor stuck. No intervention yet.',
  controller_quiet:     'The tuner has been hands-off all window — there is nothing to steady.',
  insufficient_history: 'Not enough mornings yet to judge the tuner’s stability — it builds as the brief ships.',
}

// The controller's chosen breadth (cap) stepped across the trailing window, against its [min,
// base, max] rails. A step-line, not a smooth curve — the cap is a discrete row count, and a
// stepped path makes a hunt's reversals and a pin's flat ride read at a glance. Pure SVG, no deps.
function ControlHealthTrack({ series, bounds, tone }) {
  const pts = Array.isArray(series) ? series : []
  const W = 320, H = 76, padX = 8, padTop = 10, padBot = 10
  const innerW = W - padX * 2, innerH = H - padTop - padBot
  const loD = Math.min(bounds.min, bounds.base) - 0.5
  const hiD = Math.max(bounds.max, bounds.base) + 0.5
  const yFor = (v) => padTop + (1 - (v - loD) / (hiD - loD)) * innerH
  const xFor = (i) => pts.length <= 1 ? padX + innerW / 2 : padX + (i / (pts.length - 1)) * innerW
  let d = ''
  pts.forEach((p, i) => {
    const x = xFor(i), y = yFor(p.cap)
    if (i === 0) d += `M ${x.toFixed(1)} ${y.toFixed(1)}`
    else { const py = yFor(pts[i - 1].cap); d += ` L ${x.toFixed(1)} ${py.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}` }
  })
  const rail = (v, dash) => (
    <line x1={padX} x2={W - padX} y1={yFor(v)} y2={yFor(v)} className="stroke-slate-200" strokeWidth="1" strokeDasharray={dash || undefined} />
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Controller breadth across the trailing window against its rails">
      {bounds.max > bounds.base && rail(bounds.max)}
      {rail(bounds.base, '3 3')}
      {bounds.min < bounds.base && rail(bounds.min)}
      {pts.length > 0 && <path d={d} fill="none" className={tone.line} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {pts.map((p, i) => (
        <circle key={i} cx={xFor(i)} cy={yFor(p.cap)} r={i === pts.length - 1 ? 4 : 3} className={cn(CONTROL_MOVE_DOT[p.move] || CONTROL_MOVE_DOT.none, 'stroke-white')} strokeWidth="1.5" />
      ))}
    </svg>
  )
}

function BriefEmphasisControlHealthPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [health, setHealth] = useState(null)
  const [error, setError]   = useState('')

  const fetchHealth = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const h = await api.getBriefEmphasisControlHealth()
      setHealth(h); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load controller stability'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const vstatus    = health?.status || 'abstained'
  const tone       = CONTROL_HEALTH_TONE[vstatus] || CONTROL_HEALTH_TONE.abstained
  const StatusIcon = tone.icon
  const action     = health?.recommended_action || 'none'
  const act        = CONTROL_HEALTH_ACTION[action] || CONTROL_HEALTH_ACTION.none
  const ActIcon    = act.icon
  const ctl        = health?.control || {}
  const bounds     = health?.bounds || { min: 1, base: 3, max: 5 }
  const series     = Array.isArray(ctl.series) ? ctl.series : []
  const windowN    = health?.requested?.days || health?.window_used || 6
  const hasChart   = vstatus !== 'abstained' && series.length >= 2
  const damping    = action === 'damp'
  const narrative  = (health?.narrative || '').trim()
  const reasonLine = CONTROL_HEALTH_REASON[health?.verdict_reason] || ''
  const subLine    = narrative || reasonLine
  const pillLabel  = vstatus === 'constrained'
    ? (health?.verdict_reason === 'pinned_low' ? 'Pinned low' : 'Pinned high')
    : tone.label
  const flips      = Number.isFinite(Number(ctl.flips)) ? Number(ctl.flips) : 0
  const settledRun = Number.isFinite(Number(ctl.settled_run)) ? Number(ctl.settled_run) : 0

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Controller stability</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The governor watching the tuner for hunting &amp; saturation · trailing {windowN} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Controller health: ${vstatus}`}>
            <StatusIcon className="w-3 h-3" /> {pillLabel}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Watching the tuner settle…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load controller stability'}</p>
            <button
              onClick={fetchHealth}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && vstatus === 'abstained' && (
          <div className="flex items-start gap-2 text-sm text-slate-400 py-2">
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{reasonLine || 'Not enough mornings yet to judge the tuner’s stability — it builds as the brief ships.'}</p>
          </div>
        )}

        {status === 'done' && vstatus !== 'abstained' && (
          <>
            {damping && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                <Wrench className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <p className="text-[12px] font-semibold text-rose-700 leading-relaxed">
                  Self-healing — the tuner is reversing itself faster than it’s converging, so the governor benched it to baseline for tomorrow’s brief.
                </p>
              </div>
            )}

            {hasChart && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 pt-3 pb-2">
                <ControlHealthTrack series={series} bounds={bounds} tone={tone} />
                <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> lean-in</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> ease-off</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300" /> hold</span>
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-3 border-t border-dashed border-slate-300" /> baseline</span>
                </div>
              </div>
            )}

            <div className={cn('grid grid-cols-3 gap-1.5', hasChart && 'mt-3')}>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Swings</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', vstatus === 'unstable' ? 'text-rose-700' : 'text-slate-900')}>{flips}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">reversals</p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Settled</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', vstatus === 'stable' ? 'text-emerald-700' : 'text-slate-900')}>{settledRun}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">in a row</p>
              </div>
              <div className={cn('rounded-xl border-2 px-2 py-2.5 text-center flex flex-col items-center justify-center', act.box)}>
                <p className={cn('text-[9px] font-bold uppercase tracking-wide', act.cls)}>Action</p>
                <ActIcon className={cn('mt-1.5 w-5 h-5', act.cls)} />
                <p className={cn('mt-1 text-[10px] font-bold', act.cls)}>{act.label}</p>
              </div>
            </div>

            {subLine && (
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">{subLine}</p>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">governor</span> on the self-tuning loop — it watches the controller across mornings, not one move at a time.
          {' '}<span className="font-semibold text-rose-600">Hunting</span> (it keeps reversing) or <span className="font-semibold text-amber-600">pinned</span> (stuck on a rail) reads as unstable even when each move looked fine.
          {' '}When the tuner won’t settle the governor <span className="font-semibold text-rose-600">self-heals</span> — benching it to baseline — so a runaway loop can’t quietly distort the brief.
          {' '}Agency-only; a reader never sees their attention being tuned, let alone policed.
        </p>
      </div>
    </section>
  )
}

/* ── adaptive gain — intel-v9 (23c): schedule the CONTROLLER'S authority from the governor's record ─
   Layer 22 (above) is the ACUTE breaker — it watches the controller one window at a time and benches
   it to baseline the moment it hunts. THIS is the CHRONIC gain-schedule sitting over that same
   governor: it reads a HISTORY of 22's verdicts and, when hunting RECURS across mornings, narrows how
   far the controller is allowed to swing AT ALL (reach < max_reach), then restores the full range
   once the loop proves it has converged for a run of steady mornings. Reads
   GET /api/ai/brief-emphasis-control-tuning, agency-only. The hero is the controller's AUTHORITY
   ENVELOPE — its full structural swing range with the currently-allowed band filled inside: a
   narrowing reads as the colored band shrinking toward base, a freeze as it collapsing onto base.
   NON-CIRCULAR (load-bearing): the schedule is computed from the governor's read of the RAW
   controller, never the narrowed one, so the breaker keeps grading an un-tuned loop; the only trace a
   narrow leaves on a brief is a smaller breadth cap (a layer-19 projection). Speaks pure gain
   vocabulary (reach / authority / detune) → rides NO serialized pack, recomputed only here, narrator
   returns '' for clients (proven in 23d). Precedence: 22-acute-damp ▸ 23-chronic-narrow ▸ raw
   controller. Sits right after the governor it schedules. Self-fetching, USE_API-gated, agency-only. */
const CONTROL_TUNING_TONE = {
  default:  { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: CheckCircle2, label: 'Full range', fill: 'fill-emerald-400', swatch: 'bg-emerald-400' },
  detuned:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          icon: Scissors,     label: 'Narrowed',   fill: 'fill-rose-400',    swatch: 'bg-rose-400' },
  holding:  { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: Gauge,        label: 'Holding',    fill: 'fill-amber-400',   swatch: 'bg-amber-400' },
  restored: { pill: 'border-sky-200 bg-sky-50 text-sky-700',             icon: RotateCcw,    label: 'Restored',   fill: 'fill-sky-400',     swatch: 'bg-sky-400' },
}

// recommended_action → the self-heal lane, shown as a tile. reduce_authority (narrow) and
// restore_authority (hand back) are the two autonomous moves the scheduler makes; hold_authority is
// the hysteresis wait one notch below full; none is full-authority standing-by.
const CONTROL_TUNING_ACTION = {
  reduce_authority:  { label: 'Narrowing',   icon: Scissors,  cls: 'text-rose-700',  box: 'border-rose-200 bg-rose-50' },
  hold_authority:    { label: 'Holding',     icon: Gauge,     cls: 'text-amber-700', box: 'border-amber-200 bg-amber-50' },
  restore_authority: { label: 'Restoring',   icon: RotateCcw, cls: 'text-sky-700',   box: 'border-sky-200 bg-sky-50' },
  none:              { label: 'Standing by', icon: Inbox,     cls: 'text-slate-400', box: 'border-slate-200 bg-slate-50' },
}

// reason → one plain clause for the calm states (the engaged states speak via the agency narrative /
// banner). Kept free of machine tokens so it reads as prose on the agency surface.
const CONTROL_TUNING_REASON = {
  insufficient_history: 'Not enough governor mornings yet to schedule the controller’s range — it builds as the brief ships.',
  no_intervention:      'The controller has stayed steady all window — it keeps its full swing range.',
  awaiting_stability:   'The controller has stopped swinging but hasn’t proven it yet — its range stays trimmed a notch until it does.',
  hunting_active:       'The controller kept over-correcting, so its swing range has been narrowed to settle it.',
  stability_proven:     'The controller has proven steady again, so its full swing range was handed back.',
}

// The controller's AUTHORITY ENVELOPE: its full structural swing range [min..max] as the outer lane,
// with the currently-allowed (gain-scheduled) band [effective.min..effective.max] filled inside it.
// The slate showing past each end of the colored band is authority the tuner has surrendered while it
// proves it can stop hunting; frozen (reach 0) collapses to a marker on base. Pure SVG, no deps —
// mirrors ControlHealthTrack's footprint so the governor and its schedule read as siblings.
function AuthorityBandTrack({ effective, bounds, tone }) {
  const W = 320, H = 56, padX = 18
  const innerW = W - padX * 2
  const lo = Math.min(bounds.min, bounds.base, effective.min)
  const hi = Math.max(bounds.max, bounds.base, effective.max)
  const span = (hi - lo) || 1
  const xFor = (v) => padX + ((v - lo) / span) * innerW
  const laneY = 12, laneH = 16, r = 8
  const fX1 = xFor(bounds.min), fX2 = xFor(bounds.max)
  const eX1 = xFor(effective.min), eX2 = xFor(effective.max)
  const baseX = xFor(bounds.base)
  const frozen = (effective.max - effective.min) < 0.01
  const label = (x, t) => (
    <text x={x} y={laneY + laneH + 14} textAnchor="middle" className="fill-slate-400 text-[9px] font-bold">{t}</text>
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
         aria-label="Controller authority envelope: full swing range with the currently-allowed band filled inside">
      <rect x={fX1} y={laneY} width={Math.max(0, fX2 - fX1)} height={laneH} rx={r} className="fill-slate-100" />
      {frozen
        ? <circle cx={baseX} cy={laneY + laneH / 2} r={5} className={cn(tone.fill, 'stroke-white')} strokeWidth="1.5" />
        : <rect x={eX1} y={laneY} width={Math.max(0, eX2 - eX1)} height={laneH} rx={r} className={tone.fill} />}
      <line x1={baseX} x2={baseX} y1={laneY - 4} y2={laneY + laneH + 4} className="stroke-slate-400" strokeWidth="1.5" strokeDasharray="3 2" />
      {label(xFor(bounds.min), bounds.min)}
      {label(baseX, 'base')}
      {label(xFor(bounds.max), bounds.max)}
    </svg>
  )
}

function BriefEmphasisControlTuningPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [tune, setTune]     = useState(null)
  const [error, setError]   = useState('')

  const fetchTune = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const t = await api.getBriefEmphasisControlTuning()
      setTune(t); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load adaptive gain'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchTune() }, [fetchTune])

  const vstatus    = tune?.status || 'default'
  const tone       = CONTROL_TUNING_TONE[vstatus] || CONTROL_TUNING_TONE.default
  const StatusIcon = tone.icon
  const action     = tune?.recommended_action || 'none'
  const act        = CONTROL_TUNING_ACTION[action] || CONTROL_TUNING_ACTION.none
  const ActIcon    = act.icon
  const bounds     = tune?.bounds || { min: 1, base: 3, max: 5 }
  const effective  = tune?.effective_bounds || bounds
  const reach      = Number.isFinite(Number(tune?.reach)) ? Number(tune.reach) : 0
  const maxReach   = Number.isFinite(Number(tune?.max_reach)) ? Number(tune.max_reach) : 0
  const gov        = tune?.governor || {}
  const huntCount  = Number.isFinite(Number(gov.hunt_count)) ? Number(gov.hunt_count) : 0
  const windowN    = tune?.requested?.days || tune?.window_used || 6
  const narrative  = (tune?.narrative || '').trim()
  const reasonLine = CONTROL_TUNING_REASON[tune?.reason] || ''
  const building   = vstatus === 'default' && tune?.reason === 'insufficient_history'
  const frozen     = reach <= 0
  const narrowing  = action === 'reduce_authority'
  const restoring  = action === 'restore_authority'
  const showBanner = narrowing || restoring
  const subLine    = showBanner ? '' : (narrative || reasonLine)
  const hasChart   = !building && maxReach > 0
  const pillLabel  = vstatus === 'detuned' ? (frozen ? 'Frozen' : 'Narrowed') : tone.label

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Adaptive gain</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Scheduling the controller’s authority from the governor’s record · trailing {windowN} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Adaptive gain: ${vstatus}`}>
            <StatusIcon className="w-3 h-3" /> {pillLabel}
          </span>
        )}
        <button
          onClick={fetchTune}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the governor’s record…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load adaptive gain'}</p>
            <button
              onClick={fetchTune}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && building && (
          <div className="flex items-start gap-2 text-sm text-slate-400 py-2">
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{reasonLine || 'Not enough governor mornings yet to schedule the controller’s range — it builds as the brief ships.'}</p>
          </div>
        )}

        {status === 'done' && !building && (
          <>
            {narrowing && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                <Scissors className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <p className="text-[12px] font-semibold text-rose-700 leading-relaxed">
                  {frozen
                    ? 'Adaptive gain — the controller kept over-correcting morning after morning, so it’s been pinned to its baseline breadth until it stops swinging.'
                    : 'Adaptive gain — the controller kept over-correcting, so the range it’s allowed to swing was narrowed for tomorrow’s brief.'}
                </p>
              </div>
            )}

            {restoring && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5">
                <RotateCcw className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                <p className="text-[12px] font-semibold text-sky-700 leading-relaxed">
                  The controller has proven steady again for a run of mornings, so its full swing range was handed back.
                </p>
              </div>
            )}

            {hasChart && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 pt-3 pb-2">
                <AuthorityBandTrack effective={effective} bounds={bounds} tone={tone} />
                <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
                  <span className="inline-flex items-center gap-1"><span className={cn('w-2 h-2 rounded-full', tone.swatch)} /> allowed swing</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-200" /> full range</span>
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-3 border-t border-dashed border-slate-400" /> base</span>
                </div>
              </div>
            )}

            <div className={cn('grid grid-cols-3 gap-1.5', hasChart && 'mt-3')}>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Reach</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', vstatus === 'detuned' ? 'text-rose-700' : vstatus === 'restored' ? 'text-sky-700' : 'text-slate-900')}>{reach}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">of {maxReach} rows</p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Hunts</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', huntCount > 0 ? 'text-rose-700' : 'text-slate-900')}>{huntCount}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">of {windowN} mornings</p>
              </div>
              <div className={cn('rounded-xl border-2 px-2 py-2.5 text-center flex flex-col items-center justify-center', act.box)}>
                <p className={cn('text-[9px] font-bold uppercase tracking-wide', act.cls)}>Action</p>
                <ActIcon className={cn('mt-1.5 w-5 h-5', act.cls)} />
                <p className={cn('mt-1 text-[10px] font-bold', act.cls)}>{act.label}</p>
              </div>
            </div>

            {subLine && (
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">{subLine}</p>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">gain schedule</span> over the governor — it reads the governor’s record across mornings, not one window at a time.
          {' '}When hunting <span className="font-semibold text-rose-600">recurs</span>, it <span className="font-semibold text-rose-600">narrows</span> how far the controller may swing at all (a smaller breadth cap), and <span className="font-semibold text-sky-600">hands the full range back</span> once the loop proves it has converged.
          {' '}It schedules off the governor’s read of the <span className="font-semibold text-slate-500">raw</span> controller, so the breaker still grades an un-tuned loop.
          {' '}Agency-only; a reader never sees their attention being tuned, governed, or gain-scheduled.
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

// ── lead-policy REMEDIATION (17c) — "the remediator" ─────────────────────────
// The auditor (16) ESCALATES a churning lane to a human; this stages the concrete, bounded,
// reversible STRUCTURAL fix that answers that escalation — one agency click, never auto-applied,
// never touching the safety floor. A vocabulary disjoint from every layer below it: the governor
// resets one output, the remediator changes how the loop DERIVES that output. (briefLeadPolicyRemediation.js.)
// Remediation roll-up status → the header pill, its dot, its headline-icon tint.
const LEAD_REMEDY_TONE = {
  remediation_proposed: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'Fix staged', Icon: Wrench },
  steady:               { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Holding',    Icon: ShieldCheck },
  abstained:            { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Waiting',    Icon: Clock },
}

// each structural remedy → the card it wears + its escalation tint. The ladder deepens sky → amber →
// rose: widen (gentlest — absorb day-to-day noise) → tighten (firmer — shrink the swing) → pin (most
// decisive — out of the adaptive loop). The icon mirrors the move: sliders ease, scissors trim,
// crosshair fixes in place. The remedy ESCALATES by what's already been tried, never a fixed table.
const LEAD_REMEDY_KIND = {
  widen_neutral_band: { badge: 'border-sky-200 bg-sky-50 text-sky-700',     text: 'text-sky-600',   Icon: SlidersHorizontal, label: 'Widen dead-band', rung: 1 },
  tighten_bounds:     { badge: 'border-amber-200 bg-amber-50 text-amber-700', text: 'text-amber-600', Icon: Scissors,          label: 'Tighten bounds',  rung: 2 },
  pin_neutral:        { badge: 'border-rose-200 bg-rose-50 text-rose-700',    text: 'text-rose-600',  Icon: Crosshair,         label: 'Pin to neutral',  rung: 3 },
}

// why a lane was set aside instead of remediated. safety_floored is PROTECTIVE — we refuse to risk
// under-serving a real emergency, so the floor lane is never tuned down (a GOOD abstention, emerald).
// at_ceiling is OUT OF SAFE MOVES — already pinned and still churning, genuinely a human call (rose).
const LEAD_REMEDY_ABSTAIN = {
  safety_floored: { badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', text: 'text-emerald-600', Icon: ShieldCheck,  label: 'Safety floor', reason: 'the emergency lane — never tuned down, by design' },
  at_ceiling:     { badge: 'border-rose-200 bg-rose-50 text-rose-600',          text: 'text-rose-600',    Icon: AlertOctagon, label: 'At ceiling',   reason: 'every safe structural move is spent — a person decides the next step' },
}

// a knob value in two-decimal form so a from→to delta lines up column-true (0.00 → 0.10, 0.80 → 0.90).
const remedyN2 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—')

// the exact knob change a proposal makes, in plain words — the `from` the agency can revert to sits
// right beside the `to` it would apply, so the move reads as one bounded, reversible step.
function remedyDelta(p) {
  if (!p || typeof p !== 'object') return ''
  switch (p.remedy) {
    case 'widen_neutral_band':
      return `dead-band ${remedyN2(p.from?.neutral_band)} → ${remedyN2(p.to?.neutral_band)}`
    case 'tighten_bounds':
      return `bounds ${remedyN2(p.from?.bounds?.min)}–${remedyN2(p.from?.bounds?.max)} → ${remedyN2(p.to?.bounds?.min)}–${remedyN2(p.to?.bounds?.max)}`
    case 'pin_neutral':
      return 'adaptive → pinned at 1.0'
    default:
      return ''
  }
}

function leadRemedyHeadline(status, count) {
  switch (status) {
    case 'remediation_proposed':
      return count === 1
        ? 'A structural fix is staged — one click, fully reversible'
        : `${count} structural fixes are staged — one click each, fully reversible`
    case 'steady':
      return "Nothing to remediate — the governor's resets are holding on their own"
    default:
      return 'Not enough audited history yet to stage a structural fix'
  }
}

// One staged proposal: the lane, the remedy it would apply (icon + the exact from→to knob change),
// why, and the bounded/reversible affordances. severity = how many mornings the churn has stood — the
// same number that drove the auditor's escalation, carried straight through so the two layers agree.
function RemediationProposalCard({ proposal }) {
  const meta = LEAD_REMEDY_KIND[proposal?.remedy] || LEAD_REMEDY_KIND.widen_neutral_band
  const Icon = meta.Icon
  const severity = Number.isFinite(proposal?.severity) ? proposal.severity : 1
  const delta = remedyDelta(proposal)
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
        <span className="text-[11px] font-bold text-slate-700 truncate" title={laneLabel(proposal?.lane)}>{laneLabel(proposal?.lane)}</span>
        <span className={cn('ml-auto text-[11px] font-black tabular-nums', meta.text)}>{severity}× running</span>
      </div>
      {delta && (
        <div className="mt-1.5">
          <code className="inline-block rounded bg-white border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 tabular-nums">{delta}</code>
        </div>
      )}
      {proposal?.rationale && (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400 leading-relaxed">{proposal.rationale}</p>
      )}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">
          <Wrench className="w-2.5 h-2.5" /> One click to apply
        </span>
        {proposal?.reversible && (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-600">
            <RotateCcw className="w-2.5 h-2.5" /> Reversible
          </span>
        )}
      </div>
    </div>
  )
}

// One set-aside lane: why the remediator did NOT stage a structural fix for it. Protective floor
// abstentions read calm (emerald); at-ceiling abstentions read as the genuine hand-off they are (rose).
function RemediationAbstainRow({ lane, reason }) {
  const meta = LEAD_REMEDY_ABSTAIN[reason] || LEAD_REMEDY_ABSTAIN.at_ceiling
  const Icon = meta.Icon
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(lane)}>{laneLabel(lane)}</div>
        <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">{meta.reason}</div>
    </div>
  )
}

// The remediator that answers the loop the auditor only flags — "the remediator" (layer 17). Reads GET
// /api/ai/lead-policy-governance-remediation (agency-only): the auditor escalates a churning lane but
// the per-morning reset it keeps applying is STRUCTURALLY unable to fix it — neutralise resets the
// applied weight for one morning, never the knobs that re-derive that weight from noise the next. This
// computes the least-aggressive structural change that would actually still the loop — widen the lane's
// dead-band, tighten its bounds, or pin it to neutral — escalating by what's already been tried, and
// stages it for one agency click: bounded, reversible, never auto-applied, never on the safety floor.
// Closes the last open rung: SENSE→ACT→AUDIT→REMEDIATE, all but the click now in-loop. Never client-facing.
function LeadPolicyGovernanceRemediationPanel() {
  const [status, setStatus] = useState('loading')   // loading | done | error
  const [remediation, setRemediation] = useState(null)
  const [error, setError] = useState('')

  const fetchRemediation = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const r = await api.getLeadPolicyGovernanceRemediation()
      setRemediation(r); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load governance remediation'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchRemediation() }, [fetchRemediation])

  const st = remediation?.status || 'abstained'
  const tone = LEAD_REMEDY_TONE[st] || LEAD_REMEDY_TONE.abstained
  const HeadIcon = tone.Icon
  const proposals = Array.isArray(remediation?.proposals) ? remediation.proposals : []
  const abstained = Array.isArray(remediation?.abstained_lanes) ? remediation.abstained_lanes : []
  const narrative = (remediation?.narrative || '').trim()
  const headline = leadRemedyHeadline(st, proposals.length || 1)
  // remedy-kind tally, gentlest-first — only non-zero buckets, so a steady loop reads steady.
  const kinds = proposals.reduce((m, p) => { m[p?.remedy] = (m[p?.remedy] || 0) + 1; return m }, {})
  const tally = [
    kinds.widen_neutral_band > 0 ? `${kinds.widen_neutral_band} widen` : null,
    kinds.tighten_bounds > 0 ? `${kinds.tighten_bounds} tighten` : null,
    kinds.pin_neutral > 0 ? `${kinds.pin_neutral} pin` : null,
  ].filter(Boolean)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Wrench className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Governance remediation</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The structural fix behind the auditor's escalation
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Remediation: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchRemediation}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Computing the least-aggressive structural fix…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load governance remediation'}</p>
            <button onClick={fetchRemediation} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
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

            {tally.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {tally.join(' · ')}
                {abstained.length > 0 && <span className="text-slate-300"> · {abstained.length} set aside</span>}
              </p>
            )}

            {proposals.length > 0 ? (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Staged structural fixes, most-pressing first</p>
                <div className="space-y-2">
                  {proposals.map((p, i) => (
                    <RemediationProposalCard key={`${p?.lane}-${i}`} proposal={p} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {st === 'abstained'
                  ? 'No audited escalation to act on yet — the remediator waits until the auditor has flagged a churn.'
                  : "Nothing to restructure — the governor's safe resets are holding, so no knob needs changing."}
              </div>
            )}

            {abstained.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Set aside, not remediated</p>
                <div className="space-y-2.5">
                  {abstained.slice(0, 6).map((a, i) => (
                    <RemediationAbstainRow key={`${a?.lane}-${i}`} lane={a?.lane} reason={a?.reason} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The remediator.</span> The auditor escalates a churning lane; the per-morning reset can't fix it because it resets the <span className="font-semibold text-slate-600">output</span>, not the knobs that re-derive it. This stages the least-aggressive <span className="font-semibold text-sky-600">structural</span> change that would still the loop — widen the dead-band, tighten bounds, or pin to neutral — deepening only when the gentler move has already failed. Every fix is <span className="font-semibold text-amber-600">one click</span> and <span className="font-semibold text-emerald-600">reversible</span>; never auto-applied, never on the safety floor. Agency-only.
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

/* ── Budget reallocation (agency roster, PRESCRIPTIVE) ───────────────────────
   The first layer that doesn't just diagnose — it PROPOSES. For each client the engine compares
   the paid channels measuring the SAME outcome on realized cost-per-outcome, reads each channel's
   spend↔cost TREND (is the cost climbing the more we feed it?), and — when one channel is durably
   cheaper and the move is defensible — proposes ONE small, reversible TEST shift of weekly budget.
   Only 'reallocate' verdicts reach here (engine drops 'hold'/'insufficient'); sorted most-defensible
   first (confidence → gap → $ saved). Correlational hypotheses to test and watch, NEVER guarantees,
   and never a client scoreboard line — a media-buying call, so it's agency-only by construction. */
const REALLOC_SHOWN = 6   // cap the rows so a busy book stays a glance

// signal strength → chip + accent. 'strong' = the source's cost is CLIMBING as it scales while the
// target holds cheaper (the climbing-cost case — sharper indigo); 'tentative' = the target is simply
// cheaper right now, worth a modest test (softer indigo). Total map so an unexpected strength still
// renders a sane row. Indigo throughout = the "smart-money" hue, distinct from the rose/amber alarms
// above and the emerald recovery wins; the winning channel + the savings read in emerald inside the row.
const REALLOC_STRENGTH_META = {
  strong:    { label: 'Strong signal', chip: 'bg-indigo-50 text-indigo-700 border-indigo-200',  text: 'text-indigo-600', dot: 'bg-indigo-500' },
  tentative: { label: 'Worth testing', chip: 'bg-indigo-50/70 text-indigo-500 border-indigo-100', text: 'text-indigo-500', dot: 'bg-indigo-400' },
}
const reallocStrengthMeta = (s) => REALLOC_STRENGTH_META[s] || REALLOC_STRENGTH_META.tentative

// $/outcome + weekly $ shift → clean currency. Whole dollars once ≥ $100 or already integer (the
// common case for cpo + a budget slice); 1–2 dp only for small fractional values so a "$8.50" never
// renders "$8". null on non-finite → caller hides the clause.
function fmtReallocUsd(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  const abs = Math.abs(v)
  const digits = (Number.isInteger(v) || abs >= 100) ? 0 : abs >= 10 ? 1 : 2
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
// fraction (0.31, 0.12) → "31%" / "12%". null on non-finite → caller hides the clause.
const fmtReallocPct = (frac) => Number.isFinite(Number(frac)) ? `${Math.round(Number(frac) * 100)}%` : null

function ReallocationPanel({ data }) {
  const roster = Array.isArray(data?.roster) ? data.roster : []
  if (roster.length === 0) return null               // no defensible move → degrade to no panel
  const shown  = roster.slice(0, REALLOC_SHOWN)
  const hidden = roster.length - shown.length

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <ArrowLeftRight className="w-4 h-4 text-indigo-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Budget reallocation</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {roster.length} defensible spend shift{roster.length === 1 ? '' : 's'} · most-defensible first
        </span>
      </div>

      <div className="divide-y divide-slate-50">
        {shown.map((r) => <ReallocationRow key={`${r.client_id}:${r.from}:${r.to}:${r.outcome}`} r={r} />)}
      </div>

      {hidden > 0 && (
        <div className="px-4 py-2 bg-slate-50/40 border-t border-slate-50 text-center">
          <span className="text-[11px] font-semibold text-slate-400">+{hidden} more spend shift{hidden === 1 ? '' : 's'} to test</span>
        </div>
      )}

      <div className="px-4 py-2.5 bg-indigo-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          A move lands here when two paid channels chase the <span className="font-bold text-indigo-600">same outcome</span> and
          one is durably turning it out cheaper — the engine proposes a small, reversible <span className="font-bold text-indigo-600">test
          slice</span> of weekly budget and a metric to watch as it scales. These are correlational hypotheses to test and
          watch, not guarantees. Agency-only — clients never see the cross-account roster, only their own results.
        </p>
      </div>
    </div>
  )
}

/* One proposed shift: whose, the cheaper target vs the costlier source on realized $/outcome, the
   test slice to move, and the per-outcome savings. The left rail + headline gap read in the signal
   color; the shift line walks source → target with the winner + savings in emerald (the upside);
   the plain-English message is the media-buyer sentence; the right rail is the headline relative
   gap over a confidence meter (how much the trend + sample back the call). */
function ReallocationRow({ r }) {
  const meta    = reallocStrengthMeta(r.strength)
  const ol      = (r.outcome_label || 'outcome')
  const fromCpo = fmtReallocUsd(r.from_cpo)
  const toCpo   = fmtReallocUsd(r.to_cpo)
  const shift   = fmtReallocUsd(r.suggested_shift)
  const saved   = fmtReallocUsd(r.saved_per_outcome)
  const testPct = fmtReallocPct(r.test_fraction)
  const gapPct  = fmtReallocPct(r.gap_pct)
  const conf    = r.confidence == null ? null : Math.max(0, Math.min(100, Math.round(Number(r.confidence) * 100)))

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border', meta.chip)}>
          <ArrowLeftRight className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{r.client_name || 'Unknown'}</span>
            <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
              per {ol}
            </span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', meta.chip)}>
              {meta.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span className="font-bold text-slate-600">{r.from_label || 'source'}</span>
            {fromCpo && <span className="tabular-nums font-bold text-slate-500">{fromCpo}</span>}
            <ArrowRight className="w-3 h-3 text-slate-300" />
            <span className="font-bold text-emerald-600">{r.to_label || 'target'}</span>
            {toCpo && <span className="tabular-nums font-bold text-emerald-600">{toCpo}</span>}
            <span className="text-slate-300">/{ol}</span>
            {shift && (
              <>
                <span className="text-slate-300">·</span>
                <span>test <span className="tabular-nums font-bold text-indigo-600">{shift}</span>/wk{testPct ? ` (${testPct})` : ''}</span>
              </>
            )}
            {saved && (
              <>
                <span className="text-slate-300">·</span>
                <span>saves <span className="tabular-nums font-bold text-emerald-600">{saved}</span>/{ol}</span>
              </>
            )}
          </div>

          {r.message && (
            <p className="mt-1.5 text-[11px] font-medium text-slate-400 leading-relaxed">{r.message}</p>
          )}
        </div>

        <div className="shrink-0 text-right w-24">
          {gapPct != null && (
            <>
              <div className="text-lg font-black tabular-nums leading-none text-emerald-600">{gapPct}</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">lower cost</div>
            </>
          )}
          {conf != null && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className={cn('h-full rounded-full', meta.dot)} style={{ width: `${conf}%` }} />
              </div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5 tabular-nums">{conf}% confidence</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Reallocation calibration (intel-v10, layer 25) — the reallocation FEEDBACK LOOP ─────────
   Layer 24 proposes a budget shift and prints a confidence; until now nothing ever checked whether
   those bets paid off. This is the missing wire. It reconstructs every past proposal from the fact
   grain, re-measures what the cost-per-outcome gap ACTUALLY did over the weeks that followed, and
   grades each one vindicated (the edge held) / refuted (it collapsed or reversed). From the pooled
   record it derives the ONE knob the engine consumes — a confidence CALIBRATION: when past bets held
   up LESS often than their confidence implied it returns a factor < 1 that DAMPENS the next proposal;
   when they beat it, a factor > 1 (capped) that EMBOLDENS it; shrunk toward a neutral 1.0 at thin
   evidence so the loop never lurches. The system grading its own money moves. Indigo throughout (the
   smart-money hue it shares with the proposer); emerald = a bet that held, rose = one that faded.
   Agency-only by construction — an internal media-buying instrument, never a client scoreboard. */

// hit-rate band → chip + accent. 'high' = these bets reliably hold (emerald); 'medium' = mixed
// (indigo); 'low' = they rarely hold up (slate, the row to distrust). Total map → safe default.
const REALLOC_EFF_BAND_META = {
  high:   { label: 'Reliable',     chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-600', dot: 'bg-emerald-500' },
  medium: { label: 'Mixed',        chip: 'bg-indigo-50 text-indigo-700 border-indigo-200',    text: 'text-indigo-600',  dot: 'bg-indigo-500' },
  low:    { label: 'Rarely holds', chip: 'bg-slate-100 text-slate-500 border-slate-200',      text: 'text-slate-500',   dot: 'bg-slate-400' },
}
const reallocEffBandMeta = (b) => REALLOC_EFF_BAND_META[b] || REALLOC_EFF_BAND_META.medium

// confidence-band key → human label for the strength rows the calibration learns on.
const REALLOC_STRENGTH_LABEL = { strong: 'Strong-signal bets', moderate: 'Moderate bets', tentative: 'Tentative bets', unrated: 'Unrated bets' }
const reallocStrengthLabel = (k) => REALLOC_STRENGTH_LABEL[k] || (typeof k === 'string' && k ? `${k.charAt(0).toUpperCase()}${k.slice(1)} bets` : 'Bets')

// channel id → friendly label, so a 'meta->google_ads' pair key reads 'Facebook/Meta → Google Ads'.
const REALLOC_CHANNEL_LABEL = { google_ads: 'Google Ads', meta: 'Facebook/Meta', facebook: 'Facebook/Meta', lsa: 'Local Services', gbp: 'Google Business', ga4: 'GA4', tiktok: 'TikTok', bing: 'Microsoft Ads' }
const reallocChannelLabel = (id) => REALLOC_CHANNEL_LABEL[id] || (typeof id === 'string' && id ? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : id)
const reallocPairLabel = (key) => {
  const parts = String(key || '').split('->')
  return parts.length === 2 ? `${reallocChannelLabel(parts[0])} → ${reallocChannelLabel(parts[1])}` : String(key || '')
}

// calibration factor → verdict chip + tone. < 0.98 the engine is DAMPING future confidence (past bets
// underdelivered — amber caution); > 1.02 EMBOLDENING (they beat their confidence — emerald); else the
// proposer is well-calibrated and the knob is a no-op (indigo). Mirrors the module's basis thresholds.
function reallocCalVerdict(factor) {
  const f = Number(factor)
  if (!Number.isFinite(f) || (f > 0.98 && f < 1.02)) return { label: 'Well-calibrated', chip: 'bg-indigo-50 text-indigo-700 border-indigo-200', text: 'text-indigo-600', dot: 'bg-indigo-500', verb: 'holding steady' }
  if (f <= 0.98) return { label: 'Tempering', chip: 'bg-amber-50 text-amber-700 border-amber-200', text: 'text-amber-600', dot: 'bg-amber-500', verb: 'damping the next bet' }
  return { label: 'Emboldening', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-600', dot: 'bg-emerald-500', verb: 'leaning into the next bet' }
}
// factor → "×0.85" / "×1.10"; null on non-finite.
const fmtCalFactor = (f) => (Number.isFinite(Number(f)) ? `×${Number(f).toFixed(2)}` : null)
// fraction → integer percent for a meter width, clamped [0,100]; null passes through.
const reallocPctWidth = (frac) => (frac == null || !Number.isFinite(Number(frac)) ? null : Math.max(0, Math.min(100, Math.round(Number(frac) * 100))))

function ReallocationEfficacyPanel({ data }) {
  const cal     = data?.calibration || {}
  const overall = data?.overall || null
  if (!overall || !(Number(overall.n) > 0)) return null     // nothing old enough to grade → no panel

  const verdict   = reallocCalVerdict(cal.factor)
  const factorTxt = fmtCalFactor(cal.factor)
  const hitPct    = fmtReallocPct(overall.hit_rate)
  const confPct   = fmtReallocPct(cal.mean_confidence)
  const floorPct  = fmtReallocPct(overall.lower)
  const hold      = Number.isFinite(Number(overall.median_hold)) ? Number(overall.median_hold) : null
  const vind      = Number(overall.vindicated) || 0
  const refuted   = Number(overall.refuted) || 0
  const decided   = vind + refuted
  // two bars make the calibration legible at a glance: what we PROMISED (mean confidence) vs what
  // REALIZED (shrunk hit-rate). The gap between them is exactly why the factor moves off 1.0.
  const confW = reallocPctWidth(cal.mean_confidence)
  const hitW  = reallocPctWidth(overall.hit_rate)

  // strength rows that have earned a note (n ≥ NOTE_MIN_N server-side) lead; ranked is best-first already.
  const strengthRows = (Array.isArray(data?.ranked) && data.ranked.length ? data.ranked : (Array.isArray(data?.by_strength) ? data.by_strength : []))
  const pairs   = Array.isArray(data?.by_pair) ? data.by_pair.filter((p) => Number(p?.n) > 0).slice(0, 4) : []
  const clients = Array.isArray(data?.by_client) ? data.by_client.filter((c) => Number(c?.trials) > 0) : []

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Gauge className="w-4 h-4 text-indigo-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Reallocation calibration</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {decided} graded budget bet{decided === 1 ? '' : 's'} · self-tuning the next proposal
        </span>
      </div>

      {/* calibration hero — the factor the engine actually multiplies through, with promise-vs-realized bars */}
      <div className="px-4 py-4 bg-indigo-50/30 border-b border-slate-50">
        <div className="flex items-start gap-4">
          <div className="shrink-0">
            <div className={cn('text-3xl font-black tabular-nums leading-none', verdict.text)}>{factorTxt || '×1.00'}</div>
            <span className={cn('inline-flex items-center mt-1.5 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', verdict.chip)}>
              {verdict.label}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-slate-700 leading-snug">
              {vind} of {decided} past shift{decided === 1 ? '' : 's'} held up
              {hitPct ? <> — a <span className="text-indigo-600">{hitPct}</span> hit rate</> : null}
              {confPct ? <> against <span className="text-slate-500">{confPct}</span> assigned confidence</> : null}.
            </p>
            {cal.basis && <p className="mt-1 text-[11px] font-medium text-slate-400 leading-relaxed">The engine is {verdict.verb}: {cal.basis}.</p>}

            {(confW != null || hitW != null) && (
              <div className="mt-2.5 space-y-1.5 max-w-sm">
                {confW != null && (
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-[10px] font-semibold text-slate-400 shrink-0">promised</span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full bg-slate-300" style={{ width: `${confW}%` }} /></div>
                    <span className="w-9 text-right text-[10px] font-bold tabular-nums text-slate-500">{confW}%</span>
                  </div>
                )}
                {hitW != null && (
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-[10px] font-semibold text-slate-400 shrink-0">realized</span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className={cn('h-full rounded-full', verdict.dot)} style={{ width: `${hitW}%` }} /></div>
                    <span className={cn('w-9 text-right text-[10px] font-bold tabular-nums', verdict.text)}>{hitW}%</span>
                  </div>
                )}
              </div>
            )}

            <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
              <span className="inline-flex items-center gap-1"><Check className="w-3 h-3 text-emerald-500" />{vind} held</span>
              <span className="inline-flex items-center gap-1"><Minus className="w-3 h-3 text-rose-400" />{refuted} faded</span>
              {floorPct && <span>floor {floorPct}</span>}
              {hold != null && <span>edge usually held {Math.round(hold * 100)}%</span>}
            </div>
          </div>
        </div>
      </div>

      {/* by-confidence-band track record — which strengths actually hold, best-first */}
      {strengthRows.length > 0 && (
        <div className="divide-y divide-slate-50">
          {strengthRows.map((r) => <ReallocationEfficacyRow key={r.key} r={r} />)}
        </div>
      )}

      {/* per-pair + contributing accounts — the drill-down under the headline */}
      {(pairs.length > 0 || clients.length > 0) && (
        <div className="px-4 py-3 border-t border-slate-50 space-y-2.5">
          {pairs.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">By channel pair</p>
              <div className="flex flex-wrap gap-1.5">
                {pairs.map((p) => {
                  const bm = reallocEffBandMeta(p.band); const pct = fmtReallocPct(p.hit_rate)
                  return (
                    <span key={p.key} className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold rounded-full px-2 py-0.5 border', bm.chip)}>
                      <span className="font-bold">{reallocPairLabel(p.key)}</span>
                      {pct && <span className="tabular-nums">{pct}</span>}
                      <span className="opacity-60 tabular-nums">({Number(p.vindicated) || 0}/{Number(p.n) || 0})</span>
                    </span>
                  )
                })}
              </div>
            </div>
          )}
          {clients.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">Contributing accounts · {clients.length}</p>
              <div className="flex flex-wrap gap-1.5">
                {clients.slice(0, 8).map((c) => (
                  <span key={c.client_id} className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5">
                    <span className="font-bold text-slate-600 truncate max-w-[10rem]">{c.client_name}</span>
                    <span className="tabular-nums text-slate-400">{Number(c.trials) || 0}</span>
                  </span>
                ))}
                {clients.length > 8 && <span className="text-[10px] font-semibold text-slate-400 self-center">+{clients.length - 8} more</span>}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="px-4 py-2.5 bg-indigo-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Each past budget shift is re-graded against what the cost-per-outcome gap <span className="font-bold text-indigo-600">actually did</span> over
          the weeks that followed — <span className="font-bold text-emerald-600">held</span> or <span className="font-bold text-rose-500">faded</span> — and the
          pooled record tunes the confidence on the <span className="font-bold text-indigo-600">next</span> proposal: damped when bets underdeliver, emboldened
          when they beat it, neutral until the evidence earns a move. The engine grading its own money moves. Agency-only — an internal media-buying instrument.
        </p>
      </div>
    </div>
  )
}

/* One confidence band's track record: how often a bet PROPOSED at this strength actually held its
   cost edge over the following weeks. The hit-rate reads in the band color; the note is the grounded
   sentence the proposer can carry (present only once the band earns ≥ NOTE_MIN_N decided trials). */
function ReallocationEfficacyRow({ r }) {
  const bm       = reallocEffBandMeta(r.band)
  const hitPct   = fmtReallocPct(r.hit_rate)
  const floorPct = fmtReallocPct(r.lower)
  const vind     = Number(r.vindicated) || 0
  const refuted  = Number(r.refuted) || 0
  const n        = Number(r.n) || (vind + refuted)
  const hitW     = reallocPctWidth(r.hit_rate)

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800">{reallocStrengthLabel(r.key)}</span>
            <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', bm.chip)}>{bm.label}</span>
            <span className="text-[10px] font-semibold text-slate-400 tabular-nums">{vind}/{n} held{floorPct ? ` · floor ${floorPct}` : ''}</span>
          </div>
          {r.note && <p className="mt-1.5 text-[11px] font-medium text-slate-400 leading-relaxed">{r.note}</p>}
        </div>
        <div className="shrink-0 text-right w-24">
          {hitPct != null && (
            <>
              <div className={cn('text-lg font-black tabular-nums leading-none', bm.text)}>{hitPct}</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">held up</div>
            </>
          )}
          {hitW != null && (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className={cn('h-full rounded-full', bm.dot)} style={{ width: `${hitW}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Calibration stability (Layer 26, agency-only watchdog) ──────────────────
   The meta-monitor one level ABOVE the reallocation confidence tuner. The tuner (Layer 25) learns
   how much to trust the next budget shift and emits a factor in [CAL_MIN, CAL_MAX]; this watches
   that factor as a TIME SERIES for the two pathologies a single reading can never show:
     • HUNTING   — the factor thrashing up/down without ever settling. Self-healed: the watchdog
                   benches the tuner to a neutral ×1.00 (applied_factor) until the swing calms, so a
                   thrashing tuner can never move real money. The visible "took the wheel" moment.
     • PINNED    — the factor stuck against a clamp rail (chronically mis-calibrated). Surfaced as an
                   advisory to revisit the clamp; never auto-touched (the rail might be correct).
   Plus STARVED (too few graded shifts to tune on → neutral for lack of evidence, not confirmed
   calibration), SETTLING (still moving, not yet trusted) and STABLE (converged, trustworthy).
   stability_score ∈ [0,1] folds mean credibility × (1−flip rate), halved while pinned, into one
   trust read. Agency-only internal instrument — never a client number. */
function reallocHealthMeta(status) {
  switch (status) {
    case 'unstable':    return { label: 'Hunting',           chip: 'bg-rose-50 text-rose-700 border-rose-200',         text: 'text-rose-600',    dot: 'bg-rose-500',    ring: 'bg-rose-50/40',    Icon: AlertOctagon }
    case 'constrained': return { label: 'Pinned at a limit', chip: 'bg-amber-50 text-amber-700 border-amber-200',      text: 'text-amber-600',   dot: 'bg-amber-500',   ring: 'bg-amber-50/40',   Icon: ShieldAlert }
    case 'starved':     return { label: 'Awaiting evidence', chip: 'bg-slate-100 text-slate-600 border-slate-200',     text: 'text-slate-500',   dot: 'bg-slate-400',   ring: 'bg-slate-50/60',   Icon: Clock }
    case 'stable':      return { label: 'Settled',           chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-600', dot: 'bg-emerald-500', ring: 'bg-emerald-50/40', Icon: ShieldCheck }
    case 'settling':    return { label: 'Settling',          chip: 'bg-indigo-50 text-indigo-700 border-indigo-200',   text: 'text-indigo-600',  dot: 'bg-indigo-500',  ring: 'bg-indigo-50/40',  Icon: Activity }
    default:            return { label: 'Quiet',             chip: 'bg-slate-100 text-slate-500 border-slate-200',     text: 'text-slate-400',   dot: 'bg-slate-300',   ring: 'bg-slate-50/60',   Icon: Activity }
  }
}
// recommended_action → the plain-English "what we're doing about it" line. Keys mirror the module's
// verdict.recommended_action; 'none' (abstained) is empty since that verdict never renders a panel.
const REALLOC_HEALTH_ACTION = {
  distrust:       'Tuning benched — a neutral ×1.00 is applied until the swing settles.',
  review_bounds:  'The tuner is pinned against its limit — the clamp may be worth revisiting.',
  await_evidence: 'Too few resolved budget bets to tune on yet — holding neutral.',
  trust:          'The tuning has settled into a steady setting.',
  hold:           'Still moving — letting the tuning settle before trusting it.',
  none:           '',
}
// factor → bar height %, normalized within the tuner's own [min,max] bounds so the rails read full.
// min 8% so even a floor-pinned bar stays visible; neutral 50% when bounds are missing/degenerate.
const reallocHealthBarH = (factor, bounds) => {
  const lo = Number(bounds?.min), hi = Number(bounds?.max), f = Number(factor)
  if (![lo, hi, f].every(Number.isFinite) || hi <= lo) return 50
  return Math.max(8, Math.min(100, Math.round(((f - lo) / (hi - lo)) * 100)))
}
// per-setting direction → bar tint: embolden (leaned in, emerald) / damp (pulled back, amber) /
// hold (neutral, slate). Mirrors the calibration series' dir field.
const reallocHealthDirColor = (dir) => (dir === 'embolden' ? 'bg-emerald-400' : dir === 'damp' ? 'bg-amber-400' : 'bg-slate-300')

function ReallocationEfficacyHealthPanel({ data }) {
  if (!data || typeof data !== 'object') return null
  const status = String(data.status || '')
  if (!status || status === 'abstained') return null      // no verdict worth showing → no panel
  const cal     = data.calibration || {}
  const meta    = reallocHealthMeta(status)
  const Icon    = meta.Icon
  // applied = what the watchdog actually lets through (neutral when benched); fall back to the last
  // observed factor when the engine didn't echo applied_factor.
  const applied = Number.isFinite(Number(data.applied_factor)) ? Number(data.applied_factor) : Number(cal.last_factor)
  const raw     = Number.isFinite(Number(data.raw_factor)) ? Number(data.raw_factor) : null
  const benched = !!data.distrust
  const appliedTxt = fmtCalFactor(applied) || '×1.00'
  const rawTxt     = fmtCalFactor(raw)
  const stab    = Number(data.stability_score)
  const stabPct = Number.isFinite(stab) ? Math.round(stab * 100) : null
  const credPct = fmtReallocPct(cal.mean_credibility)
  const action  = REALLOC_HEALTH_ACTION[String(data.recommended_action || '')] || ''
  const narration = typeof data.narration === 'string' && data.narration.trim() ? data.narration.trim() : ''
  const series  = Array.isArray(cal.series) ? cal.series : []
  const flips   = Number(cal.flips) || 0
  const highRun = Number(cal.high_run) || 0
  const lowRun  = Number(cal.low_run) || 0
  const settled = Number(cal.settled_run) || 0
  const railRun = Math.max(highRun, lowRun)
  const window  = Number(data.window_used) || series.length || 0
  const decided = Array.isArray(data.decision_weeks) ? data.decision_weeks.length : (Number(data.decision_weeks) || 0)

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center shrink-0"><Activity className="w-4 h-4 text-slate-500" /></div>
        <h2 className="text-sm font-black text-slate-900">Calibration stability</h2>
        <span className="text-[11px] font-semibold text-slate-400">watchdog over the reallocation tuner{window ? ` · last ${window} run${window === 1 ? '' : 's'}` : ''}</span>
        <span className={cn('ml-auto inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 border', meta.chip)}><Icon className="w-3 h-3" />{meta.label}</span>
      </div>
      <div className={cn('px-4 py-4 border-b border-slate-50', meta.ring)}>
        <div className="flex items-start gap-4">
          <div className="shrink-0">
            <div className={cn('text-3xl font-black tabular-nums leading-none', meta.text)}>{appliedTxt}</div>
            <span className="block mt-1 text-[10px] font-semibold text-slate-400">applied to next bet</span>
          </div>
          <div className="min-w-0 flex-1">
            {benched && rawTxt ? (
              <p className="text-xs font-bold text-slate-700 leading-snug inline-flex items-center gap-1.5 flex-wrap">Tuner proposed <span className="text-slate-400 line-through tabular-nums">{rawTxt}</span><ArrowRight className="w-3 h-3 text-rose-400" /><span className={cn('tabular-nums', meta.text)}>{appliedTxt}</span><span className="text-rose-600">— held at neutral</span></p>
            ) : (
              <p className="text-xs font-bold text-slate-700 leading-snug">The confidence tuner is <span className={meta.text}>{meta.label.toLowerCase()}</span>{rawTxt ? <> at a proposed <span className="text-slate-500 tabular-nums">{rawTxt}</span></> : null}.</p>
            )}
            {action && <p className="mt-1 text-[11px] font-medium text-slate-400 leading-relaxed">{action}</p>}
            {stabPct != null && (
              <div className="mt-2.5 max-w-sm"><div className="flex items-center gap-2"><span className="w-16 text-[10px] font-semibold text-slate-400 shrink-0">stability</span><div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className={cn('h-full rounded-full', meta.dot)} style={{ width: `${stabPct}%` }} /></div><span className={cn('w-9 text-right text-[10px] font-bold tabular-nums', meta.text)}>{stabPct}%</span></div></div>
            )}
            <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
              <span className="inline-flex items-center gap-1"><ArrowLeftRight className="w-3 h-3 text-slate-400" />{flips} swing{flips === 1 ? '' : 's'}</span>
              {railRun > 0 && <span className="inline-flex items-center gap-1"><ShieldAlert className="w-3 h-3 text-amber-400" />{railRun} at limit</span>}
              {settled > 0 && <span className="inline-flex items-center gap-1"><Check className="w-3 h-3 text-emerald-500" />{settled} settled</span>}
              {credPct && <span>evidence {credPct}</span>}
              {decided > 0 && <span>{decided} graded</span>}
            </div>
          </div>
        </div>
      </div>
      {series.length > 1 && (
        <div className="px-4 py-3 border-b border-slate-50">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-2">Last {series.length} settings</p>
          <div className="flex items-end gap-1 h-12">
            {series.map((s, i) => { const h = reallocHealthBarH(s.factor, data.bounds); const last = i === series.length - 1; return (
              <div key={s.as_of || i} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${s.as_of || ''} ${fmtCalFactor(s.factor) || ''}`.trim()}><div className={cn('w-full rounded-sm', reallocHealthDirColor(s.dir), last ? 'ring-2 ring-slate-300 ring-offset-1' : 'opacity-70')} style={{ height: `${h}%` }} /></div>
            )})}
          </div>
        </div>
      )}
      {narration && (
        <div className="px-4 py-3 border-b border-slate-50"><p className="text-[11px] font-medium text-slate-500 leading-relaxed inline-flex items-start gap-1.5"><Stethoscope className="w-3.5 h-3.5 text-slate-400 mt-px shrink-0" /><span>{narration}</span></p></div>
      )}
      <div className="px-4 py-2.5 bg-slate-50/50 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">This watches the budget-shift <span className="font-bold text-slate-600">confidence tuner</span> across time for the two failures a single setting can't show: <span className="font-bold text-rose-500">hunting</span> (the setting thrashing without settling — automatically <span className="font-bold text-slate-600">held at neutral</span> until it calms) and a setting <span className="font-bold text-amber-600">pinned</span> at its limit (chronically mis-calibrated — surfaced, never auto-touched). The safeguard that lets the tuner self-correct without ever running away. Agency-only — an internal instrument.</p>
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
