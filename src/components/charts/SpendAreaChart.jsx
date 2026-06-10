import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { weekLabel, fmtDollarShort } from '@/lib/utils'

/**
 * SpendAreaChart — weekly spend vs revenue area chart.
 * Accepts trend rows from /api/metrics (`{ week, spend, revenue }`) as the primary
 * shape, with the wide weekly_reports field names kept as fallbacks so the chart
 * works whether it's fed the aggregated trend or a raw weekly row. `??` (not `||`)
 * so a legitimately-zero week stays 0 instead of cascading to the next fallback.
 *
 * Optional `events` prop: array of campaign event objects `{ event_date, label }`.
 * Each event is matched to the nearest chart week (within ±7 days) and rendered
 * as a dashed vertical ReferenceLine marker.
 */
export default function SpendAreaChart({ data = [], events = [] }) {
  const chartData = data.map(w => ({
    week:    w.week_start ?? w.week,
    Spend:   Math.round(w.spend   ?? w.total_spend   ?? w.ads_spend         ?? 0),
    Revenue: Math.round(w.revenue ?? w.total_revenue ?? w.projected_revenue ?? 0),
  }))

  // Match each event to the nearest chart week (within ±7 days)
  const eventMarkers = events.flatMap(ev => {
    const evMs = new Date(ev.event_date).getTime()
    if (isNaN(evMs)) return []
    const sevenDays = 7 * 24 * 3600 * 1000
    const match = chartData.find(d => Math.abs(new Date(d.week).getTime() - evMs) <= sevenDays)
    return match ? [{ x: match.week, label: ev.label }] : []
  })

  if (!chartData.length) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-text-muted">
        No trend data yet
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
        Spend vs Revenue
      </p>
      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#e53935" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#e53935" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#10b981" stopOpacity={0.45} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="week"
              tickFormatter={weekLabel}
              tick={{ fontSize: 9, fill: '#94a3b8' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={fmtDollarShort}
              tick={{ fontSize: 9, fill: '#94a3b8' }}
              axisLine={false}
              tickLine={false}
              width={42}
            />
            <Tooltip
              formatter={(v, name) => [fmtDollarShort(v), name]}
              labelFormatter={weekLabel}
              contentStyle={{ fontSize: 11, borderRadius: 8, background: '#22263a', border: '1px solid rgba(255,255,255,0.08)', color: '#f1f5f9' }}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Area
              type="monotone" dataKey="Spend"
              stroke="#e53935" strokeWidth={2}
              fill="url(#spendGrad)" dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone" dataKey="Revenue"
              stroke="#10b981" strokeWidth={2.5}
              fill="url(#revenueGrad)" dot={false}
              isAnimationActive={false}
            />
            {eventMarkers.map((m, i) => (
              <ReferenceLine
                key={i}
                x={m.x}
                stroke="#6366f1"
                strokeDasharray="4 3"
                strokeWidth={1.5}
                label={{ value: m.label, position: 'top', fontSize: 9, fill: '#6366f1', offset: 4 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
