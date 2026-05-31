import { useOutletContext, useNavigate } from 'react-router-dom'
import { ArrowRight, AlertTriangle, CheckCircle, ExternalLink } from 'lucide-react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'
import TopBar from '@/components/TopBar'
import AskBox from '@/components/AskBox'
import ChannelBreakdown from '@/components/ChannelBreakdown'
import ActivityFeed from '@/components/ActivityFeed'
import SpendAreaChart from '@/components/charts/SpendAreaChart'
import { SkeletonGrid } from '@/components/SkeletonCard'
import { fmt$$, fmtN, fmtPct, fmtX, delta } from '@/lib/utils'

/* ── Bottleneck detection logic ── */
function bottleneck(stats) {
  const mqlTracked  = (stats.total_mql || 0) > 0
  const closeRate   = stats.total_leads > 0 ? (stats.total_closed / stats.total_leads) * 100 : null
  // Guard: only fire follow-up bottleneck when MQL data is actually tracked.
  // Without tracking, total_mql = 0, which would generate a false "0% follow-up" alarm.
  const followUpRate = mqlTracked && stats.total_leads > 0
    ? (stats.total_mql / stats.total_leads) * 100
    : null
  if (closeRate !== null && closeRate < 10)
    return { type: 'close_rate', label: 'Close Rate', desc: `Only ${closeRate.toFixed(0)}% of leads are converting. Focus on follow-up speed and lead qualification.` }
  if (followUpRate !== null && followUpRate < 50)
    return { type: 'follow_up', label: 'Follow-Up Speed', desc: `${followUpRate.toFixed(0)}% of leads tagged MQL are being followed up. Automate day-1 outreach.` }
  const roas = stats.avg_roas || (stats.total_spend > 0 ? stats.total_revenue / stats.total_spend : 0)
  if (roas > 0 && roas < 1.5)
    return { type: 'ad_efficiency', label: 'Ad Efficiency', desc: `ROAS is ${roas.toFixed(1)}×. Review targeting and creative before increasing spend.` }
  return null
}

/* ── Delta pill ── */
function DeltaPill({ value, prev, invert = false }) {
  if (!prev || prev === 0) return null
  const pct  = ((value - prev) / prev) * 100
  const up   = pct >= 0
  const good = invert ? !up : up
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold px-2 py-0.5 rounded-full mt-2 ${
      good ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
    }`}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%
      <span className="text-slate-400 font-normal ml-0.5 text-[10px]">vs prior</span>
    </span>
  )
}

/* ── Micro-sparkline inside each KPI card ── */
function KpiSpark({ data, dataKey, color = '#e53935' }) {
  if (!data?.length) return null
  return (
    <div className="absolute bottom-0 left-0 right-0 h-12 opacity-60 pointer-events-none">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`spark-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#spark-${dataKey})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ── Big metric widget ── */
function MetricWidget({ label, value, sub, prev, invert, format = fmt$$, sparkData, sparkKey, sparkColor }) {
  return (
    <div className="relative flex flex-col justify-between h-full p-5 overflow-hidden">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <div className="relative z-10">
        <p className="text-4xl font-black text-slate-900 leading-none">{format(value)}</p>
        {sub && <p className="text-xs text-slate-400 mt-1.5">{sub}</p>}
        <DeltaPill value={value} prev={prev} invert={invert} />
      </div>
      {sparkData && <KpiSpark data={sparkData} dataKey={sparkKey} color={sparkColor} />}
    </div>
  )
}

/* ── Funnel widget ── */
// Change 1: never fabricate MQL — show "not tracked" when data is missing
function FunnelWidget({ stats }) {
  const spend  = stats.total_spend   || 0
  const leads  = stats.total_leads   || 0
  const mql    = stats.total_mql     || 0
  const closed = stats.total_closed  || 0
  const revenue= stats.total_revenue || 0
  const impressions = (stats.ads_impressions || 0) + (stats.meta_impressions || 0)

  // Only treat MQL as real if it's actually > 0
  const mqlTracked = mql > 0
  const closeRate  = leads > 0 ? (closed / leads) * 100 : 0
  const mqlRate    = mqlTracked && leads > 0 ? (mql / leads) * 100 : null

  const steps = [
    {
      label:     'Spend',
      value:     fmt$$(spend),
      dot:       'bg-slate-400',
      color:     'text-slate-600',
    },
    {
      label:     'Reached',
      value:     fmtN(impressions),
      note:      'impressions',
      dot:       'bg-blue-300',
      color:     'text-blue-500',
    },
    {
      label:     'Leads',
      value:     fmtN(leads),
      dot:       'bg-blue-500',
      color:     'text-blue-700',
    },
    {
      label:     'Followed Up',
      // ← real data or explicit "not tracked" — never a made-up 65%
      value:     mqlTracked ? fmtN(mql) : '—',
      dot:       !mqlTracked       ? 'bg-slate-200'  :
                 mqlRate >= 50     ? 'bg-amber-400'  : 'bg-rose-500',
      color:     !mqlTracked       ? 'text-slate-300' :
                 mqlRate >= 50     ? 'text-amber-600' : 'text-rose-600',
      dropoff:   mqlRate != null ? `${mqlRate.toFixed(0)}%` : null,
      untracked: !mqlTracked && leads > 0,
    },
    {
      label:     'Jobs Won',
      value:     fmtN(closed),
      dot:       closeRate >= 15  ? 'bg-emerald-500' :
                 leads > 0        ? 'bg-rose-500'    : 'bg-slate-300',
      color:     closeRate >= 15  ? 'text-emerald-700' :
                 leads > 0        ? 'text-rose-600'    : 'text-slate-400',
      dropoff:   leads > 0 ? `${closeRate.toFixed(0)}%` : null,
    },
    {
      label:     'Revenue',
      value:     fmt$$(revenue),
      dot:       revenue > 0 ? 'bg-brand-500' : 'bg-slate-300',
      color:     revenue > 0 ? 'text-brand-600' : 'text-slate-400',
    },
  ]

  return (
    <div className="h-full flex flex-col justify-between p-5">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Marketing Funnel — This Period</p>
      <div className="flex flex-wrap items-center gap-y-4 gap-x-1 flex-1">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1">
            <div className="flex flex-col items-center min-w-[64px]">
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
                <span className={`text-lg font-black leading-none ${s.color}`}>{s.value}</span>
              </div>
              <span className="text-[10px] text-slate-500 text-center leading-tight">{s.label}</span>
              {/* "not tracked" label — honest about missing CRM data */}
              {s.untracked && (
                <span className="text-[8px] text-slate-400 italic mt-0.5">not tracked</span>
              )}
              {/* real dropoff rate */}
              {!s.untracked && s.dropoff && (
                <span className={`text-[9px] font-bold mt-0.5 ${
                  parseFloat(s.dropoff) >= 50 ? 'text-emerald-500' :
                  parseFloat(s.dropoff) >= 20 ? 'text-amber-500'  : 'text-rose-500'
                }`}>{s.dropoff} rate</span>
              )}
              {s.note && (
                <span className="text-[9px] text-slate-400 mt-0.5">{s.note}</span>
              )}
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className="w-3.5 h-3.5 text-slate-200 shrink-0" />
            )}
          </div>
        ))}
      </div>
      {/* Reminder if MQL isn't wired up */}
      {!mqlTracked && leads > 0 && (
        <p className="text-[9px] text-slate-400 mt-3 border-t border-slate-50 pt-2">
          💡 Tag leads "MQL" in GHL to unlock follow-up rate tracking
        </p>
      )}
    </div>
  )
}

/* ── Bottleneck widget ── */
function BottleneckWidget({ stats }) {
  const bn = bottleneck(stats)

  if (!bn) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center mb-3">
          <CheckCircle className="w-6 h-6 text-emerald-500" />
        </div>
        <p className="text-sm font-black text-slate-800 mb-1">Performance on Track</p>
        <p className="text-xs text-slate-400 leading-relaxed">
          No critical issues detected. Close rate, follow-up speed, and ROAS are all within healthy ranges.
        </p>
      </div>
    )
  }

  const colors = {
    close_rate:   { bg: 'bg-rose-50',   border: 'border-rose-200',   dot: 'bg-rose-500',   text: 'text-rose-700',   label: 'text-rose-600'   },
    follow_up:    { bg: 'bg-amber-50',  border: 'border-amber-200',  dot: 'bg-amber-500',  text: 'text-amber-700',  label: 'text-amber-600'  },
    ad_efficiency:{ bg: 'bg-orange-50', border: 'border-orange-200', dot: 'bg-orange-500', text: 'text-orange-700', label: 'text-orange-600' },
  }
  const c = colors[bn.type] || colors.close_rate

  return (
    <div className={`h-full flex flex-col justify-between p-5 rounded-2xl ${c.bg} border ${c.border}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
        <p className={`text-[10px] font-black uppercase tracking-widest ${c.label}`}>Bottleneck Detected</p>
      </div>
      <div className="flex-1 flex flex-col justify-center">
        <div className="flex items-start gap-2 mb-3">
          <AlertTriangle className={`w-5 h-5 shrink-0 mt-0.5 ${c.label}`} />
          <p className={`text-base font-black ${c.text}`}>{bn.label}</p>
        </div>
        <p className={`text-sm leading-relaxed ${c.text}`}>{bn.desc}</p>
      </div>
      <p className={`text-[10px] font-bold uppercase tracking-wider mt-3 ${c.label}`}>
        Focus area this period
      </p>
    </div>
  )
}

/* ── Client health table ── */
// Sort worst (red) first — agency needs to see who's on fire immediately
function clientHealthScore(c) {
  const roas      = c.total_spend > 0 ? (c.total_revenue || 0) / c.total_spend : 0
  const closeRate = c.total_leads > 0 ? ((c.total_closed || 0) / c.total_leads) * 100 : 0
  if (!c.total_revenue && !c.total_leads) return 2  // no data — middle
  if (roas >= 3 && closeRate >= 15)         return 3  // strong — last
  if (roas >= 1.5 || closeRate >= 10)       return 1  // watch
  return 0                                            // at risk — first
}

function ClientsWidget({ clients, stats, onClientClick }) {
  const topClients = [...(clients || [])].sort((a, b) => clientHealthScore(a) - clientHealthScore(b))
  const totalRev = topClients.reduce((s, c) => s + (c.total_revenue || 0), 0) || 1

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
        <p className="text-sm font-bold text-slate-700">Client Health</p>
        <p className="text-xs text-slate-400">Worst first</p>
      </div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60">
              {['Client', 'Revenue', 'Jobs', 'ROAS', 'Close Rate', 'Rev. Share'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topClients.map(c => {
              const closeRate = c.total_leads > 0 ? ((c.total_closed || 0) / c.total_leads) * 100 : 0
              const roas      = c.total_spend > 0 ? (c.total_revenue || 0) / c.total_spend : 0
              const revShare  = ((c.total_revenue || 0) / totalRev) * 100

              // Health: green = ROAS≥3 AND close≥15%, amber = one weak, red = both weak
              const roasOk  = roas >= 3
              const closeOk = closeRate >= 15
              const health  = roasOk && closeOk
                ? { dot: 'bg-emerald-500', ring: 'ring-emerald-100', label: 'Strong' }
                : roasOk || closeOk
                ? { dot: 'bg-amber-400',   ring: 'ring-amber-100',   label: 'Watch'  }
                : { dot: 'bg-rose-500',    ring: 'ring-rose-100',    label: 'At Risk' }

              const atRisk = health.label === 'At Risk'
              return (
                <tr
                  key={c.id}
                  onClick={() => onClientClick && onClientClick(c.id)}
                  className={`border-b border-slate-50 transition-colors group cursor-pointer ${atRisk ? 'bg-rose-50/40 hover:bg-rose-50/70' : 'hover:bg-slate-50/70'}`}
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ring-2 ${health.dot} ${health.ring}`}
                        title={health.label}
                      />
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-slate-800 leading-none group-hover:text-brand-600 transition-colors">{c.name}</p>
                          {atRisk && (
                            <span className="text-[9px] font-black uppercase tracking-wide text-rose-500 bg-rose-100 px-1.5 py-0.5 rounded">
                              Needs Attention
                            </span>
                          )}
                        </div>
                        {c.location && <p className="text-[10px] text-slate-400 mt-0.5">{c.location}</p>}
                      </div>
                      <ExternalLink className="w-3 h-3 text-slate-300 group-hover:text-brand-400 transition-colors ml-auto shrink-0" />
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="font-bold text-slate-800">{fmt$$(c.total_revenue)}</p>
                    {c.total_spend > 0 && (
                      <p className="text-[10px] text-slate-400">{fmt$$(c.total_spend)} spend</p>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="font-semibold text-slate-700">{fmtN(c.total_closed)}</p>
                    {c.total_closed > 0 && c.total_revenue > 0 && (
                      <p className="text-[10px] text-slate-400">{fmt$$(c.total_revenue / c.total_closed)} avg</p>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-sm font-bold ${roas >= 3 ? 'text-emerald-600' : roas >= 1.5 ? 'text-amber-600' : 'text-rose-600'}`}>
                      {roas > 0 ? fmtX(roas) : '—'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(closeRate, 100)}%`,
                            background: closeRate >= 20 ? '#10b981' : closeRate >= 10 ? '#f59e0b' : '#e53935',
                          }}
                        />
                      </div>
                      <span className={`text-xs font-semibold ${closeRate >= 20 ? 'text-emerald-600' : closeRate >= 10 ? 'text-amber-600' : 'text-rose-600'}`}>
                        {fmtPct(closeRate)}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-brand-500 rounded-full"
                          style={{ width: `${Math.min(revShare, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold text-slate-500">{revShare.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Main Dashboard page ── */
export default function Dashboard() {
  const store    = useOutletContext() || {}
  const navigate = useNavigate()
  const { stats = {}, prevStats = {}, weeklyTrend = [], clientSummary = [], loading } = store

  const revenue = stats.total_revenue || 0
  const jobs    = stats.total_closed  || 0
  const leads   = stats.total_leads   || 0
  const spend   = stats.total_spend   || 0
  const roas    = spend > 0 ? revenue / spend : (stats.avg_roas || 0)

  // Spark data slices — last 8 weeks mapped per metric
  const sparkWeeks = weeklyTrend.slice(-8)
  const revSpark   = sparkWeeks.map(w => ({ v: Math.round(w.revenue || 0) }))
  const jobsSpark  = sparkWeeks.map(w => ({ v: Math.round(w.closed  || 0) }))
  const leadsSpark = sparkWeeks.map(w => ({ v: Math.round(w.leads   || 0) }))
  const roasSpark  = sparkWeeks.map(w => ({
    v: w.spend > 0 ? Math.round((w.revenue / w.spend) * 10) : 0,
  }))

  function handleClientClick(clientId) {
    store.setSelectedClient?.(clientId)
    navigate('/my-dashboard')
  }

  return (
    <div>
      <TopBar
        title="Agency Dashboard"
        subtitle="Performance across all clients — this period"
        {...store}
        onClientChange={store.setSelectedClient}
        onPeriodChange={store.setSelectedPeriod}
      />

      {loading ? (
        <>
          <SkeletonGrid count={4} />
          <SkeletonGrid count={2} />
        </>
      ) : (
        <div className="px-6 pb-8 space-y-4">

          {/* ── Ask your data (Sprint 2 NL query) ── */}
          <AskBox />

          {/* ── Row 1: 4 KPI cards ── */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Revenue Generated', value: revenue, format: fmt$$,  sub: jobs > 0 ? `Avg ${fmt$$(revenue / jobs)} per job` : 'No closed jobs yet', prev: prevStats.total_revenue, spark: revSpark,   color: '#e53935' },
              { label: 'Jobs Won',           value: jobs,    format: fmtN,   sub: leads > 0 ? `${fmtPct((jobs / leads) * 100)} close rate` : 'No leads yet',  prev: prevStats.total_closed,  spark: jobsSpark,  color: '#10b981' },
              { label: 'Marketing ROAS',     value: roas,    format: fmtX,   sub: 'Per $1 spent on ads',                                                       prev: prevStats.total_spend > 0 ? prevStats.total_revenue / prevStats.total_spend : null, spark: roasSpark, color: '#6366f1' },
              { label: 'New Leads',          value: leads,   format: fmtN,   sub: spend > 0 ? `${fmt$$(spend)} total ad spend` : 'No ad spend recorded',       prev: prevStats.total_leads,   spark: leadsSpark, color: '#3b82f6' },
            ].map(m => (
              <div key={m.label} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden h-40">
                <MetricWidget label={m.label} value={m.value} format={m.format} sub={m.sub} prev={m.prev} sparkData={m.spark} sparkKey="v" sparkColor={m.color} />
              </div>
            ))}
          </div>

          {/* ── Row 2: Funnel + Bottleneck ── */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm h-52">
              <FunnelWidget stats={stats} />
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm h-52 overflow-hidden">
              <BottleneckWidget stats={stats} />
            </div>
          </div>

          {/* ── Row 3: Trend + Channels + Activity ── */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm h-64 overflow-hidden">
              <div className="p-5 h-full">
                <SpendAreaChart data={weeklyTrend} />
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm h-64 overflow-hidden">
              <ChannelBreakdown stats={stats} />
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm h-64 overflow-hidden">
              <ActivityFeed clients={store.clients || []} />
            </div>
          </div>

          {/* ── Row 4: Client health table ── */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <ClientsWidget clients={clientSummary} stats={stats} onClientClick={handleClientClick} />
          </div>

        </div>
      )}
    </div>
  )
}
