import { useState, useEffect, useRef } from 'react'

/**
 * Counts a number from 0 → target with an ease-out cubic curve.
 * Used on exec + client hero numbers for the "roll-up" entrance effect.
 *
 * @param {number}  target   — final value
 * @param {object}  options
 * @param {number}  options.duration  — ms (default 1400)
 * @param {number}  options.delay     — ms before starting (default 0)
 * @param {boolean} options.enabled   — false = return target immediately (for non-SSR / mock paths)
 */
export function useCountUp(target, { duration = 1400, delay = 0, enabled = true } = {}) {
  const [value, setValue] = useState(0)
  const rafRef = useRef(null)

  useEffect(() => {
    if (!enabled || target == null) {
      setValue(target || 0)
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
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [target, duration, delay, enabled])

  return value
}
