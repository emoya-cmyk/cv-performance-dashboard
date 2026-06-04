import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, RefreshCw, AlertCircle, Route, History, TrendingUp } from 'lucide-react'
import { api } from '@/lib/api'
import { useLiveStream } from '@/lib/useLiveStream'
import { severityMeta, urgencyMeta, directionIcon } from '@/lib/insightMeta'

/**
 * ScopeNarrative — intel-v13 C3, the SHARED surface that makes the dashboard's
 * insight *words* regenerate when a filter or date changes, not just the numbers.
 *
 * It owns one debounced call to POST /api/ai/ask/scope-insight (api.askScopeInsight):
 * hand it the live scope a dashboard is already showing — { metrics?, dateRange,
 * filters?, compareTo? } — and the server re-reads that exact window through the real
 * semantic compiler and returns a freshly NARRATED insight (headline + per-metric
 * movement findings + the channel driver behind each + a recommendation). This panel
 * renders that, re-fetching (debounced, race-guarded) whenever the scope changes, so
 * the story stays in lock-step with the controls.
 *
 * ONE component, BOTH surfaces (the agency Explore view and the client dashboard):
 *   • leak-safe by construction — the endpoint pins tenancy server-side and only ever
 *     attributes drivers by CHANNEL (a global, non-tenant axis), so a client/shared
 *     surface receives no peer data to print. `tone` only re-voices copy, never gates
 *     data; the payload is identical and safe on either surface.
 *   • agency passes no clientId (whole book) or a chosen one; the client surface passes
 *     its own clientObj.id freely — the server hard-pins a client token regardless.
 *
 * Props:
 * intel-v14 D1 — "since you last looked": when C4 silently swaps the cards because fresh
 * data landed for the scope you're sitting on, a same-scope refresh now hands the server a
 * compact snapshot of what's ON SCREEN (as `since`); the server diffs the fresh read against
 * it and returns a leak-safe `delta`, which this panel renders as a one-glance strip above
 * the cards (what moved, good/bad, driver flips, cards in/out of view). A scope CHANGE sends
 * no `since` — there's nothing comparable to diff — so the strip is strictly session-relative,
 * never period-over-period. Same payload, same surface on agency and client (tone is cosmetic).
 *
 * intel-v14 D2 — "cross-read trend": D1 narrates a single hop; this panel also buffers the last
 * few same-scope reads (historyRef) and hands them back as `history`. The server appends the
 * fresh read and, when a metric has moved the SAME direction across ≥3 consecutive reads,
 * returns a leak-safe `trend` we render as a violet streak strip above the delta — "revenue has
 * climbed 3 straight updates", "CPL has risen 3 straight updates — worth a look", with a tiny
 * sparkline of the run. The buffer clears on any scope change, so a streak never straddles scopes.
 *
 * Props:
 *   input       — { metrics?, dateRange:{start,end}, filters?, compareTo? } live scope.
 *   clientId    — optional; honoured ONLY for an agency token (see above).
 *   enabled     — default true; when false (or no window yet) the panel renders nothing.
 *   tone        — 'agency' | 'client'; cosmetic copy only.
 *   debounceMs  — default 400; the quiet-period before a scope change triggers a refetch.
 *   className   — merged onto the section wrapper.
 */
const trim1 = (n) => String(Math.round(Number(n) * 10) / 10)
// "Since you last looked: revenue +$2,400." → "revenue +$2,400." (the eyebrow says the rest)
const stripSincePrefix = (h) => String(h || '').replace(/^since you last looked:\s*/i, '')
// Compact, leak-safe snapshot of what's ON SCREEN now: [{metric, current}] keyed to the
// ABSOLUTE scope total per metric (evidence.current — the exact axis scopeDelta diffs, NOT
// the period-over-period compare). This is what we hand back as `since` on a live refresh.
const snapOf = (d) =>
  (d && Array.isArray(d.findings) ? d.findings : [])
    .map((f) => ({ metric: f && f.metric, current: f && f.evidence ? f.evidence.current : null }))
    .filter((s) => s.metric && Number.isFinite(Number(s.current)))

// intel-v14 D2 — how many PRIOR reads we keep in the rolling trend buffer. Matches the
// server's detectScopeTrends maxReads default; the server also clamps, so this is just a
// memory bound on a long session, never a correctness lever.
const MAX_HISTORY = 12

function deltaChip(improved) {
  if (improved === true)  return 'text-emerald-700 bg-emerald-50 border-emerald-200'
  if (improved === false) return 'text-rose-700 bg-rose-50 border-rose-200'
  return 'text-slate-600 bg-slate-50 border-slate-200'
}

function FindingCard({ f }) {
  const sev    = severityMeta(f.severity)
  const Dir    = directionIcon(f.direction)
  const dirCls = f.improved === true ? 'text-emerald-600'
               : f.improved === false ? 'text-rose-600'
               : 'text-slate-400'
  const pc     = f && f.evidence ? f.evidence.pct_change : null
  const pctTxt = pc != null && Number.isFinite(Number(pc))
    ? `${Number(pc) > 0 ? '+' : ''}${trim1(pc)}%`
    : null
  const rec  = f.recommendation
  const u    = rec ? urgencyMeta(rec.urgency) : null
  const UIcon = u ? u.icon : null

  return (
    <div
      className="rounded-xl border border-slate-200 border-l-4 bg-white px-3.5 py-3 shadow-[0_1px_0_rgba(15,23,42,0.04)]"
      style={{ borderLeftColor: sev.accent }}
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 ${dirCls}`}><Dir size={18} strokeWidth={2.25} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-semibold text-slate-800">{f.title}</span>
            {pctTxt && (
              <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${deltaChip(f.improved)}`}>
                {pctTxt}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">{f.detail}</p>

          {f.driver && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">
              <Route size={11} className="text-slate-400" />
              <span className="font-medium text-slate-600">{f.driver.label}</span>
              <span className="text-slate-300">·</span>
              <span className="tabular-nums">{f.driver.display}</span>
            </div>
          )}

          {rec && (
            <div className="mt-2 flex items-start gap-2">
              <span className={`mt-px inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${u.chip}`}>
                {UIcon && <UIcon size={11} />}{u.label}
              </span>
              <span className="text-[12px] leading-relaxed text-slate-600">{rec.text}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// intel-v14 D1 — the "since you last looked" strip. Turns C4's silent card-swap into a
// sentence: which metrics moved (and was it good/bad), whether the channel driver behind
// one flipped, which cards came into / settled out of view. Every field comes from the
// server's already-leak-safe `delta` (metric names + the global channel axis only; no
// tenant identity), so it renders identically on the agency and client surfaces. Shown
// only when there is a real cross-read change (status 'changed').
function DeltaStrip({ delta }) {
  const changes  = Array.isArray(delta.changes)  ? delta.changes  : []
  const appeared = Array.isArray(delta.appeared) ? delta.appeared : []
  const resolved = Array.isArray(delta.resolved) ? delta.resolved : []
  const shift    = changes.find((c) => c && c.driverShift) || null

  return (
    <div className="mt-3 rounded-xl border border-indigo-200/70 border-l-4 border-l-indigo-500 bg-indigo-50/50 px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-indigo-500"><History size={15} strokeWidth={2.25} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600">Since you last looked</div>
          {delta.headline && (
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-700">{stripSincePrefix(delta.headline)}</p>
          )}

          {changes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {changes.map((c) => {
                const Dir = directionIcon(c.direction)
                const pc  = c.pct
                const pctTxt = pc != null && Number.isFinite(Number(pc))
                  ? `${Number(pc) > 0 ? '+' : ''}${trim1(pc)}%`
                  : null
                return (
                  <span
                    key={c.metric}
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${deltaChip(c.improved)}`}
                  >
                    <Dir size={11} strokeWidth={2.5} />
                    <span className="font-medium">{c.metric_label}</span>
                    {pctTxt && <span>{pctTxt}</span>}
                  </span>
                )
              })}
            </div>
          )}

          {shift && (
            <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
              <Route size={11} className="text-slate-400" />
              <span>Now led by</span>
              <span className="font-medium text-slate-600">{shift.driverShift.to || '—'}</span>
              {shift.driverShift.from && <span className="text-slate-400">(was {shift.driverShift.from})</span>}
            </div>
          )}

          {(appeared.length > 0 || resolved.length > 0) && (
            <div className="mt-1.5 text-[11px] text-slate-400">
              {appeared.length > 0 && (
                <span>{appeared.length} new {appeared.length === 1 ? 'mover' : 'movers'} in view</span>
              )}
              {appeared.length > 0 && resolved.length > 0 && <span className="text-slate-300"> · </span>}
              {resolved.length > 0 && (
                <span>{resolved.length} {resolved.length === 1 ? 'mover' : 'movers'} settled</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// intel-v14 D2 — a tiny leak-safe sparkline of one metric's own run values (bare numbers,
// no tenant identity). Inherits the surrounding chip's text color via currentColor, so it
// reads emerald on an improving streak and rose on an adverse one without extra wiring.
function Sparkline({ values }) {
  const nums = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : []
  if (nums.length < 2) return null
  const w = 38, h = 12, pad = 1.5
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const stepX = (w - pad * 2) / (nums.length - 1)
  const pts = nums
    .map((v, i) => `${trim1(pad + i * stepX)},${trim1(pad + (h - pad * 2) * (1 - (v - min) / span))}`)
    .join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="opacity-80" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// intel-v14 D2 — the cross-read MICRO-TREND strip. D1's DeltaStrip narrates ONE hop; this
// surfaces the stronger signal: a metric on a same-direction streak across several consecutive
// live reads ("Revenue has climbed 3 straight updates", "CPL has risen 3 straight updates —
// worth a look"). Every field is from the server's already-leak-safe `trend` (metric labels +
// bare run values + the global channel axis only; no tenant identity), so it renders identically
// on the agency and client surfaces. Shown only on a real streak (status 'trending'); a single
// hop or a reversal leaves it absent. Placed above the delta because a streak outranks a hop.
function TrendStrip({ trend, tone }) {
  const trends = Array.isArray(trend.trends) ? trend.trends : []
  if (!trends.length) return null
  const accelerating = trends.some((t) => t && t.accelerating)

  return (
    <div className="mt-3 rounded-xl border border-violet-200/70 border-l-4 border-l-violet-500 bg-violet-50/50 px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-violet-500"><TrendingUp size={15} strokeWidth={2.25} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-600">
              {tone === 'client' ? 'Recent trend' : 'Cross-read trend'}
            </span>
            {accelerating && (
              <span className="rounded border border-violet-200 bg-white px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-violet-500">
                accelerating
              </span>
            )}
          </div>
          {trend.headline && (
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-700">{trend.headline}</p>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {trends.map((t) => {
              const Dir = directionIcon(t.direction)
              const pc  = t.pct
              const pctTxt = pc != null && Number.isFinite(Number(pc))
                ? `${Number(pc) > 0 ? '+' : ''}${trim1(pc)}%`
                : null
              return (
                <span
                  key={t.metric}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${deltaChip(t.improving)}`}
                >
                  <Dir size={11} strokeWidth={2.5} />
                  <span className="font-medium">{t.metric_label}</span>
                  <Sparkline values={t.values} />
                  <span className="text-[10px] font-normal opacity-60">{t.runReads}×</span>
                  {pctTxt && <span>{pctTxt}</span>}
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ScopeNarrative({
  input,
  clientId = null,
  enabled = true,
  tone = 'agency',
  debounceMs = 400,
  className = '',
}) {
  const seqRef = useRef(0)
  // intel-v14 D1 — "since you last looked": the snapshot of the read currently on screen
  // and the scope it belongs to. On a SAME-SCOPE live refresh (a C4 push) we hand snapshotRef
  // back to the server as `since` so it can diff the fresh read against what the user was
  // looking at. Cleared on any scope change so a delta never straddles two scopes.
  const lastKeyRef  = useRef(null)
  const snapshotRef = useRef(null)
  // intel-v14 D2 — the rolling buffer of PRIOR same-scope reads (oldest→newest), each a
  // compact snapOf() snapshot. snapshotRef is the single newest read (D1's one-hop baseline);
  // historyRef is the stream the server walks for a multi-read streak. We send PRIOR reads
  // only — the server appends the just-computed read as the newest before detecting — so a
  // read is never double-counted. Cleared on any scope change so a trend never straddles
  // scopes; capped at MAX_HISTORY (the server also clamps) as a long-session memory bound.
  const historyRef  = useRef([])
  const [state, setState] = useState({ status: 'idle', data: null, error: null })

  const dr        = input && input.dateRange
  const hasWindow = !!(dr && dr.start && dr.end)
  const active    = enabled !== false && hasWindow

  // Serialise the live scope so the effect only re-fires when its CONTENT changes —
  // the parent is free to rebuild `input` inline on every render.
  const inputKey = useMemo(
    () => JSON.stringify({ input: input || null, clientId: clientId ?? null }),
    [input, clientId],
  )

  // intel-v13 C4 — live auto-refresh, the PUSH twin of C3's PULL. The effect below
  // already re-narrates when the user changes a filter/date. C4 adds: when new data
  // LANDS for the scope we're already sitting on, re-narrate on its own. The live SSE
  // `tick` is a GLOBAL broadcast with no tenant id (a tick = SOME tenant pushed), so we
  // never trust it alone. On each tick we run the CHEAP per-scope freshness probe and
  // compare its opaque version token against the last one seen FOR THIS EXACT SCOPE;
  // only a real move bumps `refreshNonce`, a dependency of the C3 effect, firing its
  // established debounced + race-guarded re-fetch. Another tenant's tick costs one cheap
  // probe and changes nothing. Leak-safe: the token carries no tenant identity and is
  // only ever compared within one fixed scope.
  const { tick } = useLiveStream({ enabled: active })
  const verRef   = useRef(null)   // last version token seen for the scope in scopeRef
  const scopeRef = useRef(null)   // the inputKey that verRef's baseline belongs to
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    if (!active) {
      setState((s) => (s.status === 'idle' && !s.data ? s : { status: 'idle', data: null, error: null }))
      return
    }
    const myId = ++seqRef.current
    // intel-v14 D1 — same scope as the last fetch (a live-data refresh) ⇒ diff the fresh
    // read against what's on screen; a NEW scope ⇒ nothing comparable, send no baseline.
    // Clearing the baseline on any scope change makes a cross-scope delta impossible
    // (fail-safe: no baseline ⇒ the server omits `delta` entirely).
    const sameScope = lastKeyRef.current === inputKey
    if (!sameScope) { snapshotRef.current = null; historyRef.current = [] }
    const since = sameScope && snapshotRef.current && snapshotRef.current.length
      ? snapshotRef.current
      : undefined
    // intel-v14 D2 — hand back the PRIOR same-scope reads as the trend stream (the server
    // appends the fresh read itself). Empty on a new scope ⇒ omitted ⇒ server attaches no trend.
    const history = sameScope && historyRef.current.length ? historyRef.current : undefined
    lastKeyRef.current = inputKey
    setState((s) => ({ status: 'loading', data: s.data, error: null }))   // keep prior cards visible while refreshing
    const ms = Number.isFinite(debounceMs) ? debounceMs : 400
    const t = setTimeout(async () => {
      try {
        const data = await api.askScopeInsight(input, clientId, since, history)
        if (myId !== seqRef.current) return                                // a newer scope superseded this one
        const snap = snapOf(data)
        snapshotRef.current = snap                                         // this read becomes the next D1 baseline
        // intel-v14 D2 — append every read (even an empty snap) so the buffer mirrors the
        // true consecutive-read cadence; a gap correctly severs a streak server-side. Keep
        // only the last MAX_HISTORY prior reads as a memory bound (the server clamps too).
        historyRef.current = [...historyRef.current, snap].slice(-MAX_HISTORY)
        setState({ status: 'ready', data, error: null })
      } catch (err) {
        if (myId !== seqRef.current) return
        setState((s) => ({ status: 'error', data: s.data, error: err }))   // surface the failure, keep stale cards
      }
    }, ms)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, active, debounceMs, refreshNonce])   // refreshNonce: C4 live-push re-narration

  // intel-v13 C4 — the per-scope freshness probe that gates the push refresh above.
  // Fires on every live tick (debounced): probe → compare to the scope's last token →
  // bump refreshNonce only on a genuine move. Resets the baseline whenever the scope
  // changes, so a new scope's first probe adopts its baseline silently (prev=null).
  useEffect(() => {
    if (scopeRef.current !== inputKey) {   // scope changed → drop the stale baseline
      scopeRef.current = inputKey
      verRef.current = null
    }
    if (!active || !tick) return undefined  // no probe until a real event has arrived
    let cancelled = false
    const ms = Number.isFinite(debounceMs) ? debounceMs : 400
    const timer = setTimeout(async () => {
      try {
        const res  = await api.scopeFreshness(input, clientId)
        if (cancelled || scopeRef.current !== inputKey) return   // superseded by a scope change
        const ver  = res && res.version
        const prev = verRef.current
        verRef.current = ver                                     // always adopt the latest as baseline
        if (api.scopeFreshness.shouldRefresh(prev, ver)) setRefreshNonce((n) => n + 1)
      } catch {
        /* a freshness probe failure is non-fatal — skip this tick, keep the baseline */
      }
    }, ms)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, inputKey, active, debounceMs])

  if (!active) return null

  const { status, data } = state
  const loading  = status === 'loading'
  const findings = data && Array.isArray(data.findings) ? data.findings : []
  const meta     = data && data.meta ? data.meta : null
  const scope    = data && data.scope ? data.scope : null
  const steady   = meta ? Number(meta.steady) || 0 : 0

  const title = tone === 'client' ? "What's happening right now" : 'Live read of this scope'
  const eyebrow = scope
    ? `${scope.windowLabel || ''}${scope.compareLabel ? ` · ${scope.compareLabel}` : ''}`
    : null

  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
            <Sparkles size={15} />
          </span>
          <div>
            <div className="text-sm font-semibold text-slate-800">{title}</div>
            {eyebrow && <div className="text-[11px] text-slate-400">{eyebrow}</div>}
          </div>
        </div>
        {loading && (
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <RefreshCw size={12} className="animate-spin" /> Updating…
          </span>
        )}
      </div>

      {/* first load, nothing to show yet → a light skeleton */}
      {loading && !data && (
        <div className="mt-3 animate-pulse space-y-2">
          <div className="h-3 w-3/4 rounded bg-slate-100" />
          <div className="h-16 rounded-xl bg-slate-100" />
          <div className="h-16 rounded-xl bg-slate-100" />
        </div>
      )}

      {/* hard error with no prior cards to fall back on */}
      {status === 'error' && !data && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] text-slate-500">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-slate-400" />
          <span>Couldn’t generate a live read for this scope just now. Adjust a filter or try again in a moment.</span>
        </div>
      )}

      {data && (
        <>
          {data.headline && (
            <p className="mt-3 text-[13px] leading-relaxed text-slate-600">{data.headline}</p>
          )}

          {data.trend && data.trend.status === 'trending' && <TrendStrip trend={data.trend} tone={tone} />}
          {data.delta && data.delta.status === 'changed' && <DeltaStrip delta={data.delta} />}

          {findings.length > 0 && (
            <div className="mt-3 space-y-2">
              {findings.map((f, i) => (
                <FindingCard key={`${f.metric || 'm'}-${i}`} f={f} />
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
            {findings.length > 0 && steady > 0 && (
              <span>{steady} {steady === 1 ? 'metric' : 'metrics'} held steady.</span>
            )}
            {status === 'error' && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertCircle size={11} /> Showing the last read — refresh didn’t go through.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
