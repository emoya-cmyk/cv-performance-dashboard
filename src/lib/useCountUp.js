import { useState, useEffect, useRef } from 'react'

// Resolved once. In a non-browser/test context matchMedia may be absent, so guard.
const PREFERS_REDUCED_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Counts a number from 0 → target with an ease-out cubic curve.
 * Used on exec + client hero numbers for the "roll-up" entrance effect.
 *
 * Robustness contract: the returned value ALWAYS settles on `target`, even when
 * requestAnimationFrame never fires — which is exactly what happens when the page
 * is mounted in a hidden/background tab (rAF is paused, not throttled, so the
 * queued tick never runs and a naïve count-up would park at 0 forever). A
 * setTimeout safety net guarantees the final value lands regardless, and
 * prefers-reduced-motion / disabled paths skip the animation entirely.
 *
 * @param {number}  target   — final value (callers pass integers; ratios are pre-scaled)
 * @param {object}  options
 * @param {number}  options.duration  — ms (default 1400)
 * @param {number}  options.delay     — ms before starting (default 0)
 * @param {boolean} options.enabled   — false = return target immediately (for non-SSR / mock paths)
 */
export function useCountUp(target, { duration = 1400, delay = 0, enabled = true } = {}) {
  const animate = enabled && !PREFERS_REDUCED_MOTION
  // Seed with the final value when we won't animate, so the very first paint is correct.
  const [value, setValue] = useState(animate ? 0 : (target ?? 0))
  const rafRef = useRef(null)

  useEffect(() => {
    if (!animate || target == null) {
      setValue(target ?? 0)
      return
    }

    // Always start from 0 on re-mount
    setValue(0)
    const startAt = performance.now() + delay

    function tick(now) {
      if (now < startAt) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const elapsed  = now - startAt
      const progress = Math.min(elapsed / duration, 1)
      const eased    = 1 - Math.pow(1 - progress, 3)   // ease out cubic
      setValue(Math.round(target * eased))
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    // Safety net: rAF does not fire in a hidden/background tab, so the animation
    // above can stall at 0. setTimeout still runs there (clamped, but it runs),
    // guaranteeing the number snaps to its true value. In the normal visible case
    // the animation has already reached target by now, so this is a no-op.
    const settleMs   = delay + duration + 150
    const fallbackId = setTimeout(() => setValue(target), settleMs)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      clearTimeout(fallbackId)
    }
  }, [target, duration, delay, animate])

  return value
}
