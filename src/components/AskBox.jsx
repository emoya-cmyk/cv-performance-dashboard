import { useState, useRef } from 'react'
import { Sparkles, CornerDownLeft, Loader2, AlertTriangle, ShieldCheck, X } from 'lucide-react'
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

function AskResult({ result, onClear }) {
  const { answer, narrated, meta, columns, rows } = result
  const hasBucket    = columns.includes('bucket')
  const bucketHeader = BUCKET_HEADER[meta.group_by] || 'Item'

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

      {/* Single overall figure (group_by none) */}
      {rows.length > 0 && !hasBucket && (
        <div className="mt-3 inline-flex items-baseline gap-2 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
          <span className="text-2xl font-black text-slate-900 tabular-nums">{rows[0].display}</span>
          <span className="text-xs text-slate-400">{meta.metric} · {meta.time_label}</span>
        </div>
      )}

      {/* Honest empty state */}
      {rows.length === 0 && (
        <p className="mt-2 text-xs text-slate-400">No matching data for that question and timeframe.</p>
      )}
    </div>
  )
}

export default function AskBox() {
  const [question, setQuestion] = useState('')
  const [status, setStatus]     = useState('idle')   // idle | loading | done | error
  const [result, setResult]     = useState(null)
  const [error, setError]       = useState(null)
  const inputRef = useRef(null)

  async function run(q) {
    const text = (q ?? question).trim()
    if (!text || status === 'loading') return
    setQuestion(text)
    setStatus('loading')
    setError(null)
    try {
      const res = await api.ask(text)
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
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Ask your data</p>
          <p className="text-[11px] text-slate-400 mt-0.5">Plain-English questions across every client — answered with exact, verified numbers</p>
        </div>
      </div>

      {/* Input row */}
      <form onSubmit={(e) => { e.preventDefault(); run() }} className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Which client had the highest revenue last month?"
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

      {/* Suggestion chips — discoverability, only before the first answer */}
      {status === 'idle' && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => run(s)}
              className="text-[11px] font-medium text-slate-500 bg-slate-50 hover:bg-brand-50 hover:text-brand-600 border border-slate-100 rounded-full px-3 py-1 transition"
            >
              {s}
            </button>
          ))}
        </div>
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
      {status === 'done' && result && <AskResult result={result} onClear={reset} />}
    </div>
  )
}
