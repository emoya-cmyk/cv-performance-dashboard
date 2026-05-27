import { useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  ResponsiveContainer, Tooltip, Legend,
} from 'recharts'
import { AlertTriangle, CheckCircle, TrendingUp, Target } from 'lucide-react'
import TopBar from '@/components/TopBar'
import { fmt$$, fmtN, fmtPct, weekLabel } from '@/lib/utils'

// ── Industry benchmarks (home services, 2024) ────────────────────────────────
const BENCHMARKS = {
  impressionToClick: { avg: 4.5,  unit: '%', label: 'Impression-to-Click (CTR)' },
  clickToLead:       { avg: 8.0,  unit: '%', label: 'Click-to-Lead' },
  leadToClose:       { avg: 22,   unit: '%', label: 'Lead-to-Job Close Rate' },
  cpl:               { avg: 62,   unit: '$', label: 'Cost Per Lead',      invert: true },
  roas:              { avg: 3.5,  unit: '×', label: 'Marketing ROAS' },
}

// ── Color helpers ─────────────────────────────────────────────────────────────
function rateColor(rate, goodThreshold, okThreshold) {
  if (rate === null || rate === undefined) return { text: 'text-slate-400', bg: 'bg-slate-100', dot: 'bg-slate-400' }
  if (rate >= goodThreshold) return { text: 'text-emerald-700', bg: 'bg-emerald-100', dot: 'bg-emerald-500' }
  if (rate >= okThreshold)   return { text: 'text-amber-700',   bg: 'bg-amber-100',   dot: 'bg-amber-500'   }
  return                            { text: 'text-rose-700',    bg: 'bg-rose-100',    dot: 'bg-rose-500'    }
}

// ── Funnel health score (0–100) ───────────────────────────────────────────────
function computeHealthScore({ closeRate, cpl, roas, leadTrend, dataCompleteness }) {
  let score = 0
  // Close rate vs 22% benchmark (30pts)
  if (closeRate >= 22) score += 30
  else if (closeRate >= 10) score += Math.round((closeRate / 22) * 30)
  // CPL vs $62 benchmark (20pts — lower is better)
  if (cpl > 0 && cpl <= 62) score += 20
  else if (cpl > 0 && cpl <= 120) score += Math.round(((120 - cpl) / 120) * 20)
  // ROAS vs 3.5× benchmark (25pts)
  if (roas >= 3.5) score += 25
  else if (roas >= 1.5) score += Math.round((roas / 3.5) * 25)
  // Lead trend (15pts — are leads growing?)
  if (leadTrend > 5)  score += 15
  else if (leadTrend >= 0) score += 8
  // Data completeness (10pts)
  score += Math.round(dataCompleteness * 10)
  return Math.min(Math.round(score), 100)
}

// ── Waterfall funnel component ────────────────────────────────────────────────
function FunnelWaterfall({ stages }) {
  const maxVol = stages.reduce((m, s) => Math.max(m, s.volume || 0), 0) || 1
  return (
    <div className="space-y-2">
      {stages.map((s, i) => {
        if (s.missing) {
          return (
            <div key={s.label} className="flex items-center gap-4">
              <div className="w-32 text-right">
                <p className="text-[11px] font-black text-slate-400 uppercase tracking-wide">{s.label}</p>
              </div>
              <div className="flex-1 h-10 border-2 border-dashed border-slate-200 rounded-xl flex items-center px-3">
                <p className="text-[10px] text-slate-400 italic">{s.missingLabel || 'Not yet tracked'}</p>
              </div>
              <div className="w-24 text-right">
                <p className="text-[11px] text-slate-300">—</p>
              </div>
            </div>
          )
        }
        const pct    = maxVol > 0 ? (s.volume / maxVol) * 100 : 0
        const convPct = s.convRate !== null && s.convRate !== undefined
          ? s.convRate : null
        const c = convPct !== null
          ? rateColor(convPct, s.goodThreshold || 20, s.okThreshold || 10)
          : { text: 'text-slate-400', bg: 'bg-slate-100', dot: 'bg-slate-400' }
        return (
          <div key={s.label}>
            <div className="flex items-center gap-4">
              <div className="w-32 text-right">
                <p className="text-[11px] font-black text-slate-500 uppercase tracking-wide leading-tight">{s.label}</p>
              </div>
              <div className="flex-1 relative h-10 bg-slate-50 rounded-xl overflow-hidden">
                <div
                  className="absolute left-0 top-0 h-full rounded-xl transition-all duration-700"
                  style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, #e53935 0%, ${i === stages.length - 1 ? '#e53935' : '#ef9a9a'} 100%)`,
                    opacity: 0.85 - (i / stages.length) * 0.35,
                  }}
                />
                <div className="absolute inset-0 flex items-center px-4">
                  <p className="text-sm font-black text-white drop-shadow-sm z-10 relative">
                    {s.format ? s.format(s.volume) : fmtN(s.volume)}
                  </p>
                </div>
              </div>
              <div className="w-28 flex flex-col items-end">
                {convPct !== null ? (
                  <>
                    <span className={`text-xs font-black px-2 py-0.5 rounded-full ${c.bg} ${c.text}`}>
                      {convPct.toFixed(0)}%
                    </span>
                    <p className="text-[9px] text-slate-400 mt-0.5">conv. rate</p>
                  </>
                ) : (
                  <span className="text-[11px] text-slate-400">—</span>
                )}
              </div>
            </div>
            {/* Drop-off indicator between stages */}
            {i < stages.length - 1 && !stages[i + 1]?.missing && s.volume > 0 && (
              <div className="flex items-center gap-4 py-0.5">
                <div className="w-32" />
                <div className="flex-1 flex items-center gap-2 px-4">
                  <div className="w-px h-3 bg-slate-200 ml-2" />
                  {(() => {
                    const next = stages.find((ns, ni) => ni > i && !ns.missing && ns.volume > 0)
                    if (!next) return null
                    const dropped = s.volume - next.volume
                    const dropPct = (dropped / s.volume) * 100
                    return (
                      <p className="text-[9px] text-slate-400 font-medium">
                        {fmtN(Math.max(dropped, 0))} dropped ({dropPct.toFixed(0)}%)
                      </p>
                    )
                  })()}
                </div>
                <div className="w-28" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Channel comparison card ───────────────────────────────────────────────────
function ChannelCard({ channel, sparkData }) {
  const { label, color, icon, spend, leads, cpl, roas, status } = channel
  const statusColors = { strong: 'bg-emerald-50 text-emerald-600', building: 'bg-amber-50 text-amber-600', low: 'bg-rose-50 text-rose-600', inactive: 'bg-slate-50 text-slate-400' }
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
          <p className="text-xs font-black text-slate-700">{label}</p>
        </div>
        {status && (
          <span className={`text-[9px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full ${statusColors[status] || statusColors.inactive}`}>
            {status}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-y-2 gap-x-4 mb-3 text-[11px]">
        <div>
          <p className="text-slate-400 font-bold">Spend</p>
          <p className="font-black text-slate-800">{spend > 0 ? fmt$$(spend) : '—'}</p>
        </div>
        <div>
          <p className="text-slate-400 font-bold">Leads</p>
          <p className="font-black text-slate-800">{leads > 0 ? fmtN(leads) : '—'}</p>
        </div>
        <div>
          <p className="text-slate-400 font-bold">Cost / Lead</p>
          <p className={`font-black ${cpl > 0 && cpl < 62 ? 'text-emerald-600' : cpl > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
            {cpl > 0 ? fmt$$(cpl) : '—'}
          </p>
        </div>
        <div>
          <p className="text-slate-400 font-bold">ROAS</p>
          <p className={`font-black ${roas >= 3 ? 'text-emerald-600' : roas >= 1.5 ? 'text-amber-600' : roas > 0 ? 'text-rose-600' : 'text-slate-400'}`}>
            {roas > 0 ? `${roas.toFixed(1)}×` : '—'}
          </p>
        </div>
      </div>
      {/* Mini trend sparkline */}
      {sparkData?.length > 1 && (
        <ResponsiveContainer width="100%" height={36}>
          <AreaChart data={sparkData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`cg-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e53935" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#e53935" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="leads" stroke="#e53935" strokeWidth={1.5}
              fill={`url(#cg-${label})`} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ── Main Funnel page ──────────────────────────────────────────────────────────
export default function LeadFunnel() {
  const store = useOutletContext() || {}
  const { stats = {}, prevStats = {}, weeklyTrend = [], clients = [], selectedClient } = store

  const clientObj  = clients.find(c => c.id === selectedClient)
  const clientName = clientObj?.name || (selectedClient === 'all' ? 'All Clients' : 'Your Business')

  // ── Funnel metrics ───────────────────────────────────────────────────────────
  const impressions = (stats.ads_impressions || 0) + (stats.meta_impressions || 0)
  const clicks      = (stats.ads_clicks      || 0) + (stats.meta_clicks      || 0)
  const leads       = stats.total_leads  || 0
  const mql         = stats.total_mql    || 0
  const booked      = (stats.lsa_booked_jobs || 0) + (stats.appointments || 0)
  const jobs        = stats.total_closed || 0
  const revenue     = stats.total_revenue || 0
  const spend       = stats.total_spend   || 0

  const mqlTracked    = mql > 0
  const bookedTracked = booked > 0
  const revenueTracked = revenue > 0

  // Conversion rates
  const ctr         = impressions > 0 ? (clicks      / impressions) * 100 : null
  const clickToLead = clicks > 0      ? (leads       / clicks)      * 100 : null
  const leadToMql   = leads > 0 && mqlTracked ? (mql / leads) * 100 : null
  const mqlToBooked = mql > 0 && bookedTracked ? (booked / mql) * 100 : null
  const closeRate   = leads > 0 ? (jobs / leads) * 100 : null
  const cpl         = leads > 0 && spend > 0 ? spend / leads : 0
  const roas        = spend > 0 ? revenue / spend : 0

  // ── Funnel stages ────────────────────────────────────────────────────────────
  const funnelStages = [
    ...(impressions > 0 ? [{
      label: 'Ad Impressions', volume: impressions, format: fmtN,
      convRate: ctr, goodThreshold: 5, okThreshold: 3,
    }] : []),
    ...(clicks > 0 ? [{
      label: 'Website Clicks', volume: clicks, format: fmtN,
      convRate: clickToLead, goodThreshold: 10, okThreshold: 5,
    }] : []),
    {
      label: 'Total Leads', volume: leads, format: fmtN,
      convRate: mqlTracked ? leadToMql : null, goodThreshold: 60, okThreshold: 30,
    },
    mqlTracked
      ? { label: 'Qualified Leads', volume: mql, format: fmtN, convRate: bookedTracked ? mqlToBooked : null, goodThreshold: 70, okThreshold: 40 }
      : { label: 'Qualified Leads', missing: true, missingLabel: 'Tag leads "MQL" in GHL to unlock this stage' },
    bookedTracked
      ? { label: 'Appts Booked', volume: booked, format: fmtN, convRate: booked > 0 ? (jobs / booked) * 100 : null, goodThreshold: 70, okThreshold: 50 }
      : { label: 'Appts Booked', missing: true, missingLabel: 'Connect scheduling to track appointments' },
    { label: 'Jobs Won', volume: jobs, format: fmtN, convRate: closeRate, goodThreshold: 20, okThreshold: 10 },
    revenueTracked
      ? { label: 'Revenue', volume: revenue, format: fmt$$, convRate: null }
      : { label: 'Revenue', missing: true, missingLabel: 'Connect CRM to track closed revenue' },
  ]

  // ── Bottleneck detection ─────────────────────────────────────────────────────
  const bottleneck = useMemo(() => {
    const candidates = []
    if (ctr !== null        && ctr < 3)        candidates.push({ stage: 'Ad Impressions → Clicks', rate: ctr, benchmark: 4.5, dollar: null, why: ['Low click-through typically means the ad creative or headline isn\'t resonating.', 'Try testing a new headline focused on your guarantee or response time.', 'Check whether your targeting is reaching homeowners vs. renters.'] })
    if (clickToLead !== null && clickToLead < 5) candidates.push({ stage: 'Clicks → Leads', rate: clickToLead, benchmark: 8, dollar: null, why: ['Your landing page may not match the ad\'s promise.', 'Make sure your phone number and "Get a Quote" button are above the fold.', 'Adding reviews or trust signals to the page typically lifts this by 20–40%.'] })
    if (closeRate !== null  && closeRate < 15)  {
      const avgJobVal   = jobs > 0 ? revenue / jobs : 4500
      const gapToAvg   = Math.max(Math.round(leads * 0.22) - jobs, 0)
      const opportunity = Math.round(gapToAvg * avgJobVal)
      candidates.push({ stage: 'Lead → Job Close Rate', rate: closeRate, benchmark: 22, dollar: opportunity, why: ['Most close-rate gaps come from slow first response — aim for under 5 minutes.', 'Automated day-1 outreach via GHL workflows closes this gap in 2–3 weeks.', 'Make sure every lead gets a follow-up call, not just a text.'] })
    }
    if (!candidates.length && leads > 0 && roas < 1.5 && spend > 0) {
      candidates.push({ stage: 'Marketing ROI', rate: roas * 100, benchmark: 350, dollar: null, why: ['ROAS below 1.5× means you\'re spending more than you\'re returning.', 'Pause lowest-performing campaigns and shift budget to top performers.', 'Review search terms to eliminate wasted spend on irrelevant queries.'] })
    }
    return candidates.sort((a, b) => (a.rate - b.rate))[0] || null
  }, [ctr, clickToLead, closeRate, roas, leads, jobs, revenue, spend])

  // ── Channel data ─────────────────────────────────────────────────────────────
  const channels = useMemo(() => {
    const list = []
    const adsLeads  = stats.ads_leads   || 0
    const adsSpend  = stats.ads_spend   || 0
    const adsRoas   = adsSpend > 0 && revenue > 0 ? (revenue * (adsLeads / Math.max(leads, 1))) / adsSpend : 0
    const lsaLeads  = stats.lsa_calls   || 0
    const lsaSpend  = stats.lsa_spend   || 0
    const metaLeads = stats.meta_leads  || 0
    const metaSpend = stats.meta_spend  || 0
    const gbpLeads  = stats.gbp_calls   || 0

    if (adsSpend > 0 || adsLeads > 0)
      list.push({ label: 'Google Ads', color: 'bg-blue-500', spend: adsSpend, leads: adsLeads, cpl: adsLeads > 0 ? adsSpend / adsLeads : 0, roas: adsRoas, status: adsRoas >= 3 ? 'strong' : adsRoas >= 1.5 ? 'building' : adsLeads > 0 ? 'low' : 'inactive' })
    if (lsaSpend > 0 || lsaLeads > 0)
      list.push({ label: 'Google LSA', color: 'bg-cyan-500', spend: lsaSpend, leads: lsaLeads, cpl: lsaLeads > 0 ? lsaSpend / lsaLeads : 0, roas: 0, status: lsaLeads > 0 ? 'strong' : 'inactive' })
    if (metaSpend > 0 || metaLeads > 0)
      list.push({ label: 'Meta Ads', color: 'bg-indigo-500', spend: metaSpend, leads: metaLeads, cpl: metaLeads > 0 ? metaSpend / metaLeads : 0, roas: 0, status: metaLeads > 0 ? 'building' : 'inactive' })
    if (gbpLeads > 0)
      list.push({ label: 'GBP / Local', color: 'bg-emerald-500', spend: 0, leads: gbpLeads, cpl: 0, roas: 0, status: 'strong' })
    return list
  }, [stats, revenue, leads])

  // ── 8-week multi-line trend ───────────────────────────────────────────────────
  const trendData = weeklyTrend.slice(-8).map(w => ({
    week:    weekLabel(w.week),
    leads:   Math.round(w.leads   || 0),
    jobs:    Math.round(w.closed  || w.lsa_booked || 0),
    revenue: Math.round(w.revenue || 0),
  }))

  // Channel sparklines
  const channelSparks = useMemo(() => {
    const sparks = {}
    channels.forEach(c => {
      sparks[c.label] = weeklyTrend.slice(-8).map(w => ({
        leads: c.label === 'Google Ads' ? (w.ads_clicks || 0) :
               c.label === 'Meta Ads'   ? (w.meta_leads || 0) :
               c.label === 'Google LSA' ? (w.lsa_calls  || 0) : 0,
      }))
    })
    return sparks
  }, [weeklyTrend, channels])

  // ── Health score ─────────────────────────────────────────────────────────────
  const leadTrend = trendData.length >= 2
    ? ((trendData[trendData.length - 1].leads - trendData[0].leads) / Math.max(trendData[0].leads, 1)) * 100
    : 0
  const dataCompleteness = [leads > 0, spend > 0, revenue > 0, mqlTracked, channels.length > 0].filter(Boolean).length / 5
  const healthScore = computeHealthScore({ closeRate: closeRate || 0, cpl, roas, leadTrend, dataCompleteness })
  const healthColor = healthScore >= 75 ? 'text-emerald-600' : healthScore >= 50 ? 'text-amber-600' : 'text-rose-600'
  const healthRing  = healthScore >= 75 ? 'stroke-emerald-500' : healthScore >= 50 ? 'stroke-amber-500' : 'stroke-rose-500'
  const healthText  = healthScore >= 75
    ? 'Your funnel is firing well. Scale ad spend to grow lead volume.'
    : healthScore >= 50
    ? 'Your funnel is building. The key opportunity is improving lead follow-up speed.'
    : 'Your funnel has a conversion gap. More spend will not solve this — fix the follow-up process first.'

  // SVG ring
  const RING_SIZE = 100, RING_STROKE = 8, RING_R = (RING_SIZE - RING_STROKE) / 2
  const RING_CIRC = 2 * Math.PI * RING_R
  const ringOffset = RING_CIRC - (healthScore / 100) * RING_CIRC

  const noData = leads === 0 && spend === 0 && revenue === 0

  return (
    <div>
      <TopBar
        title="Marketing Funnel"
        subtitle={`Complete lead journey · ${clientName}`}
        {...store}
        onClientChange={store.setSelectedClient}
        onPeriodChange={store.setSelectedPeriod}
      />

      <div className="px-6 pb-12 space-y-6">

        {noData ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
              <TrendingUp className="w-8 h-8 text-slate-400" />
            </div>
            <p className="text-lg font-black text-slate-800 mb-2">No funnel data yet</p>
            <p className="text-sm text-slate-400 max-w-sm">
              Connect your marketing channels in the Connections page to start seeing your full lead journey here.
            </p>
          </div>
        ) : (
          <>
            {/* ── Row 1: Waterfall + Health Score ── */}
            <div className="grid grid-cols-3 gap-6">

              {/* Waterfall funnel — 2/3 width */}
              <div className="col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Lead Journey</p>
                    <p className="text-base font-black text-slate-800 mt-0.5">From first impression to closed job</p>
                  </div>
                  {spend > 0 && (
                    <div className="text-right">
                      <p className="text-[10px] text-slate-400 font-bold">Total spend</p>
                      <p className="text-lg font-black text-slate-800">{fmt$$(spend)}</p>
                    </div>
                  )}
                </div>
                <FunnelWaterfall stages={funnelStages} />
              </div>

              {/* Health score + summary stats — 1/3 width */}
              <div className="space-y-4">
                {/* Health ring */}
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 text-center">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Funnel Health Score</p>
                  <div className="flex justify-center mb-3">
                    <div className="relative">
                      <svg width={RING_SIZE} height={RING_SIZE} className="-rotate-90">
                        <circle cx={RING_SIZE/2} cy={RING_SIZE/2} r={RING_R} fill="none" stroke="#f1f5f9" strokeWidth={RING_STROKE} />
                        <circle cx={RING_SIZE/2} cy={RING_SIZE/2} r={RING_R} fill="none"
                          className={healthRing} strokeWidth={RING_STROKE} strokeLinecap="round"
                          strokeDasharray={RING_CIRC} strokeDashoffset={ringOffset}
                          style={{ transition: 'stroke-dashoffset 800ms ease-out' }}
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <p className={`text-2xl font-black leading-none ${healthColor}`}>{healthScore}</p>
                        <p className="text-[9px] text-slate-400 font-bold">/100</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">{healthText}</p>
                </div>

                {/* Quick stats */}
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Key Rates</p>
                  {[
                    { label: 'Close Rate',     value: closeRate !== null ? `${closeRate.toFixed(0)}%` : '—', good: closeRate !== null && closeRate >= 20, ok: closeRate !== null && closeRate >= 10 },
                    { label: 'Cost Per Lead',   value: cpl > 0 ? fmt$$(cpl) : '—',   good: cpl > 0 && cpl <= 62, ok: cpl > 0 && cpl <= 120 },
                    { label: 'Marketing ROAS',  value: roas > 0 ? `${roas.toFixed(1)}×` : '—',  good: roas >= 3, ok: roas >= 1.5 },
                    { label: 'Click-to-Lead',   value: clickToLead !== null ? `${clickToLead.toFixed(0)}%` : '—', good: clickToLead !== null && clickToLead >= 8, ok: clickToLead !== null && clickToLead >= 4 },
                  ].map(m => (
                    <div key={m.label} className="flex items-center justify-between">
                      <p className="text-xs text-slate-500">{m.label}</p>
                      <span className={`text-xs font-black px-2 py-0.5 rounded-full ${
                        m.value === '—' ? 'bg-slate-100 text-slate-400' :
                        m.good ? 'bg-emerald-100 text-emerald-700' :
                        m.ok   ? 'bg-amber-100 text-amber-700'   :
                                 'bg-rose-100 text-rose-700'
                      }`}>{m.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Row 2: Bottleneck analysis ── */}
            {bottleneck && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <div className="flex items-center gap-2 mb-4">
                  <AlertTriangle className="w-4 h-4 text-rose-500" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-rose-500">Primary Bottleneck Detected</p>
                </div>
                <div className="grid grid-cols-2 gap-8">
                  <div>
                    <p className="text-lg font-black text-slate-800 mb-1">{bottleneck.stage}</p>
                    <div className="flex items-baseline gap-3 mb-3">
                      <p className="text-4xl font-black text-rose-600">
                        {bottleneck.rate < 10 ? bottleneck.rate.toFixed(1) : bottleneck.rate.toFixed(0)}%
                      </p>
                      <div>
                        <p className="text-xs text-slate-400 font-bold">Your rate</p>
                        <p className="text-xs text-slate-500">Industry avg: {bottleneck.benchmark}%</p>
                      </div>
                    </div>
                    {bottleneck.dollar > 0 && (
                      <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">
                        <p className="text-[10px] font-black text-emerald-600 uppercase tracking-wide mb-0.5">Revenue Opportunity</p>
                        <p className="text-xl font-black text-emerald-700">{fmt$$(bottleneck.dollar)}</p>
                        <p className="text-xs text-emerald-600 mt-0.5">
                          Achievable at the industry-average close rate without increasing ad spend
                        </p>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Why This Happens + What We Do</p>
                    <ul className="space-y-2.5">
                      {bottleneck.why.map((w, i) => (
                        <li key={i} className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 mt-1.5" />
                          <p className="text-sm text-slate-600 leading-relaxed">{w}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* ── Row 3: Channel comparison ── */}
            {channels.length > 0 && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">By Channel</p>
                <div className={`grid gap-4 ${channels.length === 1 ? 'grid-cols-1 max-w-xs' : channels.length === 2 ? 'grid-cols-2' : channels.length === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
                  {channels.map(c => (
                    <ChannelCard key={c.label} channel={c} sparkData={channelSparks[c.label]} />
                  ))}
                </div>
              </div>
            )}

            {/* ── Row 4: 8-week funnel trend ── */}
            {trendData.length > 1 && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Funnel Trend</p>
                    <p className="text-sm font-black text-slate-700 mt-0.5">Leads, jobs, and revenue — last 8 weeks</p>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={trendData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="f-leads-g"   x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}    />
                      </linearGradient>
                      <linearGradient id="f-jobs-g"    x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#10b981" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}    />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 700 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 700 }} axisLine={false} tickLine={false} width={36} />
                    <Tooltip
                      content={({ active, payload, label }) =>
                        active && payload?.length
                          ? <div className="bg-slate-800 border border-white/10 rounded-lg px-3 py-2 shadow text-[11px] space-y-1">
                              <p className="text-white/60 font-bold mb-1">{label}</p>
                              {payload.map(p => (
                                <p key={p.dataKey} style={{ color: p.color }} className="font-black">
                                  {p.name}: {p.dataKey === 'revenue' ? fmt$$(p.value) : fmtN(p.value)}
                                </p>
                              ))}
                            </div>
                          : null
                      }
                    />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
                    <Area type="monotone" dataKey="leads"   name="Leads"    stroke="#3b82f6" strokeWidth={2} fill="url(#f-leads-g)" dot={false} activeDot={{ r: 4 }} />
                    <Area type="monotone" dataKey="jobs"    name="Jobs Won" stroke="#10b981" strokeWidth={2} fill="url(#f-jobs-g)"  dot={false} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* ── Row 5: Industry benchmark table ── */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
              <div className="flex items-center gap-2 mb-5">
                <Target className="w-4 h-4 text-slate-400" />
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Industry Benchmarks — Home Services 2024</p>
              </div>
              <div className="space-y-3">
                {[
                  { label: 'Close Rate (Lead → Job)',  yours: closeRate   !== null ? closeRate.toFixed(0) + '%'   : '—', avg: '20–25%',  good: closeRate !== null && closeRate >= 20,  ok: closeRate !== null && closeRate >= 10 },
                  { label: 'Cost Per Lead',             yours: cpl > 0     ? fmt$$(cpl)                           : '—', avg: '$45–80',   good: cpl > 0 && cpl <= 45,                  ok: cpl > 0 && cpl <= 80 },
                  { label: 'Marketing ROAS',            yours: roas > 0    ? roas.toFixed(1) + '×'               : '—', avg: '3–5×',     good: roas >= 3,                              ok: roas >= 1.5 },
                  { label: 'Click-Through Rate (CTR)',  yours: ctr !== null ? ctr.toFixed(1) + '%'                : '—', avg: '3–6%',     good: ctr !== null && ctr >= 3,               ok: ctr !== null && ctr >= 2 },
                  { label: 'Click-to-Lead Rate',        yours: clickToLead !== null ? clickToLead.toFixed(0) + '%' : '—', avg: '6–12%', good: clickToLead !== null && clickToLead >= 6, ok: clickToLead !== null && clickToLead >= 3 },
                ].map(row => (
                  <div key={row.label} className="flex items-center gap-4 py-2.5 border-b border-slate-50 last:border-0">
                    <p className="text-sm text-slate-600 flex-1">{row.label}</p>
                    <p className="text-xs text-slate-400 w-20 text-center">{row.avg}</p>
                    <div className="w-24 text-right">
                      <span className={`text-xs font-black px-2.5 py-1 rounded-full ${
                        row.yours === '—' ? 'bg-slate-100 text-slate-400' :
                        row.good ? 'bg-emerald-100 text-emerald-700' :
                        row.ok   ? 'bg-amber-100 text-amber-700'   :
                                   'bg-rose-100 text-rose-700'
                      }`}>{row.yours}</span>
                    </div>
                    <div className="w-16 text-right">
                      {row.yours !== '—' && (
                        <span className="text-[10px] font-bold text-slate-400">
                          {row.good ? '✓ On target' : row.ok ? 'Near avg' : '↘ Below avg'}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[9px] text-slate-300 mt-4">
                Benchmarks sourced from Home Services Marketing Industry Report 2024. Results vary by market, service type, and season.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
