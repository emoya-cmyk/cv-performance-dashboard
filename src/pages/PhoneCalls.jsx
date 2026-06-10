import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Phone, PhoneCall, PhoneMissed, Users } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import TopBar from '@/components/TopBar'
import MetricCard from '@/components/MetricCard'
import { api } from '@/lib/api'
import { fmtN, fmtPct, weekLabel } from '@/lib/utils'
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
          <span className="font-semibold text-white">{fmtN(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function PhoneCalls() {
  const store = useOutletContext() || {}
  const { clients = [], selectedClient, setSelectedClient } = store

  const [rows, setRows]     = useState([])
  const [loading, setLoading] = useState(false)
  const [period, setPeriod]   = useState('last_4w')
  const ready = useDelayedMount()

  const weeksBack = { last_4w: 4, last_8w: 8, last_12w: 12 }[period] || 4
  const since = daysAgo(weeksBack * 7 - 1)

  useEffect(() => {
    if (!selectedClient || selectedClient === 'all') { setRows([]); return }
    setLoading(true)
    api.query({
      client_id:  selectedClient,
      metrics:    ['calls', 'answered_calls', 'missed_calls', 'first_time_callers'],
      groupBy:    ['date:week'],
      channels:   ['callrail'],
      dateRange:  { since, until: TODAY },
    })
      .then(r => setRows(r?.rows || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [selectedClient, period])

  // Totals
  const totals = rows.reduce((a, r) => ({
    calls:             (a.calls             || 0) + (r.calls             || 0),
    answered_calls:    (a.answered_calls    || 0) + (r.answered_calls    || 0),
    missed_calls:      (a.missed_calls      || 0) + (r.missed_calls      || 0),
    first_time_callers:(a.first_time_callers|| 0) + (r.first_time_callers|| 0),
  }), {})

  const answerRate = totals.calls > 0 ? (totals.answered_calls / totals.calls) * 100 : 0
  const missedRate = totals.calls > 0 ? (totals.missed_calls   / totals.calls) * 100 : 0

  const trend = rows.map(r => ({
    week:                r.date,
    'Total Calls':       r.calls             || 0,
    'Answered':          r.answered_calls    || 0,
    'Missed':            r.missed_calls      || 0,
    'First-Time':        r.first_time_callers|| 0,
  }))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TopBar
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        period={period}
        onPeriodChange={setPeriod}
        title="Phone Calls"
        subtitle="CallRail call tracking & answer intelligence"
      />
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {!selectedClient || selectedClient === 'all' ? (
          <div className="card p-8 text-center text-slate-500">Select a client to view call data.</div>
        ) : loading ? (
          <div className="card p-8 text-center text-slate-500">Loading call data…</div>
        ) : rows.length === 0 ? (
          <div className="card p-8 text-center text-slate-500">
            No CallRail data yet. Connect a CallRail account in the Connections page.
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Total Calls"
                value={fmtN(totals.calls || 0)}
                icon={<Phone className="w-5 h-5" />}
                color="blue"
                ready={ready}
              />
              <MetricCard
                label="Answered"
                value={fmtN(totals.answered_calls || 0)}
                subValue={`${fmtPct(answerRate / 100)} answer rate`}
                icon={<PhoneCall className="w-5 h-5" />}
                color="green"
                ready={ready}
              />
              <MetricCard
                label="Missed"
                value={fmtN(totals.missed_calls || 0)}
                subValue={`${fmtPct(missedRate / 100)} missed rate`}
                icon={<PhoneMissed className="w-5 h-5" />}
                color="red"
                ready={ready}
              />
              <MetricCard
                label="First-Time Callers"
                value={fmtN(totals.first_time_callers || 0)}
                icon={<Users className="w-5 h-5" />}
                color="purple"
                ready={ready}
              />
            </div>

            {/* Volume trend */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-slate-300 mb-4">Call Volume Trend</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<TT />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="Total Calls" stroke="#3b82f6" fill="#3b82f620" strokeWidth={2} />
                  <Area type="monotone" dataKey="Answered"    stroke="#22c55e" fill="#22c55e20" strokeWidth={2} />
                  <Area type="monotone" dataKey="Missed"      stroke="#ef4444" fill="#ef444420" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Answer vs Missed + First-time callers */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-slate-300 mb-4">Answered vs Missed by Week</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<TT />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Answered" fill="#22c55e" radius={[3,3,0,0]} />
                    <Bar dataKey="Missed"   fill="#ef4444" radius={[3,3,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-slate-300 mb-4">First-Time Callers Trend</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<TT />} />
                    <Area type="monotone" dataKey="First-Time" stroke="#a855f7" fill="#a855f720" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
