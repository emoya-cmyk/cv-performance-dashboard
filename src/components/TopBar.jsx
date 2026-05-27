import { ChevronDown } from 'lucide-react'
import LiveBadge from './LiveBadge'

const PERIODS = [
  { value: 'this_week', label: 'This Week' },
  { value: 'last_4w',   label: 'Last 4 Weeks' },
  { value: 'last_8w',   label: 'Last 8 Weeks' },
  { value: 'all_time',  label: 'All Time' },
]

export default function TopBar({
  title, subtitle,
  clients, selectedClient, onClientChange,
  selectedPeriod, onPeriodChange,
  loading, lastRefresh,
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-black text-slate-900">{title}</h1>
          <LiveBadge loading={loading} lastRefresh={lastRefresh} />
        </div>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {/* Client selector */}
        <div className="relative">
          <select
            value={selectedClient}
            onChange={e => onClientChange(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2 text-sm font-medium bg-white border border-slate-200 rounded-xl text-slate-700 shadow-sm cursor-pointer hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          >
            <option value="all">All Clients</option>
            {(clients || []).map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        </div>

        {/* Period tabs */}
        <div className="flex items-center bg-white border border-slate-200 rounded-xl p-1 shadow-sm">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => onPeriodChange(p.value)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                selectedPeriod === p.value
                  ? 'bg-brand-500 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
