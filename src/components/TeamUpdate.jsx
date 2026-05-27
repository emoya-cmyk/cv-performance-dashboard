import { CheckCircle, AlertCircle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

const STATUS_MAP = {
  on_track:  { label: 'On Track',          Icon: CheckCircle,  color: 'text-emerald-600', bg: 'bg-emerald-50',  border: 'border-emerald-100' },
  monitoring:{ label: 'Monitoring',         Icon: AlertCircle,  color: 'text-amber-600',   bg: 'bg-amber-50',    border: 'border-amber-100'   },
  adjusted:  { label: 'Strategy Adjusted',  Icon: RefreshCw,    color: 'text-blue-600',    bg: 'bg-blue-50',     border: 'border-blue-100'    },
}

function formatWeek(dateStr) {
  if (!dateStr) return ''
  const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00')
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * TeamUpdate — shows latest agency-written update in the client view.
 *
 * Props:
 *   updates        — array from GET /api/updates/:clientId (newest first)
 *   fallbackBullets — array of { icon, text } for the auto-generated fallback
 */
export default function TeamUpdate({ updates = [], fallbackBullets = [] }) {
  const [showHistory, setShowHistory] = useState(false)

  const latest  = updates[0]
  const history = updates.slice(1, 5)

  // No agency update this week → show machine-generated fallback
  if (!latest?.this_week) {
    return (
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 fade-up">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-brand-500/10 flex items-center justify-center">
            <span className="text-brand-500 text-sm">⚡</span>
          </div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            Your Team — This Week
          </p>
        </div>
        <ul className="space-y-3">
          {fallbackBullets.map((b, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="text-base leading-none mt-0.5">{b.icon}</span>
              <p className="text-sm text-slate-600 leading-relaxed">{b.text}</p>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const s = STATUS_MAP[latest.status] || STATUS_MAP.on_track
  const { Icon } = s

  return (
    <div className={`rounded-2xl border p-5 fade-up ${s.bg} ${s.border}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-white/80 flex items-center justify-center shadow-sm">
            <Icon className={`w-3.5 h-3.5 ${s.color}`} />
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 leading-none">
              From Your Team
            </p>
            <p className="text-[9px] text-slate-400 mt-0.5">
              Week of {formatWeek(latest.week_start)}
            </p>
          </div>
        </div>
        <span className={`text-[10px] font-black px-2 py-0.5 rounded-full bg-white/80 ${s.color}`}>
          {s.label}
        </span>
      </div>

      {/* This week update */}
      <p className="text-sm text-slate-700 leading-relaxed mb-3">{latest.this_week}</p>

      {/* Next week focus */}
      {latest.next_week && (
        <div className="border-t border-white/50 pt-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">
            Next Week's Focus
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">{latest.next_week}</p>
        </div>
      )}

      {/* History toggle */}
      {history.length > 0 && (
        <div className="mt-3 border-t border-white/50 pt-3">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="flex items-center gap-1 text-[10px] font-black text-slate-400 hover:text-slate-600 transition-colors"
          >
            {showHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showHistory ? 'Hide' : 'See'} previous updates
          </button>
          {showHistory && (
            <div className="mt-3 space-y-3">
              {history.map(u => (
                <div key={u.id} className="bg-white/60 rounded-xl p-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-wide mb-1">
                    Week of {formatWeek(u.week_start)}
                  </p>
                  <p className="text-xs text-slate-600 leading-relaxed">{u.this_week}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
