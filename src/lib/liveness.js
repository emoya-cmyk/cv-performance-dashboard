// ============================================================================
// lib/liveness.js — the badge state machine behind every "Live" indicator (intel-v13 C2).
//
// useLiveStream (C1) exposes two honest, orthogonal signals:
//   • connected   — is the SSE pipe open right now? (transport health)
//   • lastEventAt — when did real data last move?    (recency, browser-clock ms)
//
// A badge needs ONE composed verdict. This pure function folds those two signals
// (recency via classifyFreshness, C1) into a single presentational shape the
// shared <LiveBadge> renders on BOTH the agency and client surfaces. Keeping it
// pure means it unit-tests in isolation under the API gate (dynamic import from
// api/test/) and imports natively into the FE — one source of truth, no drift.
//
// The state machine (transport dominates, then recency):
//   not connected            → 'offline'    (muted, no pulse) — pipe is down
//   connected + event ≤ ~90s → 'live'       (positive, pulsing) — data is moving
//   connected + quiet        → 'connected'  (neutral, steady) — pipe open, no recent event
//
// LEAK-SAFE BY CONSTRUCTION: the inputs are a boolean and a timestamp; the outputs
// are a state token, a semantic tone, a boolean, and age-only strings ("updated 3m
// ago"). No client id, name, figure, count, or agency internal can pass through —
// so the very same badge is safe on a client's own dashboard and the agency fleet
// view alike. tone is a SEMANTIC token ('positive'|'neutral'|'muted'); mapping it
// to Tailwind classes is the component's job, keeping this module render-agnostic.
// ============================================================================

import { classifyFreshness } from './freshness.js'

// The three canonical states and their human labels. Exported so the badge and its
// tests reference one declared set of strings instead of re-typing them (the same
// drift bug — a hard-coded event name — that made the old subscribeRealtime dead).
export const LIVENESS_STATES = Object.freeze(['live', 'connected', 'offline'])

export const LIVENESS_LABELS = Object.freeze({
  live:      'Live',
  connected: 'Connected',
  offline:   'Offline',
})

// Semantic tone per state — the component maps these to color classes. Kept here so
// every surface tones the same state identically.
export const LIVENESS_TONES = Object.freeze({
  live:      'positive',
  connected: 'neutral',
  offline:   'muted',
})

/**
 * Fold the live-stream signals into a single badge-ready verdict.
 *
 * @param {{connected?: boolean, lastEventAt?: Date|number|string|null}} [signals]
 *        typically the (subset of the) object returned by useLiveStream. Only
 *        `connected` and `lastEventAt` are read; anything else (lastEventName,
 *        tick) is ignored — and deliberately so, to keep this leak-safe.
 * @param {Date|number} [now]  reference instant (defaults to Date.now()).
 * @returns {{
 *   state:  'live'|'connected'|'offline',
 *   tone:   'positive'|'neutral'|'muted',
 *   pulse:  boolean,
 *   label:  string,
 *   detail: string,
 *   live:   boolean,
 *   ageMs:  number|null
 * }}
 *
 * - `detail` is always age-only ("updated 3m ago") or a status hint
 *   ("awaiting activity" / "reconnecting…") — never a figure or tenant token.
 * - Transport dominates: a fresh `lastEventAt` with `connected:false` still reads
 *   'offline' (we cannot trust "live" when the socket is down).
 */
export function summarizeLiveness(signals = {}, now = Date.now()) {
  const connected   = Boolean(signals && signals.connected)
  const lastEventAt = signals ? signals.lastEventAt : null

  const fresh = classifyFreshness(lastEventAt, now)   // { state, ageMs, label, fresh }
  const known = fresh.state !== 'unknown'
  const updated = known ? `updated ${fresh.label}` : null

  // Transport down → offline, no matter how fresh the last event looked.
  if (!connected) {
    return {
      state:  'offline',
      tone:   LIVENESS_TONES.offline,
      pulse:  false,
      label:  LIVENESS_LABELS.offline,
      // EventSource auto-retries, so "reconnecting…" is the honest hint when we
      // have no prior data; otherwise show how stale the last-known data is.
      detail: known ? updated : 'reconnecting…',
      live:   false,
      ageMs:  fresh.ageMs,
    }
  }

  // Connected AND a real event within the live window → genuinely live.
  if (fresh.fresh) {   // fresh.state === 'live'
    return {
      state:  'live',
      tone:   LIVENESS_TONES.live,
      pulse:  true,
      label:  LIVENESS_LABELS.live,
      detail: updated,           // 'updated just now' / 'updated 12s ago'
      live:   true,
      ageMs:  fresh.ageMs,
    }
  }

  // Connected but quiet (recent / stale / never-seen) → pipe healthy, no recent event.
  return {
    state:  'connected',
    tone:   LIVENESS_TONES.connected,
    pulse:  false,
    label:  LIVENESS_LABELS.connected,
    detail: known ? updated : 'awaiting activity',
    live:   false,
    ageMs:  fresh.ageMs,
  }
}
