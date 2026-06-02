import { useState, useRef, useEffect } from 'react'
import { Sparkles, Lightbulb, CornerDownLeft, CornerDownRight, Loader2, AlertTriangle, ShieldCheck, X, TrendingUp, TrendingDown, Minus, LineChart, Users, CalendarRange, Sigma, ArrowLeftRight } from 'lucide-react'
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

// intel-v6 (5): the grounded "why did it change?" breakdown. Renders ONLY what the
// server already computed and formatted (lib/contribution via runExplain) — the
// one-line narration, then the exact per-client receipts. Every figure and sign is
// read verbatim (delta_display, share_pct); the only thing this panel computes is
// cosmetic bar width. Because the arithmetic is EXACT — named contributors + others
// + unattributed sum to the true Δtotal — it carries the same "Verified" trust mark
// as the figures, never the "AI-written" one: there is no model in this path to
// hallucinate a driver.
function WhyPanel({ explain }) {
  const { narration, contributors, others, unattributed, moved, lead } = explain

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
        Each client’s share of the total change · <span className="text-emerald-600 font-semibold">drivers</span> pushed it, <span className="text-rose-500 font-semibold">drags</span> held it back
      </p>
    </div>
  )
}

function AskResult({ result, clientId, onClear, onPick }) {
  const { answer, narrated, meta, columns, rows, followups } = result
  const hasBucket    = columns.includes('bucket')
  const bucketHeader = BUCKET_HEADER[meta.group_by] || 'Item'

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

      {/* Single overall figure (group_by none), with an optional period-over-period delta */}
      {rows.length > 0 && !hasBucket && (
        <div className="mt-3 inline-flex flex-col gap-1.5 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl font-black text-slate-900 tabular-nums">{rows[0].display}</span>
            {meta.comparison && <DeltaChip comparison={meta.comparison} />}
          </div>
          <span className="text-xs text-slate-400">{meta.metric} · {meta.time_label}</span>
        </div>
      )}

      {/* intel-v6 (5): grounded "why did it change?" — offered ONLY when the server
          flagged this exact figure decomposable (meta.explainable: an UNSCOPED,
          additive single figure that moved vs its prior period). Clicking re-runs the
          SAME spec through contribution.js for an EXACT per-client breakdown — no LLM,
          so the receipts can never disagree with the figure above. A client-scoped
          ask is never flagged (there is no cross-client "who" to show), so this chip
          only appears on the agency whole-book view. */}
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

      {/* Honest empty state */}
      {rows.length === 0 && (
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
