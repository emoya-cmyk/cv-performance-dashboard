import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Phone, CheckCircle, DollarSign, BarChart2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtDollar, fmtN } from '@/lib/utils'
import TopBar from '@/components/TopBar'
import Sparkline from '@/components/Sparkline'

export default function LSAPerformance() {
  const store = useOutletContext() || {}
  const { clients = [], selectedClient, setSelectedClient } = store

  const [data,       setData]       = useState(null)
  const [period,     setPeriod]     = useState('last_4w')
  const [weeklyData, setWeeklyData] = useState([])

  useEffect(() => {
    if (!selectedClient || selectedClient === 'all') { setData(null); setWeeklyData([]); return }
    api.getMetrics(selectedClient, period)
      .then(d => setData(d))
      .catch(console.error)
  }, [selectedClient, period])

  useEffect(() => {
    if (!selectedClient || selectedClient === 'all') return
    api.weeklyTrend(selectedClient, 8).then(setWeeklyData).catch(() => {})
  }, [selectedClient])

  const stats = data?.stats || {}

  const bookRate = stats.lsa_calls > 0
    ? `${(((stats.lsa_booked_jobs || 0) / stats.lsa_calls) * 100).toFixed(1)}%`
    : '—'

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="LSA Performance"
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        selectedPeriod={period}
        onPeriodChange={setPeriod}
      />

      <div className="flex-1 overflow-auto p-6">
        {(!selectedClient || selectedClient === 'all') ? (
          <div className="card">
            <p className="text-sm text-text-muted">Select a specific client above to view LSA performance.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {[
                { label: 'LSA Spend',   value: fmtDollar(stats.lsa_spend),   icon: DollarSign, sparkKey: 'lsa_spend' },
                { label: 'Calls',       value: fmtN(stats.lsa_calls),        icon: Phone,      sparkKey: 'lsa_calls' },
                { label: 'Booked Jobs', value: fmtN(stats.lsa_booked_jobs),  icon: CheckCircle },
                { label: 'Book Rate',   value: bookRate,                      icon: BarChart2 },
              ].map(({ label, value, icon: Icon, sparkKey }) => (
                <div key={label} className="card">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-4 h-4 text-accent" />
                    <span className="text-xs text-text-muted font-semibold uppercase tracking-wide">{label}</span>
                  </div>
                  <div className="flex items-end justify-between">
                    <p className="text-2xl font-black text-white">{value || '—'}</p>
                    {sparkKey && weeklyData.length > 1 && (
                      <Sparkline values={weeklyData.map(w => w[sparkKey])} />
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <p className="text-xs font-bold text-accent uppercase tracking-wider mb-3">Cost Per Booked Job</p>
              <p className="text-3xl font-black text-white">
                {stats.lsa_booked_jobs > 0 ? fmtDollar((stats.lsa_spend || 0) / stats.lsa_booked_jobs) : '—'}
              </p>
              <p className="text-sm text-text-muted mt-1">avg cost per LSA booked job this period</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
