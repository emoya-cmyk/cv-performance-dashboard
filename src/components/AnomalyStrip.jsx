import { useState, useEffect } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react'
import { api, USE_API } from '@/lib/api'

function fmt(metric, value) {
  if (metric === 'revenue' || metric === 'spend') {
    if (value >= 1_000_000) return '$' + (value / 1_000_000).toFixed(1) + 'M'
    if (value >= 1_000)     return '$' + Math.round(value / 1_000) + 'K'
    return '$' + value
  }
  return value.toLocaleString()
}

export default function AnomalyStrip({ period = 'last_4w' }) {
  const [anomalies, setAnomalies] = useState([])
  const [open, setOpen]           = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading]     = useState(false)

  useEffect(() => {
    if (!USE_API) return
    setLoading(true)
    setDismissed(false)
    api.getAnomalies(period)
      .then(data => { setAnomalies(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [period])

  if (!USE_API || loading || dismissed || anomalies.length === 0) return null

  const critical = anomalies.filter(a => a.severity === 'critical')
  const warnings = anomalies.filter(a => a.severity === 'warning')

  return (
    <div className="mx-4 mb-4 rounded-2xl border overflow-hidden border-rose-500/30 bg-rose-950/20">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
        <p className="text-xs font-black text-rose-300 flex-1">
          Performance Alerts
          <span className="ml-2 text-[9px] font-black bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded-full">
            {anomalies.length}
          </span>
          {critical.length > 0 && (
            <span className="ml-1 text-[9px] font-black bg-rose-500/30 text-rose-300 px-1.5 py-0.5 rounded-full">
              {critical.length} critical
            </span>
          )}
        </p>
        <button
          onClick={e => { e.stopPropagation(); setDismissed(true) }}
          className="text-rose-500/50 hover:text-rose-400 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-rose-500/50" /> : <ChevronDown className="w-3.5 h-3.5 text-rose-500/50" />}
      </div>

      {/* Body */}
      {open && (
        <div className="border-t border-rose-500/15 px-4 py-3 flex flex-wrap gap-2">
          {anomalies.map((a, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold
                ${a.severity === 'critical'
                  ? 'bg-rose-500/15 border border-rose-500/25 text-rose-300'
                  : 'bg-amber-500/10 border border-amber-500/20 text-amber-300'}`}
            >
              <span className="font-black">{a.clientName}</span>
              <span className="opacity-50">·</span>
              <span>{a.label}</span>
              <span className={`font-black ${a.severity === 'critical' ? 'text-rose-400' : 'text-amber-400'}`}>
                ↓{Math.abs(a.pctChange)}%
              </span>
              <span className="opacity-40 text-[10px]">{fmt(a.metric, a.current)} vs {fmt(a.metric, a.prior)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
