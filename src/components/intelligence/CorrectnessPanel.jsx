import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck, CheckCircle2, AlertTriangle, Loader2, RefreshCw, Inbox } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isAgency } from '@/lib/auth'

// ── Write-Verification Correctness panel (Spec A) ───────────────────────────
// Read-only, agency-only. Surfaces the persistence-vs-correctness split per
// (tenant, endpoint): the share of writes proven VERIFIED_CORRECT vs. merely
// persisted (or persisted-but-wrong), with the Wilson lower bound the promotion
// gate WILL read. It is reporting-only today — nothing here gates autonomy yet.

// outcome → display tone (matches the panel palette used across Intelligence).
const OUTCOME_TONE = {
  verified_correct:     { label: 'Verified',   dot: 'bg-emerald-500', text: 'text-emerald-700' },
  persisted_incorrect:  { label: 'Wrong',      dot: 'bg-rose-500',    text: 'text-rose-700' },
  persisted_unverified: { label: 'Unverified', dot: 'bg-amber-500',   text: 'text-amber-700' },
  failed:               { label: 'Failed',     dot: 'bg-slate-400',   text: 'text-slate-500' },
}

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`

function CorrectnessRow({ row }) {
  const total = Number(row.total) || 0
  const segs = ['verified_correct', 'persisted_incorrect', 'persisted_unverified', 'failed']
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-3 py-2.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[13px] font-black text-slate-900">{row.endpoint}</span>
        <span className="text-[10px] font-semibold text-slate-400">· {row.tenant_id}</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
          {pct(row.verified_rate)} correct
        </span>
      </div>

      {/* proportion bar across the four outcomes */}
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        {segs.map((k) => {
          const n = Number(row[k]) || 0
          if (!total || !n) return null
          return <span key={k} className={cn('h-full', OUTCOME_TONE[k].dot)} style={{ width: `${(n / total) * 100}%` }} />
        })}
      </div>

      <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold">
        {segs.map((k) => (
          <span key={k} className={cn('inline-flex items-center gap-1', OUTCOME_TONE[k].text)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', OUTCOME_TONE[k].dot)} />
            {OUTCOME_TONE[k].label} {Number(row[k]) || 0}
          </span>
        ))}
        <span className="text-slate-400">· Wilson&nbsp;LB {pct(row.wilson_lower)} · n={total}</span>
      </div>
    </div>
  )
}

export function CorrectnessPanel() {
  const [status, setStatus] = useState('loading')
  const [rows, setRows]     = useState([])
  const [error, setError]   = useState('')

  const fetchCorrectness = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const res = await api.getCorrectnessStats()
      setRows(Array.isArray(res?.endpoints) ? res.endpoints : [])
      setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load write-correctness'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchCorrectness() }, [fetchCorrectness])

  // Agency-only surface; the endpoint also 403s a client token.
  if (!isAgency()) return null

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Write correctness</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Persistence vs. correctness per vendor endpoint · feeds promotion (not yet gating)
          </p>
        </div>
        <button
          onClick={fetchCorrectness}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the correctness ledger…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error}</p>
            <button onClick={fetchCorrectness} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && rows.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" /> No verified writes recorded yet — the loop is waiting on its first read-backs.
          </div>
        )}

        {status === 'done' && rows.length > 0 && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              Promotion reads VERIFIED_CORRECT / total — a persisted write is not yet a correct one.
            </p>
            {rows.map((row) => <CorrectnessRow key={`${row.tenant_id}::${row.endpoint}`} row={row} />)}
          </div>
        )}
      </div>
    </section>
  )
}
