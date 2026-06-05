import { useEffect, useState } from 'react'

// ============================================================================
// lib/useNow.js — a shared, low-frequency wall clock for relative-age UI.
//
// WHY THIS EXISTS. Components that render "X ago" against Date.now() are only
// honest if they re-render as the clock moves. A stateless badge that re-renders
// solely on prop change silently freezes: leave a tab open through a meeting and
// "updated just now" still reads "just now" twenty minutes later — the recency
// claim becomes a lie. <StreamStatus> had exactly this gap. Its live verdict is
// folded by summarizeLiveness against `now`, but the badge owned no timer, so on a
// healthy-but-quiet SSE stream (the 30s keep-alive ping moves no state) it never
// re-evaluated — falsely holding "Live · just now" long after the last event and
// never decaying live→connected at the 90s mark. This hook is the missing tick.
//
// This is the browser-clock sibling of useOpsHealth: where that hook re-READS a
// server ledger on a cadence to keep a freshness fact true, this re-GROUNDS a
// pure render against the real wall clock on a cadence. It deliberately does NOT
// re-fetch anything — it only advances `now` so a consumer's own age math (which
// already re-grounds against the server's real timestamps each render) stays live.
//
// EFFICIENT BY CONSTRUCTION. The tick pauses while the tab is hidden — an "X ago"
// no one is watching need not stay warm — and fires once immediately on re-show, so
// a returning viewer never sees an age frozen at the moment they switched away. An
// `active:false` switch lets a caller that supplies its own fixed instant (tests /
// preview, for determinism) disable the clock entirely: no timer, no listener, the
// returned value is irrelevant because the caller ignores it.
//
// SAFE BY CONSTRUCTION. SSR/non-browser safe (document is guarded, Date.now exists
// in Node). An `alive` flag plus full teardown (clearInterval + removeEventListener)
// prevent any setState-after-unmount or dangling timer/listener. Carries no data —
// it is a clock — so it widens no surface and cannot leak.
// ============================================================================

// 15s keeps the second-granular live window ("12s ago") within a tick of the truth
// and decays the false "Live" pulse to "Connected" within ~15s of the 90s boundary,
// while costing at most four trivial setStates a minute (and none while hidden).
const DEFAULT_INTERVAL_MS = 15_000

/**
 * A wall-clock `now` (epoch ms) that advances on a low cadence so relative-age UI
 * stays honest on a long-open tab. Paused while the tab is hidden; re-grounds once
 * immediately on re-show.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.intervalMs=15000]  tick cadence in ms. <=0 / non-finite
 *        disables the timer (single value, never advances).
 * @param {boolean} [opts.active=true]  when false, no timer/listener is installed —
 *        for callers that pass their own fixed instant and want determinism.
 * @returns {number} the current instant in epoch ms (re-rendered on each tick).
 */
export function useNow({ intervalMs = DEFAULT_INTERVAL_MS, active = true } = {}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return undefined
    let alive = true
    const sync = () => { if (alive) setNow(Date.now()) }

    // Re-ground immediately on (re)activation — covers the active-flips-true and
    // interval-change cases without waiting a full tick. On a fresh mount this is a
    // harmless near-identical re-set (initial state was already Date.now()).
    sync()

    // Low-frequency tick, paused while hidden so we don't advance an age no one is
    // watching. The interval keeps firing but no-ops until the tab is visible again.
    const hidden = () => (typeof document !== 'undefined' && document.hidden)
    const tick = () => { if (!hidden()) sync() }
    const timer = (Number.isFinite(intervalMs) && intervalMs > 0)
      ? setInterval(tick, intervalMs)
      : null

    // Re-show → re-ground once immediately, so a returning viewer sees the true age
    // rather than one frozen at whatever it was when they switched away.
    const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) sync() }
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
  }, [intervalMs, active])

  return now
}
