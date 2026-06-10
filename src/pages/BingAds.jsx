import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { DollarSign, Eye, MousePointerClick, TrendingUp } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import TopBar from '@/components/TopBar'
import MetricCard from '@/components/MetricCard'
import { api } from '@/lib/api'
import { fmtN, fmtDollar, fmtDollarShort, fmtPct, weekLabel } from '@/lib/utils'
import { useDelayedMount } from '@/lib/useDelayedMount'

function isoLocal(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }
const TODAY = isoLocal(new Date())

const TT = ({ active, payload, label, currency }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#1a1d27', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} className="px-3 py-2 text-xs shadow-lg">
      <p className="font-bold text-slate-300 mb-1">{weekLabel(label)}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-slate-400">{p.name}:</span>
          <span className="font-semibold text-white">
            {currency ? fmtDollar(p.value) : fmtN(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function BingAds() {
  const store = useOutletContext() || {}
  const { clients = [], selectedClient, setSelectedClient } = store

  const [rows, setRows]       = useState([])
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
      metrics:    ['spend', 'impressions', 'clicks', 'conversions', 'revenue'],
      groupBy:    ['date:week'],
      channels:   ['bing_ads'],
      dateRange:  { since, until: TODAY },
    })
      .then(r => setRows(r?.rows || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [selectedClient, period])

  const totals = rows.reduce((a, r) => ({
    spend:       (a.spend       || 0) + (r.spend       || 0),
    impressions: (a.impressions || 0) + (r.impressions || 0),
    clicks:      (a.clicks      || 0) + (r.clicks      || 0),
    conversions: (a.conversions || 0) + (r.conversions || 0),
    revenue:     (a.revenue     || 0) + (r.revenue     || 0),
  }), {})

  const roas = totals.spend > 0 ? totals.revenue / totals.spend : 0
  const ctr  = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0
  const cpc  = totals.clicks > 0 ? totals.spend / totals.clicks : 0
  const cpa  = totals.conversions > 0 ? totals.spend / totals.conversions : 0

  const spendTrend = rows.map(r => ({
    week:    r.date,
    'Spend': r.spend   || 0,
    'Revenue': r.revenue || 0,
  }))

  const volumeTrend = rows.map(r => ({
    week:          r.date,
    'Impressions': r.impressions || 0,
    'Clicks':      r.clicks      || 0,
    'Conversions': r.conversions || 0,
  }))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TopBar
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        period={period}
        onPeriodChange={setPeriod}
        title="Microsoft / Bing Ads"
        subtitle="Paid search performance on Microsoft Advertising"
      />
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {!selectedClient || selectedClient === 'all' ? (
          <div className="card p-8 text-center text-slate-500">Select a client to view Bing Ads data.</div>
        ) : loading ? (
          <div className="card p-8 text-center text-slate-500">Loading Microsoft Ads data…</div>
        ) : rows.length === 0 ? (
          <div className="card p-8 text-center text-slate-500">
            No Microsoft Ads data yet. Connect a Bing Ads account in the Connections page.
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Spend"
                value={fmtDollarShort(totals.spend || 0)}
                icon={<DollarSign className="w-5 h-5" />}
                color="red"
                ready={ready}
              />
              <MetricCard
                label="ROAS"
                value={`${roas.toFixed(2)}×`}
                subValue={`${fmtDollarShort(totals.revenue || 0)} revenue`}
                icon={<TrendingUp className="w-5 h-5" />}
                color="green"
                ready={ready}
              />
              <MetricCard
                label="Impressions"
                value={fmtN(totals.impressions || 0)}
                subValue={`${ctr.toFixed(2)}% CTR`}
                icon={<Eye className="w-5 h-5" />}
                color="blue"
                ready={ready}
              />
              <MetricCard
                label="Clicks"
                value={fmtN(totals.clicks || 0)}
                subValue={`${fmtDollar(cpc)} CPC`}
                icon={<MousePointerClick className="w-5 h-5" />}
                color="purple"
                ready={ready}
              />
            </div>

            {/* Secondary metrics */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'Conversions',  value: fmtN(totals.conversions || 0) },
                { label: 'Revenue',      value: fmtDollarShort(totals.revenue || 0) },
                { label: 'CPA',          value: fmtDollar(cpa) },
                { label: 'CTR',          value: `${ctr.toFixed(2)}%` },
              ].map(m => (
                <div key={m.label} className="card p-4">
                  <p className="text-xs text-slate-500 mb-1">{m.label}</p>
                  <p className="text-xl font-black text-white">{m.value}</p>
                </div>
              ))}
            </div>

            {/* Spend vs Revenue trend */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-slate-300 mb-4">Spend vs Revenue</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={spendTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => fmtDollarShort(v)} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<TT currency />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="Revenue" stroke="#22c55e" fill="#22c55e20" strokeWidth={2} />
                  <Area type="monotone" dataKey="Spend"   stroke="#ef4444" fill="#ef444420" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Volume trend */}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-slate-300 mb-4">Impressions, Clicks & Conversions</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={volumeTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<TT />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Impressions" fill="#3b82f6" radius={[3,3,0,0]} />
                  <Bar dataKey="Clicks"      fill="#a855f7" radius={[3,3,0,0]} />
                  <Bar dataKey="Conversions" fill="#22c55e" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
