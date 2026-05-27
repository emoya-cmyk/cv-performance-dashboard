import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from 'recharts'
import { api, USE_API } from '@/lib/api'
import { fmt$$, fmtN } from '@/lib/utils'

// ── Mock data for dev/preview ─────────────────────────────────────────────────
function mockMonths() {
  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - i)
    months.push({
      month:   d.toISOString().slice(0, 7) + '-01',
      revenue: Math.round(12000 + Math.random() * 28000),
      leads:   Math.round(40  + Math.random() * 80),
      jobs:    Math.round(8   + Math.random() * 20),
      spend:   Math.round(3000 + Math.random() * 5000),
    })
  }
  return months
}

const MOCK = mockMonths()

// ── Formatters ────────────────────────────────────────────────────────────────
function monthLabel(iso) {
  // iso is like "2025-06-01"
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
}

const METRICS = [
  { key: 'revenue', label: 'Revenue',    fmt: v => fmt$$(v) },
  { key: 'leads',   label: 'Leads',      fmt: v => fmtN(v)  },
  { key: 'jobs',    label: 'Jobs Won',   fmt: v => fmtN(v)  },
]

// Custom tooltip
function CustomTooltip({ active, payload, label, metric }) {
  if (!active || !payload?.length) return null
  const v = payload[0]?.value
  const m = METRICS.find(m => m.key === metric) || METRICS[0]
  return (
    <div className="bg-white border border-slate-100 rounded-xl px-3 py-2 shadow-lg text-xs">
      <p className="font-black text-slate-800">{m.fmt(v)}</p>
      <p className="text-slate-400">{label}</p>
    </div>
  )
}

export default function MonthlyTrend({ clientId }) {
  const [data,    setData]    = useState([])
  const [loading, setLoading] = useState(true)
  const [metric,  setMetric]  = useState('revenue')

  useEffect(() => {
    setLoading(true)
    if (!USE_API) {
      setData(MOCK); setLoading(false); return
    }
    const params = new URLSearchParams({ months: 12 })
    if (clientId) params.set('client', clientId)
    api.monthly(params.toString())
      .then(d => setData(d || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [clientId])

  if (loading && !data.length) return null
  if (!data.length) return null

  const chartData = data.map(d => ({ ...d, label: monthLabel(d.month) }))
  const currentMetric = METRICS.find(m => m.key === metric)
  const maxVal = Math.max(...chartData.map(d => d[metric] || 0))
  const latestIdx = chartData.length - 1

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.14s' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">12-Month Trend</p>
        <div className="flex gap-1">
          {METRICS.map(m => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={`text-[10px] font-black px-2.5 py-1.5 rounded-xl transition-colors ${
                metric === m.key
                  ? 'bg-brand-500 text-white'
                  : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI summary row */}
      <div className="flex items-end gap-1 mb-5">
        <p className="text-2xl font-black text-slate-900 leading-none tabular-nums">
          {currentMetric?.fmt(data.reduce((s, d) => s + (d[metric] || 0), 0))}
        </p>
        <p className="text-xs text-slate-400 font-semibold pb-0.5 ml-1">trailing 12 months</p>
      </div>

      {/* Bar chart */}
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }} barCategoryGap="28%">
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis hide />
          <Tooltip
            content={<CustomTooltip metric={metric} />}
            cursor={{ fill: 'rgba(148,163,184,0.08)', radius: 6 }}
          />
          <Bar dataKey={metric} radius={[4, 4, 0, 0]}>
            {chartData.map((entry, idx) => (
              <Cell
                key={idx}
                fill={idx === latestIdx
                  ? 'rgb(var(--brand-500))'
                  : entry[metric] === maxVal
                    ? 'rgb(var(--brand-500) / 0.7)'
                    : 'rgb(var(--brand-500) / 0.25)'
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <p className="text-[10px] text-slate-300 mt-2">Grouped by calendar month · current month is partial</p>
    </div>
  )
}
