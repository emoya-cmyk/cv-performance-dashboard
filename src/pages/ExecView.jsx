import { useNavigate, Link } from 'react-router-dom'
import { AreaChart, Area, ResponsiveContainer, Tooltip, Treemap } from 'recharts'
import {
  TrendingUp, ArrowUp, ArrowDown, LayoutDashboard,
  Smartphone, Printer, Download, CheckCircle, AlertCircle, Clock, BarChart2,
} from 'lucide-react'
import { fmt$$, fmtN, fmtX, delta, weekLabel } from '@/lib/utils'
import { useCountUp } from '@/lib/useCountUp'
import ImpactBanner from '@/components/ImpactBanner'

const PERIOD_OPTS = [
  { value: 'this_week', label: 'This Week' },
  { value: 'last_4w',   label: 'Last 4 Weeks' },
  { value: 'last_8w',   label: 'Last 8 Weeks' },
  { value: 'all_time',  label: 'All Time' },
]

// ── Sparkline — revenue (solid red) + spend (dashed indigo) ──────────────────
function Spark({ data }) {
  if (!data?.length) return null
  const hasSpend = data.some(d => (d.spend || 0) > 0)
  return (
    <>
      {/* Legend */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-0.5 bg-brand-500 rounded-full" />
          <span className="text-[10px] font-black text-white/40 uppercase tracking-wider">Revenue</span>
        </div>
        {hasSpend && (
          <div className="flex items-center gap-1.5">
            <div className="w-5 border-t border-dashed border-indigo-400" />
            <span className="text-[10px] font-black text-white/40 uppercase tracking-wider">Spend</span>
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={72}>
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="ev-rev-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#e53935" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#e53935" stopOpacity={0}    />
            </linearGradient>
            <linearGradient id="ev-spend-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#818cf8" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#818cf8" stopOpacity={0}   />
            </linearGradient>
          </defs>
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.length
                ? <div className="text-[10px] bg-slate-800 border border-white/10 rounded-lg px-3 py-2 shadow space-y-1">
                    {payload.map(p => (
                      <div key={p.dataKey} className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
                        <span className="text-white/50">{p.dataKey === 'revenue' ? 'Revenue' : 'Spend'}</span>
                        <span className="text-white font-black ml-1">{fmt$$(p.value)}</span>
                      </div>
                    ))}
                  </div>
                : null
            }
          />
          {hasSpend && (
            <Area type="monotone" dataKey="spend"
              stroke="#818cf8" strokeWidth={1.5} strokeDasharray="5 3"
              fill="url(#ev-spend-g)" dot={false} />
          )}
          <Area type="monotone" dataKey="revenue"
            stroke="#e53935" strokeWidth={2}
            fill="url(#ev-rev-g)" dot={false}
            activeDot={{ r: 4, fill: '#e53935' }} />
        </AreaChart>
      </ResponsiveContainer>
    </>
  )
}

// ── Delta tag ─────────────────────────────────────────────────────────────────
function DeltaTag({ pct }) {
  if (pct == null) return null
  const up = pct > 1
  const dn = pct < -1
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-black px-2 py-0.5 rounded-full
      ${up ? 'bg-emerald-500/20 text-emerald-400' : dn ? 'bg-rose-500/20 text-rose-400' : 'bg-white/10 text-white/50'}`}>
      {up ? <ArrowUp className="w-3 h-3" /> : dn ? <ArrowDown className="w-3 h-3" /> : null}
      {Math.abs(pct).toFixed(0)}% vs last period
    </span>
  )
}

// ── Strategic headline — 2–3 sentences (Change 5) ────────────────────────────
function buildStrategicHeadline({ clientName, revenue, jobs, roas, spend, leads, revDelta, stats }) {
  const closeRate = leads > 0 ? (jobs / leads) * 100 : 0
  const parts     = []

  // Sentence 1 — revenue / jobs story
  if (revenue > 0 && jobs > 0) {
    let s = `${clientName} generated ${fmt$$(revenue)} from ${jobs} ${jobs === 1 ? 'job' : 'jobs'}`
    if (revDelta !== null && Math.abs(revDelta) > 5) {
      s += `, a ${revDelta > 0
        ? `${revDelta.toFixed(0)}% increase`
        : `${Math.abs(revDelta).toFixed(0)}% decline`} vs the prior period`
    }
    parts.push(s + '.')
  } else if (leads > 0) {
    parts.push(
      `${clientName} generated ${fmtN(leads)} leads this period${spend > 0 ? ` on ${fmt$$(spend)} in ad spend` : ''}.`
    )
  } else {
    return `${clientName} is in the ramp-up phase — connect all channels for a complete performance view.`
  }

  // Sentence 2 — ROI framing with benchmark context
  if (roas >= 3) {
    parts.push(
      `At ${roas.toFixed(1)}× ROAS, every marketing dollar is returning $${roas.toFixed(2)} — above the 3–5× home services benchmark.`
    )
  } else if (roas >= 1.5) {
    parts.push(
      `Marketing ROI is positive at ${roas.toFixed(1)}× — below the 3–5× home services benchmark, with clear room to optimize.`
    )
  } else if (roas > 0) {
    parts.push(
      `ROAS sits at ${roas.toFixed(1)}×, meaning ad spend is not yet returning its full cost — creative, targeting, and follow-up speed are the primary levers.`
    )
  }

  // Sentence 3 — bottleneck or opportunity
  if (closeRate > 0 && closeRate < 15) {
    const revPerJob   = jobs > 0 ? revenue / jobs : 0
    const gapToAvg    = Math.max(Math.round(leads * 0.20) - jobs, 0)
    if (gapToAvg > 0 && revPerJob > 0) {
      parts.push(
        `The biggest lever is conversion: at ${closeRate.toFixed(0)}% close rate, reaching the 20% industry average could add approximately ${fmt$$(gapToAvg * revPerJob)} in revenue without increasing ad spend.`
      )
    } else {
      parts.push(
        `At ${closeRate.toFixed(0)}% close rate, improving lead follow-up speed is the highest-ROI action — the industry average is 20–25%.`
      )
    }
  } else if (closeRate >= 25) {
    parts.push(
      `With a strong ${closeRate.toFixed(0)}% close rate, the sales process is firing well — the primary lever now is scaling lead volume.`
    )
  } else if (closeRate >= 15) {
    parts.push(
      `Close rate is ${closeRate.toFixed(0)}% — near the 20–25% industry average. Consistent first-contact speed is the key to pushing it higher.`
    )
  }

  return parts.join(' ')
}

// ── Health verdict ────────────────────────────────────────────────────────────
function verdictFor({ revenue, revDelta, roas, leads, jobs }) {
  if (revenue <= 0) return null
  const roasStrong  = roas >= 3
  const roasOk      = roas >= 1.5
  const revGrowing  = revDelta > 2
  const revFalling  = revDelta < -5
  const closeRate   = leads > 0 ? (jobs / leads) * 100 : 0
  const closingWell = closeRate >= 20
  if (roasStrong && revGrowing && closingWell)
    return { status: 'Strong',           color: 'emerald', dot: 'bg-emerald-400', Icon: CheckCircle,
      text: `Revenue is up ${revDelta.toFixed(0)}% and every $1 in marketing is returning $${roas.toFixed(2)}. Growth is healthy.` }
  if (roasOk && !revFalling)
    return { status: 'Steady',           color: 'amber',   dot: 'bg-amber-400',   Icon: Clock,
      text: `Marketing ROI is positive at ${roas.toFixed(1)}×${revGrowing ? ` with revenue trending up ${revDelta.toFixed(0)}%` : ', consistent with last period'}. Performance is on track.` }
  if (!roasOk && leads > 0 && closeRate < 15)
    return { status: 'Conversion Gap',   color: 'rose',    dot: 'bg-rose-400',    Icon: AlertCircle,
      text: `Leads are coming in but only ${closeRate.toFixed(0)}% are closing. The gap is in follow-up speed and lead qualification, not ad spend.` }
  if (revFalling)
    return { status: 'Review Needed',    color: 'rose',    dot: 'bg-rose-400',    Icon: AlertCircle,
      text: `Revenue is down ${Math.abs(revDelta).toFixed(0)}% vs last period. A channel-by-channel review will identify whether this is a volume or conversion issue.` }
  return { status: 'Building',           color: 'slate',   dot: 'bg-slate-500',   Icon: BarChart2,
    text: `Not enough data yet for a full assessment. Check back after a full period of activity.` }
}

// ── KPI block — benchmark is { text, color } or null (Change 4) ─────────────
// Color-coded: emerald = above industry avg, amber = near it, rose = below
function KPI({ label, value, sub, pct, big, benchmark }) {
  // Length-aware sizing: a 7-figure currency value (e.g. "$1,142,638") at text-5xl
  // overflows its minmax(0,1fr) grid track and collides with the next tile's number.
  // Step the font down as the string grows so the value always fits its own column.
  // tabular-nums + tracking-tight + whitespace-nowrap keep the count-up animation from
  // jittering the width frame-to-frame and stop a long number from wrapping to 2 lines.
  const len = String(value).length
  const sizeClass = big
    ? (len >= 11 ? 'text-3xl' : len >= 9 ? 'text-4xl' : 'text-5xl')
    : (len >= 11 ? 'text-2xl' : len >= 9 ? 'text-3xl' : 'text-4xl')
  return (
    <div className="flex flex-col min-w-0">
      <p className="text-[11px] font-black uppercase tracking-widest text-white/60 mb-2">{label}</p>
      <p className={`font-black text-white leading-none tabular-nums tracking-tight whitespace-nowrap ${sizeClass}`}>{value}</p>
      {sub       && <p className="text-sm text-white/65 mt-1.5 font-medium">{sub}</p>}
      {pct != null && <div className="mt-2"><DeltaTag pct={pct} /></div>}
      {benchmark && (
        <p className={`text-[10px] mt-2 font-bold leading-snug border-t border-white/8 pt-2 ${benchmark.color}`}>
          {benchmark.text}
        </p>
      )}
    </div>
  )
}

// ── Goal status pill ─────────────────────────────────────────────────────────
function goalStatus(actual, target) {
  if (!target || target <= 0 || actual == null) return null
  const pct = actual / target
  if (pct >= 0.95)  return { label: 'On Track',  color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' }
  if (pct >= 0.75)  return { label: 'Close',      color: 'bg-amber-500/20   text-amber-400   border-amber-500/30'   }
  return              { label: 'Behind',           color: 'bg-rose-500/20    text-rose-400    border-rose-500/30'    }
}

function GoalPill({ label, actual, target, fmt }) {
  const status = goalStatus(actual, target)
  if (!status) return null
  const pct = Math.min(100, Math.round((actual / target) * 100))
  return (
    <div className={`inline-flex items-center gap-2 text-[10px] font-black px-3 py-1.5 rounded-full border ${status.color}`}>
      <span className="uppercase tracking-wider">{status.label}</span>
      <span className="opacity-60">|</span>
      <span>{label}: {fmt ? fmt(actual) : actual} / {fmt ? fmt(target) : target}</span>
      <span className="opacity-60">({pct}%)</span>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ExecView({ store }) {
  const {
    stats = {}, prevStats = {}, weeklyTrend = [],
    clients = [], selectedClient, clientSummary = [],
    selectedPeriod, setSelectedPeriod,
    currentGoal,
    loading, metricsLoading,
  } = store

  const clientObj   = clients.find(c => c.id === selectedClient) || null
  const clientName  = clientObj?.name || (selectedClient === 'all' ? 'All Clients' : 'Your Business')
  const periodLabel = PERIOD_OPTS.find(p => p.value === selectedPeriod)?.label || ''

  const revenue  = stats.total_revenue || 0
  const jobs     = stats.total_closed  || 0
  const leads    = stats.total_leads   || 0
  const spend    = stats.total_spend   || 0
  const roas     = spend > 0 ? revenue / spend : (stats.avg_roas || 0)

  const revDelta   = delta(revenue, prevStats.total_revenue)?.pct ?? null
  const jobsDelta  = delta(jobs,    prevStats.total_closed)?.pct  ?? null
  const leadsDelta = delta(leads,   prevStats.total_leads)?.pct   ?? null

  const sparkData = weeklyTrend.slice(-8).map(w => ({
    week:    weekLabel(w.week),
    revenue: Math.round(w.revenue || 0),
    spend:   Math.round(w.spend   || 0),
  }))

  const verdict = verdictFor({ revenue, revDelta: revDelta ?? 0, roas, leads, jobs })

  // Show loading spinner while data is fetching — never flash the empty state
  const isLoading = loading || metricsLoading
  const noData    = !isLoading && revenue === 0 && leads === 0 && spend === 0

  // Animated counters — numbers roll up when exec page mounts (dramatic in a boardroom)
  const animRevenue = useCountUp(Math.round(revenue), { duration: 1800, delay: 300 })
  const animJobs    = useCountUp(jobs,                { duration: 1400, delay: 500 })
  const animRoas    = useCountUp(Math.round(roas * 10), { duration: 1600, delay: 700 })
  const animLeads   = useCountUp(leads,               { duration: 1300, delay: 600 })

  // Verdict color map
  const vc = {
    emerald: { statusText: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/10' },
    amber:   { statusText: 'text-amber-400',   border: 'border-amber-500/30',   bg: 'bg-amber-500/10'   },
    rose:    { statusText: 'text-rose-400',     border: 'border-rose-500/30',    bg: 'bg-rose-500/10'    },
    slate:   { statusText: 'text-white/50',     border: 'border-white/10',       bg: 'bg-white/5'        },
  }[verdict?.color || 'slate']

  // Loading state — data is still fetching
  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-8" style={{ background: '#0a0a0a' }}>
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-6 animate-pulse">
            <TrendingUp className="w-8 h-8 text-white/30" />
          </div>
          <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-3">
            Executive Summary
          </p>
          <p className="text-white/40 text-sm">Loading performance data…</p>
        </div>
      </div>
    )
  }

  // Clean placeholder — only shown after load completes with genuinely no data
  if (noData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-8" style={{ background: '#0a0a0a' }}>
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-6">
            <TrendingUp className="w-8 h-8 text-white/30" />
          </div>
          <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-3">
            Executive Summary
          </p>
          <p className="text-white text-xl font-black mb-2">{clientName}</p>
          <p className="text-white/40 text-sm leading-relaxed mb-6">
            Connect your marketing channels in the Connections page to populate your performance summary.
          </p>
          <Link to="/connections" className="inline-flex items-center gap-2 text-xs font-black text-brand-400 hover:text-brand-300 transition-colors border border-brand-500/30 px-4 py-2 rounded-xl hover:bg-brand-500/10">
            Go to Connections →
          </Link>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @media print {
          .ev-nav, .ev-footer { display: none !important; }
          body { background: white !important; color: black !important; }
          .ev-main { background: white !important; color: black !important; }
          .ev-hero { background: #0a0a0a !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .ev-kpi-text { color: black !important; }
          @page { margin: 1.5cm; }
        }
      `}</style>

      <div className="ev-main min-h-screen flex flex-col" style={{ background: '#0a0a0a' }}>

        {/* ── Nav ── */}
        <header className="ev-nav flex items-center justify-between px-8 py-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-brand-500 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs font-black tracking-[.2em] text-brand-500 uppercase">10X Performance</span>
          </div>

          <div className="flex items-center gap-3">
            <select
              value={selectedPeriod}
              onChange={e => setSelectedPeriod(e.target.value)}
              className="appearance-none text-xs font-black text-white bg-white/10 border border-white/15 rounded-xl px-3 py-1.5 pr-7 focus:outline-none cursor-pointer"
            >
              {PERIOD_OPTS.map(o => (
                <option key={o.value} value={o.value} className="text-black">{o.label}</option>
              ))}
            </select>

            {/* Minimal exit — doesn't compete with content in a QBR setting */}
            <Link to="/" className="text-[10px] font-bold text-white/25 hover:text-white/50 transition-colors">
              ← Agency
            </Link>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 text-xs font-black text-white/60 hover:text-white/90 transition-colors border border-white/15 px-3 py-1.5 rounded-xl hover:bg-white/5"
            >
              <Download className="w-3.5 h-3.5" />
              Download PDF
            </button>
          </div>
        </header>

        {/* ── Main content ── */}
        <div className="flex-1 flex flex-col justify-center px-8 py-12 max-w-5xl mx-auto w-full">

          {/* Context line */}
          <p className="text-white/60 text-sm font-black uppercase tracking-widest mb-3">
            {clientName} · {periodLabel}
          </p>

          {/* Strategic headline — 2–3 sentences generated from live data */}
          <p className="text-white/90 text-xl font-semibold leading-relaxed mb-5 max-w-2xl">
            {buildStrategicHeadline({ clientName, revenue, jobs, roas, spend, leads, revDelta: revDelta ?? 0, stats })}
          </p>

          {/* Influence hero (intel-v12 B3) — the honest, weighted tally of what the autonomous
              analyst MOVED, sitting between the strategic headline and the health verdict so the
              exec view leads with delivered value. The shared ImpactBanner brings its own brand-
              gradient background (theme-independent), self-fetches the portfolio ledger, and stays
              silent until there's a real headline — so on a fresh portfolio this column is unchanged. */}
          <ImpactBanner className="mb-10" />

          {/* ── Health verdict ── */}
          {verdict && (
            <div className={`flex items-start gap-3 mb-12 p-4 rounded-2xl border ${vc.border} ${vc.bg} max-w-2xl`}>
              <span className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${verdict.dot}`} />
              <div>
                <span className={`text-xs font-black uppercase tracking-wider mr-2 ${vc.statusText}`}>
                  {verdict.status}
                </span>
                <span className="text-sm text-white/70 leading-relaxed">{verdict.text}</span>
              </div>
            </div>
          )}

          {/* ── Goal pills — On Track / Close / Behind ── */}
          {currentGoal && (currentGoal.revenue_target || currentGoal.leads_target || currentGoal.jobs_target) && (
            <div className="flex flex-wrap items-center gap-2 mb-10">
              <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mr-1">Monthly Goals</p>
              <GoalPill label="Revenue" actual={revenue} target={currentGoal.revenue_target} fmt={fmt$$} />
              <GoalPill label="Leads"   actual={leads}   target={currentGoal.leads_target} />
              <GoalPill label="Jobs"    actual={jobs}    target={currentGoal.jobs_target} />
            </div>
          )}

          {/* ── 4 giant KPIs — colored benchmark lines ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-10 mb-16">
            <KPI
              label="Revenue Generated"
              value={revenue > 0 ? fmt$$(animRevenue) : '—'}
              sub="from closed jobs"
              pct={revDelta}
              big
              benchmark={
                prevStats.total_revenue > 0
                  ? {
                      text:  `Prior period: ${fmt$$(prevStats.total_revenue)}`,
                      color: revenue >= prevStats.total_revenue ? 'text-emerald-400' : 'text-rose-400',
                    }
                  : null
              }
            />
            <KPI
              label="Jobs Won"
              value={jobs > 0 ? fmtN(animJobs) : '—'}
              sub={jobs > 0 ? `avg ${fmt$$(revenue / jobs)} per job` : undefined}
              pct={jobsDelta}
              big
              benchmark={
                leads > 0
                  ? {
                      text:  `${((jobs / leads) * 100).toFixed(0)}% close rate · avg 20–25%`,
                      color: (jobs / leads) * 100 >= 20 ? 'text-emerald-400'
                           : (jobs / leads) * 100 >= 10 ? 'text-amber-400'
                           :                               'text-rose-400',
                    }
                  : null
              }
            />
            <KPI
              label="Marketing ROI"
              value={roas >= 1 ? `${(animRoas / 10).toFixed(1)}×` : '—'}
              sub={roas >= 1 ? `$${(animRoas / 10).toFixed(2)} earned per $1 spent` : 'Not enough data'}
              pct={null}
              big
              benchmark={{
                text:  roas >= 3   ? '✓ Above 3–5× home services avg'
                     : roas >= 1.5 ? 'Home services avg: 3–5×'
                     : roas > 0    ? '↘ Below breakeven · avg: 3–5×'
                     :               'Home services avg: 3–5×',
                color: roas >= 3   ? 'text-emerald-400'
                     : roas >= 1.5 ? 'text-amber-400'
                     : roas > 0    ? 'text-rose-400'
                     :               'text-white/35',
              }}
            />
            <KPI
              label="New Leads"
              value={leads > 0 ? fmtN(animLeads) : '—'}
              sub={`${fmt$$(spend)} total spend`}
              pct={leadsDelta}
              big
              benchmark={
                leads > 0 && spend > 0
                  ? { text: `${fmt$$(spend / leads)} avg cost per lead`, color: 'text-white/50' }
                  : null
              }
            />
          </div>

          {/* ── Conversion story ── */}
          {leads > 0 && jobs > 0 && (
            <div className="mb-16">
              <p className="text-white/60 text-xs font-black uppercase tracking-widest mb-5">
                Lead-to-Revenue Story
              </p>
              <div className="flex items-center gap-0 flex-wrap">
                {[
                  { label: 'Leads came in', value: leads, sub: 'people contacted you' },
                  ...(stats.total_mql > 0 ? [{ label: 'Leads qualified', value: stats.total_mql, sub: `${Math.round((stats.total_mql / leads) * 100)}% of leads` }] : []),
                  { label: 'Jobs won',      value: jobs,  sub: `${Math.round((jobs / leads) * 100)}% close rate`, accent: true },
                ].map((step, i, arr) => (
                  <div key={step.label} className="flex items-center">
                    <div className={`px-5 py-4 rounded-2xl border ${step.accent ? 'border-brand-500/40 bg-brand-500/10' : 'border-white/10 bg-white/5'}`}>
                      <p className={`text-2xl font-black ${step.accent ? 'text-brand-400' : 'text-white'}`}>
                        {fmtN(step.value)}
                      </p>
                      <p className="text-xs font-black text-white/65 mt-0.5">{step.label}</p>
                      <p className="text-[10px] text-white/40 mt-0.5">{step.sub}</p>
                    </div>
                    {i < arr.length - 1 && (
                      <div className="flex flex-col items-center px-3">
                        <div className="w-6 h-px bg-white/20" />
                        <p className="text-[9px] text-white/30 mt-0.5 whitespace-nowrap">
                          {arr[i + 1].accent
                            ? `${Math.round((arr[i + 1].value / step.value) * 100)}% became jobs`
                            : `${Math.round((arr[i + 1].value / step.value) * 100)}% continued`}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Sparkline ── */}
          {sparkData.length > 1 && (
            <div className="mb-16">
              <div className="flex items-center justify-between mb-4">
                <p className="text-white/60 text-xs font-black uppercase tracking-widest">Revenue Trend</p>
                <p className="text-white/30 text-xs font-bold">Last 8 weeks</p>
              </div>
              <div className="border-t border-white/10 pt-5">
                <Spark data={sparkData} />
                <div className="flex justify-between mt-2">
                  {sparkData.map((d, i) => (
                    <p key={i} className="text-[9px] text-white/35 font-medium">{d.week}</p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Portfolio Treemap — size=revenue, color=ROAS health ── */}
          {selectedClient === 'all' && clientSummary.filter(c => (c.total_revenue || 0) > 0).length > 1 && (
            <div className="mb-16">
              <div className="flex items-center justify-between mb-2">
                <p className="text-white/60 text-xs font-black uppercase tracking-widest">Portfolio Map</p>
                <div className="flex items-center gap-3 text-[9px] font-black uppercase tracking-wider">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Strong ROAS</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Building</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-400 inline-block" /> Needs work</span>
                </div>
              </div>
              <p className="text-white/25 text-[10px] mb-4">Box size = revenue share · Color = ROAS health · Hover for details</p>
              <div style={{ height: 200, width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <Treemap
                    data={clientSummary
                      .filter(c => (c.total_revenue || 0) > 0)
                      .map(c => ({
                        name:    c.name.split(' ')[0],
                        size:    c.total_revenue || 1,
                        roas:    c.total_spend > 0 ? (c.total_revenue / c.total_spend) : 0,
                        revenue: c.total_revenue || 0,
                        jobs:    c.total_closed || 0,
                      }))}
                    dataKey="size"
                    aspectRatio={4 / 3}
                    content={({ x, y, width, height, name, roas, revenue, jobs }) => {
                      const color = roas >= 3 ? '#34d399' : roas >= 1.5 ? '#fbbf24' : '#f87171'
                      const show  = width > 50 && height > 28
                      return (
                        <g>
                          <rect x={x+1} y={y+1} width={width-2} height={height-2}
                            fill={color} fillOpacity={0.85} rx={6} />
                          {show && (
                            <>
                              <text x={x+width/2} y={y+height/2-(jobs>0?8:2)} textAnchor="middle"
                                fill="white" fontSize={Math.min(13, width/4)} fontWeight="800">
                                {name}
                              </text>
                              {jobs > 0 && (
                                <text x={x+width/2} y={y+height/2+10} textAnchor="middle"
                                  fill="rgba(255,255,255,0.65)" fontSize={Math.min(10, width/5)}>
                                  {roas > 0 ? `${roas.toFixed(1)}× ROAS` : `${jobs} jobs`}
                                </text>
                              )}
                            </>
                          )}
                        </g>
                      )
                    }}
                  />
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ── Client breakdown table (agency view only) ── */}
          {selectedClient === 'all' && clientSummary.length > 0 && (
            <div>
              <p className="text-white/60 text-xs font-black uppercase tracking-widest mb-5">
                Results by Client
              </p>
              <div className="space-y-1">
                {clientSummary
                  .filter(c => (c.total_revenue || 0) > 0)
                  .sort((a, b) => (b.total_revenue || 0) - (a.total_revenue || 0))
                  .slice(0, 6)
                  .map(c => {
                    const clientRoas = c.total_spend > 0 ? (c.total_revenue / c.total_spend) : 0
                    const revShare   = revenue > 0 ? ((c.total_revenue || 0) / revenue) * 100 : 0
                    const closeRate  = c.total_leads > 0 ? ((c.total_closed || 0) / c.total_leads) * 100 : 0
                    const health     = clientRoas >= 3 ? 'bg-emerald-400' : clientRoas >= 1.5 ? 'bg-amber-400' : 'bg-rose-400'
                    return (
                      <div key={c.id} className="flex items-center gap-4 py-3.5 border-b border-white/8 group hover:bg-white/3 rounded-xl px-3 transition-colors">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${health}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black text-white leading-none">{c.name}</p>
                          {c.location && <p className="text-[10px] text-white/40 mt-0.5">{c.location}</p>}
                        </div>
                        <p className="text-sm font-black text-white w-24 text-right">{fmt$$(c.total_revenue)}</p>
                        <p className="text-xs font-bold text-white/60 w-16 text-right">{fmtN(c.total_closed)} jobs</p>
                        <p className="text-xs font-black text-brand-400 w-16 text-right">{clientRoas.toFixed(1)}× ROI</p>
                        <div className="w-20">
                          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-brand-500 rounded-full transition-all" style={{ width: `${revShare}%` }} />
                          </div>
                          <p className="text-[9px] text-white/30 mt-0.5 text-right">{revShare.toFixed(0)}%</p>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <footer className="ev-footer px-8 py-5 border-t border-white/8 flex items-center justify-between">
          <p className="text-[10px] text-white/40 font-medium">
            Powered by 10X Marketing Performance Dashboard
          </p>
          <p className="text-[10px] text-white/40 font-medium">
            Updated weekly · {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </footer>
      </div>
    </>
  )
}
