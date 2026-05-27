import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Globe, Users, TrendingUp, MousePointerClick } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import TopBar from '@/components/TopBar'
import MetricCard from '@/components/MetricCard'
import { api } from '@/lib/api'
import { fmtN, fmtPct, weekLabel } from '@/lib/utils'
import { useDelayedMount } from '@/lib/useDelayedMount'

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="card px-3 py-2 text-xs shadow-lg" style={{ background: '#1a1d27', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}>
      <p className="font-bold text-slate-300 mb-1">{weekLabel(label)}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-slate-400">{p.name}:</span>
          <span className="font-semibold text-white">{p.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function GA4Insights() {
  const store = useOutletContext() || {}
  const { clients = [], selectedClient, setSelectedClient } = store

  const [data, setData]     = useState(null)
  const [period, setPeriod] = useState('last_4w')
  const ready = useDelayedMount()

  useEffect(() => {
    if (!selectedClient || selectedClient === 'all') { setData(null); return }
    api.getMetrics(selectedClient, period)
      .then(d => setData(d))
      .catch(console.error)
  }, [selectedClient, period])

  const stats     = data?.stats     || {}
  const prevStats = data?.prevStats || {}
  const trend     = data?.trend     || []

  const engagementRate = stats.ga4_engagement_rate || 0
  const organicShare   = stats.ga4_sessions > 0
    ? ((stats.ga4_organic_sessions || 0) / stats.ga4_sessions) * 100 : 0

  const channelTrend = trend.map(w => ({
    week:    w.week,
    Organic: w.ga4_organic_sessions || 0,
    Paid:    w.ga4_paid_sessions    || 0,
    Direct:  w.ga4_direct_sessions  || 0,
    Other:   Math.max(0, (w.ga4_sessions || 0)
               - (w.ga4_organic_sessions || 0)
               - (w.ga4_paid_sessions    || 0)
               - (w.ga4_direct_sessions  || 0)),
  }))

  const engagementTrend = trend.map(w => ({
    week:           w.week,
    'Engagement %': parseFloat(w.ga4_engagement_rate) || 0,
    Conversions:    w.ga4_conversions || 0,
  }))

  const sessionsTrend = trend.map(w => ({
    week:        w.week,
    Sessions:    w.ga4_sessions   || 0,
    'New Users': w.ga4_new_users  || 0,
  }))

  const chartProps = {
    contentStyle: { background: '#1a1d27', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 },
    labelStyle:   { color: '#f1f5f9' },
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="GA4 / Web"
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        selectedPeriod={period}
        onPeriodChange={setPeriod}
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {(!selectedClient || selectedClient === 'all') ? (
          <div className="card">
            <p className="text-sm text-text-muted">Select a specific client above to view GA4 / Web Analytics.</p>
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Sessions"
                value={stats.ga4_sessions}
                prev={prevStats.ga4_sessions}
                format={fmtN}
                icon={Globe}
                accent="blue"
              />
              <MetricCard
                label="New Users"
                value={stats.ga4_new_users}
                prev={prevStats.ga4_new_users}
                format={fmtN}
                icon={Users}
                accent="purple"
              />
              <MetricCard
                label="Organic Sessions"
                value={stats.ga4_organic_sessions}
                prev={prevStats.ga4_organic_sessions}
                format={fmtN}
                icon={TrendingUp}
                accent="green"
              />
              <MetricCard
                label="Conversions"
                value={stats.ga4_conversions}
                prev={prevStats.ga4_conversions}
                format={fmtN}
                icon={MousePointerClick}
                accent="orange"
              />
            </div>

            {/* Engagement rate + organic share hero cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="card">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold text-accent uppercase tracking-wider mb-1">Engagement Rate</p>
                    <p className="text-4xl font-black text-white">{fmtPct(engagementRate)}</p>
                    <p className="text-sm text-text-muted mt-1">of sessions had meaningful interaction</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <p className="text-xs text-text-muted uppercase tracking-wider">Benchmark</p>
                    <p className="text-sm font-bold text-white">Industry avg ~55%</p>
                    <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                      engagementRate >= 60 ? 'bg-emerald-400/20 text-emerald-400'
                      : engagementRate >= 40 ? 'bg-amber-400/20 text-amber-400'
                      : 'bg-rose-400/20 text-rose-400'
                    }`}>
                      {engagementRate >= 60 ? '✓ Strong' : engagementRate >= 40 ? '⚠ Average' : '↓ Needs work'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold text-accent uppercase tracking-wider mb-1">Organic Share</p>
                    <p className="text-4xl font-black text-white">{fmtPct(organicShare)}</p>
                    <p className="text-sm text-text-muted mt-1">of sessions from unpaid search</p>
                  </div>
                  <div className="flex flex-col gap-1.5 text-right shrink-0">
                    {[
                      { label: 'Organic', val: stats.ga4_organic_sessions, color: '#10b981' },
                      { label: 'Paid',    val: stats.ga4_paid_sessions,    color: '#3b82f6' },
                      { label: 'Direct',  val: stats.ga4_direct_sessions,  color: '#8b5cf6' },
                    ].map(({ label, val, color }) => (
                      <div key={label} className="flex items-center justify-end gap-2">
                        <span className="text-xs text-text-muted">{label}</span>
                        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                        <span className="text-xs font-bold text-white w-16 text-right">{fmtN(val)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Charts — only render when trend data exists */}
            {trend.length > 0 && (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Sessions by Channel stacked bar */}
                  <div className="card">
                    <p className="text-sm font-bold text-white mb-4">Sessions by Channel</p>
                    {ready && (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={channelTrend} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                          <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
                          <Tooltip content={<TT />} {...chartProps} />
                          <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                          <Bar dataKey="Organic" stackId="a" fill="#10b981" />
                          <Bar dataKey="Paid"    stackId="a" fill="#3b82f6" />
                          <Bar dataKey="Direct"  stackId="a" fill="#8b5cf6" />
                          <Bar dataKey="Other"   stackId="a" fill="#334155" radius={[4,4,0,0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>

                  {/* Engagement Rate & Conversions */}
                  <div className="card">
                    <p className="text-sm font-bold text-white mb-4">Engagement Rate & Conversions</p>
                    {ready && (
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={engagementTrend} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                          <YAxis yAxisId="left"  tick={{ fill: '#94a3b8', fontSize: 10 }} unit="%" domain={[0, 100]} />
                          <YAxis yAxisId="right" orientation="right" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                          <Tooltip content={<TT />} />
                          <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                          <Line yAxisId="left"  type="monotone" dataKey="Engagement %" stroke="#3b82f6" strokeWidth={2} dot={false} />
                          <Line yAxisId="right" type="monotone" dataKey="Conversions"  stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                {/* Total Sessions area chart */}
                <div className="card">
                  <p className="text-sm font-bold text-white mb-4">Total Sessions Trend</p>
                  {ready && (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={sessionsTrend} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="ga4sessions" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="ga4users" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.2} />
                            <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} />
                        <Tooltip content={<TT />} />
                        <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                        <Area type="monotone" dataKey="Sessions"   stroke="#3b82f6" strokeWidth={2} fill="url(#ga4sessions)" />
                        <Area type="monotone" dataKey="New Users"  stroke="#8b5cf6" strokeWidth={2} fill="url(#ga4users)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
