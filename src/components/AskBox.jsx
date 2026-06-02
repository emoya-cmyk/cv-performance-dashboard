import { useState, useRef, useEffect } from 'react'
import { Sparkles, Lightbulb, CornerDownLeft, CornerDownRight, Loader2, AlertTriangle, ShieldCheck, X, TrendingUp, TrendingDown, Minus, LineChart, Users, CalendarRange, Sigma, ArrowLeftRight, Clock, Eye, ArrowUpCircle, Activity } from 'lucide-react'
import { api } from '@/lib/api'
import { weekLabel } from '@/lib/utils'

/*
 * AskBox — the front door to Sprint-2 "ask your data".
 *
 * The user types a plain-English question; POST /api/ai/ask turns it into a
 * whitelisted query-spec, runs deterministic SQL, and returns exact rows plus a
 * grounded one-line answer. This component never computes a number itself — it
 * only renders what the server already verified, so the figures here can never
 * disagree with the rest of the dashboard.
 */

const SUGGESTIONS = [
  'Top clients by revenue this month',
  'What was our ROAS last month?',
  'Revenue by week over the last 12 weeks',
  'Which client has the best close rate?',
]

const BUCKET_HEADER = { client: 'Client', week: 'Week', month: 'Month' }

// Map the server's honest failure codes to a calm, useful message. Numbers are
// never wrong here — these are config/transport/understanding problems only.
function friendlyError(err) {
  switch (err?.code) {
    case 'NO_AI':
      return {
        tone: 'info',
        title: 'Natural-language questions aren’t turned on yet',
        body: 'This feature needs an Anthropic API key. Add ANTHROPIC_API_KEY to the server environment to enable it — everything else on the dashboard keeps working without it.',
      }
    case 'UNPARSEABLE':
      return {
        tone: 'warn',
        title: 'I couldn’t map that to your data',
        body: 'Try naming a metric — revenue, leads, jobs, spend, ROAS, cost per lead, or close rate — plus an optional client or timeframe. e.g. “Top clients by revenue this month”.',
      }
    case 'PARSE_TRANSPORT':
      return {
        tone: 'warn',
        title: 'The AI service was unreachable',
        body: 'That was a temporary problem reaching the model. Give it a moment and ask again.',
      }
    default:
      return {
        tone: 'warn',
        title: 'Couldn’t answer that one',
        body: err?.message || 'Something went wrong. Please try again.',
      }
  }
}

// Cosmetic only — prettify date buckets for readability. Never touches the
// verified `display` figure, just the row label.
function prettyBucket(bucket, groupBy) {
  if (groupBy === 'week') return weekLabel(bucket)
  if (groupBy === 'month') {
    const d = new Date(`${bucket}-01T00:00:00`)
    return isNaN(d) ? bucket : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }
  return bucket
}

function Chip({ children }) {
  return (
    <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 rounded-full px-2.5 py-0.5 capitalize">
      {children}
    </span>
  )
}

// Period-over-period delta pill rendered beside a single overall figure. Reads
// ONLY meta.comparison — every number here was computed and grounded server-side
// (the baseline comes from the DB, never the model), so it can never disagree
// with the figure it sits next to. Green when the change is an improvement for
// this metric's polarity, red on a regression, neutral when flat or polarity-free
// (e.g. spend). Magnitude prefers the %; on a zero baseline (% undefined) it
// shows the absolute change instead. Tooltip names the period it's measured against.
function DeltaChip({ comparison }) {
  const { direction, improved, pct_display, delta_display, label, baseline_display } = comparison
  const flat = direction === 'flat'
  const Icon = flat ? Minus : direction === 'down' ? TrendingDown : TrendingUp
  const tone =
    improved === true  ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
    : improved === false ? 'text-rose-700 bg-rose-50 border-rose-100'
    :                      'text-slate-500 bg-slate-100 border-slate-200'
  const magnitude = flat ? 'unchanged' : (pct_display || delta_display)
  return (
    <span
      title={`vs ${label} (${baseline_display})`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold tabular-nums ${tone}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {magnitude}
    </span>
  )
}

// A single DYNAMIC opening suggestion: the headline of a metric that actually
// moved for this caller's scope (e.g. "Revenue up 23.1%"), rendered as a
// click-to-run question. It carries the SAME polarity tone as DeltaChip —
// emerald when the move is an improvement, rose on a regression, slate when the
// metric has no inherent good/bad direction (spend) — so the colour reads the
// same here as on the answer it produces. Clicking asks the canonical question
// behind the chip, which re-derives the very figure shown on it. The headline,
// %/delta and tone are all computed and grounded server-side (lib/suggest over
// the same scope-safe path as the answer) — this only renders them.
function MoverChip({ mover, onPick }) {
  const Icon = mover.direction === 'down' ? TrendingDown : mover.direction === 'up' ? TrendingUp : Minus
  const tone =
    mover.improved === true  ? 'text-emerald-700 bg-emerald-50 border-emerald-100 hover:bg-emerald-100'
    : mover.improved === false ? 'text-rose-700 bg-rose-50 border-rose-100 hover:bg-rose-100'
    :                            'text-slate-600 bg-slate-50 border-slate-200 hover:bg-slate-100'
  return (
    <button
      onClick={() => onPick(mover.question)}
      title={`${mover.headline} ${mover.subtext} — click to ask`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold tabular-nums transition ${tone}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {mover.headline}
    </button>
  )
}

// Map each follow-up's pivot dimension to a leading icon — purely navigational
// (which axis the next question moves along), never a number or a polarity. An
// unrecognised kind falls back to the same "ask" affordance as the submit button,
// mirrored to point forward.
const FOLLOWUP_ICON = {
  trend:   LineChart,       // by week / by month
  clients: Users,           // cross-client ranking
  time:    CalendarRange,   // widen the window
  total:   Sigma,           // collapse a ranking to one overall figure
  metric:  ArrowLeftRight,  // pivot to a neighbouring metric
}

// A single "Ask next" chip: one of the 2-4 parser-stable follow-up questions the
// server proposed for the answer just shown (lib/followups). The full question is
// a real spec runAsk can re-derive, so clicking simply asks it — every chip lands
// back on the SAME grounded path, so its answer will be as verified as this one.
// We show the short scannable label ("By week", "By client", "Leads") and carry
// the exact question in the tooltip; kind drives only the icon. Computes nothing.
function FollowupChip({ followup, onPick }) {
  const Icon = FOLLOWUP_ICON[followup.kind] || CornerDownRight
  return (
    <button
      onClick={() => onPick(followup.question)}
      title={followup.question}
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-600 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-600 transition"
    >
      <Icon className="w-3.5 h-3.5 shrink-0 opacity-70" />
      {followup.label}
    </button>
  )
}

// intel-v6 (5/6): the grounded "why did it change?" breakdown. Renders ONLY what the
// server already computed and formatted — the one-line narration, then the exact
// receipts. Two shapes share this one panel, told apart by explain.basis:
//   • 'client' — an ADDITIVE figure (revenue/leads/jobs/spend) split by WHO moved it
//     (lib/contribution): per-client contributors, then others + unattributed.
//   • 'driver' — a RATIO figure (roas/cpl/close_rate) split by WHICH LEVER moved it
//     (lib/ratioAttribution): numerator vs denominator. others/unattributed are null —
//     a quotient has no residual, its two signed shares sum to exactly 1.
// Every figure and sign is read verbatim (delta_display, share_pct); the only thing
// this panel computes is cosmetic bar width (normalised by |share|, so the differently
// -scaled ratio levers stay comparable). Because both decompositions are EXACT it
// carries the "Verified" trust mark, never the "AI-written" one — no model in either
// path to hallucinate a driver.
function WhyPanel({ explain }) {
  const { narration, contributors, others, unattributed, moved, lead, basis } = explain

  // Eligible but washed out: the answer said it moved, the recomputed totals agree it
  // didn't (a rare race). runExplain reports that honestly with moved:false; mirror
  // it rather than drawing an empty breakdown.
  if (!moved) return <p className="mt-2 text-sm text-slate-500 fade-in">{narration}</p>

  // A contributor's SIGNED share is its delta as a fraction of the net change, so
  // share > 0 means it pushed the figure the way the total actually went (a DRIVER)
  // and share < 0 means it pulled the other way (a DRAG) — true whether the metric
  // rose or fell, since share = delta / totalDelta folds the direction in. We colour
  // by that, never by metric polarity: this panel explains the change, not whether
  // the change is "good".
  const kind = (share) => (share > 1e-9 ? 'driver' : share < -1e-9 ? 'drag' : 'flat')
  const TONE = {
    driver: { bar: 'bg-emerald-400', text: 'text-emerald-700' },
    drag:   { bar: 'bg-rose-300',    text: 'text-rose-600' },
    flat:   { bar: 'bg-slate-200',   text: 'text-slate-400' },
  }

  // Bars normalise to the largest |share| so the biggest mover reads full-width and
  // the rest stay proportional. |share| can exceed 1 (a mover bigger than the net
  // change, offset by a counter-mover), so normalise rather than assume a 0..1 range.
  const maxAbs = Math.max(...contributors.map((c) => Math.abs(c.share)), 0) || 1
  const barW   = (share) => `${Math.max(6, Math.round((Math.abs(share) / maxAbs) * 100))}%`

  const Row = ({ label, deltaText, share, share_pct, emphasis }) => {
    const tone = TONE[kind(share)]
    return (
      <div className="flex items-center gap-2.5 py-1">
        <span className={`w-24 sm:w-28 shrink-0 truncate text-xs ${emphasis ? 'font-extrabold text-slate-800' : 'font-semibold text-slate-600'}`} title={label}>{label}</span>
        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: barW(share) }} />
        </div>
        <span className={`w-20 shrink-0 text-right text-xs font-bold tabular-nums ${tone.text}`}>{deltaText}</span>
        <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{share_pct != null ? `${share_pct}%` : ''}</span>
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-xl bg-slate-50/70 border border-slate-100 p-3.5 fade-in">
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5 mb-2">
        <ShieldCheck className="w-3 h-3" /> Exact attribution
      </span>
      <p className="text-sm font-semibold text-slate-800 leading-relaxed mb-2.5">{narration}</p>
      <div className="flex flex-col">
        {contributors.map((c) => (
          <Row key={c.key} label={c.label} deltaText={c.delta_display} share={c.share} share_pct={c.share_pct}
               emphasis={!!lead && c.key === lead.key} />
        ))}
        {others && (
          <Row label={`${others.count} other${others.count === 1 ? '' : 's'}`} deltaText={others.delta_display}
               share={others.share} share_pct={others.share_pct} />
        )}
        {unattributed && (
          <Row label="Unattributed" deltaText={unattributed.delta_display}
               share={unattributed.share} share_pct={unattributed.share_pct} />
        )}
      </div>
      <p className="mt-2.5 text-[10px] text-slate-400">
        {basis === 'driver' ? 'Each lever’s share of the move' : 'Each client’s share of the total change'} · <span className="text-emerald-600 font-semibold">drivers</span> pushed it, <span className="text-rose-500 font-semibold">drags</span> held it back
      </p>
    </div>
  )
}

// intel-v6 (7): the grounded FORWARD answer — "what WILL it be?". The Ask box now
// answers the question a sharp operator actually leads with, off the SAME self-tuning
// forecast.js the health layer already trusts (lib/forecastAnswer). This panel renders
// ONLY what the server projected — the 80% fan, the per-step figures, the trust gate —
// and never recomputes a number, so it carries the "Verified" mark, never "AI-written".
// HONEST BY CONSTRUCTION: a clean trend shows a confident headline + a solid fan; too
// little history, or a model that can't fit its own recent past, shows a muted, dashed
// "directional only" fan with the caveat — never a false-precision number. LEAK-SAFE on
// both surfaces: a single metric's weekly series is single-tenant, so one forecast answer
// is equally safe on the agency Intelligence page and on a client's /my-dashboard.
function ForecastPanel({ forecast, rows, timeLabel }) {
  // No model (no finite history) → the grounded one-line answer above already says so;
  // nothing to draw, and we don't want a misleading empty chart.
  if (!forecast || rows.length === 0) return null

  const { trustworthy, direction, confidence, current, caveat } = forecast
  const DirIcon = direction === 'down' ? TrendingDown : direction === 'up' ? TrendingUp : Minus
  const dirText = direction === 'up' ? 'Trending up' : direction === 'down' ? 'Trending down' : 'Holding steady'

  // Accent reads the trust gate FIRST, then polarity: untrustworthy → slate + a dashed
  // line, so "directional only" reads at a glance and is never dressed up as precision.
  const accent  = !trustworthy ? 'slate' : direction === 'down' ? 'rose' : direction === 'up' ? 'emerald' : 'slate'
  const HEX     = { emerald: '#10b981', rose: '#f43f5e', slate: '#94a3b8' }
  const stroke  = HEX[accent]
  const dirTone =
    accent === 'emerald' ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
    : accent === 'rose'  ? 'text-rose-700 bg-rose-50 border-rose-100'
    :                      'text-slate-600 bg-slate-100 border-slate-200'

  // ── Fan geometry. COSMETIC ONLY: every figure shown as text comes from the server's
  // display strings; only the pixel coordinates are derived here, from the raw
  // value/lo/hi the server already grounded. Anchored at step 0 = current, so the fan
  // visibly departs from "now". vector-effect keeps strokes crisp under the x/y stretch.
  const W = 320, H = 84, padX = 4, padT = 8, padB = 8
  const n   = rows.length
  const val = [current, ...rows.map((r) => r.value)]
  const lo  = [current, ...rows.map((r) => r.lo)]
  const hi  = [current, ...rows.map((r) => r.hi)]
  const yLo  = Math.min(...lo)
  const yHi  = Math.max(...hi)
  const span = (yHi - yLo) || 1
  const X = (i) => padX + (i * (W - 2 * padX)) / Math.max(1, n)
  const Y = (v) => padT + (1 - (v - yLo) / span) * (H - padT - padB)
  const lineD = val.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')
  const bandD =
    hi.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') +
    lo.map((_, i) => `L${X(n - i).toFixed(1)},${Y(lo[n - i]).toFixed(1)}`).join('') + 'Z'

  return (
    <div className="mt-3 rounded-xl bg-slate-50/70 border border-slate-100 p-3.5 fade-in">
      {/* Trust + direction chips — scannable honesty before the picture */}
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${dirTone}`}>
          <DirIcon className="w-3.5 h-3.5" /> {dirText}
        </span>
        {trustworthy && confidence != null ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-brand-100 bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-600">
            <ShieldCheck className="w-3.5 h-3.5" /> {Math.round(confidence * 100)}% model fit
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5" />
            {caveat === 'poor_fit' ? 'Too volatile — directional only' : 'Thin history — directional only'}
          </span>
        )}
      </div>

      {/* The 80% fan: shaded band + projected line, anchored at today (hollow dot) and
          ending at the headline week (filled dot). Geometry is cosmetic; the numbers
          live in the receipts table below. */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none" role="img" aria-label={`Projected ${timeLabel}`}>
        <path d={bandD} fill={stroke} fillOpacity="0.13" stroke="none" />
        <path d={lineD} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              strokeDasharray={trustworthy ? '0' : '5 3'} vectorEffect="non-scaling-stroke" />
        <circle cx={X(0)} cy={Y(current)} r="3" fill="white" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={X(n)} cy={Y(rows[n - 1].value)} r="3.5" fill={stroke} />
      </svg>
      <div className="flex justify-between text-[10px] font-semibold text-slate-400 mt-1">
        <span>now</span>
        <span>{timeLabel.replace(/^the /, '')}</span>
      </div>

      {/* Per-step receipts — every figure copied verbatim from the server's verified display. */}
      <div className="mt-2.5 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              <th className="text-left py-1">Ahead</th>
              <th className="text-right py-1">Projected</th>
              <th className="text-right py-1">80% range</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const last = r.step === n
              return (
                <tr key={r.step} className="border-t border-slate-100">
                  <td className={`py-1 ${last ? 'font-extrabold text-slate-800' : 'font-semibold text-slate-500'}`}>+{r.step} wk</td>
                  <td className={`py-1 text-right tabular-nums ${last ? 'font-extrabold text-slate-900' : 'font-bold text-slate-700'}`}>{r.display}</td>
                  <td className="py-1 text-right tabular-nums text-slate-400">{r.lo_display} – {r.hi_display}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] text-slate-400">
        Self-tuning projection — the shaded band is the 80% range, and it sharpens as each forecast is checked against what actually happens.
      </p>
    </div>
  )
}

// One grounded figure in the pacing strip — copied verbatim from the verdict's display
// string (never recomputed), so it can't disagree with the rest of the dashboard.
function PaceStat({ label, value, accent }) {
  return (
    <div className="rounded-lg bg-white border border-slate-100 px-2.5 py-1.5 text-center">
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-sm font-extrabold tabular-nums ${accent || 'text-slate-900'}`}>{value}</p>
    </div>
  )
}

const PACE_BAND = {
  ahead:    { tone: 'emerald', Icon: TrendingUp,    label: 'Pacing ahead' },
  on_track: { tone: 'brand',   Icon: ShieldCheck,   label: 'On track' },
  behind:   { tone: 'amber',   Icon: TrendingDown,  label: 'Behind pace' },
  at_risk:  { tone: 'rose',    Icon: AlertTriangle, label: 'At risk' },
  early:    { tone: 'slate',   Icon: Minus,         label: 'Too early to call' },
}
const PACE_TONE = {
  emerald: { badge: 'text-emerald-700 bg-emerald-50 border-emerald-100', bar: 'bg-emerald-400', ghost: 'bg-emerald-400/30', text: 'text-emerald-700' },
  brand:   { badge: 'text-brand-600 bg-brand-50 border-brand-100',       bar: 'bg-brand-500',   ghost: 'bg-brand-500/25',   text: 'text-brand-600' },
  amber:   { badge: 'text-amber-700 bg-amber-50 border-amber-200',       bar: 'bg-amber-400',   ghost: 'bg-amber-400/30',   text: 'text-amber-700' },
  rose:    { badge: 'text-rose-700 bg-rose-50 border-rose-100',          bar: 'bg-rose-400',    ghost: 'bg-rose-400/30',    text: 'text-rose-700' },
  slate:   { badge: 'text-slate-600 bg-slate-100 border-slate-200',      bar: 'bg-slate-300',   ghost: 'bg-slate-300/40',   text: 'text-slate-500' },
}

// intel-v6 (8): the grounded GOAL answer — "are we on track to hit our number?". The Ask
// box now answers the question an owner leads with, off the SAME pacing.js the health badge
// and the at-risk roster already trust (lib/pacingAnswer → classifyPacing). This panel
// renders ONLY what the server graded — the status band, the pace bar (where we ARE vs where
// the run-rate LANDS us against the goal line), the three figures and the day-of-month
// context — and recomputes no number, so it carries the "Verified" mark, never "AI-written".
// HONEST BY CONSTRUCTION: too little of the month gone → a muted "too early to call" state
// that reports the figures but withholds the verdict (mirrors the forecast's directional-only
// gate); the closed-month and catch-up caveats ride in the verdict, never by hiding a number.
// LEAK-SAFE on both surfaces: a single client's actual-vs-goal names no other tenant, so this
// is equally safe on the agency Intelligence page and a client's /my-dashboard — exactly like
// the per-client badge pacing.js already feeds.
function PacingPanel({ pacing }) {
  // grounded-null paths (no goal set, a non-goal metric, "which client?") carry their honest
  // sentence in the answer line above with meta.pacing:null — nothing to chart, so opt out
  // exactly like the forecast panel does on no-history (avoids an empty, misleading bar).
  if (!pacing) return null

  const band  = PACE_BAND[pacing.status] || PACE_BAND.early
  const tone  = PACE_TONE[band.tone]
  const Icon  = band.Icon
  const early = pacing.status === 'early'
  const lagging = pacing.status === 'behind' || pacing.status === 'at_risk'

  // ── Pace-bar geometry. COSMETIC ONLY: the 100%-of-goal line is pinned at GOAL_X of the
  // track, leaving headroom so an "ahead" overshoot stays visible; the solid fill is where
  // we ARE (actual/goal) and the ghosted extension is where today's run-rate LANDS us
  // (projected/goal = attainment). Widths are derived from the server's grounded raw values
  // purely for pixels — every NUMBER shown as text is the server's *_display string, which is
  // recomputed nowhere here (mirrors how WhyPanel/ForecastPanel derive only geometry).
  const GOAL_X  = 74                                  // % of track where the goal line sits
  const target  = pacing.target || 1                  // always > 0 when a verdict is shown
  const px = (v) => Math.max(0, Math.min(100, (v / target) * GOAL_X))
  const actualW    = px(pacing.actual)
  const projectedW = px(pacing.projected)             // ≥ actualW (run-rate ≥ booked-to-date)

  return (
    <div className="mt-3 rounded-xl bg-slate-50/70 border border-slate-100 p-3.5 fade-in">
      {/* Status band + attainment headline — the scannable verdict before the bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2.5">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${tone.badge}`}>
          <Icon className="w-3.5 h-3.5" /> {band.label}
        </span>
        {pacing.attainment_pct != null && (
          <span className={`text-xs font-bold tabular-nums ${tone.text}`}>
            {early ? 'tracking ' : ''}{pacing.attainment_pct}% of goal
          </span>
        )}
      </div>

      {/* The pace bar: solid = booked to date, ghosted = projected on the current run-rate;
          a dashed marker pins the 100%-of-goal line. Muted/dashed when 'early' so a month
          that has barely begun never reads as a confident call. */}
      <div className="relative h-3 rounded-full bg-slate-100 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${tone.ghost} ${early ? 'opacity-60' : ''}`} style={{ width: `${projectedW}%` }} />
        <div className={`absolute inset-y-0 left-0 ${tone.bar} ${early ? 'opacity-70' : ''}`} style={{ width: `${actualW}%` }} />
      </div>
      <div className="relative h-4 mt-0.5">
        <div className="absolute top-0 -translate-x-1/2 flex flex-col items-center" style={{ left: `${GOAL_X}%` }}>
          <div className="h-1.5 w-px bg-slate-300" />
          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">goal</span>
        </div>
      </div>

      {/* Three grounded figures — verbatim from the verdict's display strings */}
      <div className="grid grid-cols-3 gap-2 mt-2">
        <PaceStat label="Booked" value={pacing.actual_display} />
        <PaceStat label="Projected" value={pacing.projected_display} accent={tone.text} />
        <PaceStat label="Goal" value={pacing.target_display} />
      </div>

      {/* Context: where in the month we are, plus the honest caveat for this band */}
      <p className="mt-2.5 text-[11px] text-slate-500 leading-relaxed">
        Day {pacing.days_elapsed} of {pacing.days_in_month}
        {pacing.days_remaining > 0
          ? ` · ${pacing.days_remaining} ${pacing.days_remaining === 1 ? 'day' : 'days'} left`
          : ' · month closed'}
        {lagging && pacing.shortfall_display && (
          <span className={tone.text}> · {pacing.shortfall_display} short at this pace</span>
        )}
        {pacing.catchup != null && (
          <span className={`font-semibold ${tone.text}`}> · need ~{pacing.catchup}× the current pace to still hit it</span>
        )}
      </p>

      <p className="mt-2 text-[10px] text-slate-400">
        Run-rate pacing — the solid bar is booked so far, the lighter bar is where today’s pace lands you by month-end against the goal line.
      </p>
    </div>
  )
}

// intel-v6 (9c/9d): the grounded PRESCRIBE answer — "so what should I DO about it?". This is the
// question that ties the whole Ask box together: the past, the who, the why, the future and the
// goal all exist to inform the next action. It renders ONLY the already-decorated, already-ranked
// client feed the server hands back (lib/adviceAnswer over getInsightFeed) — each card's urgency,
// title, action text and efficacy note are copied verbatim from the verdict, recomputed nowhere
// here, so it carries no "AI-written" chip: there is no model in this path to hallucinate a step.
// HONEST BY CONSTRUCTION: an all-clear, a "which client?", or a not-found verdict carries its
// sentence in the answer line above with meta.advice:null — nothing to list, so this panel returns
// null then (exactly like Forecast/Pacing opt out on no-data). LEAK-SAFE on both surfaces: the feed
// is one client's own findings, so the to-do list names no other tenant and is equally safe on the
// agency Intelligence page and a client's /my-dashboard — the only audience difference (escalated
// wording) was already resolved server-side, so this component is byte-identical for both.
const ADVICE_URGENCY = {
  act_now: { tone: 'rose',  Icon: AlertTriangle, label: 'Act now' },
  plan:    { tone: 'amber', Icon: Clock,         label: 'Plan' },
  monitor: { tone: 'slate', Icon: Eye,           label: 'Monitor' },
}
const ADVICE_TONE = {
  rose:  { badge: 'text-rose-700 bg-rose-50 border-rose-100',     accent: 'border-l-rose-300' },
  amber: { badge: 'text-amber-700 bg-amber-50 border-amber-200',  accent: 'border-l-amber-300' },
  slate: { badge: 'text-slate-600 bg-slate-100 border-slate-200', accent: 'border-l-slate-200' },
}
const ADVICE_EFF_BAND = { high: 'text-emerald-600', medium: 'text-slate-500', low: 'text-amber-600' }

// The "what should I do?" to-do list. Renders the server's ranked, decorated feed verbatim:
// one card per recommended action, urgency-coded by a left rail + chip, with the play's own
// learned track-record note when present. Computes nothing — every word and figure is the
// server's (mirrors how WhyPanel/ForecastPanel/PacingPanel render only what was grounded).
function AdvicePanel({ advice }) {
  // grounded-null paths (all-clear / "which client?" / not-found) carry their honest sentence in
  // the answer line above with meta.advice:null — nothing to list, so opt out exactly like the
  // forecast/pacing panels do on no-data (avoids an empty, misleading card).
  if (!advice || !Array.isArray(advice.actions) || advice.actions.length === 0) return null
  // An escalated play reads differently by audience and the server already picked the wording; the
  // badge just LABELS that a play changed tack — "New approach" for a client (no failure framing),
  // "Escalated" for the agency. Either way the action text below is the server's verbatim choice.
  const escalatedLabel = advice.audience === 'client' ? 'New approach' : 'Escalated'
  return (
    <div className="mt-3 rounded-xl bg-slate-50/70 border border-slate-100 p-3.5 fade-in">
      <div className="flex flex-col gap-2">
        {advice.actions.map((a) => {
          const band = ADVICE_URGENCY[a.urgency] || ADVICE_URGENCY.monitor
          const tone = ADVICE_TONE[band.tone]
          const Icon = band.Icon
          const note = a.efficacy_note
          return (
            <div key={a.id} className={`rounded-lg bg-white border border-slate-100 border-l-4 ${tone.accent} p-3`}>
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone.badge}`}>
                  <Icon className="w-3 h-3" /> {band.label}
                </span>
                {a.escalated && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-600">
                    <ArrowUpCircle className="w-3 h-3" /> {escalatedLabel}
                  </span>
                )}
                {a.title && <span className="text-[11px] font-semibold text-slate-400 truncate">{a.title}</span>}
              </div>
              <p className="text-sm font-semibold text-slate-800 leading-relaxed">{a.action}</p>
              {note && note.text && (
                <p className={`mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium ${ADVICE_EFF_BAND[note.band] || 'text-slate-500'}`}>
                  <Activity className="w-3 h-3 shrink-0" /> {note.text}
                </p>
              )}
            </div>
          )
        })}
      </div>
      {advice.total > advice.count && (
        <p className="mt-2.5 text-[11px] text-slate-400">
          Showing the {advice.count} sharpest of {advice.total} open {advice.total === 1 ? 'item' : 'items'}.
        </p>
      )}
      <p className="mt-2 text-[10px] text-slate-400">
        Pulled straight from this client’s open findings, sharpest first — each step and its track record come from the system’s own results, not AI guesswork.
      </p>
    </div>
  )
}

function AskResult({ result, clientId, onClear, onPick }) {
  const { answer, narrated, meta, columns, rows, followups } = result
  const hasBucket    = columns.includes('bucket')
  const bucketHeader = BUCKET_HEADER[meta.group_by] || 'Item'
  // intel-v6 (7): a forward FORECAST answer rides the standard envelope but carries a
  // step→value projection (columns ['step','value','lo','hi'], meta.forecast set) instead
  // of a bucket breakdown or a single past figure. Detect it so it renders as a fan + band
  // (ForecastPanel) instead of falling through to the single-overall-figure branch below.
  const isForecast   = columns.includes('step')
  // intel-v6 (8): a goal-PACING answer ("are we on track?") rides the standard envelope but
  // carries the three-row actual/projected/goal verdict (columns ['label','value'], with
  // meta.pacing set when a verdict is shown, null on the honest "no goal to pace" paths).
  // 'label' is unique to pacing — single-figure is ['value'], bucket ['bucket',…], forecast
  // ['step',…] — so this is the clean parallel detector to isForecast. Like forecast, it must
  // be carved OUT of the single-figure branch (a 3-row verdict would misread as one big
  // number) and out of the empty state (a grounded-null verdict already says its piece in the
  // answer line), then rendered as the PacingPanel below.
  const isPacing     = columns.includes('label')
  // intel-v6 (9c/9d): a PRESCRIBE answer ("what should I do?") rides the standard envelope but
  // carries a ranked to-do list (columns ['action'], meta.advice set when actionable, null on the
  // honest all-clear / "which client?" / not-found paths). 'action' is unique to advice — single
  // -figure is ['value'], bucket ['bucket',…], forecast ['step',…], pacing ['label',…] — so this is
  // the clean parallel detector. Like forecast/pacing it must be carved OUT of the single-figure
  // branch (advice rows carry a `display`, which would misread as one big number) and out of the
  // empty state (a grounded-null verdict already says its piece in the answer line), then rendered
  // as the AdvicePanel below.
  const isAdvice     = columns.includes('action')

  // intel-v6 (5): the on-demand "why did it change?" sub-flow — its own little state
  // machine (idle → loading → done | error) so the breakdown loads inline under the
  // figure without disturbing the answer above. Reset whenever a NEW answer arrives so
  // a prior breakdown never bleeds onto the next question (the parent also remounts us
  // through its loading state, but this keeps the per-answer invariant explicit).
  const [whyStatus, setWhyStatus] = useState('idle')
  const [why, setWhy]             = useState(null)
  const [whyErr, setWhyErr]       = useState(null)
  useEffect(() => { setWhyStatus('idle'); setWhy(null); setWhyErr(null) }, [result])

  async function runWhy() {
    if (whyStatus === 'loading') return
    setWhyStatus('loading'); setWhyErr(null)
    try {
      // Re-run the SAME spec the answer carried; the server scopes it by token and
      // returns the exact per-client contributions (api.askExplain → POST /ask/explain).
      const r = await api.askExplain(result.spec, clientId)
      setWhy(r); setWhyStatus('done')
    } catch (err) {
      setWhyErr(friendlyError(err))
      setWhyStatus('error')
    }
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-4 fade-in">
      {/* Context chips · trust signals · clear */}
      <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Chip>{meta.metric}</Chip>
          {meta.group_by !== 'none' && <Chip>by {meta.group_by}</Chip>}
          <Chip>{meta.time_label}</Chip>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5">
            <ShieldCheck className="w-3 h-3" /> Verified figures
          </span>
          {narrated && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-indigo-600 bg-indigo-50 rounded-full px-2 py-0.5">
              <Sparkles className="w-3 h-3" /> AI-written
            </span>
          )}
          <button onClick={onClear} title="Clear" className="text-slate-300 hover:text-slate-500 transition">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* The grounded one-line answer */}
      <p className="text-base font-semibold text-slate-800 leading-relaxed">{answer}</p>

      {/* Deterministic breakdown table (client / week / month) */}
      {rows.length > 0 && hasBucket && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50/70 border-b border-slate-100">
                <th className="text-left px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400">{bucketHeader}</th>
                <th className="text-right px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400">{meta.metric}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.bucket}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                  <td className="px-4 py-2.5 font-semibold text-slate-700">{prettyBucket(r.bucket, meta.group_by)}</td>
                  <td className="px-4 py-2.5 text-right font-bold text-slate-900 tabular-nums">{r.display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Single overall figure (group_by none), with an optional period-over-period delta.
          A forecast also has no bucket, so it's excluded here (!isForecast) and rendered as
          the projection fan below — otherwise it would misread as one big step-1 number. A
          pacing verdict is likewise no-bucket but 3-row, so it's excluded (!isPacing) and
          drawn as the pace bar below rather than collapsing to its first row's $figure. */}
      {rows.length > 0 && !hasBucket && !isForecast && !isPacing && !isAdvice && (
        <div className="mt-3 inline-flex flex-col gap-1.5 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl font-black text-slate-900 tabular-nums">{rows[0].display}</span>
            {meta.comparison && <DeltaChip comparison={meta.comparison} />}
          </div>
          <span className="text-xs text-slate-400">{meta.metric} · {meta.time_label}</span>
        </div>
      )}

      {/* Forward FORECAST — the projection fan + per-step receipts + honest trust gate.
          Same envelope, same shared component on agency Intelligence and client /my-dashboard. */}
      {isForecast && <ForecastPanel forecast={meta.forecast} rows={rows} timeLabel={meta.time_label} />}

      {/* Goal PACING — "are we on track?": the status band + pace bar + the three grounded
          figures + month-context. meta.pacing is null on the honest "no goal to pace" paths
          (the answer line above carries that sentence), so PacingPanel renders nothing then.
          Shared, so it's identical on the agency Intelligence page and a client /my-dashboard
          — a single client's actual-vs-goal names no other tenant, so it's leak-safe on both. */}
      {isPacing && <PacingPanel pacing={meta.pacing} />}

      {/* PRESCRIBE — "what should I do?": the grounded, ranked to-do list. meta.advice is null on
          the honest all-clear / "which client?" / not-found paths (the answer line above carries
          that sentence), so AdvicePanel renders nothing then. Shared, so it's identical on the
          agency Intelligence page and a client /my-dashboard — one client's own feed names no other
          tenant, and the only audience difference (escalated wording) was resolved server-side, so
          it's leak-safe on both. */}
      {isAdvice && <AdvicePanel advice={meta.advice} />}

      {/* intel-v6 (5)+(6): grounded "why did it change?" — offered ONLY when the server
          flagged this exact figure decomposable (meta.explainable: a single figure that
          moved vs its prior period AND is decomposable). Clicking re-runs the SAME spec
          server-side for an EXACT breakdown — no LLM, so the receipts can never disagree
          with the figure above. Two shapes qualify: a WHOLE-BOOK additive figure → the
          by-client "who" split (contribution.js); OR a RATIO (roas/cpl/close_rate) on
          ANY view incl. a single client → the numerator-vs-denominator "which lever"
          split (ratioAttribution.js), valid for one client via its own levers. So this
          chip now lights up on /my-dashboard too — but only ever for a ratio there (a
          client-scoped additive has no cross-client "who", so it stays unflagged). */}
      {meta.explainable && (
        <div className="mt-3">
          {(whyStatus === 'idle' || whyStatus === 'loading') && (
            <button
              onClick={runWhy}
              disabled={whyStatus === 'loading'}
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-60 transition"
            >
              {whyStatus === 'loading'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Lightbulb className="w-3.5 h-3.5" />}
              {whyStatus === 'loading' ? 'Breaking it down…' : 'Why did it change?'}
            </button>
          )}
          {whyStatus === 'error' && (
            <p className="text-xs text-amber-700">
              {whyErr?.body || 'Couldn’t break that down right now.'}{' '}
              <button onClick={runWhy} className="font-semibold underline hover:no-underline">Try again</button>
            </p>
          )}
          {whyStatus === 'done' && why && <WhyPanel explain={why} />}
        </div>
      )}

      {/* Honest empty state — a no-history forecast, and a "no goal to pace against" pacing
          verdict, each carry their own grounded message in the answer line above, so both opt
          out here (!isForecast && !isPacing) to avoid double-rendering "no data". */}
      {rows.length === 0 && !isForecast && !isPacing && !isAdvice && (
        <p className="mt-2 text-xs text-slate-400">No matching data for that question and timeframe.</p>
      )}

      {/* intel-v6 (4): turn this answer into a branch point. The server proposed
          these parser-stable next questions (lib/followups) for the spec it just
          answered; each chip re-runs through the SAME grounded path, so a click is
          just another verified answer — never a dead end at a single number. Hidden
          when none were proposed (e.g. an unknown metric) so it never renders empty. */}
      {Array.isArray(followups) && followups.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-50">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Ask next</p>
          <div className="flex flex-wrap gap-1.5">
            {followups.map((f) => <FollowupChip key={f.question} followup={f} onPick={onPick} />)}
          </div>
        </div>
      )}
    </div>
  )
}

/*
 * Props (all optional; defaults reproduce the original agency surface verbatim):
 *   clientId    — when set, narrows the ask to one client. Passed straight to
 *                 api.ask; the server only honours it for an agency token and
 *                 hard-pins a client token to its own data regardless, so the
 *                 client surface can pass its own id without ever widening access.
 *   title/subtitle/placeholder/suggestions — surface-specific copy. The client
 *                 surface uses "my/our" phrasing and drops cross-client prompts.
 */
export default function AskBox({
  clientId,
  title       = 'Ask your data',
  subtitle    = 'Plain-English questions across every client — answered with exact, verified numbers',
  placeholder = 'e.g. Which client had the highest revenue last month?',
  suggestions = SUGGESTIONS,
} = {}) {
  const [question, setQuestion] = useState('')
  const [status, setStatus]     = useState('idle')   // idle | loading | done | error
  const [result, setResult]     = useState(null)
  const [error, setError]       = useState(null)
  const [movers, setMovers]     = useState(null)   // null = loading/unknown · [] = none · [chips]
  const inputRef = useRef(null)

  // Dynamic opening chips: the biggest period-over-period movers for this
  // caller's scope. Fetched once per clientId — pure DB aggregation, no LLM, so
  // it works even without an Anthropic key, and the route soft-degrades to an
  // empty list on any fault. While null (loading) or empty (none/degraded) the
  // box falls back to its static suggestions, so first paint is never blank.
  useEffect(() => {
    let alive = true
    api.askSuggestions(clientId)
      .then((r) => { if (alive) setMovers(Array.isArray(r?.suggestions) ? r.suggestions : []) })
      .catch(()  => { if (alive) setMovers([]) })
    return () => { alive = false }
  }, [clientId])

  async function run(q) {
    const text = (q ?? question).trim()
    if (!text || status === 'loading') return
    setQuestion(text)
    setStatus('loading')
    setError(null)
    try {
      const res = await api.ask(text, clientId)
      setResult(res)
      setStatus('done')
    } catch (err) {
      setError(friendlyError(err))
      setResult(null)
      setStatus('error')
    }
  }

  function reset() {
    setQuestion('')
    setResult(null)
    setError(null)
    setStatus('idle')
    inputRef.current?.focus()
  }

  const busy = status === 'loading'

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-brand-500" />
        </div>
        <div className="leading-tight">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{title}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
        </div>
      </div>

      {/* Input row */}
      <form onSubmit={(e) => { e.preventDefault(); run() }} className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
          className="flex-1 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 disabled:opacity-60 transition"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CornerDownLeft className="w-4 h-4" />}
          {busy ? 'Reading…' : 'Ask'}
        </button>
      </form>

      {/* Opening suggestions — discoverability, only before the first answer.
          When we have live MOVERS for this scope, show those (each titled by
          what actually changed and click-to-run); otherwise fall back to the
          static prompts while they load, or if there are none / it degraded. */}
      {status === 'idle' && (
        movers && movers.length > 0 ? (
          <div className="mt-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
              Worth asking right now
              {movers[0]?.subtext && (
                <span className="font-semibold text-slate-300 normal-case tracking-normal"> · {movers[0].subtext}</span>
              )}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {movers.map((m) => <MoverChip key={m.metric} mover={m} onPick={run} />)}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => run(s)}
                className="text-[11px] font-medium text-slate-500 bg-slate-50 hover:bg-brand-50 hover:text-brand-600 border border-slate-100 rounded-full px-3 py-1 transition"
              >
                {s}
              </button>
            ))}
          </div>
        )
      )}

      {/* Loading echo */}
      {busy && (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin text-brand-500" />
          <span>Computing exact figures for “<span className="text-slate-600">{question}</span>”…</span>
        </div>
      )}

      {/* Error / config state */}
      {status === 'error' && error && (
        <div className={`mt-4 rounded-xl border p-4 fade-in ${error.tone === 'info' ? 'bg-blue-50/60 border-blue-100' : 'bg-amber-50/60 border-amber-100'}`}>
          <div className="flex items-start gap-2.5">
            <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${error.tone === 'info' ? 'text-blue-500' : 'text-amber-500'}`} />
            <div>
              <p className={`text-sm font-bold ${error.tone === 'info' ? 'text-blue-800' : 'text-amber-800'}`}>{error.title}</p>
              <p className={`text-xs mt-1 leading-relaxed ${error.tone === 'info' ? 'text-blue-600' : 'text-amber-700'}`}>{error.body}</p>
            </div>
          </div>
        </div>
      )}

      {/* Result */}
      {status === 'done' && result && <AskResult result={result} clientId={clientId} onClear={reset} onPick={run} />}
    </div>
  )
}
