import { useEffect, useState } from 'react'
import { api, USE_API } from '@/lib/api'

// ============================================================================
// lib/useOpsHealth.js — the shared live-read primitive behind every autonomy
// proof line (ops-v2). OpsHealthStrip (agency · Intelligence) and ExecAutonomyLine
// (executive · ExecView) both answer one question — "is the self-healing engine
// behind these numbers still running on its own, and is what I'm seeing current?"
// Both did so by fetching GET /api/insights/ops ONCE on mount, with byte-identical
// USE_API-gating + null-safety. ExecAutonomyLine's own contract note even said the
// two share that fetch "deliberately." This hook is that shared contract, made one
// thing — and it closes the last honesty gap in the proof.
//
// WHY A POLL, NOT A ONE-SHOT. The pill's headline fact is freshness ("verified 2m
// ago" / "last run 2m ago"). A one-shot fetch froze that string at mount: leave the
// tab open through a meeting and a confidence line still reads "verified 2m ago"
// twenty minutes later — the freshness claim silently becomes a lie. So the proof
// that the engine is live must itself stay live. This hook re-reads /ops on a low
// cadence (the grade only moves every ~15m — the watchdog's beat — so 90s is ample)
// and re-grounds the displayed age against the server's real ledger each time,
// rather than ticking a local counter that would keep counting even if the engine
// had genuinely stalled. Refetch is both honest AND current.
//
// EFFICIENT BY CONSTRUCTION. Polling pauses while the tab is hidden (no needless
// background fetches — the "Xm ago" no one is looking at need not stay warm), and a
// single immediate read fires the instant the tab is shown again, so a returning
// viewer never sees a stale age waiting for the next tick. /ops is a cheap ledger
// read and carries NO per-client payload (it 403s a client token), so the added
// reads widen no client-data surface.
//
// SAFE BY CONSTRUCTION. USE_API-gated (off in the demo build → stays {null,false}
// → consumer renders nothing). Every read SWALLOWS its error and, crucially, leaves
// the LAST-GOOD data in place — a momentary network blip during polling must not
// flash the confidence pill off; it simply isn't refreshed until the next read
// succeeds. An `alive` flag + full teardown prevent any setState-after-unmount or
// dangling interval/listener. document is guarded so a non-browser context no-ops.
// ============================================================================

// The ops grade changes at most every ~15 min (the watchdog cadence is the fastest
// heartbeat feeding it), so a 90s poll keeps the minute-granular "X ago" honest with
// generous headroom while staying gentle on the endpoint.
const DEFAULT_REFRESH_MS = 90_000

/**
 * Live-read the autonomy/ops grade for the lifetime of the mounted component.
 *
 * First read is byte-identical to the prior mount fetch (USE_API-gated, null-safe,
 * swallow-on-error); thereafter it low-frequency-polls so the freshness fact the
 * consumer renders stays true on a long-open tab.
 *
 * @param {number} [refreshMs=90000]  poll cadence in ms. <=0 disables polling
 *        (single mount read only). Stable primitive → effect re-runs only if changed.
 * @returns {{data: object|null, loaded: boolean}}
 *        `data` is the latest /ops payload (or null before first success / in demo
 *        mode); `loaded` flips true once the first read settles (success OR error),
 *        so a consumer can distinguish "still loading" from "loaded, nothing to show."
 */
export function useOpsHealth(refreshMs = DEFAULT_REFRESH_MS) {
  const [data, setData]     = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!USE_API) return undefined
    let alive = true

    // One read. On success: fresh data + loaded. On failure: loaded only — the
    // last-good `data` is deliberately left untouched so a transient blip never
    // blanks the pill. The `alive` guard blocks setState after unmount.
    const read = () => {
      api.getOpsHealth()
        .then((d) => { if (alive) { setData(d); setLoaded(true) } })
        .catch(() => { if (alive) setLoaded(true) })
    }

    read()   // immediate first read — identical to the old one-shot mount fetch

    // Low-frequency poll, paused while the tab is hidden so we don't refresh an age
    // no one is watching. The interval keeps ticking but no-ops until the tab is back.
    const hidden = () => (typeof document !== 'undefined' && document.hidden)
    const tick = () => { if (!hidden()) read() }
    const timer = (Number.isFinite(refreshMs) && refreshMs > 0)
      ? setInterval(tick, refreshMs)
      : null

    // Re-show → read once immediately, so a returning viewer sees fresh truth rather
    // than a stale "X ago" frozen at whatever it was when they switched away.
    const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) read() }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
      alive = false
      if (timer) clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [refreshMs])

  return { data, loaded }
}
