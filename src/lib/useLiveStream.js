import { useEffect, useRef, useState } from 'react'
import { getToken } from '@/lib/auth'

// ============================================================================
// lib/useLiveStream.js — the React primitive for the live data pipe (intel-v13 C1).
//
// The backend already runs a Server-Sent-Events stream (GET /api/realtime,
// api/routes/realtime.js): it broadcasts a named event every time a connected
// source pushes — ghl_event / supermetrics_sync / hubspot_event — and a `: ping`
// comment every 30s to hold the socket open. The old api.js subscribeRealtime()
// listened only for a `refresh` event that NOTHING emits, so the dashboards were
// never actually live. This hook subscribes to the events that genuinely fire and
// exposes two honest, orthogonal signals a badge can compose:
//
//   • connected    — is the pipe open right now? (transport health; survives the
//                    30s pings, flips false on a drop, true again on reconnect —
//                    EventSource reconnects on its own.)
//   • lastEventAt   — when did real data last move? (browser-clock ms; feeds
//                    classifyFreshness for a "live / 3m ago / stale" label.)
//
// LEAK-SAFE BY CONSTRUCTION: the SSE stream is a single broadcast to EVERY
// connected browser, so a payload carries whichever tenant just pushed — including
// another client's id. This hook therefore NEVER reads ev.data. It records only
// (a) that an event of a given TYPE arrived and (b) the browser-clock instant it
// arrived. The event type name ('ghl_event', …) is transport metadata, not tenant
// data; the timestamp is the browser's own. Nothing tenant-identifying can pass
// through. A consumer that needs the actual change refetches via the REST API,
// which enforces tenant scope server-side. Backend per-tenant fan-out is a
// separate hardening concern (C2); this primitive is safe on either surface today.
//
// SSR / non-browser safe: the effect no-ops when EventSource is unavailable, so it
// never breaks a build or a server render.
// ============================================================================

// The events the backend actually broadcasts (api/routes/webhooks/{ghl,supermetrics,hubspot}.js).
// Using the wrong name here is exactly the bug this hook replaces, so it is the
// single declared list both this hook and any future consumer reference.
export const LIVE_EVENTS = Object.freeze(['ghl_event', 'supermetrics_sync', 'hubspot_event'])

// Mirrors the (module-private) BASE in api.js — the SSE URL must hit the same origin.
const BASE = import.meta.env.VITE_API_URL || ''

/**
 * Subscribe to the live SSE stream for the lifetime of the mounted component.
 *
 * @param {object}   [options]
 * @param {(activity: {name: string, at: number}) => void} [options.onActivity]
 *        called on every real event with ONLY the event type name + browser-clock
 *        arrival ms — never any payload. Latest callback is always used without
 *        re-subscribing (held in a ref), so an inline arrow is fine.
 * @param {boolean}  [options.enabled=true]  set false to pause/close the stream.
 * @returns {{connected: boolean, lastEventAt: number|null, lastEventName: string|null, tick: number}}
 *        `tick` increments once per real event — a dependency-friendly "something
 *        changed" pulse for effects that want to refetch.
 */
export function useLiveStream({ onActivity, enabled = true } = {}) {
  const [connected,     setConnected]     = useState(false)
  const [lastEventAt,   setLastEventAt]   = useState(null)
  const [lastEventName, setLastEventName] = useState(null)
  const [tick,          setTick]          = useState(0)

  // Hold the latest callback without making it a subscription dependency — a new
  // inline onActivity each render must not tear down and rebuild the EventSource.
  const onActivityRef = useRef(onActivity)
  useEffect(() => { onActivityRef.current = onActivity }, [onActivity])

  useEffect(() => {
    if (!enabled) return undefined
    // Guard SSR / test / any non-browser context: no EventSource → no-op.
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return undefined

    const token = getToken()
    // EventSource cannot set headers, so the token rides the query string — the
    // same auth shape the backend's /api/realtime already accepts (mirrors the
    // prior subscribeRealtime). encodeURIComponent guards odd token characters.
    const url = `${BASE}/api/realtime${token ? `?token=${encodeURIComponent(token)}` : ''}`

    let es
    try {
      es = new window.EventSource(url)
    } catch {
      return undefined   // malformed URL / blocked — fail closed, stay disconnected
    }

    const markOpen = () => setConnected(true)
    es.onopen = markOpen
    es.addEventListener('connected', markOpen)   // backend's initial hello event
    es.onerror = () => setConnected(false)       // transient drop; EventSource auto-retries

    // One handler per real event. Deliberately ignores ev — no payload is read.
    const makeHandler = (name) => () => {
      const at = Date.now()                       // browser clock = same domain the badge's "now" uses
      setLastEventAt(at)
      setLastEventName(name)
      setTick((n) => n + 1)
      const cb = onActivityRef.current
      if (typeof cb === 'function') cb({ name, at })
    }

    const unbinders = LIVE_EVENTS.map((name) => {
      const handler = makeHandler(name)
      es.addEventListener(name, handler)
      return () => es.removeEventListener(name, handler)
    })

    return () => {
      unbinders.forEach((off) => off())
      es.removeEventListener('connected', markOpen)
      es.close()
      setConnected(false)
    }
  }, [enabled])

  return { connected, lastEventAt, lastEventName, tick }
}
