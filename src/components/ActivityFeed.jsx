import { useState, useRef } from 'react'
import { RefreshCw, AlertCircle, Wifi } from 'lucide-react'
import { USE_API } from '@/lib/api'
import { useLiveStream, LIVE_EVENTS } from '@/lib/useLiveStream'
import { useNow } from '@/lib/useNow'

const MAX_EVENTS = 12

// ============================================================================
// components/ActivityFeed.jsx — the live ticker of sync activity (intel-v13 C2).
//
// PRIOR BUG (now fixed): this fed off api.subscribeRealtime, which listened for a
// `refresh` event the backend NEVER emits — so in API mode the feed was always
// empty. Worse, its handler read payload.clientId / payload.channel off the wire;
// the SSE stream is a single broadcast, so that payload could carry ANOTHER
// tenant's id — a peer-id leak visible on an agency screen.
//
// FIX: subscribe via useLiveStream (intel-v13 C1), which surfaces ONLY the event
// TYPE name + the browser-clock instant it arrived — never ev.data. Each real event
// (ghl_event / supermetrics_sync / hubspot_event) becomes a generic source-level
// row ("GHL CRM · activity synced") with NO client identity at all. So the feed is
// leak-proof BY CONSTRUCTION: there is simply no tenant data in scope to render.
// ============================================================================

// Map each broadcast event TYPE → a human, identity-free row descriptor. Keyed by
// the same LIVE_EVENTS names the hook binds, so a renamed event can't silently go
// unlabeled. No per-client lookup exists here anymore — the hook hands us no id.
const EVENT_META = {
  ghl_event:         { label: 'GHL CRM',      detail: 'New CRM activity synced',  dot: 'bg-purple-500' },
  supermetrics_sync: { label: 'Ad platforms', detail: 'Fresh ad metrics synced',  dot: 'bg-blue-500'   },
  hubspot_event:     { label: 'HubSpot',      detail: 'New CRM activity synced',  dot: 'bg-orange-500' },
}
const FALLBACK_META = { label: 'Data source', detail: 'Activity synced', dot: 'bg-slate-300' }

// Mock events shown when no API is connected — static demo data, no live wire.
const MOCK_EVENTS = [
  { id: 1, type: 'sync_ok', label: 'Google Ads',  detail: '34 leads imported',   dot: 'bg-blue-500',    ts: new Date(Date.now() - 3   * 60000) },
  { id: 2, type: 'sync_ok', label: 'Google Business', detail: '1.2K views synced', dot: 'bg-emerald-500', ts: new Date(Date.now() - 11  * 60000) },
  { id: 3, type: 'sync_ok', label: 'GHL CRM',     detail: '7 opportunities',     dot: 'bg-purple-500',  ts: new Date(Date.now() - 28  * 60000) },
  { id: 4, type: 'sync_ok', label: 'Meta Ads',    detail: '52 leads imported',   dot: 'bg-indigo-500',  ts: new Date(Date.now() - 64  * 60000) },
  { id: 5, type: 'live',    label: '',            detail: 'Dashboard connected', dot: '',               ts: new Date(Date.now() - 120 * 60000) },
]

// Relative age against a supplied `now` so the whole feed re-grounds off ONE shared
// clock tick (lib/useNow) instead of each row reading Date.now() independently. `ts`
// is a Date; `now - ts` coerces it to epoch ms, identical to the old Date.now()-ts.
function timeAgo(ts, now = Date.now()) {
  const s = Math.round((now - ts) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function EventRow({ ev, now }) {
  const isError = ev.type === 'sync_error'
  const isLive  = ev.type === 'live'

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-50 last:border-0 animate-fade-in">
      {/* Icon */}
      <div className="mt-0.5 shrink-0">
        {isError  && <AlertCircle className="w-3.5 h-3.5 text-rose-400" />}
        {isLive   && <Wifi        className="w-3.5 h-3.5 text-emerald-400" />}
        {!isError && !isLive && (
          <span className={`w-2 h-2 rounded-full block mt-0.5 ${ev.dot || 'bg-slate-300'}`} />
        )}
      </div>

      {/* Content — a source-level label (never a client name) + a neutral detail line */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-slate-700 leading-snug">
          {isLive
            ? <span className="text-slate-600">Live dashboard connected</span>
            : <span className="text-slate-900">{ev.label}</span>}
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5">{ev.detail}</p>
      </div>

      {/* Timestamp */}
      <p className="text-[9px] text-slate-400 font-medium tabular-nums shrink-0 mt-0.5">
        {timeAgo(ev.ts, now)}
      </p>
    </div>
  )
}

/**
 * ActivityFeed — live ticker of sync events.
 * In API mode: subscribes to the SSE stream (useLiveStream) and prepends one
 *   identity-free row per real event. NEVER reads the event payload, so no tenant
 *   data can surface — safe on any screen.
 * In mock mode: shows a set of representative demo events.
 *
 * Note: this component intentionally takes no client list anymore — the live feed
 * carries no client identity, so there is nothing to resolve a name against.
 */
export default function ActivityFeed() {
  const [events, setEvents] = useState(USE_API ? [] : MOCK_EVENTS)
  const idRef = useRef(100)

  // Advance the "X ago" labels off the shared low-frequency wall clock (lib/useNow —
  // paused while the tab is hidden, re-grounds immediately on re-show) instead of a
  // private setInterval. One tick re-renders the feed; each row reads this same `now`,
  // so a long-open tab never shows a frozen age and a hidden tab burns no timer.
  const now = useNow()

  // Subscribe to the live stream — one row per real event, payload never read.
  useLiveStream({
    enabled: USE_API,
    onActivity: ({ name, at }) => {
      const meta = EVENT_META[name] || FALLBACK_META
      setEvents(prev => [
        { id: ++idRef.current, type: 'sync_ok', label: meta.label, detail: meta.detail, dot: meta.dot, ts: new Date(at) },
        ...prev,
      ].slice(0, MAX_EVENTS))
    },
  })

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
          events.map(ev => <EventRow key={ev.id} ev={ev} now={now} />)
        )}
      </div>
    </div>
  )
}
