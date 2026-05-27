/**
 * MetricCard — standard KPI card with optional delta indicator.
 *
 * Props:
 *   label   string
 *   value   number
 *   prev    number   (optional — used to compute delta)
 *   format  fn       (optional — defaults to raw value)
 *   icon    LucideIcon component
 *   accent  string   'blue' | 'green' | 'purple' | 'orange' | 'red'
 */
const ACCENT = {
  blue:   { text: 'text-blue-400',   bg: 'bg-blue-400/10'   },
  green:  { text: 'text-emerald-400',bg: 'bg-emerald-400/10' },
  purple: { text: 'text-purple-400', bg: 'bg-purple-400/10'  },
  orange: { text: 'text-orange-400', bg: 'bg-orange-400/10'  },
  red:    { text: 'text-red-400',    bg: 'bg-red-400/10'     },
}

export default function MetricCard({ label, value, prev, format, icon: Icon, accent = 'blue' }) {
  const colors = ACCENT[accent] || ACCENT.blue
  const display = format ? format(value) : (value ?? '—')

  // Delta
  let delta = null
  if (prev && prev !== 0 && value != null) {
    const pct = ((value - prev) / Math.abs(prev)) * 100
    delta = { pct: pct.toFixed(1), positive: pct >= 0 }
  }

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        {Icon && (
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${colors.bg}`}>
            <Icon className={`w-3.5 h-3.5 ${colors.text}`} />
          </div>
        )}
        <span className="text-xs text-text-muted font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-black text-white">{display || '—'}</p>
      {delta && (
        <p className={`text-xs font-bold mt-1 ${delta.positive ? 'text-emerald-400' : 'text-rose-400'}`}>
          {delta.positive ? '↑' : '↓'} {Math.abs(delta.pct)}% vs prior
        </p>
      )}
    </div>
  )
}
