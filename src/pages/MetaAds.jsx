import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { TrendingUp, DollarSign, Users, BarChart2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtDollar, fmtN, fmtX } from '@/lib/utils'
import TopBar from '@/components/TopBar'
import CampaignList from '@/components/CampaignList'
import Sparkline from '@/components/Sparkline'

export default function MetaAds() {
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

  return (
    <div className="flex flex-col h-full">
      <TopBar
        title="Meta Ads"
        clients={clients}
        selectedClient={selectedClient}
        onClientChange={setSelectedClient}
        selectedPeriod={period}
        onPeriodChange={setPeriod}
      />

      <div className="flex-1 overflow-auto p-6">
        {(!selectedClient || selectedClient === 'all') ? (
          <div className="card">
            <p className="text-sm text-text-muted">Select a specific client above to view Meta Ads performance.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {[
                { label: 'Meta Spend', value: fmtDollar(stats.meta_spend), icon: DollarSign, sparkKey: 'meta_spend'  },
                { label: 'Leads',      value: fmtN(stats.meta_leads),      icon: Users,      sparkKey: 'meta_leads'  },
                { label: 'ROAS',       value: fmtX(stats.meta_roas),       icon: TrendingUp, sparkKey: 'meta_roas'   },
                { label: 'Clicks',     value: fmtN(stats.meta_clicks),     icon: BarChart2,  sparkKey: 'meta_clicks' },
              ].map(({ label, value, icon: Icon, sparkKey }) => (
                <div key={label} className="card">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-4 h-4 text-accent" />
                    <span className="text-xs text-text-muted font-semibold uppercase tracking-wide">{label}</span>
                  </div>
                  <div className="flex items-end justify-between">
                    <p className="text-2xl font-black text-white">{value || '—'}</p>
                    {weeklyData.length > 1 && (
                      <Sparkline values={weeklyData.map(w => w[sparkKey])} />
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <p className="text-xs font-bold text-accent uppercase tracking-wider mb-3">Cost Per Lead</p>
              <p className="text-3xl font-black text-white">
                {stats.meta_leads > 0 ? fmtDollar((stats.meta_spend || 0) / stats.meta_leads) : '—'}
              </p>
              <p className="text-sm text-text-muted mt-1">avg per Meta lead this period</p>
            </div>

            <CampaignList clientId={selectedClient} />
          </>
        )}
      </div>
    </div>
  )
}
