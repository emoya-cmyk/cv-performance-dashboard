import { summarizeLiveness } from '@/lib/liveness'
import { useNow } from '@/lib/useNow'

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
// Reads no payload — it folds only the parent's connected/lastEventAt (the parent
// owns the SSE subscription via useLiveStream). But it is NOT timer-free: the verdict
// is time-relative ("Live · updated 3m ago", and the live→connected decay at ~90s),
// and a real stream can sit healthy-but-quiet for minutes (the 30s keep-alive ping
// moves no state, so no prop changes). Re-rendering only on prop change would freeze
// that age and falsely hold "Live" long after the last event. So it advances its own
// low-frequency wall clock (lib/useNow — paused while hidden, re-grounds on re-show)
// purely to keep the age honest; supply a fixed `now` to disable it (tests/preview).
// The added clock carries no data, so the badge stays leak-safe on every surface.
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
  // Keep the time-relative verdict honest on a long-open, quiet stream: advance an
  // internal wall clock so "updated Nm ago" and the live→connected decay re-evaluate
  // even when no event (hence no prop change) arrives. A caller-supplied fixed `now`
  // (tests/preview) disables the clock and is used verbatim, preserving determinism;
  // otherwise we feed the ticking clock, matching the prior default-to-now behaviour.
  const liveNow = useNow({ active: now === undefined })
  const v    = summarizeLiveness({ connected, lastEventAt }, now ?? liveNow)
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
