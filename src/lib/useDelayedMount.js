import { useState, useEffect } from 'react'

/**
 * Returns true after a short delay, so that charts/heavy components
 * only render after the page layout has settled (avoids ResizeObserver flash).
 */
export function useDelayedMount(delay = 50) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setReady(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  return ready
}
