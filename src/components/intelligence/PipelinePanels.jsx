import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2, Clock, AlertTriangle, ShieldAlert, Plug, Minus, Wrench,
  Users, Check, RotateCcw, Loader2, RefreshCw, Inbox,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/insightMeta'

/* ── status tone map ─────────────────────────────────────────────────────────── */
const PIPELINE_STATUS_TONE = {
  HEALTHY:      { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-700', label: 'Healthy',         Icon: CheckCircle2 },
  STALE:        { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   chip: 'bg-amber-100 text-amber-700',     label: 'Stale',           Icon: Clock },
  ERRORING:     { pill: 'border-orange-200 bg-orange-50 text-orange-700',    dot: 'bg-orange-500',  chip: 'bg-orange-100 text-orange-700',   label: 'Erroring',        Icon: AlertTriangle },
  AUTH_EXPIRED: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    chip: 'bg-rose-100 text-rose-700',       label: 'Sign-in expired', Icon: ShieldAlert },
  NEVER_SYNCED: { pill: 'border-violet-200 bg-violet-50 text-violet-700',    dot: 'bg-violet-500',  chip: 'bg-violet-100 text-violet-700',   label: 'Never synced',    Icon: Plug },
  DISABLED:     { pill: 'border-slate-200 bg-slate-100 text-slate-500',      dot: 'bg-slate-300',   chip: 'bg-slate-100 text-slate-500',     label: 'Disabled',        Icon: Minus },
}

const PIPELINE_COUNT_ORDER = ['HEALTHY', 'STALE', 'ERRORING', 'AUTH_EXPIRED', 'NEVER_SYNCED', 'DISABLED']

function pipelineEta(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const secs = (t - Date.now()) / 1000
  if (secs <= 30) return 'due now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `in ${Math.max(1, mins)}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `in ${hrs}h`
  return `in ${Math.round(hrs / 24)}d`
}

/* ── banner ──────────────────────────────────────────────────────────────────── */
function PipelineHealthBanner({ summary }) {
  if (!summary) return null
  const opReq = summary.operator_required || 0
  const attn  = summary.needs_attention   || 0
  if (opReq === 0 && attn === 0) return null

  const reconnect = opReq > 0
  const t = reconnect
    ? { wrap: 'border-rose-200 bg-rose-50',  icon: 'text-rose-500',  kicker: 'text-rose-600',  head: 'text-rose-900',  body: 'text-rose-800/80',  Icon: ShieldAlert, label: 'Action needed · reconnect' }
    : { wrap: 'border-amber-200 bg-amber-50', icon: 'text-amber-500', kicker: 'text-amber-600', head: 'text-amber-900', body: 'text-amber-800/80', Icon: Wrench,      label: 'Self-healing · no action needed' }

  const head = reconnect
    ? `${opReq} ${opReq === 1 ? 'feed needs' : 'feeds need'} a human reconnect`
    : `${attn} ${attn === 1 ? 'feed is healing' : 'feeds are healing'} automatically`
  const detail = reconnect
    ? 'Their sign-in expired, so auto-sync is paused until someone re-authorizes — the one fault the system will never retry on its own. Use the Reconnect button on each feed below.'
    : 'The watchdog is already re-syncing them on a deterministic backoff — stale data refreshes and transient errors retry without anyone stepping in. Nothing to do but watch.'
  const alsoHealing = reconnect && attn > opReq

  return (
    <div className={cn('mb-4 rounded-xl border px-3.5 py-3', t.wrap)} role="alert">
      <div className="flex items-start gap-2.5">
        <t.Icon className={cn('w-4 h-4 mt-0.5 shrink-0', t.icon)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[10px] font-black uppercase tracking-wider', t.kicker)}>
            Pipeline watchdog · {t.label}
          </p>
          <p className={cn('mt-0.5 text-[13px] font-bold leading-snug', t.head)}>{head}</p>
          <p className={cn('mt-1 text-[11px] font-medium leading-snug', t.body)}>{detail}</p>
          {alsoHealing && (
            <p className={cn('mt-1.5 text-[10px] font-semibold leading-snug', t.body)}>
              The other {attn - opReq} degraded {attn - opReq === 1 ? 'feed is' : 'feeds are'} already self-healing — no action needed there.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── connection row ──────────────────────────────────────────────────────────── */
function PipelineConnRow({ conn, names }) {
  const tone  = PIPELINE_STATUS_TONE[conn.status] || PIPELINE_STATUS_TONE.DISABLED
  const Icon  = tone.Icon
  const cname = names[String(conn.client_id)] || (conn.client_id != null ? `Client ${conn.client_id}` : 'Unknown client')
  const rec   = conn.recovery || {}
  const opReq = !!conn.operator_required
  const eta   = pipelineEta(rec.next_attempt_at)
  const lastOk = conn.last_success_at ? timeAgo(conn.last_success_at) : ''

  return (
    <div className={cn('rounded-xl border px-3 py-2.5', opReq ? 'border-rose-200 bg-rose-50/40' : conn.needs_attention ? 'border-amber-200 bg-amber-50/30' : 'border-slate-100 bg-white')}>
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center shrink-0', tone.chip)}>
          <Icon className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-black text-slate-900">{conn.label || conn.channel}</span>
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500">
              <Users className="w-3 h-3" /> {cname}
            </span>
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide', tone.pill)}>
              <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
            </span>
          </div>
          {conn.narration && <p className="mt-1 text-[12px] font-medium text-slate-600 leading-snug">{conn.narration}</p>}
          <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
            {lastOk && <span className="inline-flex items-center gap-1"><Check className="w-2.5 h-2.5" /> last ok {lastOk}</span>}
            {conn.failures > 0 && (
              <span className="inline-flex items-center gap-1 text-slate-500">
                <AlertTriangle className="w-2.5 h-2.5" /> {conn.failures} {conn.failures === 1 ? 'failure' : 'failures'}
              </span>
            )}
            {!opReq && rec.retryable && eta && (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <RotateCcw className="w-2.5 h-2.5" /> auto-retry {eta}{rec.exhausted ? ' · slow cadence' : ''}
              </span>
            )}
          </div>
        </div>
        {opReq && (
          <a
            href={`/connections?client=${encodeURIComponent(conn.client_id)}`}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-[11px] font-black text-rose-700 hover:bg-rose-50 transition"
            title={`Reconnect ${conn.label || conn.channel} for ${cname}`}
          >
            <Plug className="w-3.5 h-3.5" /> Reconnect
          </a>
        )}
      </div>
    </div>
  )
}

/* ── main panel ──────────────────────────────────────────────────────────────── */
export function PipelineHealthPanel() {
  const [status, setStatus] = useState('loading')
  const [data, setData]     = useState(null)
  const [names, setNames]   = useState({})
  const [error, setError]   = useState('')

  const fetchPipeline = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const [health, clients] = await Promise.all([
        api.getConnectionHealth(),
        api.clients().catch(() => []),
      ])
      const map = {}
      for (const c of (clients || [])) if (c && c.id != null) map[String(c.id)] = c.name
      setNames(map); setData(health); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load pipeline health'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchPipeline() }, [fetchPipeline])

  const s        = data?.summary || null
  const worst    = s?.worst_status || null
  const worstTone = worst ? (PIPELINE_STATUS_TONE[worst] || null) : null
  const conns    = Array.isArray(data?.connections) ? data.connections : []
  const roster   = conns.filter(c => c && c.status !== 'HEALTHY')
  const ROSTER_CAP = 12
  const shown    = roster.slice(0, ROSTER_CAP)
  const overflow = roster.length - shown.length
  const healthyN = s?.counts?.HEALTHY || 0
  const allOk    = !!(s && s.ok && roster.length === 0)
  const nextWake = pipelineEta(s?.next_wake_at)
  const checked  = data?.as_of ? timeAgo(data.as_of) : ''

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Plug className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Pipeline health</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Live sync status across every client feed · self-healing watchdog
          </p>
        </div>
        {status === 'done' && s && worstTone && (
          <span
            className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', allOk ? PIPELINE_STATUS_TONE.HEALTHY.pill : worstTone.pill)}
            title={`Worst connection state: ${worst}`}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', allOk ? PIPELINE_STATUS_TONE.HEALTHY.dot : worstTone.dot)} />
            {allOk ? 'All healthy' : worstTone.label}
          </span>
        )}
        {status === 'done' && s && s.self_healing > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700"
            title="Connections the watchdog is auto-recovering right now, no operator involved"
          >
            <Wrench className="w-3 h-3" /> {s.self_healing} self-healing
          </span>
        )}
        <button
          onClick={fetchPipeline}
          disabled={status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'done' && s && <PipelineHealthBanner summary={s} />}

        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking every connection…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load pipeline health'}</p>
            <button onClick={fetchPipeline} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (!s || s.total === 0) && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" /> No connections yet — this fills in as clients link their data sources.
          </div>
        )}

        {status === 'done' && s && s.total > 0 && (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              {PIPELINE_COUNT_ORDER.filter(k => (s.counts?.[k] || 0) > 0).map(k => {
                const tone = PIPELINE_STATUS_TONE[k]
                return (
                  <span key={k} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-bold', tone.pill)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} />
                    <span className="tabular-nums">{s.counts[k]}</span> {tone.label}
                  </span>
                )
              })}
            </div>

            {(s.self_healing > 0 || s.exhausted > 0) && (
              <div className="mt-2.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
                {s.self_healing > 0 && <span className="inline-flex items-center gap-1 text-emerald-600"><Wrench className="w-2.5 h-2.5" /> {s.self_healing} auto-recovering</span>}
                {s.exhausted > 0 && <span className="inline-flex items-center gap-1 text-slate-500"><Clock className="w-2.5 h-2.5" /> {s.exhausted} on slow retry</span>}
                {nextWake && s.self_healing > 0 && <span className="inline-flex items-center gap-1"><RotateCcw className="w-2.5 h-2.5" /> next attempt {nextWake}</span>}
              </div>
            )}

            {allOk ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/40 px-3 py-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-[12px] font-semibold text-emerald-800">
                  All {s.total} {s.total === 1 ? 'feed is' : 'feeds are'} healthy and syncing on schedule — nothing needs attention.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {shown.map((c, i) => <PipelineConnRow key={`${c.client_id}:${c.channel}:${i}`} conn={c} names={names} />)}
                {overflow > 0 && (
                  <p className="text-[11px] font-semibold text-slate-400 pl-1">+ {overflow} more {overflow === 1 ? 'connection' : 'connections'} needing attention</p>
                )}
                {healthyN > 0 && (
                  <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 pl-1">
                    <CheckCircle2 className="w-3 h-3" /> {healthyN} other {healthyN === 1 ? 'feed' : 'feeds'} healthy and syncing
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The watchdog self-heals what it safely can — stale feeds resync, transient errors retry on a backoff that plateaus but never gives up. The one thing it never touches is an expired sign-in: a revoked credential is surfaced here for a human{' '}
          <span className="font-semibold text-slate-500">Reconnect</span>, never retried against a dead token.
          {checked ? ` Checked ${checked}.` : ''} Agency-only.
        </p>
      </div>
    </section>
  )
}
