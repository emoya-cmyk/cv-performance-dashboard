import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'
import {
  TrendingUp, ChevronDown, LogOut, ArrowUp, ArrowDown,
  LayoutDashboard, Smartphone, BarChart2, Zap,
  CheckCircle, AlertCircle, Clock, Sparkles, Target, SlidersHorizontal,
} from 'lucide-react'
import { fmt$$, fmtN, fmtPct, delta, weekLabel } from '@/lib/utils'
import { clearToken, getUser } from '@/lib/auth'
import { USE_API, api } from '@/lib/api'
import { severityMeta, kindMeta, urgencyMeta, isClientFacing, forecastRange, fmtMetricValue, attributionView } from '@/lib/insightMeta'
import { useCountUp } from '@/lib/useCountUp'
import BudgetSimulator from '@/components/BudgetSimulator'
import GoalRing from '@/components/GoalRing'
import TeamUpdate from '@/components/TeamUpdate'
import CampaignList from '@/components/CampaignList'
import MonthlyTrend from '@/components/MonthlyTrend'
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

              {/* Recommendation — what we'll do about it */}
              {action?.text && (
                <div className="mt-3 rounded-lg bg-white border border-slate-100 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    {urg && (
                      <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${urg.chip}`}>
                        <UrgIcon className="w-3 h-3" /> {urg.label}
                      </span>
                    )}
                    <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Our Recommendation</span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed font-medium">{action.text}</p>
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
    // Autonomous analyst — this client's grounded findings + recommended actions.
    // Failure just hides the panel; it never blocks the rest of the dashboard.
    api.getClientInsights(clientObj.id)
      .then(d => setInsights(Array.isArray(d?.insights) ? d.insights : []))
      .catch(() => setInsights([]))
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
