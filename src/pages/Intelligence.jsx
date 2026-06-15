import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Plug, Loader2, AlertTriangle, Inbox, Eye } from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { kindMeta } from '@/lib/insightMeta'
import ImpactBanner from '@/components/ImpactBanner'
import OpsHealthStrip from '@/components/OpsHealthStrip'
import MemoryHealthBadge from '@/components/MemoryHealthBadge'
import { useLiveStream } from '@/lib/useLiveStream'
import { Hero, StatCard, Pill, FieldLabel, EmptyAllClear, InsightCard, FiredAlertsPanel, TriageRoster, WeeklyRecapPanel } from '@/components/intelligence/IntelShared'
import { PipelineHealthPanel } from '@/components/intelligence/PipelinePanels'
import { MorningBriefPanel, BriefHealthPanel, BriefImpactPanel, BriefEngagementPanel, BriefEmphasisEfficacyPanel, BriefEmphasisControlPanel, BriefEmphasisControlHealthPanel, BriefEmphasisControlTuningPanel } from '@/components/intelligence/BriefPanels'
import { LeadPolicyPanel, LeadPolicyHealthPanel, LeadPolicyGovernancePanel, LeadPolicyGovernanceAuditPanel, LeadPolicyGovernanceRemediationPanel } from '@/components/intelligence/LeadPolicyPanels'
import { PulseBriefingBanner, ActTodayStrip, PulsePanel } from '@/components/intelligence/PulsePanels'
import { TrajectoryPanel, PacingPanel, ReallocationPanel, ReallocationEfficacyPanel, ReallocationEfficacyHealthPanel, SystemicPanel, BenchmarkPanel, RecoveriesPanel, EfficacyPanel } from '@/components/intelligence/PerformancePanels'

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
  const [firedAlerts, setFiredAlerts] = useState([])   // alert inventory — last 100 fired alerts (agency-only)
  const [lastLoadedAt, setLastLoadedAt] = useState(null)   // Build F: recency chip + auto-refresh
  const [nowTick,      setNowTick]      = useState(0)      // increments every 30s to refresh age label
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
      const [feed, roster, bench, recov, sys, traj, pace, eff, pls, realloc, realloEff, realloEffHealth, alertLog] = await Promise.allSettled([
        api.getInsights(), api.getPortfolioHealth(), api.getBenchmarks(), api.getRecoveries(), api.getSystemic(), api.getTrajectory(), api.getPacing(), api.getEfficacy(), api.getPulse(), api.getReallocation(), api.getReallocationEfficacy(), api.getReallocationEfficacyHealth(), api.getFiredAlerts(100),
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
      setFiredAlerts(alertLog.status === 'fulfilled' && Array.isArray(alertLog.value?.alerts) ? alertLog.value.alerts : [])
      setStatus('done')
      setLastLoadedAt(Date.now())   // Build F: stamp recency for the stale chip
    } catch (e) {
      setError(e?.message || 'Failed to load insights')
      setStatus('error')
    }
  }, [])

  useEffect(() => { if (USE_API) load() }, [load])

  // Live stream (intel-v13 C2): the SSE pipe drives the header's StreamStatus badge
  // and keeps the feed self-refreshing. We NEVER read the event payload (it can carry
  // another tenant's id) — an event is only a "something changed" pulse. On activity we
  // debounce one quiet reload so a burst of webhooks collapses into a single refresh; the
  // nightly engine still owns the heavy sweeps. Gated on USE_API like every read here.
  const refetchTimer = useRef(null)
  const onLiveActivity = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => { load() }, 4000)
  }, [load])
  const { connected: liveConnected, lastEventAt: liveLastEventAt } =
    useLiveStream({ enabled: USE_API, onActivity: onLiveActivity })
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current) }, [])
  // Build F: 5-minute auto-refresh — safety net when SSE is slow or disconnected
  useEffect(() => {
    if (!USE_API) return
    const t = setInterval(load, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [load])
  // Build F: 30-second tick to keep the "X min ago" recency chip live
  useEffect(() => {
    const t = setInterval(() => setNowTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

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
      <Hero running={running} onRun={runSweep} connected={liveConnected} lastEventAt={liveLastEventAt} ageMin={lastLoadedAt != null ? Math.floor((Date.now() - lastLoadedAt) / 60_000) : null} />

      {/* influence hero (intel-v12 B3) — the honest, weighted tally of what the autonomous
          analyst actually MOVED: leads recovered, jobs protected, dollars defended (risk-
          adjusted), with the named clients behind it and the agency narration. It makes the
          whole intelligence layer's value legible at a glance, and earns the slot right under
          the run control. Self-fetching the PORTFOLIO ledger, USE_API-gated, and SILENT until
          there's a real, non-empty headline — never a "$0 delivered" hero on a fresh portfolio.
          Agency-only by construction (dollars + per-client attribution); the client's vaguer
          "your wins" line is the separate leak-proof B4 seam. */}
      {USE_API && <ImpactBanner />}

      {/* autonomy liveness (ops-v1) — the thin, honest proof the self-healing engine behind
          every panel below is actually RUNNING on-cadence, not silently dead. Reads the
          job_heartbeats ledger grade (GET /api/insights/ops) and renders one tone-mapped pill:
          live · last run Xm ago · N/N on cadence · M self-heals this week. It sits ABOVE pipeline
          health because it is more foundational — if the scheduler itself stalled, every feed
          below would silently go stale. Agency-only (no client identifiers; 403s a client token),
          USE_API-gated, and SILENT on any read error so a ledger fault hides the badge, never the page. */}
      {USE_API && <OpsHealthStrip />}
      {USE_API && <MemoryHealthBadge className="mt-1" />}

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
      {firedAlerts.length > 0 && <FiredAlertsPanel alerts={firedAlerts} />}
    </div>
  )
}

