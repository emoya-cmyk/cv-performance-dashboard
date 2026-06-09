import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronDown, ChevronUp, X, ArrowRight } from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { severityMeta } from '@/lib/insightMeta'

/**
 * AnomalyStrip — the Dashboard's at-a-glance alert ribbon.
 *
 * Reads the SAME autonomous engine feed the Intelligence page does
 * (GET /api/insights), but surfaces only what actually needs a human right now:
 * critical + warning findings. Each chip and the "View all" link deep-link into
 * the full Intelligence feed where they can be acknowledged or resolved. Stays
 * completely silent when the portfolio is clean — no row, no empty box.
 *
 * Light-themed to sit at the top of the light Dashboard. Self-dismissable for the
 * session; reappears on next load if findings remain.
 */
export default function AnomalyStrip() {
  const [items, setItems]         = useState([])
  const [open, setOpen]           = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [loaded, setLoaded]       = useState(false)

  useEffect(() => {
    if (!USE_API) return
    let alive = true
    api.getInsights()
      .then(data => {
        if (!alive) return
        const alerting = (Array.isArray(data?.insights) ? data.insights : [])
          .filter(i => i.severity === 'critical' || i.severity === 'warning')
        setItems(alerting)
        setLoaded(true)
      })
      .catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [])

  if (!USE_API || !loaded || dismissed || items.length === 0) return null

  const critical = items.filter(i => i.severity === 'critical')
  const shown    = items.slice(0, 8)

  return (
    <div className="rounded-2xl border border-rose-500/30 bg-gradient-to-r from-rose-500/10 to-amber-500/5 overflow-hidden shadow-sm">
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <div className="w-7 h-7 rounded-lg bg-rose-500/20 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-4 h-4 text-rose-400" />
        </div>
        <p className="text-xs font-black text-rose-300 flex-1">
          Performance Alerts
          <span className="ml-2 text-[9px] font-black bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded-full">
            {items.length}
          </span>
          {critical.length > 0 && (
            <span className="ml-1 text-[9px] font-black bg-rose-500 text-white px-1.5 py-0.5 rounded-full">
              {critical.length} critical
            </span>
          )}
        </p>
        <Link
          to="/intelligence"
          onClick={e => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-400 hover:text-rose-300 transition-colors"
        >
          View all <ArrowRight className="w-3 h-3" />
        </Link>
        <button
          onClick={e => { e.stopPropagation(); setDismissed(true) }}
          className="text-rose-400 hover:text-rose-600 transition-colors"
          title="Dismiss for now"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-rose-400" /> : <ChevronDown className="w-3.5 h-3.5 text-rose-400" />}
      </div>

      {/* body */}
      {open && (
        <div className="border-t border-rose-500/20 px-4 py-3 flex flex-wrap gap-2">
          {shown.map(i => {
            const sev = severityMeta(i.severity)
            return (
              <Link
                to="/intelligence"
                key={i.id}
                className={cn('flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold border transition hover:shadow-sm', sev.chipBg, sev.border, sev.text)}
                title={i.detail || i.title}
              >
                <span className="font-black truncate max-w-[10rem]">{i.client_name || '—'}</span>
                <span className="opacity-40">·</span>
                <span className="truncate max-w-[22rem]">{i.title}</span>
              </Link>
            )
          })}
          {items.length > shown.length && (
            <Link
              to="/intelligence"
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold text-slate-400 bg-white/[0.06] border border-white/[0.10] hover:border-brand-500/40 hover:text-brand-400 transition"
            >
              +{items.length - shown.length} more <ArrowRight className="w-3 h-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
