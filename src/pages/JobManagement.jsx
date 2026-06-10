import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Briefcase, CheckCircle, DollarSign, TrendingUp } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import TopBar from '@/components/TopBar'
import MetricCard from '@/components/MetricCard'
import { api } from '@/lib/api'
import { fmtN, fmtDollar, fmtDollarShort, weekLabel } from '@/lib/utils'
import { useDelayedMount } from '@/lib/useDelayedMount'

function isoLocal(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }
const TODAY = isoLocal(new Date())

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#1a1d27', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} className="px-3 py-2 text-xs shadow-lg">
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

export default function JobManagement() {
  const store = useOutletContext() || {}
  const { clients = [], selectedClient, setSelectedClient } = store

  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(false)
  const [period, setPeriod]     = useState('last_4w')
  const ready = useDelayedMount()

  const weeksBack = { last_4w: 4, last_8w: 8, last_12w: 12 }[period] || 4
  const since = daysAgo(weeksBack * 7 - 1)

  useEffect(() => {
    if (!selectedClient || selectedClient === 'all') { setRows([]); return }
    setLoading(true)
    api.query({
      client_id:  selectedClient,
      metrics:    ['jobs_created', 'jobs_completed', 'job_revenue'],
      groupBy:    ['date:week'],
      channels:   ['housecallpro'],
      dateRange:  { since, until: TODAY },
    })
      .then(r => setRows(r?.rows || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [selectedClient, period])

  const totals = rows.reduce((a, r) => ({
    jobs_created:   (a.jobs_created   || 0) + (r.jobs_created   || 0),
    jobs_completed: (a.jobs_completed || 0) + (r.jobs_completed || 0),
    job_revenue:    (a.job_revenue    || 0) + (r.job_revenue    || 0),
  }), {})

  const completionRate = totals.jobs_created > 0
    ? (totals.jobs_completed / totals.jobs_created) * 100 : 0
  const revenuePerJob  = totals.jobs_completed > 0
    ? totals.job_revenue / totals.jobs_completed : 0

  const trend = rows.map(r => ({
    week:             r.date,
    'Jobs Created':   r.jobs_created   || 0,
    'Jobs Completed': r.jobs_completed || 0,
    'Revenue':        r.job_revenue    || 0,
  }))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TopBar
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        period={period}
        onPeriodChange={setPeriod}
        title="Job Management"
        subtitle="HouseCall Pro job pipeline & revenue"
      />
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {!selectedClient || selectedClient === 'all' ? (
          <div className="card p-8 text-center text-slate-500">Select a client to view job data.</div>
        ) : loading ? (
          <div className="card p-8 text-center text-slate-500">Loading job data…</div>
        ) : rows.length === 0 ? (
          <div className="card p-8 text-center text-slate-500">
            No HouseCall Pro data yet. Connect a HouseCall Pro account in the Connections page.
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Jobs Created"
                value={fmtN(totals.jobs_created || 0)}
                icon={<Briefcase className="w-5 h-5" />}
                color="blue"
                ready={ready}
              />
              <MetricCard
                label="Jobs Completed"
                value={fmtN(totals.jobs_completed || 0)}
                subValue={`${completionRate.toFixed(1)}% completion rate`}
                icon={<CheckCircle className="w-5 h-5" />}
                color="green"
                ready={ready}
              />
              <MetricCard
                label="Job Revenue"
                value={fmtDollarShort(totals.job_revenue || 0)}
                icon={<DollarSign className="w-5 h-5" />}
                color="emerald"
                ready={ready}
              />
              <MetricCard
                label="Revenue / Job"
                value={fmtDollar(revenuePerJob)}
                icon={<TrendingUp className="w-5 h-5" />}
                color="purple"
                ready={ready}
              />
            </div>

            {/* Revenue trend */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-slate-300 mb-4">Revenue Trend</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => fmtDollarShort(v)} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      return (
                        <div style={{ background: '#1a1d27', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} className="px-3 py-2 text-xs">
                          <p className="font-bold text-slate-300 mb-1">{weekLabel(label)}</p>
                          {payload.map(p => (
                            <div key={p.name} className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                              <span className="text-slate-400">{p.name}:</span>
                              <span className="font-semibold text-white">{fmtDollar(p.value)}</span>
                            </div>
                          ))}
                        </div>
                      )
                    }}
                  />
                  <Area type="monotone" dataKey="Revenue" stroke="#10b981" fill="#10b98120" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Job volume + completion */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-slate-300 mb-4">Job Volume by Week</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<TT />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Jobs Created"   fill="#3b82f6" radius={[3,3,0,0]} />
                    <Bar dataKey="Jobs Completed" fill="#10b981" radius={[3,3,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-slate-300 mb-4">Pipeline Summary</h3>
                <div className="space-y-3 mt-2">
                  <div className="flex items-center justify-between p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                    <span className="text-sm text-slate-300">Total Jobs Created</span>
                    <span className="text-lg font-bold text-blue-400">{fmtN(totals.jobs_created || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                    <span className="text-sm text-slate-300">Completed</span>
                    <span className="text-lg font-bold text-emerald-400">{fmtN(totals.jobs_completed || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10">
                    <span className="text-sm text-slate-300">Pending / In Progress</span>
                    <span className="text-lg font-bold text-slate-300">
                      {fmtN(Math.max(0, (totals.jobs_created || 0) - (totals.jobs_completed || 0)))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-xl bg-purple-500/10 border border-purple-500/20">
                    <span className="text-sm text-slate-300">Total Revenue</span>
                    <span className="text-lg font-bold text-purple-400">{fmtDollarShort(totals.job_revenue || 0)}</span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
