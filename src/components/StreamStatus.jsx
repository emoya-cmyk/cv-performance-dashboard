import { summarizeLiveness } from '@/lib/liveness'

// ============================================================================
// components/StreamStatus.jsx — the shared live-stream badge (intel-v13 C2).
//
// Renders the single verdict lib/liveness.summarizeLiveness folds out of
// useLiveStream's two orthogonal signals (connected + lastEventAt). ONE component,
// used on BOTH the agency Intelligence header and the client's own dashboard,
// because the verdict is leak-safe BY CONSTRUCTION: summarizeLiveness emits only a
// state token, a semantic tone, a boolean, and age-only strings ("updated 3m ago")
// — never a figure, count, client id, or peer name. So the very same badge is
// correct on a shared/client surface and the agency fleet view alike.
//
// NOT to be confused with components/LiveBadge.jsx — that is the older fetch-
// refresh indicator ({loading, lastRefresh}) wired into TopBar. This badge reflects
// the SSE transport health + data recency, a distinct concept; the two coexist.
//
// Purely presentational and stateless: it owns no timer and reads no payload. It
// re-renders when its props change — the parent owns the subscription via
// useLiveStream and passes connected/lastEventAt down, refreshed on every event.
// ============================================================================

// Semantic tone (declared in liveness.js) → Tailwind classes. The mapping lives
// here so the state machine stays render-agnostic and every surface tones a given
// state identically (an agency "Live" looks like a client "Live").
const TONE_DOT = {
  positive: 'bg-emerald-400',
  neutral:  'bg-sky-400',
  muted:    'bg-slate-300',
}
const TONE_TEXT = {
  positive: 'text-emerald-600',
  neutral:  'text-slate-500',
  muted:    'text-slate-400',
}

/**
 * @param {object}       props
 * @param {boolean}      [props.connected]    from useLiveStream — is the pipe open?
 * @param {number|null}  [props.lastEventAt]  from useLiveStream — last real event (browser-clock ms)
 * @param {Date|number}  [props.now]          reference instant for tests/preview (defaults to Date.now())
 * @param {boolean}      [props.showDetail=true]  render the age/status hint after the label
 * @param {string}       [props.className]
 */
export default function StreamStatus({ connected, lastEventAt, now, showDetail = true, className = '' }) {
  const v    = summarizeLiveness({ connected, lastEventAt }, now)
  const dot  = TONE_DOT[v.tone]  || TONE_DOT.muted
  const text = TONE_TEXT[v.tone] || TONE_TEXT.muted

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${text} ${className}`}
      title={v.detail ? `${v.label} · ${v.detail}` : v.label}
      role="status"
      aria-live="polite"
    >
      <span
        className={`w-2 h-2 rounded-full ${dot} ${v.pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      <span className="uppercase tracking-wide">{v.label}</span>
      {showDetail && v.detail
        ? <span className="font-medium text-slate-400 normal-case tracking-normal">· {v.detail}</span>
        : null}
    </span>
  )
}
