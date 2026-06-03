import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'
import {
  TrendingUp, ChevronDown, LogOut, ArrowUp, ArrowDown,
  LayoutDashboard, Smartphone, BarChart2, Zap,
  CheckCircle, AlertCircle, Clock, Sparkles, Target, SlidersHorizontal, Activity,
  Award, Minus, ArrowUpRight, RefreshCw, ShieldCheck,
  AlertTriangle, Crosshair, Eye, Radar,
} from 'lucide-react'
import { fmt$$, fmtN, fmtPct, delta, weekLabel } from '@/lib/utils'
import { clearToken, getUser } from '@/lib/auth'
import { USE_API, api } from '@/lib/api'
import { severityMeta, kindMeta, urgencyMeta, isClientFacing, forecastRange, fmtMetricValue, attributionView, correlateView, escalationView, healthBandMeta, metricLabel, recoveryMeta, timeAgo, recapPosture } from '@/lib/insightMeta'
import { useCountUp } from '@/lib/useCountUp'
import BudgetSimulator from '@/components/BudgetSimulator'
import GoalRing from '@/components/GoalRing'
import TeamUpdate from '@/components/TeamUpdate'
import CampaignList from '@/components/CampaignList'
import MonthlyTrend from '@/components/MonthlyTrend'
import AskBox from '@/components/AskBox'
import DriverBreakdown from '@/components/DriverBreakdown'
import { useAgency } from '@/lib/agencySettings'

const PERIOD_OPTS = [
  { value: 'this_week', label: 'Last 7 Days' },
  { value: 'last_4w',   label: 'Last 30 Days' },
  { value: 'last_8w',   label: 'Last 60 Days' },
  { value: 'all_time',  label: 'All Time' },
]

// ── Verdict logic (shared with ExecView) ─────────────────────────────────────
function verdictFor({ revenue, revDelta, roas, leads, jobs }) {
  if (revenue <= 0) return null
  const roasStrong  = roas >= 3
  const roasOk      = roas >= 1.5
  const revGrowing  = revDelta > 2
  const revFalling  = revDelta < -5
  const closeRate   = leads > 0 ? (jobs / leads) * 100 : 0
  const closingWell = closeRate >= 20
  if (roasStrong && revGrowing && closingWell)
    return { status: 'Strong Performance', color: 'emerald',
      text: `Revenue is up ${revDelta.toFixed(0)}% and every $1 in marketing is returning $${roas.toFixed(2)}. Growth is healthy.` }
  if (roasOk && !revFalling)
    return { status: 'Steady Growth', color: 'amber',
      text: `Marketing ROI is positive at ${roas.toFixed(1)}×${revGrowing ? ` with revenue trending up ${revDelta.toFixed(0)}%` : ', consistent with last period'}. Performance is on track.` }
  if (!roasOk && leads > 0 && closeRate < 15)
    return { status: 'Conversion Opportunity', color: 'rose',
      text: `Leads are coming in but only ${closeRate.toFixed(0)}% are closing. Faster follow-up typically doubles booking rates.` }
  if (revFalling)
    return { status: 'Review Underway', color: 'rose',
      text: `Revenue is down ${Math.abs(revDelta).toFixed(0)}% vs last period. A channel review is in progress to identify the adjustment needed.` }
  return { status: 'Building Momentum', color: 'slate',
    text: `Campaign is ramping up. Expect clearer performance signals after a full period of data.` }
}

// ── Narrative hero headline (Change 2) ───────────────────────────────────────
// Reads like a letter from your accountant — no jargon, bold the numbers that matter
function buildNarrative({ revenue, jobs, roas, leads, spend }) {
  const bold = txt => <span className="font-black text-white">{txt}</span>

  if (revenue > 0 && jobs > 0 && roas >= 1) {
    return (
      <>
        Your marketing brought in {bold(`${jobs} ${jobs === 1 ? 'job' : 'new jobs'}`)} worth{' '}
        {bold(fmt$$(revenue))} this period. Every $1 you spent returned{' '}
        {bold(`$${roas.toFixed(2)}`)}.
      </>
    )
  }
  if (revenue > 0 && jobs > 0) {
    return (
      <>
        Your campaigns generated {bold(`${jobs} ${jobs === 1 ? 'job' : 'jobs'}`)} and{' '}
        {bold(fmt$$(revenue))} in revenue. We're actively optimizing ad targeting
        to push your return higher.
      </>
    )
  }
  if (leads > 0) {
    return (
      <>
        We drove {bold(`${fmtN(leads)} new ${leads === 1 ? 'lead' : 'leads'}`)} to your business
        this period.{jobs > 0 ? <> Of those, {bold(`${jobs} became ${jobs === 1 ? 'a paying job' : 'paying jobs'}`)}.</> : ''}
        {' '}Fast follow-up is the single biggest lever to increase bookings.
      </>
    )
  }
  if (spend > 0) {
    return (
      <>
        {bold(fmt$$(spend))} invested in campaigns this period. Results will show
        here as leads come in and convert to booked jobs.
      </>
    )
  }
  return <>Connect your marketing channels so we can show you exactly what's working.</>
}

// ── Dynamic account team bullets — generated from live performance data ───────
// Returns 3 bullets tuned to the client's actual situation this period
function buildAccountTeamBullets({ roas, leads, jobs, closeRate, spend, revDelta }) {
  const bullets = []

  // Bullet 1 — ad efficiency signal
  if (roas > 0 && roas < 1.5) {
    bullets.push({ icon: '🔬', text: `Your ROAS is at ${roas.toFixed(1)}× — we've audited your campaigns and are reallocating budget away from underperforming ad sets to bring cost per lead down.` })
  } else if (roas >= 3) {
    bullets.push({ icon: '📈', text: `Your campaigns are returning ${roas.toFixed(1)}× — above the 3–5× industry benchmark. We're scaling budget into the top-performing ad sets this week.` })
  } else if (spend > 0) {
    bullets.push({ icon: '📊', text: `Reviewing campaign-level performance to identify which channels to scale. ROAS is positive at ${roas > 0 ? roas.toFixed(1) + '×' : 'building'} — optimizing creative and audience targeting.` })
  } else {
    bullets.push({ icon: '🚀', text: 'Setting up your initial campaign structure, audience targeting, and attribution so every lead is tracked back to the channel that drove it.' })
  }

  // Bullet 2 — conversion signal
  if (closeRate > 0 && closeRate < 15) {
    bullets.push({ icon: '⚡', text: `Your close rate is ${closeRate.toFixed(0)}% — we're reviewing your lead follow-up sequence timing. Studies show responding within 5 minutes increases booking rates by up to 40%.` })
  } else if (closeRate >= 25) {
    bullets.push({ icon: '🎯', text: `Strong ${closeRate.toFixed(0)}% close rate — your sales process is firing well. We're focused on increasing lead volume at the same quality level to scale revenue.` })
  } else if (leads > 0) {
    bullets.push({ icon: '🎯', text: `Refining targeting to improve lead quality and reduce the gap between inquiries and booked estimates. Current close rate is ${closeRate.toFixed(0)}%.` })
  } else {
    bullets.push({ icon: '🎯', text: 'Analyzing competitor ad positioning and audience intent signals to build a targeting strategy that attracts higher-intent leads for your market.' })
  }

  // Bullet 3 — trend or reporting signal
  if (revDelta !== null && revDelta < -5) {
    bullets.push({ icon: '🔄', text: `Revenue is down ${Math.abs(revDelta).toFixed(0)}% vs last period — a full channel review is underway to identify whether this is a volume or conversion issue and correct it.` })
  } else if (revDelta !== null && revDelta > 10) {
    bullets.push({ icon: '📋', text: `Revenue is up ${revDelta.toFixed(0)}% vs last period — preparing your next performance summary with channel attribution and week-over-week trend analysis.` })
  } else {
    bullets.push({ icon: '📋', text: 'Preparing your next performance summary with week-over-week trend analysis and channel attribution breakdown — delivered every Monday morning.' })
  }

  return bullets
}

// ── Data source setup checklist ──────────────────────────────────────────────
// Shown in client view when < 4 sources are connected.
// Tells the client (or agency) what each connection unlocks.
const SOURCE_DEFS = [
  {
    key:     'ghl',
    label:   'CRM (GoHighLevel)',
    unlocks: 'Leads, closed jobs, pipeline stages, and revenue tracking',
    impact:  'highest',
  },
  {
    key:     'google_ads',
    label:   'Google Ads',
    unlocks: 'Paid search spend, impressions, clicks, and ROAS',
    impact:  'high',
  },
  {
    key:     'google_lsa',
    label:   'Google Local Service Ads',
    unlocks: 'LSA call volume, booked jobs, and local ad spend',
    impact:  'high',
  },
  {
    key:     'meta',
    label:   'Meta Ads',
    unlocks: 'Facebook and Instagram campaign performance + lead attribution',
    impact:  'medium',
  },
  {
    key:     'gbp',
    label:   'Google Business Profile',
    unlocks: 'Local visibility: profile views, calls, and direction requests',
    impact:  'medium',
  },
  {
    key:     'ga4',
    label:   'Google Analytics 4',
    unlocks: 'Website sessions, organic traffic, and conversion paths',
    impact:  'medium',
  },
]

function SourceChecklist({ connectedKeys, isAgency: agencyMode }) {
  const total     = SOURCE_DEFS.length
  const connected = SOURCE_DEFS.filter(s => connectedKeys.has(s.key)).length
  const pct       = Math.round((connected / total) * 100)
  const barColor  = connected >= 4 ? '#10b981' : connected >= 2 ? '#f59e0b' : '#e53935'

  if (connected >= 4) return null  // Dismiss once 4+ connected

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.05s' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Data Sources</p>
          <p className="text-sm font-black text-slate-800 mt-0.5">
            {connected} of {total} connected
          </p>
        </div>
        {agencyMode && (
          <Link
            to="/connections"
            className="text-xs font-black text-brand-500 hover:text-brand-600 transition-colors"
          >
            Connect Sources →
          </Link>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mb-4">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>

      {/* Source list */}
      <div className="space-y-2.5">
        {SOURCE_DEFS.map(s => {
          const ok = connectedKeys.has(s.key)
          return (
            <div key={s.key} className="flex items-start gap-3">
              <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                ok ? 'bg-emerald-100' : 'bg-slate-100'
              }`}>
                {ok
                  ? <CheckCircle className="w-3 h-3 text-emerald-500" />
                  : <span className="w-2 h-2 rounded-full bg-slate-300" />}
              </span>
              <div className="min-w-0">
                <p className={`text-xs font-black leading-none ${ok ? 'text-slate-700' : 'text-slate-400'}`}>
                  {s.label}
                  {s.impact === 'highest' && !ok && (
                    <span className="ml-1.5 text-[9px] font-black uppercase tracking-wide text-rose-500 bg-rose-50 px-1.5 py-0.5 rounded">
                      Most Impact
                    </span>
                  )}
                </p>
                {!ok && (
                  <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">{s.unlocks}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Agency note */}
      {agencyMode && (
        <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50">
          Checklist hides automatically once 4 or more sources are active.
        </p>
      )}
    </div>
  )
}

// ── Intelligence findings — the autonomous analyst, in the client's own words ──
// The consumer cut of the same feed the agency sees on /intelligence: capped to
// the top few, stripped of operator chrome (ack/resolve, evidence audit, the
// AI-verified badge), and filtered to client-facing kinds via isClientFacing()
// so an internal data-pipeline alert never lands on a client's screen. Every
// string — title, detail, and the recommended action — is computed by the engine
// (no model in the render path), so it's accurate by construction and renders the
// same whether or not an API key is present. Pairs each observation ("what we
// noticed") with its recommendation ("what we'll do about it"), which is exactly
// the transparency-plus-reassurance a client wants from a performance report.
function ClientInsights({ insights }) {
  const visible = (insights || []).filter(
    i => isClientFacing(i) && i.status !== 'resolved' && i.status !== 'expired',
  )
  const items = visible.slice(0, 3)
  const more  = visible.length - items.length

  if (items.length === 0) return null

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.19s' }}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">What We're Watching</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>

      <div className="space-y-3">
        {items.map(item => {
          const sev      = severityMeta(item.severity)
          const kind     = kindMeta(item.kind)
          const KindIcon = kind.icon
          const action   = item.recommended_action
          const urg      = action ? urgencyMeta(action.urgency) : null
          const UrgIcon  = urg ? urg.icon : null
          // Self-tuned prediction band, if this forecast earned one. Client-appropriate:
          // a confident, honest range reassures, where the agency-only precision chip
          // ("your team ignores these") would not. Null → no line, a clean point.
          const range    = forecastRange(item)
          // The model-free "why" (lib/attribution.js), reduced to the single lever that
          // moved the number most. Null for non-composite metrics → no line, exactly as
          // before. The operator-facing signed-share breakdown stays on /intelligence.
          const attribution = attributionView(item)
          // Upstream root-cause link, softened for the client (correlateView). The agency
          // sees the named dark channel + reconnect on /intelligence; the client gets only a
          // calm "we're restoring a reporting source" note — the channel is the agency's to
          // reconnect, and naming it would read as a defect the client can't act on. Null → no note.
          const cause = correlateView(item)
          // The recommendation's earned track record (lib/efficacy.js), already client-safe by
          // construction: the engine only stamps efficacy_note onto an adverse, advised finding
          // whose play archetype has a PROVEN pooled recovery rate (n≥4 decided outcomes), and the
          // text quotes only that play's OWN rate — it names no peer and exposes no other client.
          // Turns "here's what we'll do" into "here's what we'll do, and here's how often it has
          // worked for problems like this" — the self-improving loop made visible as honest
          // credibility. Null → no line, exactly as before.
          const efficacy = item.efficacy_note
          // Auto-escalation, softened for the client (escalationView). When lib/escalation.js has
          // PROVEN the usual play ineffective it bumps the urgency AND rewrites recommended_action.text
          // with a CANDID, agency-facing clause ("cleared the problem only X% of the time (s of n) —
          // escalate…"). That sentence is right for /intelligence but must NEVER reach the client: it
          // exposes a failure statistic and internal ops language. So here we render escalation.clientText
          // INSTEAD — a calm "we're changing our approach" — and (below) SUPPRESS the efficacy_note, which
          // would otherwise brag about a track record this very escalation just declared insufficient.
          // Non-escalated findings are untouched: escalation is null and the original advice renders as before.
          const escalation = escalationView(item)
          const recommendationText = escalation?.clientText || action?.text
          return (
            <div
              key={item.id}
              className="rounded-xl border border-slate-100 bg-slate-50/40 p-3.5"
              style={{ borderLeftWidth: 3, borderLeftColor: sev.accent }}
            >
              {/* Observation — what the analyst noticed, grounded in the numbers */}
              <div className="flex items-start gap-2.5">
                <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${sev.chipBg}`}>
                  <KindIcon className={`w-3.5 h-3.5 ${sev.chipText}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-slate-800 leading-snug">{item.title}</p>
                  {item.detail && (
                    <p className="text-xs text-slate-500 leading-relaxed mt-0.5">{item.detail}</p>
                  )}
                  {/* The "why" in plain language — the engine's model-free driver
                      decomposition (lib/attribution.js), reduced to the single lever that
                      moved the number most. Honest and reassuring: it names the cause in the
                      client's own terms ("driven mostly by leads") without the operator-facing
                      signed-share breakdown the agency sees. Null → no line. */}
                  {attribution && (
                    <div className="mt-1.5 flex items-start gap-1.5">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-slate-600 leading-relaxed font-medium">
                        Driven mostly by <span className="font-bold text-slate-800">{attribution.lead.label}</span>
                        {attribution.lead.dirWord !== 'flat' && (
                          <>, {attribution.lead.dirWord} <span className="tabular-nums">{attribution.lead.pctAbs}%</span></>
                        )}.
                      </p>
                    </div>
                  )}
                  {/* Root-cause link, softened (correlateView). The symptom anomaly is
                      client-facing, but the dark channel behind it is the agency's to
                      reconnect — so we acknowledge a reporting source is being restored
                      WITHOUT naming the channel, its share, days dark, or "reconnect" (all
                      agency-only on /intelligence). Calm reassurance, no defect to act on. */}
                  {cause && (
                    <div className="mt-1.5 flex items-start gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-slate-600 leading-relaxed font-medium">
                        Part of this traces to a reporting source we&rsquo;re restoring — your team is already on it.
                      </p>
                    </div>
                  )}
                  {/* Likely range — the self-tuned prediction band in plain English.
                      Its width is the engine's own realized forecast accuracy for THIS
                      client, so it tightens as we earn it — honest, not a bare guess. */}
                  {range && (
                    <div className="mt-2 flex items-start gap-1.5">
                      <Target className="w-3.5 h-3.5 text-brand-600 shrink-0 mt-0.5" />
                      <p className="text-xs text-slate-600 leading-relaxed font-medium">
                        Projected around <span className="font-bold text-slate-800">{fmtMetricValue(item.metric, range.point)}</span> this month — likely{' '}
                        <span className="tabular-nums">{fmtMetricValue(item.metric, range.lo)}</span> to{' '}
                        <span className="tabular-nums">{fmtMetricValue(item.metric, range.hi)}</span>
                        {range.pct != null ? <span className="text-slate-400"> ({range.pct}% confidence)</span> : null}.
                      </p>
                    </div>
                  )}
                  {/* Goal-in-band reassurance — the calibrated alarm (lib/insights.js#detectForecast)
                      eased the severity because the goal still falls inside the likely range above.
                      Client-framed as encouragement, not the operator-facing "alarm softened": an
                      honest "still in reach" read straight off the same band, so it can never
                      contradict the projection the client is looking at. */}
                  {range && range.goalInBand && (
                    <div className="mt-1.5 flex items-start gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-emerald-700 leading-relaxed font-semibold">
                        Your goal is still within reach this month.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Recommendation — what we'll do about it. When escalated, recommendationText is
                  the softened escalation.clientText (the candid agency text is suppressed); otherwise
                  it's the engine's original advice. */}
              {recommendationText && (
                <div className="mt-3 rounded-lg bg-white border border-slate-100 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    {urg && (
                      <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${urg.chip}`}>
                        <UrgIcon className="w-3 h-3" /> {urg.label}
                      </span>
                    )}
                    <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Our Recommendation</span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed font-medium">{recommendationText}</p>
                  {/* Earned-credibility line — the recommendation's own proven success rate, in
                      plain English (efficacy_note.text). Sits UNDER the advice, divided off, as a
                      quiet "and it tends to work" — never a claim the client must act on. The text
                      is the engine's, peer-free; null → nothing renders, exactly as before.
                      SUPPRESSED when escalated: an escalation means this very play's record proved
                      INSUFFICIENT, so bragging "it tends to work" right under "we're changing approach"
                      would directly contradict itself. The two are mutually exclusive by design. */}
                  {!escalation && efficacy?.text && (
                    <div className="mt-2 pt-2 border-t border-slate-50 flex items-start gap-1.5">
                      <Award className="w-3.5 h-3.5 text-brand-600 shrink-0 mt-0.5" />
                      <p className="text-xs text-slate-500 leading-relaxed font-medium">{efficacy.text}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-[10px] text-slate-400 mt-3.5 pt-3 border-t border-slate-50 leading-relaxed">
        {more > 0 ? `+${more} more ${more === 1 ? 'item' : 'items'} your account team is tracking. ` : ''}
        Flagged automatically by your account's AI analyst and reviewed by your team every Monday.
      </p>
    </div>
  )
}

// ── Recently Resolved — the "what we fixed" win list, client-framed ────────────
// The visible payoff of the self-improving loop. The engine flags a problem, watches
// it, and when the number climbs back into its normal range it marks the finding
// RECOVERED on its own — no human closes it. This surface shows the client only the
// wins they can feel: filtered through isClientFacing, so agency-internal recoveries
// (a reconnected reporting source — coverage_gap) never appear here; those are the
// team's plumbing, not the client's outcome. A quiet week renders nothing.
const CLIENT_WINS_SHOWN = 3
function ClientWins({ recoveries }) {
  const rows  = (recoveries || []).filter(isClientFacing)
  const items = rows.slice(0, CLIENT_WINS_SHOWN)
  const more  = rows.length - items.length
  if (items.length === 0) return null
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.17s' }}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Recently Resolved</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      <div className="space-y-3">
        {items.map(r => <ClientWinRow key={r.id} r={r} />)}
      </div>
      <p className="text-[10px] text-slate-400 mt-3.5 pt-3 border-t border-slate-50 leading-relaxed">
        {more > 0 ? `+${more} more resolved this month. ` : ''}
        Your account&rsquo;s AI analyst watches every issue it flags and clears it automatically the
        moment your numbers recover — nothing needed on your end.
      </p>
    </div>
  )
}
function ClientWinRow({ r }) {
  const meta     = recoveryMeta(r.recovery_reason)
  const Icon     = meta.icon
  const ago      = timeAgo(r.recovered_at)
  const metric   = r.metric ? metricLabel(r.metric) : null
  const baseline = r.recovery_reason === 'metric_returned_to_baseline'
  const headline = baseline && metric ? `Your ${metric} is back to normal` : metric ? `${metric} resolved` : 'Resolved'
  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-emerald-100">
          <Icon className="w-3.5 h-3.5 text-emerald-600" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-black text-slate-800 leading-snug">{headline}</p>
            <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-700 bg-emerald-100 rounded-full px-1.5 py-0.5">
              <CheckCircle className="w-3 h-3" /> Resolved
            </span>
            {ago && (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 shrink-0">
                <Clock className="w-3 h-3" /> {ago}
              </span>
            )}
          </div>
          {r.title && (
            <p className="text-xs text-slate-500 leading-relaxed mt-1 line-through decoration-slate-300">{r.title}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Account Health — the one-number verdict, client-framed ─────────────────────
// The same pure synthesis the agency triage roster runs (lib/health.js, surfaced
// for staff on /intelligence) — every open finding for this client compounded into
// one 0–100 score and band — but rewritten for the people the report is about. The
// roster answers "which client do I open first?"; here there's only one client, so
// the count dots, the client name, and the "biggest drag" severity jargon all fall
// away. What's left is the honest headline a client actually wants: a confident
// score, a plain-language read of where things stand, and — when the engine has
// isolated the lever — the area it's mostly about, named in their own words ("your
// ad return"), never an operator severity. Renders even at a perfect 100 (no
// findings → healthy) so an all-clear account gets the big green reassurance, not a
// blank space; the parent gates it out only for an empty/unconnected account where a
// "100" would be a fiction rather than a verdict. Band colours come from the shared
// healthBandMeta() vocabulary, so this badge and the agency roster can never drift
// on what "Watch" looks like.
function AccountHealth({ health }) {
  if (!health) return null
  const m      = healthBandMeta(health.band)
  const score  = Math.max(0, Math.min(100, Math.round(Number(health.score) || 0)))
  const driver = health.driver
  // Plain-language read per band — transparency without alarm. Where the agency sees
  // "3 critical · biggest drag: revenue", the client sees the same posture phrased as
  // where things stand and that their team is already on it.
  const READ = {
    healthy:  "Everything's running smoothly across your account right now.",
    watch:    "A few things we're keeping an eye on — nothing that needs you today.",
    at_risk:  "A couple of areas need attention, and your team is already on them.",
    critical: "We've flagged the priorities and your team is actively working on them.",
  }
  const read = READ[health.band] || READ.healthy
  // Name the area the score is mostly about, in friendly terms — only when the engine
  // isolated a driver and the score isn't already perfect (a 100 has no drag to name).
  const area = driver && score < 100 ? metricLabel(driver.metric) : null

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.06s' }}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Account Health</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>

      <div className="flex items-center gap-4">
        {/* Score — the marquee number, painted in the band colour */}
        <div className="shrink-0 text-center w-20">
          <div className={`text-4xl font-black tabular-nums leading-none ${m.text}`}>{score}</div>
          <div className="text-[10px] font-bold text-slate-300 mt-1">out of 100</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-2.5">
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider rounded-full px-2.5 py-0.5 border ${m.chip}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} /> {m.label}
            </span>
            <Activity className={`w-3.5 h-3.5 ${m.text}`} />
          </div>
          {/* Meter — the score on a 0–100 track, filled in the band colour */}
          <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-700 ${m.bar}`} style={{ width: `${score}%` }} />
          </div>
        </div>
      </div>

      <p className="text-sm text-slate-600 leading-relaxed font-medium mt-4">
        {read}
        {area && (
          <> Right now that's mostly around your <span className="font-bold text-slate-800">{area}</span>.</>
        )}
      </p>
    </div>
  )
}

// ── Your Week in Review — the grounded weekly recap, in the client's own inbox words ──
// lib/recap.js writes one plain-English narration of each client's most recently completed
// week, grounded so every number in it was checked against the same verified facts the rest
// of this page is scored from, and ships it in the Monday email. This surfaces that exact
// recap in-app so the client can reread it any day — first the story of the week, then a
// compact "where things stand now" coda built from the recap's own CLIENT-SAFE intelligence
// digest (recapPosture → counts and area names only, never a severity statistic, a failure
// percentage, or another client). Like the rest of this surface the operator machinery stays
// backstage: no "regenerate", no model name, and no verification badge (the client view
// deliberately omits it — the grounding still happens, it just isn't chrome the client needs
// to see). Self-hides when there's no recap text yet.
function WeeklyRecap({ recap }) {
  const text = (recap?.recap_text || '').trim()
  if (!text) return null
  const period  = recap?.evidence_pack?.period?.label || recap?.week_start || ''
  const posture = recapPosture(recap.evidence_pack)
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.065s' }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Your Week in Review</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      {period && (
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400 mb-3">
          <Clock className="w-3 h-3" /> {period}
        </div>
      )}
      <p className="text-sm text-slate-600 leading-relaxed font-medium whitespace-pre-line">{text}</p>
      {posture && <RecapPostureCoda p={posture} />}
      <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50 leading-relaxed">
        The same recap that opens your Monday email — written by your account&rsquo;s AI analyst from your
        verified numbers, and reviewed by your team every week.
      </p>
    </div>
  )
}

// The recap's compact "where things stand now" coda — the client-safe intelligence digest
// (recapPosture) rendered as a row of calm chips. Severity jargon is dropped (no critical /
// warning split, unlike the agency strip) and the labels are softened ("being watched",
// "refining") so it reassures rather than alarms. Each chip is conditional and the set
// mirrors recapPosture's own signal test, so a quiet week that carries, say, only pacing
// signal still renders the right chips and never an empty row.
function RecapPostureCoda({ p }) {
  return (
    <div className="mt-4 pt-3 border-t border-slate-50">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Where things stand now</p>
      <div className="flex flex-wrap gap-1.5">
        {p.active > 0 && <RecapChip icon={Activity} tone="slate" label={`${p.active} being watched`} />}
        {p.adjustingCount > 0 && <RecapChip icon={SlidersHorizontal} tone="amber" label={`Refining ${p.adjusting.join(', ') || 'approach'}`} />}
        {p.improvingCount > 0 && <RecapChip icon={TrendingUp} tone="emerald" label={`Improving ${p.improving.join(', ')}`} />}
        {p.onTrack > 0 && <RecapChip icon={Target} tone="emerald" label={`${p.onTrack} on pace`} />}
        {p.atRisk > 0 && <RecapChip icon={AlertCircle} tone="rose" label={`${p.atRisk} need${p.atRisk === 1 ? 's' : ''} a push`} />}
      </div>
    </div>
  )
}

const RECAP_CHIP_TONES = {
  slate:   'text-slate-600 bg-slate-50 border-slate-200',
  amber:   'text-amber-700 bg-amber-50 border-amber-200',
  emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  rose:    'text-rose-700 bg-rose-50 border-rose-200',
}
function RecapChip({ icon: Icon, tone, label }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold ${RECAP_CHIP_TONES[tone] || RECAP_CHIP_TONES.slate}`}>
      <Icon className="w-3 h-3 shrink-0" /> {label}
    </span>
  )
}

// Friendly weekday framing for the brief's as-of date ('2026-06-02' → 'Monday, Jun 2'). Parsed
// from parts as a LOCAL date so it never slips a day across the UTC-midnight boundary the way
// new Date('YYYY-MM-DD') would; any unparseable value falls through to the raw string unchanged.
function fmtBriefDay(raw) {
  const s = String(raw || '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

// ── Your Morning Brief — the grounded AI read of THIS morning, in the client's own words ──
// lib/pulseBrief.js writes one short plain-English read of where the week IN PROGRESS stands —
// grounded so every number in it was checked against the same verified facts the rest of this
// page is scored from — and it's the very text that will open the client's next morning note.
// WeeklyRecap above tells the client how LAST week CLOSED; this is today's fresh read, days
// before the next Monday recap. Client-safe by construction: buildClientBriefPack hands down
// only this account's OWN period / posture / focus / memory and strips every peer name, severity
// statistic, and reliability/accuracy/tuning_* key, so nothing backstage can leak through. Like
// the rest of this surface the operator machinery stays hidden — no "regenerate", no model name,
// no confidence chip, no verification badge (the grounding still happens; it just isn't chrome
// the client needs to see). posture renders in the client's voice (Looking good / Worth a glance /
// Needs a look), never the agency-internal act/watch words. Self-hides when there's no brief yet.
function ClientMorningBrief({ brief }) {
  const text = (brief?.brief_text || '').trim()
  if (!text) return null
  const day     = fmtBriefDay(brief?.pack?.period?.label || brief?.as_of)
  const posture = PULSE_POSTURE_CLIENT[brief?.pack?.posture] || null
  // Honest, pre-narrated trust line — present in the pack ONLY when our recent morning
  // leads have earned it (server folds in narrateBriefImpact's 'client' branch, '' otherwise).
  // No grade, percentage or machinery ever reaches here — just the one sentence, or nothing.
  const reinforcement = (brief?.pack?.impact_reinforcement || '').trim()
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.072s' }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Your Morning Brief</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      {(posture || day) && (
        <div className="flex items-center gap-2 mb-3">
          {posture && (
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${posture.dot}`} />
              <span className={`text-[11px] font-bold ${posture.text}`}>{posture.label}</span>
            </span>
          )}
          {day && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
              <Clock className="w-3 h-3" /> {day}
            </span>
          )}
        </div>
      )}
      <p className="text-sm text-slate-600 leading-relaxed font-medium whitespace-pre-line">{text}</p>
      {reinforcement && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-2">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-px" />
          <p className="text-[11px] font-semibold text-emerald-800 leading-relaxed">{reinforcement}</p>
        </div>
      )}
      <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50 leading-relaxed">
        A fresh read each morning — written by your account&rsquo;s AI analyst from your verified
        numbers, days before your Monday recap.
      </p>
    </div>
  )
}

// ── How You Compare — the client's own peer standing, fully anonymized ─────────
// The same cross-client benchmark the agency sees on /intelligence (lib/benchmark.js),
// reduced to ONLY this client's placement against the anonymous portfolio — never a
// peer's id, name, or value. The server (clientStanding) already withholds any metric
// whose cohort is too thin to publish AND any where this client has no finite
// percentile, so a sparse portfolio simply yields fewer rows and an unbenchmarkable
// account yields none → the panel hides. Percentile is direction-aware "how good", so
// the bar fills the same way whether the metric runs up (roas) or down (cpl), and the
// 50% mark is always the typical account. Best-first from the API → leads with wins:
// the honest, client-framed mirror of the agency's leader/laggard chips.
function MyStanding({ benchmark }) {
  const rows = Array.isArray(benchmark?.standing) ? benchmark.standing : []
  if (rows.length === 0) return null
  const n     = benchmark.cohort_size
  const weeks = benchmark.period?.weeks || 4

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.13s' }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">How You Compare</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      <p className="text-xs text-slate-500 font-medium mb-4 leading-relaxed">
        Where your account stands against {n ? `${n} other account${n === 1 ? '' : 's'}` : 'the rest of the portfolio'} we manage — fully anonymized.
      </p>

      <div className="space-y-4">
        {rows.map(r => <StandingRow key={r.metric} r={r} />)}
      </div>

      <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50 leading-relaxed">
        Measured on a rolling {weeks}-week window. We only ever show how you stack up — never who the other accounts are.
      </p>
    </div>
  )
}

// One metric's standing: a direction-aware "how good" bar (fill = this client's
// percentile, the tick at 50% = the typical account) with a friendly placement chip
// and the client's own value beside the cohort median. Natural units throughout, so
// "You: 4.2× · Typical: 3.1×" reads the way a client expects.
function StandingRow({ r }) {
  const t   = standingTier(r.percentile, r.quartile)
  const Ico = t.Icon
  const pct = Math.max(0, Math.min(100, Math.round(Number(r.percentile) || 0)))
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-black text-slate-800 truncate">{metricLabel(r.metric)}</span>
          <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 border shrink-0 ${t.chip}`}>
            <Ico className="w-3 h-3" /> {t.label}
          </span>
        </div>
        <span className="text-[11px] font-bold text-slate-400 tabular-nums shrink-0">
          You: <span className="text-slate-800">{fmtBench(r.metric, r.value)}</span>
        </span>
      </div>

      {/* how-good axis 0–100: fill = your percentile, the tick at 50% is the
          typical account. A higher fill is always better, whichever way the metric runs. */}
      <div className="relative h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${t.bar}`} style={{ width: `${pct}%` }} />
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-300/80 -translate-x-1/2" />
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1">
        <span>Typical account: <span className="font-semibold text-slate-500 tabular-nums">{fmtBench(r.metric, r.median)}</span></span>
        <span className="font-semibold text-slate-400">{Number.isFinite(r.cohort_size) ? `of ${r.cohort_size} accounts` : ''}</span>
      </div>
    </div>
  )
}

// Percentile → a friendly, honest placement. Driven by the server-computed quartile
// (top|upper|lower|bottom on the 0–100 "how good" scale) so this badge can never drift
// from the agency's; the exact "Top N%" comes from the percentile. Client-appropriate
// tone — wins lead, the soft spots read as "room to grow", never an operator alarm.
function standingTier(percentile, quartile) {
  const pct = Number(percentile)
  if (quartile === 'top') {
    const top = Math.max(1, Math.round(100 - (Number.isFinite(pct) ? pct : 75)))
    return { label: `Top ${top}%`, chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-500', Icon: Award }
  }
  if (quartile === 'upper') return { label: 'Above average',     chip: 'bg-sky-50 text-sky-700 border-sky-200',         bar: 'bg-sky-500',   Icon: TrendingUp }
  if (quartile === 'lower') return { label: 'Just below average', chip: 'bg-slate-100 text-slate-600 border-slate-200', bar: 'bg-slate-400', Icon: Minus }
  return { label: 'Room to grow', chip: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-400', Icon: ArrowUpRight }
}

// Metric-native formatting for the standing surface — ROAS as a multiple (4.2×),
// close-rate as a percent (30%); money and counts defer to the shared fmtMetricValue.
// Local twins of the agency panel's helpers, kept here so insightMeta keeps its single
// contract and this surface can still speak the ratios it doesn't.
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

// ── Will You Hit Your Goal? — this client's own pace to each monthly goal ──────
// The same goal-pacing the agency sees as the "Off goal pace" roster on /intelligence
// (lib/pacing.js), reduced to ONLY this client's own numbers — no peers, no roster, no
// book-wide share. Unlike the agency view, which lists only the goals about to MISS, the
// client sees EVERY goal they set this month — the ahead and on-track ones too — because the
// honest answer to "will I hit my number?" includes the good news, not just the alarms. Each
// metric reads as banked-so-far against the target with where today's pace lands it, framed
// encouragingly: the agency's "At risk" becomes "Needs a push", never an operator alarm. Empty
// metrics (no goal set this month, or too early to call) → the card hides; the parent also
// gates it behind real activity so a brand-new account doesn't get a wall of "behind".
const GOAL_PACE_SHOWN = 4

// pacing status → a friendly, honest placement, client-toned. The agency panel paints only
// behind / at_risk; here all five verdicts can appear, so the good news leads in green and the
// soft spots read as "needs a push" / "behind pace" — encouragement, not an operator severity.
// Drives the row's chip, bar, and accent so this card and the agency roster never disagree on
// what a given pace MEANS, only on how loudly they say it.
function paceClientTier(status) {
  switch (status) {
    case 'ahead':    return { label: 'Ahead of pace', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-500', text: 'text-emerald-600', Icon: Award }
    case 'on_track': return { label: 'On track',      chip: 'bg-sky-50 text-sky-700 border-sky-200',             bar: 'bg-sky-500',     text: 'text-sky-600',     Icon: CheckCircle }
    case 'behind':   return { label: 'Behind pace',   chip: 'bg-amber-50 text-amber-700 border-amber-200',       bar: 'bg-amber-400',   text: 'text-amber-600',   Icon: ArrowUpRight }
    case 'at_risk':  return { label: 'Needs a push',  chip: 'bg-rose-50 text-rose-600 border-rose-200',          bar: 'bg-rose-500',    text: 'text-rose-600',    Icon: AlertCircle }
    case 'early':    return { label: 'Early days',    chip: 'bg-slate-100 text-slate-500 border-slate-200',      bar: 'bg-slate-400',   text: 'text-slate-500',   Icon: Clock }
    default:         return { label: 'Tracking',      chip: 'bg-slate-100 text-slate-500 border-slate-200',      bar: 'bg-slate-400',   text: 'text-slate-500',   Icon: Activity }
  }
}

function GoalPace({ pacing }) {
  const metrics = Array.isArray(pacing?.metrics) ? pacing.metrics : []
  if (metrics.length === 0) return null               // no goal this month / too early → hide
  const shown    = metrics.slice(0, GOAL_PACE_SHOWN)
  const daysLeft = Number(pacing?.days_in_month) - Number(pacing?.days_elapsed)
  const hasRunway = Number.isFinite(daysLeft) && daysLeft >= 0

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.10s' }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Will You Hit Your Goal?</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      <p className="text-xs text-slate-500 font-medium mb-4 leading-relaxed">
        Where each goal you set this month stands today, and where your current pace lands it
        {hasRunway ? <> — <span className="font-bold text-slate-700">{daysLeft} day{daysLeft === 1 ? '' : 's'} to go</span></> : ''}.
      </p>

      <div className="space-y-4">
        {shown.map(m => <GoalPaceRow key={m.metric} m={m} />)}
      </div>

      <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50 leading-relaxed">
        Measured against the goal set for this month, projected at your current run-rate. We refresh it every day —
        it&rsquo;s a forecast from today&rsquo;s pace, not a final number.
      </p>
    </div>
  )
}

// One goal's pace: how much you've banked toward it, where today's run-rate lands you, and —
// when you're behind — what's left to close. The track runs 0 → goal: the solid fill is what's
// banked so far, the tick is where the projection ends (at the far right once it reaches goal).
// Natural units throughout (revenue in $, leads/jobs as counts) via the shared fmtMetricValue.
function GoalPaceRow({ m }) {
  const t   = paceClientTier(m.status)
  const Ico = t.Icon
  const target    = Number(m.target)
  const actual    = Number(m.actual)
  const projected = Number(m.projected)
  const remaining = Number(m.remaining)
  // 0 → goal track. Fill = banked-so-far; the tick = where today's pace ends (clamped to the
  // track so an ahead projection parks at the goal line rather than overflowing the bar).
  const pctBanked = target > 0 ? Math.max(0, Math.min(100, Math.round((actual / target) * 100))) : 0
  const pctProj   = target > 0 ? Math.max(0, Math.min(100, Math.round((projected / target) * 100))) : 0
  const aheadish  = m.status === 'ahead' || m.status === 'on_track'

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-black text-slate-800 truncate">{metricLabel(m.metric)}</span>
          <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 border shrink-0 ${t.chip}`}>
            <Ico className="w-3 h-3" /> {t.label}
          </span>
        </div>
        <span className="text-[11px] font-bold text-slate-400 tabular-nums shrink-0">
          <span className="text-slate-800">{fmtMetricValue(m.metric, actual)}</span> of {fmtMetricValue(m.metric, target)}
        </span>
      </div>

      {/* 0 → goal track: solid fill = banked so far, the tick = where today's pace ends */}
      <div className="relative h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${t.bar}`} style={{ width: `${pctBanked}%` }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-slate-400/80" style={{ left: `calc(${pctProj}% - 1px)` }} />
      </div>

      <div className="flex items-center justify-between text-[10px] mt-1">
        <span className={`font-semibold ${t.text}`}>On pace for {fmtMetricValue(m.metric, projected)}</span>
        <span className="font-semibold text-slate-400 tabular-nums">
          {aheadish || !(remaining > 0) ? 'on track to goal' : `${fmtMetricValue(m.metric, remaining)} to go`}
        </span>
      </div>
    </div>
  )
}

// ── This Week So Far — the intra-week daily pulse, client-framed ───────────────
// The weekly recap above tells the client how LAST week CLOSED; this is the live read
// on the week IN PROGRESS. The autonomous engine (lib/insights.js) only speaks once an
// ISO week ends — structurally blind between Mondays — so lib/dayPulse watches each flow
// metric's TRAILING-7-DAY total every day and fires the moment it slides out of this
// client's OWN recent band: a dip days before the next recap, or a stretch running ahead.
// This is the consumer cut of the same sensor behind the agency's "Daily pulse" roster,
// reduced to THIS account: every figure comes from the server-computed `client_message`
// (own numbers, names no peer — never a book share or another client), so it's accurate
// by construction and safe on a client screen. Worst-first; tailwinds shown too, framed
// as the encouragement they are. A quiet / in-band / data-thin week renders nothing.
function pulseClientTone(s) {
  // Non-adverse = a GOOD move (a revenue/leads/jobs surge, or spend running light) → emerald.
  // Adverse splits by the engine's own severity, mirroring paceClientTier's rose/amber.
  if (!s?.adverse)
    return { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-600', accent: '#10b981', label: 'Tailwind' }
  return s.severity === 'critical'
    ? { chip: 'bg-rose-50 text-rose-600 border-rose-200',    text: 'text-rose-600',  accent: '#f43f5e', label: 'Heads up'     }
    : { chip: 'bg-amber-50 text-amber-700 border-amber-200', text: 'text-amber-600', accent: '#f59e0b', label: 'Keep an eye' }
}

// The reliability-crossed action lane, in the client's voice. dayPulse severity says HOW BAD;
// pulseTriage's lane crosses that severity with how RELIABLE this client's own firing history on
// the metric has been, into one posture. We render it as the agency's first-person response
// ("we're on it / confirming / reviewing / watching"), so it pairs with — never repeats — the
// severity chip's HOW-BAD beside it, and we deliberately soften the agency-internal words: a noisy
// Critical reads "Confirming", never "noisy". Tailwinds get no lane pill — the emerald chip and the
// celebratory sentence already say it, and there's nothing to act on. The grounded posture sentence
// (triage_client_reason) rides along as the pill's hover title — surfaced where it adds signal,
// never stacked as a second line that would just re-state client_message.
const PULSE_LANE_CLIENT = {
  act_now:      { label: 'On it today', chip: 'bg-rose-50 text-rose-600 border-rose-200',     Icon: AlertTriangle },
  verify:       { label: 'Confirming',  chip: 'bg-amber-50 text-amber-700 border-amber-200',  Icon: Crosshair },
  worth_a_look: { label: 'Reviewing',   chip: 'bg-sky-50 text-sky-700 border-sky-200',        Icon: Eye },
  monitor:      { label: 'Watching',    chip: 'bg-slate-100 text-slate-500 border-slate-200', Icon: Radar },
}
const pulseLaneClient = (s) => (s?.adverse ? PULSE_LANE_CLIENT[s?.lane] || null : null)

// Client-side ordering mirrors the engine's rankPulseSignals comparator (adverse desc →
// reliability-weighted priority desc → |z| desc → metric asc; client_name is constant for one
// client, so it drops out). The server keeps pulse.signals worst-first by raw severity×|z| for the
// agency roster; the client deck instead leads with what the triage layer would have us tackle
// first — so a reliable Heads-up can sit above a noisier Critical, the same call the agency's
// Act-today list makes. Pure presentation over a copy; never mutates pulse.signals.
function orderClientPulse(signals) {
  return [...signals].sort((a, b) =>
    (Number(!!b?.adverse) - Number(!!a?.adverse)) ||
    ((Number(b?.priority) || 0) - (Number(a?.priority) || 0)) ||
    (Math.abs(Number(b?.z) || 0) - Math.abs(Number(a?.z) || 0)) ||
    String(a?.metric || '').localeCompare(String(b?.metric || ''))
  )
}

// ── your pulse in one sentence (intel-v7 layer 7 / 7d) — the client synthesis capstone ──
// The consumer cut of the morning briefing. lib/pulseBriefing.summarizeClientPulse collapses
// THIS client's own ranked pulse into ONE calm sentence — the top signal's client-toned triage
// line plus a soft "also watching N others" tail — anchored by a single focus chip naming the
// one metric that matters. It SUBTRACTS surface area: it replaces the generic "N numbers are
// moving" intro with the actual one thing, framing the per-metric rows below as the detail. The
// briefing arrives as a machinery-free sibling on the client-safe pulse payload (focus carries
// ONLY label/direction/delta_pct/lane; the sentence is the engine's own client_reason), so it
// honors the ClientPulseRow TRIPWIRE — no z, baseline, reliability, accuracy, or tuning_* ever
// reaches this surface. posture in the client's voice, never the agency-internal act/watch words.
const PULSE_POSTURE_CLIENT = {
  act:    { dot: 'bg-rose-500',    text: 'text-rose-600',    label: 'Needs a look'  },
  watch:  { dot: 'bg-amber-500',   text: 'text-amber-600',   label: 'Worth a glance' },
  steady: { dot: 'bg-emerald-500', text: 'text-emerald-600', label: 'Looking good'  },
}
function ClientPulseHeadline({ briefing, adverse, focusNote, resolvedNote }) {
  const b = briefing
  // No synthesis available → fall back to the original generic count intro, unchanged.
  if (!b || !b.headline_text) {
    return (
      <p className="text-xs text-slate-500 font-medium mb-4 leading-relaxed">
        {adverse > 0
          ? <>An early read on the week in progress — {adverse === 1 ? 'one number is' : `${adverse} numbers are`} moving outside your usual range, days before your Monday recap.</>
          : <>An early read on the week in progress — everything below is running <span className="font-bold text-emerald-600">ahead of your usual week</span>.</>}
      </p>
    )
  }
  const posture = PULSE_POSTURE_CLIENT[b.posture] || PULSE_POSTURE_CLIENT.steady
  const f       = b.focus
  const lane    = f ? (PULSE_LANE_CLIENT[f.lane] || null) : null
  const dpct    = f && Number.isFinite(Number(f.delta_pct)) ? Number(f.delta_pct) : null
  return (
    <div className="mb-4">
      {/* the one sentence — posture-toned, the engine's own client-voiced synthesis */}
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${posture.dot}`} />
        <p className="text-sm font-bold text-slate-800 leading-snug">{b.headline_text}</p>
      </div>
      {/* the one metric that matters — focus chip, machinery-free (label + lane + own delta) */}
      {f && (
        <div className="mt-2 ml-4 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">{f.label}</span>
          {lane && (
            <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${lane.chip}`}>
              <lane.Icon className="w-2.5 h-2.5" /> {lane.label}
            </span>
          )}
          {dpct !== null && (
            <span className={`inline-flex items-center text-[10px] font-black tabular-nums ${posture.text}`}>
              {dpct >= 0 ? '+' : '−'}{Math.abs(Math.round(dpct))}%
            </span>
          )}
          {b.also_count > 0 && (
            <span className="text-[10px] font-semibold text-slate-400">· +{b.also_count} more watched</span>
          )}
        </div>
      )}
      {/* morning memory (8d) — the focus metric's streak in the client's own voice, and any overnight
          win that's already settled back to normal. The streak grounds the headline ("is this new, or
          the same story as yesterday?"); the resolved line leads with good news even on a heavy morning. */}
      {(focusNote || resolvedNote) && (
        <div className="mt-2 ml-4 space-y-1">
          {focusNote && (
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
              <Clock className="w-3 h-3 shrink-0" />
              <span>{focusNote}</span>
            </div>
          )}
          {resolvedNote && (
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
              <CheckCircle className="w-3 h-3 shrink-0" />
              <span>{resolvedNote}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ClientPulse({ pulse }) {
  const signals = Array.isArray(pulse?.signals) ? pulse.signals : []
  if (signals.length === 0) return null                 // nothing out of band this week → hide
  const adverse = signals.filter(s => s?.adverse).length
  const ordered = orderClientPulse(signals)             // reliability-weighted triage order (4d)
  // morning memory (8d) — fold THIS client's continuity into the one-sentence briefing, machinery-free
  // and in the engine's own client voice. The focus metric's streak note (is_focus is keyed to the
  // briefing's focus, so it can never disagree with the headline) + any overnight 'resolved' win. Both
  // strings are narrateContinuity / narrateResolved output verbatim — the UI only places them, never
  // re-derives phrasing. A per-client payload, so no cross-client name can reach this surface.
  const cont         = pulse?.continuity || null
  const focusMetric  = cont?.focus?.metric || null
  const focusNote    = focusMetric ? (signals.find(s => s?.metric === focusMetric)?.continuity_client_note || '') : ''
  const resolvedNote = cont?.resolved_client_note || ''

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.08s' }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">This Week So Far</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      {/* the one sentence first — synthesised briefing (7d) replaces the generic count intro;
          falls back to that exact count line when no briefing rides along. Frames the rows below. */}
      <ClientPulseHeadline briefing={pulse?.briefing} adverse={adverse} focusNote={focusNote} resolvedNote={resolvedNote} />

      <div className="space-y-3">
        {ordered.map(s => <ClientPulseRow key={s.metric} s={s} />)}
      </div>

      <p className="text-[10px] text-slate-400 mt-3.5 pt-3 border-t border-slate-50 leading-relaxed">
        Watched live off your daily numbers and refreshed every day — it compares your last 7 days to your own
        recent weeks, so a change shows up here days before the week officially closes. An early signal from
        this week&rsquo;s pace, not a final number.
      </p>
    </div>
  )
}

// One pulse signal in the client's own words. The grounded sentence is the engine's
// client_message (own numbers, names no peer); the chip + left accent + delta carry the
// tone. Direction arrow: a DROP points down, a SPIKE up — matched to the metric, so a
// good move (revenue up, spend down) and a bad one (revenue down, spend up) read correctly.
function ClientPulseRow({ s }) {
  const tone     = pulseClientTone(s)
  const lane     = pulseLaneClient(s)   // reliability-crossed action posture (4d), null for tailwinds
  const DirIcon  = s.direction === 'down' ? ArrowDown : s.direction === 'up' ? ArrowUp : Minus
  const d        = Number(s.delta_pct)
  const deltaStr = Number.isFinite(d) ? `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d))}%` : null
  return (
    <div
      className="rounded-xl border border-slate-100 bg-slate-50/40 p-3.5"
      style={{ borderLeftWidth: 3, borderLeftColor: tone.accent }}
    >
      <div className="flex items-start gap-2.5">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border ${tone.chip}`}>
          <DirIcon className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-black text-slate-800">{s.label || metricLabel(s.metric)}</span>
            <span className={`inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${tone.chip}`}>
              {tone.label}
            </span>
            {/* The reliability-crossed action lane (4d) — what WE'll do, in the agency's voice, so it
                pairs with the severity chip's HOW-BAD rather than repeating it. Softened from the
                agency words (a noisy Critical reads "Confirming", never "noisy"); the grounded
                posture sentence rides along as the hover title. Tailwinds carry none. */}
            {lane && (
              <span
                title={s.triage_client_reason || undefined}
                className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${lane.chip}`}
              >
                <lane.Icon className="w-2.5 h-2.5" />
                {lane.label}
              </span>
            )}
          </div>
          {/* The engine's grounded, own-numbers sentence — the single source of the figures,
              so the prose can never disagree with the chip beside it. */}
          {s.client_message && (
            <p className="text-xs text-slate-600 leading-relaxed font-medium mt-1">{s.client_message}</p>
          )}
          {/* The "why", in the client's own numbers — present only on a clean composite
              decomposition (revenue ≡ spend × roas, jobs ≡ leads × close_rate). */}
          <DriverBreakdown message={s.diagnosis_client_message} diagnosis={s.diagnosis} tone={tone} audience="client" />
          {/* A gentle, client-safe trust footnote. The engine attaches reliability_client_note
              ONLY when it graded THIS client's own firing history on THIS metric as reliable —
              narratePulseReliability's client branch returns '' for mixed/noisy/un-graded, so a
              shaky signal stays silent here and the client is never shown doubt about their own
              numbers. Neutral slate text with an emerald shield reads as a calm "you can trust
              this read" note on a Heads-up or a Tailwind alike, never competing with the accent. */}
          {s.reliability_client_note && (
            <p className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 mt-1.5">
              <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />
              {s.reliability_client_note}
            </p>
          )}
          {/* The FORESIGHT companion to the consistency line above — the engine attaches
              accuracy_client_note ONLY when it graded THIS client's own early-warning history
              on THIS metric as 'proven' (narratePulseAccuracy's client branch returns '' for
              developing/learning/un-graded, and the proven sentence carries no raw number), so
              a thin or weak record stays silent and the client is never shown doubt about their
              own numbers. Where the line above says "this is a steady signal," this says "we
              catch shifts like this early and they prove out" — the two compound into one calm
              trust statement, never repeat. Block-level so it always sits on its own line below
              the consistency note; violet target echoes the agency foresight chip, distinct from
              the emerald shield. */}
          {s.accuracy_client_note && (
            <p className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 mt-1.5">
              <Target className="w-3 h-3 text-violet-500 shrink-0" />
              {s.accuracy_client_note}
            </p>
          )}
          {/* The self-tuning layer (intel-v7 6) deliberately renders NOTHING here. The client
              feels its EFFECT — this signal already fired at the calibrated band, so it's an
              earlier (or quieter) warning, and the foresight note just above says "we catch
              shifts like this early." But the dial itself — the factor, the moved band, the
              precision — is agency-only machinery with no client-toned counterpart by design.
              The contract is enforced upstream, not by omission here: narratePulseTuning refuses
              a client audience (returns ''), and clientSafePulse strips every tuning* key from
              the GET /:clientId envelope, so the machinery is absent from the WIRE, not merely
              unread by this row. TRIPWIRE: never wire a tuning_* field into this client row. */}
        </div>
        {deltaStr != null && (
          <div className="shrink-0 text-right">
            <div className={`text-lg font-black tabular-nums leading-none ${tone.text}`}>{deltaStr}</div>
            <div className="text-[10px] font-semibold text-slate-400 mt-0.5">vs usual week</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({ data }) {
  if (!data?.length) return null
  return (
    <ResponsiveContainer width="100%" height={56}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="cv-spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#e53935" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#e53935" stopOpacity={0}   />
          </linearGradient>
        </defs>
        <Tooltip
          content={({ active, payload }) =>
            active && payload?.length
              ? <div className="text-[11px] bg-white border border-slate-100 rounded-lg px-2 py-1 shadow text-slate-700 font-bold">{fmt$$(payload[0]?.value)}</div>
              : null
          }
        />
        <Area type="monotone" dataKey="revenue" stroke="#e53935" strokeWidth={2} fill="url(#cv-spark)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── Delta badge ───────────────────────────────────────────────────────────────
function DeltaBadge({ pct, inline }) {
  if (pct == null) return null
  const up   = pct > 1
  const dn   = pct < -1
  const flat = !up && !dn
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-black px-2 py-0.5 rounded-full ${
      flat  ? 'bg-white/10 text-white/50' :
      up    ? 'bg-emerald-500/20 text-emerald-400' :
              'bg-rose-500/20 text-rose-400'
    }`}>
      {up ? <ArrowUp className="w-3 h-3" /> : dn ? <ArrowDown className="w-3 h-3" /> : null}
      {Math.abs(pct).toFixed(0)}% vs last period
    </span>
  )
}

// Client-toned starter questions for the "Ask about your results" box. Phrased in
// the first person ("we / our") and deliberately free of any cross-client framing —
// the server hard-pins every ask to this client's own scope (a group_by:'client'
// collapses to their single total), so a "top clients" prompt would be meaningless
// here. These mirror the agency suggestions' shape (a single figure, a trend, a
// ratio, a count) reduced to this one account's own numbers.
const CLIENT_ASK_SUGGESTIONS = [
  'How much revenue did we book this month?',
  'What was our ROAS last month?',
  'Revenue by week over the last 12 weeks',
  'How many leads did we get last week?',
]

// ── Main page ──────────────────────────────────────────────────────────────────
export default function ClientView({ store }) {
  const navigate = useNavigate()
  const user     = getUser()
  const { agency_name, logo_url, contact_email: agencyEmail, calendar_url: agencyCalUrl } = useAgency()
  const [mounted,      setMounted]     = useState(false)
  const [goal,         setGoal]        = useState(null)
  const [updates,      setUpdates]     = useState([])
  const [connectedSet, setConnectedSet] = useState(new Set())
  const [insights,     setInsights]    = useState([])
  const [health,       setHealth]      = useState(null)   // one-number verdict from api.getClientInsights()
  const [standing,     setStanding]    = useState(null)   // { period, cohort_size, standing } — anonymized peer benchmark
  const [recoveries,   setRecoveries]  = useState([])     // recently RECOVERED findings — the "what we fixed" win list
  const [pacing,       setPacing]      = useState(null)   // { metrics[] } — this client's OWN pace to each monthly goal (own numbers only)
  const [pulse,        setPulse]       = useState(null)   // { signals[], as_of, window, lookback_days } — this client's OWN intra-week daily pulse (own numbers, names no peer)
  const [recap,        setRecap]       = useState(null)   // grounded weekly recap row — the same narration that opens this client's Monday email
  const [brief,        setBrief]       = useState(null)   // grounded AI MORNING brief — { brief_text, pack:{period,posture,...} } over THIS client's own intra-week pulse

  const {
    stats = {}, prevStats = {}, weeklyTrend = [],
    clients = [], selectedClient,
    selectedPeriod, setSelectedPeriod,
  } = store

  const clientObj   = clients.find(c => c.id === selectedClient) || clients[0]
  const clientName  = clientObj?.name || 'Your Business'
  const periodLabel = PERIOD_OPTS.find(p => p.value === selectedPeriod)?.label || ''

  useEffect(() => { const t = setTimeout(() => setMounted(true), 60); return () => clearTimeout(t) }, [])

  // Fetch goals, updates, and connection status for this client (API mode only)
  useEffect(() => {
    if (!USE_API || !clientObj?.id) return
    const thisMonth = new Date().toISOString().slice(0, 7)
    api.getGoal(clientObj.id, thisMonth)
      .then(g => setGoal(g))
      .catch(() => setGoal(null))
    api.getUpdates(clientObj.id, 5)
      .then(u => setUpdates(u || []))
      .catch(() => setUpdates([]))
    // Fetch connection status to power the source checklist
    api.listConnections(clientObj.id)
      .then(rows => setConnectedSet(new Set(rows.map(r => r.channel))))
      .catch(() => {})
    // Autonomous analyst — this client's grounded findings + recommended actions, the
    // one-number health read, and the anonymized peer standing (all the same synthesis
    // the agency sees on /intelligence, reduced to this client). Failure just hides the
    // panels; it never blocks the rest of the dashboard.
    api.getClientInsights(clientObj.id)
      .then(d => {
        setInsights(Array.isArray(d?.insights) ? d.insights : [])
        setHealth(d?.health || null)
        setStanding(d?.benchmark || null)
        setRecoveries(Array.isArray(d?.recoveries) ? d.recoveries : [])
        setPacing(d?.pacing && Array.isArray(d.pacing.metrics) ? d.pacing : null)
        // This client's OWN intra-week pulse (lib/dayPulse via getClientPulse), folded into the same
        // payload. Each signal carries a client_message — own numbers, names no peer — so it's safe to
        // surface here exactly as pacing/standing are. Empty/in-band/data-thin → no signals → panel hides.
        setPulse(d?.pulse && Array.isArray(d.pulse.signals) ? d.pulse : null)
      })
      .catch(() => { setInsights([]); setHealth(null); setStanding(null); setRecoveries([]); setPacing(null); setPulse(null) })
    // Weekly recap — the grounded, plain-English narration of the most recently completed
    // week (lib/recap.js), the very same text that opens this client's Monday email. The
    // recap layer degrades to a deterministic template even with no API key, so this is
    // always safe to request; any failure simply hides the in-app card.
    api.getRecap(clientObj.id)
      .then(r => setRecap(r || null))
      .catch(() => setRecap(null))
    // Morning brief — the grounded, plain-English read of where THIS week-in-progress stands
    // (lib/pulseBrief.js over getClientPulse), the same text that opens the client's next morning
    // note. Like the recap it degrades to a deterministic template with no API key, so it's always
    // safe to request; any failure simply hides the in-app card.
    api.getClientBrief(clientObj.id)
      .then(b => setBrief(b || null))
      .catch(() => setBrief(null))
  }, [clientObj?.id])

  const revenue = stats.total_revenue || 0
  const jobs    = stats.total_closed  || 0
  const leads   = stats.total_leads   || 0
  const mql     = stats.total_mql     || 0
  const spend   = stats.total_spend   || 0
  const roas    = spend > 0 ? revenue / spend : (stats.avg_roas || 0)

  const revDelta  = delta(revenue,  prevStats.total_revenue)
  const jobsDelta = delta(jobs,     prevStats.total_closed)

  const closeRate = leads > 0 ? (jobs / leads) * 100 : 0

  const verdict = verdictFor({ revenue, revDelta: revDelta ?? 0, roas, leads, jobs })

  // ── Milestone detection — first-time only via localStorage ─────────────────
  // Key is per-client so milestones don't bleed across accounts
  const MILESTONE_KEY   = `milestone_seen_${clientObj?.id || clientName}`
  const REV_MILESTONES  = [10000, 25000, 50000, 100000, 250000, 500000, 1000000]
  const JOBS_MILESTONES = [5, 10, 25, 50, 100, 250]
  const revMilestone    = REV_MILESTONES.filter(m => revenue >= m).pop() || null
  const jobsMilestone   = JOBS_MILESTONES.filter(m => jobs   >= m).pop() || null

  // Only show if this exact milestone hasn't been celebrated yet
  const seenMilestones   = JSON.parse(localStorage.getItem(MILESTONE_KEY) || '{"rev":0,"jobs":0}')
  const showRevMilestone = revMilestone  && revMilestone  > seenMilestones.rev
  const showJobMilestone = jobsMilestone && jobsMilestone > seenMilestones.jobs
  const showMilestone    = showRevMilestone || showJobMilestone

  // Mark milestone as seen when first rendered
  useEffect(() => {
    if (!showMilestone) return
    localStorage.setItem(MILESTONE_KEY, JSON.stringify({
      rev:  revMilestone  || seenMilestones.rev,
      jobs: jobsMilestone || seenMilestones.jobs,
    }))
  }, [showMilestone]) // eslint-disable-line react-hooks/exhaustive-deps

  // Animated counters — numbers roll up on mount for drama
  const animRevenue = useCountUp(Math.round(revenue), { duration: 1600, delay: 200 })
  const animJobs    = useCountUp(jobs,                { duration: 1200, delay: 400 })
  const animRoas    = useCountUp(Math.round(roas * 10), { duration: 1400, delay: 600 })

  const sparkData = weeklyTrend.slice(-8).map(w => ({
    week: weekLabel(w.week),
    revenue: Math.round(w.revenue || 0),
  }))

  function handleSignOut() { clearToken(); navigate('/login', { replace: true }) }

  // Verdict color map
  const verdictColors = {
    emerald: { bg: 'bg-emerald-50', border: 'border-l-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-700', status: 'text-emerald-600', Icon: CheckCircle },
    amber:   { bg: 'bg-amber-50',   border: 'border-l-amber-500',   dot: 'bg-amber-500',   text: 'text-amber-700',   status: 'text-amber-600',   Icon: Clock },
    rose:    { bg: 'bg-rose-50',    border: 'border-l-rose-500',    dot: 'bg-rose-500',    text: 'text-rose-700',    status: 'text-rose-600',    Icon: AlertCircle },
    slate:   { bg: 'bg-slate-50',   border: 'border-l-slate-400',   dot: 'bg-slate-400',   text: 'text-slate-700',   status: 'text-slate-500',   Icon: BarChart2 },
  }
  const vc = verdictColors[verdict?.color] || verdictColors.slate

  return (
    <>
      <style>{`
        @keyframes fadeUp {
          from { transform: translateY(16px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .fade-up { animation: fadeUp .4s cubic-bezier(.32,1,.44,1) both; }
        @media print {
          .cv-nav { display: none !important; }
          body    { background: white !important; }
          .cv-hero { background: #0a0a0a !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="min-h-screen pb-12" style={{ background: '#f1f5f9' }}>

        {/* ── Nav ── */}
        <header className="cv-nav bg-white border-b border-slate-100 sticky top-0 z-20">
          <div className="max-w-4xl mx-auto px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {logo_url ? (
                <img src={logo_url} alt="logo" className="w-7 h-7 rounded-lg object-contain" />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
                  <TrendingUp className="w-3.5 h-3.5 text-white" />
                </div>
              )}
              <span className="text-[11px] font-black tracking-[.12em] text-brand-500 uppercase">{agency_name}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Agency-only nav — hidden for client role */}
              {user?.role !== 'client' && (
                <>
                  <Link to="/" className="hidden sm:flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors px-2 py-1 rounded-lg hover:bg-slate-100">
                    <LayoutDashboard className="w-3.5 h-3.5" />
                    Agency
                  </Link>
                  <Link to="/exec" className="hidden sm:flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors px-2 py-1 rounded-lg hover:bg-slate-100">
                    <Smartphone className="w-3.5 h-3.5" />
                    Exec
                  </Link>
                </>
              )}
              <div className="relative">
                <select
                  value={selectedPeriod}
                  onChange={e => setSelectedPeriod(e.target.value)}
                  className="appearance-none text-[11px] font-bold text-slate-600 bg-slate-100 rounded-xl px-3 py-1.5 pr-7 focus:outline-none cursor-pointer"
                >
                  {PERIOD_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown className="w-3 h-3 text-slate-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          </div>
        </header>

        <div className="max-w-4xl mx-auto px-5">

          {/* ── Hero ── */}
          <div
            className="cv-hero relative overflow-hidden rounded-b-3xl mb-6 fade-up"
            style={{ background: '#0a0a0a' }}
          >
            {/* brand accent bar */}
            <div className="h-1 w-full bg-brand-500" />

            {/* decorative bg circles */}
            <div className="absolute top-0 right-0 w-64 h-64 rounded-full opacity-5 bg-white translate-x-1/3 -translate-y-1/3" />
            <div className="absolute bottom-0 left-0 w-48 h-48 rounded-full opacity-5 bg-brand-500 -translate-x-1/2 translate-y-1/3" />

            <div className="relative px-4 sm:px-7 pt-5 sm:pt-7 pb-7 sm:pb-8">
              <p className="text-[10px] font-black tracking-[.2em] text-white/40 uppercase mb-1">
                {clientName} · {periodLabel}
              </p>
              <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight mb-2">
                Your Results
              </h1>

              {/* Narrative headline — reads like a letter, not a dashboard */}
              <p className="text-white/85 text-sm font-medium leading-relaxed mt-4 mb-5">
                {buildNarrative({ revenue, jobs, roas, leads, spend })}
              </p>

              {/* Three supporting numbers — animated counters roll up on load */}
              <div className="grid grid-cols-3 gap-0 border-t border-white/10 pt-4 mb-1">
                <div className="flex flex-col">
                  <p className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1">Revenue</p>
                  <p className="text-xl sm:text-2xl font-black text-white leading-none tabular-nums">
                    {revenue > 0 ? fmt$$(animRevenue) : '—'}
                  </p>
                  {revDelta != null && <div className="mt-2"><DeltaBadge pct={revDelta} /></div>}
                </div>
                <div className="flex flex-col border-l border-white/10 pl-3 sm:pl-5">
                  <p className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1">Jobs Won</p>
                  <p className="text-xl sm:text-2xl font-black text-white leading-none tabular-nums">
                    {jobs > 0 ? fmtN(animJobs) : '—'}
                  </p>
                  {jobsDelta != null && <div className="mt-2"><DeltaBadge pct={jobsDelta} /></div>}
                </div>
                <div className="flex flex-col border-l border-white/10 pl-3 sm:pl-5">
                  <p className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1">Ad Return</p>
                  <p className="text-xl sm:text-2xl font-black text-white leading-none tabular-nums">
                    {roas >= 1 ? `${(animRoas / 10).toFixed(1)}×` : '—'}
                  </p>
                  <p className="text-[9px] text-white/40 mt-1.5 font-medium">per $1 spent</p>
                </div>
              </div>
            </div>
          </div>

          {/* ── Goal Progress Ring ── */}
          <GoalRing
            revenue={revenue}
            leads={leads}
            jobs={jobs}
            goal={goal}
            periodLabel={periodLabel}
          />

          {/* ── Data Source Setup Checklist — hidden when data is present or 4+ connected ── */}
          {USE_API && revenue === 0 && leads === 0 && (
            <SourceChecklist
              connectedKeys={connectedSet}
              isAgency={user?.role !== 'client'}
            />
          )}

          {/* ── Account Health — the AI analyst's one-number read, client-framed ──
              Only once the account has real activity: on an empty/unconnected account
              the synthesis is a vacuous "100 healthy" (no findings), which would read
              as a fiction rather than a verdict, so we defer to the checklist above. */}
          {(revenue > 0 || leads > 0 || spend > 0) && <AccountHealth health={health} />}

          {/* ── Your Week in Review — the grounded weekly recap, in plain English ──
              The very same narration that opens this client's Monday email (lib/recap.js),
              surfaced in-app so they can reread it any day: the story of the week, then a
              compact "where things stand now" coda built from the recap's own CLIENT-SAFE
              intelligence digest (counts and area names only — never a severity statistic
              or another client). Same activity gate as the health badge; self-hides when
              there's no recap text yet. */}
          {(revenue > 0 || leads > 0 || spend > 0) && <WeeklyRecap recap={recap} />}

          {/* ── Your Morning Brief — the grounded AI read of THIS morning, in plain English ──
              WeeklyRecap above tells how LAST week CLOSED; this is today's fresh read on the week
              IN PROGRESS (lib/pulseBrief.js over getClientPulse), the very text that opens the
              client's next morning note. Own numbers only — the pack carries this account's own
              period/posture/focus and strips every peer, severity statistic, and machinery key;
              no regenerate, model name, confidence chip, or badge reaches this surface. Same
              activity gate as the cards around it; self-hides when there's no brief text yet. */}
          {(revenue > 0 || leads > 0 || spend > 0) && <ClientMorningBrief brief={brief} />}

          {/* ── This Week So Far — the intra-week daily pulse, client-framed ──
              The recap above tells how LAST week CLOSED; this is the live read on the week
              IN PROGRESS. The weekly engine is structurally silent between Mondays, so
              lib/dayPulse (via getClientPulse, folded into this same payload) watches each
              flow metric's trailing-7-day total every day and flags the moment it slides out
              of this client's OWN usual range — a dip days before the next recap, or a stretch
              running ahead. Own numbers only (server-computed client_message, names no peer);
              self-hides when nothing's out of band. Same activity gate as the cards above. */}
          {(revenue > 0 || leads > 0 || spend > 0) && <ClientPulse pulse={pulse} />}

          {/* ── Ask about your results — the grounded "ask your data" box, client-scoped ──
              The same plain-English query surface the agency gets on its dashboard, but
              pinned to THIS client: we pass clientObj.id, and the server derives the hard
              boundary from the authenticated token regardless (resolveAskScope), so a
              client can only ever ask about its own numbers and lib/ask.js re-binds that
              id at compile time — a question that names or groups-by another client simply
              collapses to this account's own total. Client-toned copy (no "across every
              client") and first-person starter prompts. Same activity gate as the cards
              above so an empty account doesn't invite questions it has no data to answer. */}
          {(revenue > 0 || leads > 0 || spend > 0) && clientObj?.id && (
            <div className="mb-4 fade-up" style={{ animationDelay: '.075s' }}>
              <AskBox
                clientId={clientObj.id}
                title="Ask about your results"
                subtitle="Plain-English questions about your performance — answered with exact, verified numbers"
                placeholder="e.g. How much revenue did we book this month?"
                suggestions={CLIENT_ASK_SUGGESTIONS}
              />
            </div>
          )}

          {/* ── Will You Hit Your Goal? — this client's own pace to each monthly goal ──
              The agency's "Off goal pace" roster (insights/pacing) reduced to ONLY this
              account's own numbers — no peers, no book share — and widened to show EVERY
              goal, the ahead and on-track ones too, not just the misses. Same activity gate
              as the health badge so a brand-new account doesn't open on a wall of "behind";
              the card also self-hides when there's no goal set or it's too early to call. */}
          {(revenue > 0 || leads > 0 || spend > 0) && <GoalPace pacing={pacing} />}

          {/* ── How You Compare — this client's own anonymized peer standing ──
              The cross-client benchmark reduced to this account's placement only
              (never a peer's identity). Same activity gate as the health badge;
              null-guards to nothing when the cohort is too thin to publish. */}
          {(revenue > 0 || leads > 0 || spend > 0) && <MyStanding benchmark={standing} />}

          {/* ── Funnel card: How Leads Became Jobs ── */}
          {leads > 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm mb-4 fade-up" style={{ animationDelay: '.07s' }}>
              <div className="px-6 pt-6 pb-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-5">
                  How Your Leads Became Jobs
                </p>
                {/* 3-step if MQL tracked, 2-step otherwise — never fabricate a number */}
                {mql > 0 ? (
                  <div className="grid grid-cols-3 gap-0">
                    {[
                      { label: 'Leads In',     dot: 'bg-blue-500',    val: fmtN(leads), sub: 'people contacted you',                  color: 'text-slate-800' },
                      { label: 'Followed Up',  dot: (mql/leads)>=0.5 ? 'bg-amber-400' : 'bg-rose-500', val: fmtN(mql), sub: 'team responded', color: (mql/leads)>=0.5 ? 'text-amber-600':'text-rose-600' },
                      { label: 'Jobs Won',     dot: closeRate>=20 ? 'bg-emerald-500' : closeRate>=10 ? 'bg-amber-400':'bg-rose-500', val: fmtN(jobs), sub: `${closeRate.toFixed(0)}% close rate`, color: closeRate>=20?'text-emerald-600':closeRate>=10?'text-amber-600':'text-rose-600' },
                    ].map((s, i) => (
                      <div key={s.label} className={`flex flex-col ${i > 0 ? 'pl-5 border-l border-slate-100' : ''}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{s.label}</p>
                        </div>
                        <p className={`text-2xl font-black leading-none mb-1 ${s.color}`}>{s.val}</p>
                        <p className="text-[10px] text-slate-400">{s.sub}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  /* 2-step when follow-up isn't tracked — clean, no fabrication */
                  <div className="grid grid-cols-2 gap-0">
                    {[
                      { label: 'Leads In',  dot: 'bg-blue-500',    val: fmtN(leads), sub: 'people contacted you',         color: 'text-slate-800' },
                      { label: 'Jobs Won',  dot: closeRate>=20 ? 'bg-emerald-500' : closeRate>=10 ? 'bg-amber-400':'bg-rose-500', val: fmtN(jobs), sub: `${closeRate.toFixed(0)}% became jobs`, color: closeRate>=20?'text-emerald-600':closeRate>=10?'text-amber-600':'text-rose-600' },
                    ].map((s, i) => (
                      <div key={s.label} className={`flex flex-col ${i > 0 ? 'pl-5 border-l border-slate-100' : ''}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{s.label}</p>
                        </div>
                        <p className={`text-2xl font-black leading-none mb-1 ${s.color}`}>{s.val}</p>
                        <p className="text-[10px] text-slate-400">{s.sub}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Progress bar */}
              <div className="px-6 py-4">
                <div className="flex gap-1 h-1.5">
                  <div className="flex-1 bg-blue-500 rounded-full" />
                  {mql > 0 && (
                    <div className="bg-amber-400 rounded-full transition-all duration-700"
                      style={{ flex: (mql / leads) }} />
                  )}
                  <div
                    className={`rounded-full transition-all duration-700 ${closeRate>=20?'bg-emerald-500':closeRate>=10?'bg-amber-400':'bg-rose-500'}`}
                    style={{ flex: jobs / leads }} />
                </div>
              </div>
            </div>
          )}

          {/* ── Channel Attribution ── */}
          {leads > 0 && (() => {
            const adsLeads  = stats.ads_leads    || 0
            const lsaLeads  = stats.lsa_calls    || 0
            const metaLeads = stats.meta_leads   || 0
            const gbpLeads  = stats.gbp_calls    || 0
            const tracked   = adsLeads + lsaLeads + metaLeads + gbpLeads
            const organic   = Math.max(leads - tracked, 0)
            const channels  = [
              { label: 'Google Ads', leads: adsLeads,  color: 'bg-blue-500',    dot: 'bg-blue-500'    },
              { label: 'Google LSA', leads: lsaLeads,  color: 'bg-cyan-500',    dot: 'bg-cyan-500'    },
              { label: 'Meta Ads',   leads: metaLeads, color: 'bg-indigo-500',  dot: 'bg-indigo-500'  },
              { label: 'GBP / Local',leads: gbpLeads,  color: 'bg-emerald-500', dot: 'bg-emerald-500' },
              { label: 'Organic',    leads: organic,   color: 'bg-slate-400',   dot: 'bg-slate-400'   },
            ].filter(c => c.leads > 0)

            if (channels.length < 2) return null // need 2+ to be worth showing

            return (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.09s' }}>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">
                  Where Your Leads Came From
                </p>
                {/* Stacked bar */}
                <div className="flex h-3 rounded-full overflow-hidden gap-0.5 mb-4">
                  {channels.map(c => (
                    <div
                      key={c.label}
                      className={`h-full ${c.color} transition-all duration-700`}
                      style={{ flex: c.leads / leads }}
                      title={`${c.label}: ${fmtN(c.leads)} (${((c.leads / leads) * 100).toFixed(0)}%)`}
                    />
                  ))}
                </div>
                {/* Channel chips */}
                <div className="flex flex-wrap gap-3">
                  {channels.map(c => (
                    <div key={c.label} className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                      <span className="text-[11px] font-bold text-slate-600">
                        {c.label}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        · {fmtN(c.leads)} leads · {((c.leads / leads) * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* ── Campaign Breakdown — only shown when campaigns exist ── */}
          {clientObj?.id && (
            <CampaignList clientId={clientObj.id} hideWhenEmpty />
          )}

          {/* ── Revenue trend — full width ── */}
          {mounted && sparkData.length > 1 && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.1s' }}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Revenue Trend</p>
                {revDelta != null && (
                  <span className={`text-[11px] font-black px-2 py-0.5 rounded-full ${
                    revDelta > 0 ? 'bg-emerald-50 text-emerald-600' : revDelta < 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'
                  }`}>
                    {revDelta > 0 ? '↑' : '↓'} {Math.abs(revDelta).toFixed(0)}% vs last period
                  </span>
                )}
              </div>
              <p className="text-2xl font-black text-slate-900 mb-3">{fmt$$(revenue)}</p>
              <Sparkline data={sparkData} />
              <p className="text-[10px] text-slate-400 mt-2">Weekly revenue — last 8 weeks</p>
            </div>
          )}

          {/* ── 12-Month Trend ── */}
          {clientObj?.id && <MonthlyTrend clientId={clientObj.id} />}

          {/* ── Performance Verdict + Team Update — side by side on desktop ── */}
          {verdict && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4 fade-up" style={{ animationDelay: '.18s' }}>
              {/* Verdict */}
              <div className={`bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden border-l-4 ${vc.border}`}>
                <div className="p-5 h-full flex flex-col justify-between">
                  <div className="flex items-start gap-3">
                    <vc.Icon className={`w-5 h-5 shrink-0 mt-0.5 ${vc.status}`} />
                    <div>
                      <p className={`text-xs font-black uppercase tracking-widest mb-1 ${vc.status}`}>
                        Performance Verdict
                      </p>
                      <p className={`text-sm font-black ${vc.status} mb-1`}>{verdict.status}</p>
                      <p className="text-sm text-slate-700 leading-relaxed font-medium">{verdict.text}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Agency update — shows human-written content, falls back to machine bullets */}
              <TeamUpdate
                updates={updates}
                fallbackBullets={buildAccountTeamBullets({ roas, leads, jobs, closeRate, spend, revDelta: revDelta ?? null })}
              />
            </div>
          )}

          {/* ── Recently Resolved — the "what we fixed" wins, client-facing ── */}
          <ClientWins recoveries={recoveries} />

          {/* ── What We're Watching — the autonomous analyst, client-facing ── */}
          <ClientInsights insights={insights} />

          {/* ── Milestone celebration — first-time only ── */}
          {showMilestone && (
            <div
              className="rounded-2xl p-5 mb-4 overflow-hidden relative fade-up"
              style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)', animationDelay: '.2s' }}
            >
              {/* Confetti-style background dots */}
              {['top-3 right-8', 'top-6 right-20', 'bottom-4 right-12', 'bottom-3 left-32', 'top-4 left-40'].map((pos, i) => (
                <div key={i} className={`absolute ${pos} w-1.5 h-1.5 rounded-full bg-white/20`} />
              ))}
              <div className="relative flex items-start gap-3">
                <span className="text-2xl shrink-0 mt-0.5">🏆</span>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/50 mb-1">
                    Milestone Reached
                  </p>
                  {showRevMilestone && (
                    <p className="text-white font-black text-base leading-snug">
                      You just crossed{' '}
                      <span className="text-yellow-300">{fmt$$(revMilestone)}</span> in marketing-attributed revenue.
                    </p>
                  )}
                  {showJobMilestone && !showRevMilestone && (
                    <p className="text-white font-black text-base leading-snug">
                      You've closed{' '}
                      <span className="text-yellow-300">{jobsMilestone}+ jobs</span> through your marketing campaigns.
                    </p>
                  )}
                  <p className="text-white/50 text-xs mt-1.5 leading-relaxed">
                    That's a real business result. Here's to the next milestone.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Budget Simulator ── */}
          {(spend > 0 || leads > 0) && (
            <div className="fade-up" style={{ animationDelay: '.21s' }}>
              <BudgetSimulator stats={stats} />
            </div>
          )}


          {/* ── Next Steps / Contact CTA ── */}
          <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl p-6 mb-4 fade-up text-center" style={{ animationDelay: '.25s' }}>
            <p className="text-white font-black text-base mb-1">Questions about your results?</p>
            <p className="text-slate-400 text-xs mb-5 leading-relaxed max-w-xs mx-auto">
              Your account team reviews these numbers every Monday morning and will reach out with any recommendations.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              {(clientObj?.contact_email || agencyEmail) && (
                <a
                  href={`mailto:${clientObj?.contact_email || agencyEmail}`}
                  className="flex items-center gap-2 text-xs font-black text-white bg-brand-500 hover:bg-brand-600 transition-colors px-4 py-2.5 rounded-xl"
                >
                  ✉ Email Your Team
                </a>
              )}
              {(clientObj?.calendar_url || agencyCalUrl) && (
                <a
                  href={clientObj?.calendar_url || agencyCalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs font-black text-slate-300 hover:text-white border border-white/15 hover:border-white/30 transition-colors px-4 py-2.5 rounded-xl"
                >
                  📅 Schedule a Review Call
                </a>
              )}
            </div>
            <p className="text-slate-600 text-[10px] mt-5">
              Next report: {(() => {
                const d = new Date()
                d.setDate(d.getDate() + (8 - d.getDay()) % 7 || 7)
                return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              })()}
            </p>
          </div>

          {/* ── Footer ── */}
          <div className="flex flex-col items-center gap-3 pt-4">
            {USE_API && (
              <button
                onClick={handleSignOut}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out{user?.email ? ` (${user.email})` : ''}
              </button>
            )}
            <p className="text-[10px] text-slate-300">Powered by 10X Marketing · Updated weekly</p>
          </div>

        </div>
      </div>
    </>
  )
}
