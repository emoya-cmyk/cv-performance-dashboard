import { useState, useEffect } from 'react'
import { USE_API, api } from '@/lib/api'

// ── Memory OS — governance visibility (agency-only) ───────────────────────────
//
// A thin, honest one-line read on the memory store's self-heal verdict
// (GET /api/memory/health). Mirrors OpsHealthStrip: tone-mapped status, never
// alarming on a healthy store, self-hides on any non-200 (so it shows nothing on
// a client surface — the endpoint 403s a client token) or before data loads.
const TONE = {
  healthy:  { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Memory healthy' },
  degraded: { dot: 'bg-amber-500',   text: 'text-amber-700',   label: 'Memory degraded' },
  critical: { dot: 'bg-rose-500',    text: 'text-rose-700',    label: 'Memory critical' },
}
const ACTION = { compact: 'compacting dead rows', escalate: 'flagged for review', none: '' }

export default function MemoryHealthBadge({ className = '' }) {
  const [h, setH] = useState(null)

  useEffect(() => {
    if (!USE_API) return
    let live = true
    api.getMemoryHealth()
      .then((d) => { if (live) setH(d) })
      .catch(() => {})   // 403 on a client surface / any error → stay hidden
    return () => { live = false }
  }, [])

  if (!USE_API || !h || !TONE[h.status]) return null
  const tone = TONE[h.status]
  const action = ACTION[h.recommended_action] || ''

  return (
    <div className={`no-print flex items-center gap-2 text-[11px] ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      <span className={`font-semibold ${tone.text}`}>{tone.label}</span>
      <span className="text-slate-400">
        {h.live} live · {h.dead} dead{action ? ` · ${action}` : ''}
      </span>
    </div>
  )
}
