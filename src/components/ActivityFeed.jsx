import { useState, useEffect, useRef } from 'react'
import { Zap, RefreshCw, CheckCircle, AlertCircle, Wifi } from 'lucide-react'
import { subscribeRealtime, USE_API } from '@/lib/api'
import { fmtN } from '@/lib/utils'

const MAX_EVENTS = 12

// Mock events shown when no API is connected
const MOCK_EVENTS = [
  { id: 1, type: 'sync_ok',   channel: 'google_ads', client: 'Generation Floors', detail: '34 leads imported',    ts: new Date(Date.now() - 3   * 60000) },
  { id: 2, type: 'sync_ok',   channel: 'gbp',        client: 'Generation Floors', detail: '1.2K views synced',   ts: new Date(Date.now() - 11  * 60000) },
  { id: 3, type: 'sync_ok',   channel: 'ghl',        client: 'Generation Floors', detail: '7 opportunities',     ts: new Date(Date.now() - 28  * 60000) },
  { id: 4, type: 'sync_ok',   channel: 'meta',       client: 'All Clients',       detail: '52 leads imported',   ts: new Date(Date.now() - 64  * 60000) },
  { id: 5, type: 'live',      channel: '',            client: '',                  detail: 'Dashboard connected', ts: new Date(Date.now() - 120 * 60000) },
]

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const CHANNEL_LABELS = {
  google_ads: 'Google Ads',
  meta:       'Meta Ads',
  ghl:        'GHL CRM',
  gbp:        'Google Business',
  lsa:        'LSA',
}

const CHANNEL_DOTS = {
  google_ads: 'bg-blue-500',
  meta:       'bg-indigo-500',
  ghl:        'bg-purple-500',
  gbp:        'bg-emerald-500',
  lsa:        'bg-amber-500',
}

function EventRow({ ev }) {
  const isError = ev.type === 'sync_error'
  const isLive  = ev.type === 'live'

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-50 last:border-0 animate-fade-in">
      {/* Icon */}
      <div className="mt-0.5 shrink-0">
        {isError  && <AlertCircle  className="w-3.5 h-3.5 text-rose-400" />}
        {isLive   && <Wifi         className="w-3.5 h-3.5 text-emerald-400" />}
        {!isError && !isLive && (
          <span className={`w-2 h-2 rounded-full block mt-0.5 ${CHANNEL_DOTS[ev.channel] || 'bg-slate-300'}`} />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-slate-700 leading-snug">
          {ev.client && <span className="text-slate-900">{ev.client}</span>}
          {ev.channel && <span className="text-slate-400"> · {CHANNEL_LABELS[ev.channel] || ev.channel}</span>}
          {isLive && <span className="text-slate-600">Live dashboard connected</span>}
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5">{ev.detail}</p>
      </div>

      {/* Timestamp */}
      <p className="text-[9px] text-slate-400 font-medium tabular-nums shrink-0 mt-0.5">
        {timeAgo(ev.ts)}
      </p>
    </div>
  )
}

/**
 * ActivityFeed — live ticker of sync events and dashboard refreshes.
 * In API mode: captures SSE refresh events and re-renders with timestamps.
 * In mock mode: shows a set of representative events.
 */
export default function ActivityFeed({ clients = [] }) {
  const [events, setEvents] = useState(USE_API ? [] : MOCK_EVENTS)
  const [ticker, setTicker] = useState(0)
  const idRef      = useRef(100)
  const clientsRef = useRef(clients)

  // Keep ref in sync so SSE handler always sees the latest client list
  useEffect(() => { clientsRef.current = clients }, [clients])

  // Tick every 15s to refresh "X ago" labels
  useEffect(() => {
    const id = setInterval(() => setTicker(t => t + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  // Subscribe to SSE and add an event each time data refreshes
  useEffect(() => {
    if (!USE_API) return
    return subscribeRealtime((payload) => {
      const channel   = payload?.channel || ''
      const clientObj = payload?.clientId
        ? clientsRef.current.find(c => c.id === payload.clientId)
        : null
      const client = clientObj?.name || (payload?.clientId ? `Client ${payload.clientId.slice(0, 6)}` : 'All Clients')
      setEvents(prev => [
        {
          id:      ++idRef.current,
          type:    'sync_ok',
          channel,
          client,
          detail:  'Sync complete — dashboard updated',
          ts:      new Date(),
        },
        ...prev,
      ].slice(0, MAX_EVENTS))
    })
  }, [])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-slate-700">Live Activity</p>
          {USE_API && (
            <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          )}
        </div>
        <p className="text-[9px] text-slate-400 font-medium">Sync events &amp; updates</p>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-5 py-1">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <RefreshCw className="w-6 h-6 text-slate-200 mb-2" />
            <p className="text-xs text-slate-400">Waiting for sync events…</p>
            <p className="text-[10px] text-slate-300 mt-1">Trigger a sync to see activity here</p>
          </div>
        ) : (
          events.map(ev => <EventRow key={`${ev.id}-${ticker}`} ev={ev} />)
        )}
      </div>
    </div>
  )
}
