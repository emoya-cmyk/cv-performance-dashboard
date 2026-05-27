import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Eye, Phone, Navigation, Globe, Search } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import TopBar from '@/components/TopBar'
import { api } from '@/lib/api'
import { fmtN, fmtPct, weekLabel } from '@/lib/utils'

export default function GBPInsights() {
  const store = useOutletContext() || {}
  const { clients = [], selectedClient, setSelectedClient } = store

  const [data, setData]     = useState(null)
  const [period, setPeriod] = useState('last_4w')

  useEffect(() => {
    if (!selectedClient || selectedClient === 'all') { setData(null); return }
    api.getMetrics(selectedClient, period)
      .then(d => setData(d))
      .catch(console.error)
  }, [selectedClient, period])

  const stats     = data?.stats     || {}
  const trend     = data?.trend     || []

  const totalEngagements = (stats.gbp_calls || 0) + (stats.gbp_directions || 0) + (stats.gbp_website_clicks || 0)
  const engagementRate   = stats.gbp_views > 0 ? (totalEngagements / stats.gbp_views) * 100 : 0

  const gbpTrend = trend.map(w => ({
    week:       weekLabel(w.week),
    Calls:      w.gbp_calls      || 0,
    Directions: w.gbp_directions || 0,
    Website:    w.gbp_website    || 0,
  }))

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="GBP Insights"
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        selectedPeriod={period}
        onPeriodChange={setPeriod}
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {(!selectedClient || selectedClient === 'all') ? (
          <div className="card">
            <p className="text-sm text-text-muted">Select a specific client above to view Google Business Profile insights.</p>
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {[
                { label: 'Profile Views',  value: stats.gbp_views,           icon: Eye },
                { label: 'GBP Searches',   value: stats.gbp_searches,        icon: Search },
                { label: 'GBP Calls',      value: stats.gbp_calls,           icon: Phone },
                { label: 'Direction Req.', value: stats.gbp_directions,      icon: Navigation },
                { label: 'Website Clicks', value: stats.gbp_website_clicks,  icon: Globe },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="card">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-4 h-4 text-accent" />
                    <span className="text-xs text-text-muted font-semibold uppercase tracking-wide">{label}</span>
                  </div>
                  <p className="text-2xl font-black text-white">{fmtN(value) || '—'}</p>
                </div>
              ))}
            </div>

            {/* Engagement rate */}
            <div className="card">
              <p className="text-xs font-bold text-accent uppercase tracking-wider mb-1">GBP Engagement Rate</p>
              <p className="text-4xl font-black text-white">{fmtPct(engagementRate)}</p>
              <p className="text-sm text-text-muted mt-1">of profile viewers took an action (call, direction, or website click)</p>
            </div>

            {/* Engagement trend */}
            {gbpTrend.length > 0 && (
              <div className="card">
                <p className="text-sm font-bold text-white mb-4">Weekly GBP Engagement</p>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={gbpTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="week" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: '#1a1d27', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                      labelStyle={{ color: '#f1f5f9' }}
                    />
                    <Bar dataKey="Calls"      fill="#e53935" radius={[4,4,0,0]} />
                    <Bar dataKey="Directions" fill="#3b82f6" radius={[4,4,0,0]} />
                    <Bar dataKey="Website"    fill="#10b981" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
