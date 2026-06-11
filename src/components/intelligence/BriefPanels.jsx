import { useState, useEffect, useCallback } from 'react'
import {
  Brain, ShieldCheck, AlertTriangle, Gauge, Loader2, RefreshCw, Radar,
  AlertOctagon, Wrench, Inbox, Crosshair, Clock, ThumbsUp, ArrowUpCircle,
  TrendingDown, SlidersHorizontal, Sparkles, Scissors, Minus, RotateCcw,
  Scale, ArrowRight, Activity, CheckCircle2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── laneLabel — exported; imported by LeadPolicyPanels ──────────────────────
export function laneLabel(key) {
  const s = String(key || '').trim().replace(/_/g, ' ')
  if (!s) return 'Unspecified'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── MorningBriefPanel ────────────────────────────────────────────────────────
const BRIEF_STATUS_TONE = {
  fresh:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  stale:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500' },
  missing: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500' },
  pending: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300' },
}

function briefStatusLabel(s) {
  switch (s) {
    case 'fresh':   return 'Live'
    case 'stale':   return 'Stale'
    case 'missing': return 'Missing'
    default:        return 'Pending'
  }
}

export function MorningBriefPanel() {
  const [status, setStatus]   = useState('loading')   // loading | done | error
  const [brief, setBrief]     = useState(null)
  const [regen, setRegen]     = useState(false)
  const [error, setError]     = useState('')

  const fetchBrief = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const b = await api.getPortfolioBrief()
      setBrief(b); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load brief'); setStatus('error')
    }
  }, [])

  const handleRegen = useCallback(async () => {
    setRegen(true)
    try {
      const b = await api.regeneratePortfolioBrief()
      setBrief(b); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not regenerate brief'); setStatus('error')
    } finally {
      setRegen(false)
    }
  }, [])

  useEffect(() => { fetchBrief() }, [fetchBrief])

  const bstatus   = brief?.status || 'pending'
  const tone      = BRIEF_STATUS_TONE[bstatus] || BRIEF_STATUS_TONE.pending
  const narrative = (brief?.narrative || '').trim()
  const clients   = Array.isArray(brief?.clients) ? brief.clients : []
  const generatedAt = brief?.generated_at

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Brain className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Morning brief</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Portfolio narrative · auto-generated nightly
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {briefStatusLabel(bstatus)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={fetchBrief}
            disabled={status === 'loading'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
          <button
            onClick={handleRegen}
            disabled={regen || status === 'loading'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-[11px] font-bold text-brand-700 hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {regen ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Regenerate
          </button>
        </div>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading morning brief…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load brief'}</p>
            <button
              onClick={fetchBrief}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && !narrative && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            No brief generated yet — one will appear after the first nightly run.
          </div>
        )}

        {status === 'done' && narrative && (
          <>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{narrative}</p>
            {clients.length > 0 && (
              <div className="mt-4 space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Clients covered</p>
                {clients.map((c) => (
                  <div key={c.client_id || c.name} className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold text-slate-700 flex-1 truncate">{c.name || c.client_id}</span>
                    {c.headline && <span className="text-slate-400 truncate max-w-[60%]">{c.headline}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {generatedAt && (
        <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
          <p className="text-[11px] font-medium text-slate-400">
            Generated {generatedAt} · agency-only · a client sees only their own brief
          </p>
        </div>
      )}
    </section>
  )
}

// ── BriefHealthPanel ─────────────────────────────────────────────────────────
const BRIEF_HEALTH_TONE = {
  healthy:    { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-600' },
  degraded:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-600' },
  unhealthy:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    text: 'text-rose-600' },
  abstained:  { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400' },
}

function briefCoverageView(h) {
  const n = Number(h?.clients_covered)
  const t = Number(h?.clients_total)
  if (!Number.isFinite(n) || !Number.isFinite(t) || t === 0) return null
  return { n, t, pct: Math.round((n / t) * 100) }
}

function BriefHealthStat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-3 py-2.5 text-center">
      <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', tone || 'text-slate-900')}>{value}</p>
    </div>
  )
}

const BRIEF_DELIVERY_TONE = {
  on_time:  { chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', label: 'On time' },
  delayed:  { chip: 'bg-amber-50 text-amber-600 border-amber-200',       label: 'Delayed' },
  failed:   { chip: 'bg-rose-50 text-rose-600 border-rose-200',          label: 'Failed' },
  skipped:  { chip: 'bg-slate-50 text-slate-500 border-slate-200',       label: 'Skipped' },
}
const BRIEF_GROUNDED_TAIL = {
  verified:   { chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', Icon: ShieldCheck, label: 'Verified' },
  unverified: { chip: 'bg-amber-50 text-amber-600 border-amber-200',       Icon: AlertTriangle, label: 'Unverified' },
  degraded:   { chip: 'bg-rose-50 text-rose-600 border-rose-200',          Icon: TrendingDown, label: 'Degraded' },
}

function BriefDeliveryBanner({ delivery }) {
  if (!delivery) return null
  const dt = BRIEF_DELIVERY_TONE[delivery.status] || BRIEF_DELIVERY_TONE.skipped
  const gt = delivery.grounded_tail ? (BRIEF_GROUNDED_TAIL[delivery.grounded_tail] || null) : null
  const GIcon = gt?.Icon
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-3">
      <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold', dt.chip)}>
        {dt.label}
      </span>
      {gt && (
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', gt.chip)}>
          {GIcon && <GIcon className="w-3 h-3" />} {gt.label}
        </span>
      )}
      {delivery.sent_at && (
        <span className="text-[10px] font-semibold text-slate-400">{delivery.sent_at}</span>
      )}
    </div>
  )
}

export function BriefHealthPanel() {
  const [status, setStatus] = useState('loading')
  const [health, setHealth] = useState(null)
  const [error, setError]   = useState('')

  const fetchHealth = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const h = await api.getBriefHealth()
      setHealth(h); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load brief health'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const hstatus   = health?.status || 'abstained'
  const tone      = BRIEF_HEALTH_TONE[hstatus] || BRIEF_HEALTH_TONE.abstained
  const narrative = (health?.narrative || '').trim()
  const coverage  = briefCoverageView(health)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Brief health</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Coverage, delivery, and grounding
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {hstatus.charAt(0).toUpperCase() + hstatus.slice(1)}
          </span>
        )}
        <button
          onClick={fetchHealth}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Loading brief health…
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error}</p>
            <button onClick={fetchHealth} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}
        {status === 'done' && (
          <>
            {narrative && <p className="text-sm text-slate-600 leading-relaxed">{narrative}</p>}
            {coverage && (
              <div className={cn('grid grid-cols-3 gap-1.5', narrative ? 'mt-3' : '')}>
                <BriefHealthStat label="Covered" value={coverage.n} tone={tone.text} />
                <BriefHealthStat label="Total" value={coverage.t} />
                <BriefHealthStat label="Coverage" value={`${coverage.pct}%`} tone={tone.text} />
              </div>
            )}
            <BriefDeliveryBanner delivery={health?.delivery} />
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Coverage, delivery status, and grounding quality of this morning's brief. Agency-only.
        </p>
      </div>
    </section>
  )
}

// ── BriefImpactPanel ─────────────────────────────────────────────────────────
const BRIEF_IMPACT_TONE = {
  high:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', text: 'text-emerald-600', bar: 'bg-emerald-500' },
  moderate: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       text: 'text-amber-600',   bar: 'bg-amber-500' },
  low:      { pill: 'border-rose-200 bg-rose-50 text-rose-700',          text: 'text-rose-600',    bar: 'bg-rose-500' },
  unknown:  { pill: 'border-slate-200 bg-slate-50 text-slate-500',       text: 'text-slate-400',   bar: 'bg-slate-300' },
}

function briefImpactView(data) {
  const rate = Number(data?.action_rate)
  if (!Number.isFinite(rate)) return null
  const pct = Math.round(rate * 100)
  if (pct >= 60) return { pct, key: 'high' }
  if (pct >= 35) return { pct, key: 'moderate' }
  return { pct, key: 'low' }
}

function BriefImpactStat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-3 py-2.5 text-center">
      <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', tone || 'text-slate-900')}>{value}</p>
    </div>
  )
}

function BriefImpactLaneRow({ lane, pct }) {
  const w = Math.max(0, Math.min(100, Math.round(pct * 100)))
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] font-semibold text-slate-600 truncate" title={laneLabel(lane)}>{laneLabel(lane)}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${w}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-700">{w}%</span>
    </div>
  )
}

export function BriefImpactPanel() {
  const [status, setStatus] = useState('loading')
  const [impact, setImpact] = useState(null)
  const [error, setError]   = useState('')

  const fetchImpact = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const i = await api.getBriefImpact()
      setImpact(i); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load brief impact'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchImpact() }, [fetchImpact])

  const view      = impact ? briefImpactView(impact) : null
  const tone      = BRIEF_IMPACT_TONE[view?.key || 'unknown']
  const narrative = (impact?.narrative || '').trim()
  const days      = impact?.requested?.days || 30
  const lanes     = impact?.lanes && typeof impact.lanes === 'object' ? impact.lanes : {}
  const laneEntries = Object.entries(lanes).filter(([, v]) => Number.isFinite(Number(v)))

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Brief impact</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Did the brief drive action? · last {days} days
          </p>
        </div>
        {status === 'done' && view && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)}>
            {view.pct}% action rate
          </span>
        )}
        <button
          onClick={fetchImpact}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Measuring brief impact…
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error}</p>
            <button onClick={fetchImpact} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}
        {status === 'done' && !view && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            Not enough brief history to grade impact yet.
          </div>
        )}
        {status === 'done' && view && (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{view.pct}%</span>
                <span className="text-[11px] font-bold text-slate-400">took action</span>
              </div>
            </div>
            <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${view.pct}%` }} />
            </div>
            {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
            {laneEntries.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Action by lane</p>
                <div className="space-y-1.5">
                  {laneEntries.map(([lane, pct]) => (
                    <BriefImpactLaneRow key={lane} lane={lane} pct={Number(pct)} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Action rate is the share of brief-receiving clients who took a measurable action within 24 hours. Agency-only.
        </p>
      </div>
    </section>
  )
}

// ── BriefEngagementPanel ─────────────────────────────────────────────────────
const BRIEF_ENGAGEMENT_TONE = {
  well_received: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500' },
  fair:          { pill: 'border-amber-200 bg-amber-50 text-amber-700',       bar: 'bg-amber-500' },
  landing_flat:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          bar: 'bg-rose-500' },
  unknown:       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       bar: 'bg-slate-300' },
}

const BRIEF_EMPHASIS_TONE = {
  above:  { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Above usual' },
  usual:  { chip: 'bg-slate-50 text-slate-500 border-slate-200',       label: 'Usual' },
  below:  { chip: 'bg-amber-50 text-amber-700 border-amber-200',       label: 'Below usual' },
}

const MIN_VOTES = 5

function engagementClientView(c) {
  const n = Number(c?.n)
  if (!Number.isFinite(n) || n < MIN_VOTES) return { state: 'thin', n: n || 0 }
  return {
    state: 'graded',
    n,
    helpful: Number(c.helpful) || 0,
    helpfulRate: Number(c.helpful_rate),
    label: c.label,
  }
}

function BriefEngagementClientRow({ client, watched }) {
  const view = engagementClientView(client)
  const pct  = view.state === 'graded' && Number.isFinite(view.helpfulRate)
    ? Math.round(view.helpfulRate * 100) : null
  const tone = pct != null
    ? pct >= 75 ? BRIEF_ENGAGEMENT_TONE.well_received
    : pct >= 50 ? BRIEF_ENGAGEMENT_TONE.fair
    : BRIEF_ENGAGEMENT_TONE.landing_flat
    : BRIEF_ENGAGEMENT_TONE.unknown
  return (
    <div className="flex items-center gap-2">
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', watched ? 'bg-rose-500' : 'bg-slate-300')} />
      <span className="flex-1 min-w-0 text-[11px] font-semibold text-slate-700 truncate" title={client.name}>{client.name || 'Unnamed'}</span>
      {view.state === 'graded' && pct != null ? (
        <>
          <div className="w-16 h-1 rounded-full bg-slate-100 overflow-hidden">
            <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${pct}%` }} />
          </div>
          <span className="w-8 text-right text-[11px] font-black tabular-nums text-slate-700">{pct}%</span>
        </>
      ) : (
        <span className="text-[10px] font-medium text-slate-400 shrink-0">building</span>
      )}
    </div>
  )
}

function BriefEmphasisStrip({ emphasis, narrative }) {
  if (!emphasis || typeof emphasis !== 'object') return null
  const entries = Object.entries(emphasis)
  if (!entries.length) return null
  return (
    <div className="mt-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Emphasis this brief</p>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([lane, dir]) => {
          const t = BRIEF_EMPHASIS_TONE[dir] || BRIEF_EMPHASIS_TONE.usual
          return (
            <span key={lane} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', t.chip)}>
              {laneLabel(lane)} · {t.label}
            </span>
          )
        })}
      </div>
      {narrative && <p className="mt-2 text-[11px] font-medium text-slate-400 leading-relaxed">{narrative}</p>}
    </div>
  )
}

export function BriefEngagementPanel() {
  const [status, setStatus] = useState('loading')
  const [eng, setEng]       = useState(null)
  const [error, setError]   = useState('')

  const fetchEngagement = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const e = await api.getBriefEngagement()
      setEng(e); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load consumer engagement'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchEngagement() }, [fetchEngagement])

  const graded    = eng?.status === 'graded'
  const reason    = eng?.reason
  const narrative = (eng?.narrative || '').trim()
  const days      = eng?.requested?.days || 30
  const minVotes  = eng?.min_votes || MIN_VOTES
  const pct       = eng && Number.isFinite(Number(eng.helpful_rate)) ? Math.round(eng.helpful_rate * 100) : 0
  const tone      = pct >= 75 ? BRIEF_ENGAGEMENT_TONE.well_received
                 : pct >= 50 ? BRIEF_ENGAGEMENT_TONE.fair
                 : BRIEF_ENGAGEMENT_TONE.landing_flat
  const board     = Array.isArray(eng?.clients) ? eng.clients : []
  const watch     = board.filter((c) => c.label === 'poorly_received' || c.label === 'slipping')
  const watchIds  = new Set(watch.map((c) => c.client_id))

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <ThumbsUp className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Reader engagement</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            How clients rate the brief · last {days} days
          </p>
        </div>
        {status === 'done' && graded && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)}>
            {pct}% found it useful
          </span>
        )}
        <button
          onClick={fetchEngagement}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Loading reader engagement…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load consumer engagement'}</p>
            <button
              onClick={fetchEngagement}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && !graded && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            {reason === 'insufficient_votes'
              ? `Only ${eng?.n || 0} of ${minVotes} ratings needed have come in — the reception score firms up as readers leave 👍 / 👎 on the brief.`
              : `No reader has rated a morning brief in the last ${days} days yet — this fills in as clients leave 👍 / 👎 on the brief they receive.`}
          </div>
        )}

        {status === 'done' && graded && (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{pct}%</span>
                <span className="text-[11px] font-bold text-slate-400">found it useful</span>
              </div>
              <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
                {eng.helpful} of {eng.n} {eng.n === 1 ? 'rating' : 'ratings'} were 👍
                {eng.clients_graded > 0 ? ` · ${eng.clients_graded} of ${eng.clients_total} ${eng.clients_total === 1 ? 'client' : 'clients'} rated` : ''}
              </p>
            </div>

            <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', tone.bar)} style={{ width: `${pct}%` }} />
            </div>

            {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}

            {watch.length > 0 && (
              <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/50 px-3 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-rose-500 mb-1.5 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Needs a look · {watch.length}
                </p>
                <div className="space-y-1">
                  {watch.slice(0, 5).map((c) => (
                    <div key={c.client_id} className="flex items-center gap-2 text-[11px]">
                      <span className="flex-1 truncate font-semibold text-slate-700" title={c.name || 'Unnamed client'}>{c.name || 'Unnamed client'}</span>
                      <span className="shrink-0 font-medium text-rose-600">
                        {c.label === 'poorly_received'
                          ? `landing flat · ${c.helpful_rate != null ? Math.round(c.helpful_rate * 100) : 0}%`
                          : 'reception slipping'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {board.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Who it's landing with</p>
                <div className="space-y-1.5">
                  {board.map((c) => (
                    <BriefEngagementClientRow key={c.client_id} client={c} watched={watchIds.has(c.client_id)} />
                  ))}
                </div>
              </div>
            )}

            <BriefEmphasisStrip emphasis={eng.emphasis} narrative={eng.emphasis_narrative} />
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The one <span className="font-semibold text-slate-500">outward</span> loop — every panel above is the system grading itself; this is the reader grading the brief.
          {' '}A client is graded once {minVotes}+ ratings land — thinner records abstain, never a rate off noise.
          {' '}<span className="font-semibold text-emerald-600">well received</span> ≥75% · <span className="font-semibold text-amber-600">fair</span> 50–74% · <span className="font-semibold text-rose-600">landing flat</span> &lt;50%.
          {' '}The aggregate is <span className="font-semibold text-slate-500">agency-only</span>; a client only ever sees their own vote.
        </p>
      </div>
    </section>
  )
}

// ── BriefEmphasisEfficacyPanel ───────────────────────────────────────────────
const EMPHASIS_EFFICACY_TONE = {
  endorsed:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', icon: ArrowUpCircle, label: 'Leaning in' },
  tempered:     { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   icon: RotateCcw,     label: 'Easing off' },
  steady:       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   icon: Minus,         label: 'Holding calibration' },
  insufficient: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   icon: Inbox,         label: 'Listening' },
}

function stepScaleTone(scale) {
  const s = Number(scale)
  if (Number.isFinite(s) && s > 1.0) return { chip: 'bg-emerald-100 text-emerald-700', verb: 'leaning in', Icon: ArrowUpCircle }
  if (Number.isFinite(s) && s < 1.0) return { chip: 'bg-amber-100 text-amber-700',     verb: 'easing off', Icon: RotateCcw }
  return { chip: 'bg-slate-100 text-slate-600', verb: 'holding', Icon: Minus }
}

const EMPHASIS_DIRECTION_META = {
  widen:   { icon: Sparkles, label: 'Widening',   verbed: 'sustained' },
  tighten: { icon: Scissors, label: 'Tightening', verbed: 'recovered' },
}

const EFFICACY_MIN_N = 4

function efficacyDirectionView(d) {
  const n = d?.n || 0
  if (!n)                 return { state: 'none',  n: 0, successes: 0 }
  if (n < EFFICACY_MIN_N) return { state: 'thin',  n, successes: d?.successes || 0 }
  return {
    state: 'graded', n,
    successes: d?.successes || 0,
    pct:    d?.efficacy != null ? Math.round(d.efficacy * 100) : null,
    liftPp: d?.lift != null ? Math.round(d.lift * 100) : null,
  }
}

function EmphasisDirectionCard({ dir, score, stepScale, hasControl }) {
  const meta = EMPHASIS_DIRECTION_META[dir]
  const Icon = meta.icon
  const view = efficacyDirectionView(score)
  const st   = stepScaleTone(stepScale)
  const StepIcon = st.Icon
  const scaleLabel = Number.isFinite(Number(stepScale)) ? `×${Number(stepScale).toFixed(2)}` : '×1.00'
  return (
    <div className={cn('rounded-xl border px-3 py-2.5', view.state === 'graded' ? 'border-slate-100 bg-slate-50/40' : 'border-slate-100 bg-white')}>
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-[11px] font-black text-slate-700">{meta.label}</span>
        <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums', st.chip)} title={`Learned step-scale — the loop is ${st.verb}`}>
          <StepIcon className="w-2.5 h-2.5" /> {scaleLabel}
        </span>
      </div>
      {view.state === 'graded' ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-slate-900 leading-none tabular-nums">{view.pct}%</span>
            <span className="text-[10px] font-bold text-slate-400">{meta.verbed}</span>
          </div>
          <p className="mt-0.5 text-[10px] font-semibold text-slate-400 tabular-nums">{view.successes} of {view.n} mornings</p>
          {hasControl && view.liftPp != null && (
            <p className="mt-1 text-[10px] font-medium">
              <span className={cn('font-black tabular-nums', view.liftPp > 0 ? 'text-emerald-600' : view.liftPp < 0 ? 'text-amber-600' : 'text-slate-400')}>
                {view.liftPp > 0 ? '+' : ''}{view.liftPp} pp
              </span>
              <span className="text-slate-400"> vs holding steady</span>
            </p>
          )}
        </>
      ) : view.state === 'thin' ? (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400">{view.n} decided so far · building</p>
      ) : (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400">No {meta.label.toLowerCase()} mornings yet</p>
      )}
    </div>
  )
}

export function BriefEmphasisEfficacyPanel() {
  const [status, setStatus] = useState('loading')
  const [eff, setEff]       = useState(null)
  const [error, setError]   = useState('')

  const fetchEfficacy = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const e = await api.getBriefEmphasisEfficacy()
      setEff(e); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load emphasis efficacy'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchEfficacy() }, [fetchEfficacy])

  const graded      = eff?.status === 'graded'
  const verdict     = eff?.recommendation?.verdict || 'insufficient'
  const tone        = EMPHASIS_EFFICACY_TONE[verdict] || EMPHASIS_EFFICACY_TONE.insufficient
  const VerdictIcon = tone.icon
  const narrative   = (eff?.narrative || '').trim()
  const days        = eff?.requested?.days || 90
  const dirs        = eff?.directions || {}
  const rec         = eff?.recommendation || {}
  const controlRate = eff?.control_rate
  const controlN    = eff?.control_n || 0
  const ctrlPct     = controlRate != null ? Math.round(controlRate * 100) : null

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Gauge className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Emphasis efficacy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Is the brief's self-tuning paying off · last {days} days
          </p>
        </div>
        {status === 'done' && graded && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Loop verdict: ${verdict}`}>
            <VerdictIcon className="w-3 h-3" /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchEfficacy}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Grading the loop's own moves…
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load emphasis efficacy'}</p>
            <button onClick={fetchEfficacy} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}
        {status === 'done' && !graded && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            The reception loop hasn't flexed enough to grade yet — this fills in as widen / tighten mornings accrue the reception that follows.
            {controlN > 0 ? ` (${controlN} held-steady ${controlN === 1 ? 'morning' : 'mornings'} logged so far.)` : ''}
          </div>
        )}
        {status === 'done' && graded && (
          <>
            {narrative && <p className="text-sm text-slate-600 leading-relaxed">{narrative}</p>}
            <div className={cn('grid grid-cols-2 gap-2', narrative ? 'mt-3' : '')}>
              <EmphasisDirectionCard dir="widen"   score={dirs.widen}   stepScale={rec.widen_step_scale}   hasControl={controlRate != null} />
              <EmphasisDirectionCard dir="tighten" score={dirs.tighten} stepScale={rec.tighten_step_scale} hasControl={controlRate != null} />
            </div>
            {controlN > 0 && (
              <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 flex items-center gap-2">
                <Scale className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <p className="text-[11px] font-medium text-slate-500 leading-snug">
                  <span className="font-black text-slate-700 tabular-nums">{ctrlPct}%</span> of the{' '}
                  <span className="font-black text-slate-700 tabular-nums">{controlN}</span> {controlN === 1 ? 'morning' : 'mornings'} the brief held steady saw reception improve — the control every flex is measured against.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">self-improving</span> rung — the loop above flexes the brief's breadth on every reception grade; this grades whether the flex paid off and tunes the next one.
          {' '}<span className="font-semibold text-emerald-600">Widening</span> should sustain reception · <span className="font-semibold text-amber-600">tightening</span> should recover it.
          {' '}The learned step-scale stays bounded <span className="tabular-nums">0.5×–1.25×</span> — easy to ease off, earned to lean in.
          {' '}Agency-only; a reader never sees their attention being tuned.
        </p>
      </div>
    </section>
  )
}

// ── BriefEmphasisControlPanel ────────────────────────────────────────────────
const EMPHASIS_CONTROL_TONE = {
  lean_in:  { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: ArrowUpCircle, label: 'Leaning in',  shipText: 'text-emerald-700', shipBox: 'border-emerald-200 bg-emerald-50' },
  ease_off: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: RotateCcw,     label: 'Easing off',  shipText: 'text-amber-700',   shipBox: 'border-amber-200 bg-amber-50' },
  hold:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Minus,         label: 'Holding',     shipText: 'text-slate-500',   shipBox: 'border-slate-200 bg-slate-50' },
  none:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Inbox,         label: 'Standing by', shipText: 'text-slate-500',   shipBox: 'border-slate-200 bg-slate-50' },
}

const EMPHASIS_CONTROL_REASON = {
  efficacy_endorsed:     'past flexes this direction measured as paying off, so it reaches one row further',
  efficacy_tempered:     'past flexes this direction measured as not paying off, so it pulls one row back',
  efficacy_neutral:      'the measured outcome sits right at the neutral mark, so it holds the flex as it stands',
  no_flex_to_scale:      'the reception loop is holding the brief at its baseline breadth, so there is no flex to scale yet',
  insufficient_efficacy: 'not enough measured outcomes yet to know whether to lean in or ease off, so it holds 19’s call untouched',
}

function preFlexLabel(ctrl) {
  const base = ctrl?.base_cap
  const pre  = ctrl?.emphasis_also_cap
  if (base == null || pre == null) return 'steady'
  if (pre > base) return `widen +${pre - base}`
  if (pre < base) return `tighten −${base - pre}`
  return 'steady'
}

export function BriefEmphasisControlPanel() {
  const [status, setStatus] = useState('loading')
  const [ctrl, setCtrl]     = useState(null)
  const [error, setError]   = useState('')

  const fetchControl = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const c = await api.getBriefEmphasisControl()
      setCtrl(c); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load emphasis control'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchControl() }, [fetchControl])

  const move       = ctrl?.control_move || 'none'
  const tone       = EMPHASIS_CONTROL_TONE[move] || EMPHASIS_CONTROL_TONE.none
  const MoveIcon   = tone.icon
  const days       = ctrl?.requested?.days || 90
  const narrative  = (ctrl?.narrative || '').trim()
  const reasonText = EMPHASIS_CONTROL_REASON[ctrl?.control_reason] || ''
  const engaged    = move === 'lean_in' || move === 'ease_off' || move === 'hold'
  const scale      = Number(ctrl?.step_scale)
  const scaleLabel = Number.isFinite(scale) ? `×${scale.toFixed(2)}` : '×1.00'
  const scaleColor = Number.isFinite(scale) && scale > 1 ? 'text-emerald-700'
    : Number.isFinite(scale) && scale < 1 ? 'text-amber-700' : 'text-slate-500'
  const preCap     = ctrl?.emphasis_also_cap
  const cap        = ctrl?.also_cap
  const reasonCap  = reasonText ? reasonText.charAt(0).toUpperCase() + reasonText.slice(1) + '.' : ''

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Emphasis control</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The self-tuning, re-tuned from its own grade · last {days} days
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Controller move: ${move}`}>
            <MoveIcon className="w-3 h-3" /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchControl}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Feeding the grade back into the next flex…
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load emphasis control'}</p>
            <button onClick={fetchControl} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}
        {status === 'done' && !engaged && (
          <div className="flex items-start gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{reasonCap || 'The controller is standing by — it engages once the reception loop flexes and that flex earns a measured grade.'}</p>
          </div>
        )}
        {status === 'done' && engaged && (
          <>
            <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1.5">
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Reception flex</p>
                <p className="mt-1 text-2xl font-black text-slate-900 tabular-nums leading-none">{preCap}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">{preFlexLabel(ctrl)}</p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-300 shrink-0 mx-auto" />
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Measured</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', scaleColor)}>{scaleLabel}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">efficacy</p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-300 shrink-0 mx-auto" />
              <div className={cn('rounded-xl border-2 px-2 py-2.5 text-center', tone.shipBox)}>
                <p className={cn('text-[9px] font-bold uppercase tracking-wide', tone.shipText)}>Shipped</p>
                <p className="mt-1 text-2xl font-black text-slate-900 tabular-nums leading-none">{cap}</p>
                <p className={cn('mt-1 text-[10px] font-bold', tone.shipText)}>{tone.label}</p>
              </div>
            </div>
            {(narrative || reasonCap) && (
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative || reasonCap}</p>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The rung that <span className="font-semibold text-slate-500">closes the loop</span> — reception flexes the brief's breadth, efficacy grades the flex, and this feeds that grade back into the next flex's size.
          {' '}<span className="font-semibold text-emerald-600">Lean in</span> when a direction is paying off · <span className="font-semibold text-amber-600">ease off</span> when it isn't · hold otherwise.
          {' '}Leaning in is earned twice, easing off is always free, and the cap never leaves its rails.
          {' '}Agency-only; a reader never sees their attention being tuned.
        </p>
      </div>
    </section>
  )
}

// ── BriefEmphasisControlHealthPanel ─────────────────────────────────────────
const CONTROL_HEALTH_TONE = {
  unstable:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',          icon: Activity,      label: 'Hunting',   line: 'stroke-rose-500' },
  constrained: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: AlertTriangle, label: 'Pinned',    line: 'stroke-amber-500' },
  stable:      { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: CheckCircle2,  label: 'Converged', line: 'stroke-emerald-500' },
  settling:    { pill: 'border-sky-200 bg-sky-50 text-sky-700',             icon: Gauge,         label: 'Settling',  line: 'stroke-sky-500' },
  idle:        { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Inbox,         label: 'Idle',      line: 'stroke-slate-300' },
  abstained:   { pill: 'border-slate-200 bg-slate-50 text-slate-400',       icon: Clock,         label: 'Building',  line: 'stroke-slate-300' },
}

const CONTROL_HEALTH_ACTION = {
  damp:          { label: 'Self-healing',  icon: Wrench,        cls: 'text-rose-700',    box: 'border-rose-200 bg-rose-50' },
  review_bounds: { label: 'Review bounds', icon: AlertTriangle, cls: 'text-amber-700',   box: 'border-amber-200 bg-amber-50' },
  trust:         { label: 'Trust',         icon: ShieldCheck,   cls: 'text-emerald-700', box: 'border-emerald-200 bg-emerald-50' },
  hold:          { label: 'Hold',          icon: Minus,         cls: 'text-slate-500',   box: 'border-slate-200 bg-slate-50' },
  none:          { label: 'Standing by',   icon: Inbox,         cls: 'text-slate-400',   box: 'border-slate-200 bg-slate-50' },
}

const CONTROL_MOVE_DOT = { lean_in: 'fill-emerald-500', ease_off: 'fill-amber-500', hold: 'fill-slate-300', none: 'fill-slate-200' }

const CONTROL_HEALTH_REASON = {
  control_settling:     'The tuner is mid-search — adjusting, but neither swinging nor stuck. No intervention yet.',
  controller_quiet:     'The tuner has been hands-off all window — there is nothing to steady.',
  insufficient_history: 'Not enough mornings yet to judge the tuner’s stability — it builds as the brief ships.',
}

function ControlHealthTrack({ series, bounds, tone }) {
  const pts = Array.isArray(series) ? series : []
  const W = 320, H = 76, padX = 8, padTop = 10, padBot = 10
  const innerW = W - padX * 2, innerH = H - padTop - padBot
  const loD = Math.min(bounds.min, bounds.base) - 0.5
  const hiD = Math.max(bounds.max, bounds.base) + 0.5
  const yFor = (v) => padTop + (1 - (v - loD) / (hiD - loD)) * innerH
  const xFor = (i) => pts.length <= 1 ? padX + innerW / 2 : padX + (i / (pts.length - 1)) * innerW
  let d = ''
  pts.forEach((p, i) => {
    const x = xFor(i), y = yFor(p.cap)
    if (i === 0) d += `M ${x.toFixed(1)} ${y.toFixed(1)}`
    else { const py = yFor(pts[i - 1].cap); d += ` L ${x.toFixed(1)} ${py.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}` }
  })
  const rail = (v, dash) => (
    <line x1={padX} x2={W - padX} y1={yFor(v)} y2={yFor(v)} className="stroke-slate-200" strokeWidth="1" strokeDasharray={dash || undefined} />
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Controller breadth across the trailing window against its rails">
      {bounds.max > bounds.base && rail(bounds.max)}
      {rail(bounds.base, '3 3')}
      {bounds.min < bounds.base && rail(bounds.min)}
      {pts.length > 0 && <path d={d} fill="none" className={tone.line} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {pts.map((p, i) => (
        <circle key={i} cx={xFor(i)} cy={yFor(p.cap)} r={i === pts.length - 1 ? 4 : 3} className={cn(CONTROL_MOVE_DOT[p.move] || CONTROL_MOVE_DOT.none, 'stroke-white')} strokeWidth="1.5" />
      ))}
    </svg>
  )
}

export function BriefEmphasisControlHealthPanel() {
  const [status, setStatus] = useState('loading')
  const [health, setHealth] = useState(null)
  const [error, setError]   = useState('')

  const fetchHealth = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const h = await api.getBriefEmphasisControlHealth()
      setHealth(h); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load controller stability'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const vstatus    = health?.status || 'abstained'
  const tone       = CONTROL_HEALTH_TONE[vstatus] || CONTROL_HEALTH_TONE.abstained
  const StatusIcon = tone.icon
  const action     = health?.recommended_action || 'none'
  const act        = CONTROL_HEALTH_ACTION[action] || CONTROL_HEALTH_ACTION.none
  const ActIcon    = act.icon
  const ctl        = health?.control || {}
  const bounds     = health?.bounds || { min: 1, base: 3, max: 5 }
  const series     = Array.isArray(ctl.series) ? ctl.series : []
  const windowN    = health?.requested?.days || health?.window_used || 6
  const hasChart   = vstatus !== 'abstained' && series.length >= 2
  const damping    = action === 'damp'
  const narrative  = (health?.narrative || '').trim()
  const reasonLine = CONTROL_HEALTH_REASON[health?.verdict_reason] || ''
  const subLine    = narrative || reasonLine
  const pillLabel  = vstatus === 'constrained'
    ? (health?.verdict_reason === 'pinned_low' ? 'Pinned low' : 'Pinned high')
    : tone.label
  const flips      = Number.isFinite(Number(ctl.flips)) ? Number(ctl.flips) : 0
  const settledRun = Number.isFinite(Number(ctl.settled_run)) ? Number(ctl.settled_run) : 0

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Controller stability</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The governor watching the tuner for hunting &amp; saturation · trailing {windowN} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Controller health: ${vstatus}`}>
            <StatusIcon className="w-3 h-3" /> {pillLabel}
          </span>
        )}
        <button
          onClick={fetchHealth}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Watching the tuner settle…
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load controller stability'}</p>
            <button onClick={fetchHealth} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}
        {status === 'done' && vstatus === 'abstained' && (
          <div className="flex items-start gap-2 text-sm text-slate-400 py-2">
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{reasonLine || 'Not enough mornings yet to judge the tuner’s stability — it builds as the brief ships.'}</p>
          </div>
        )}
        {status === 'done' && vstatus !== 'abstained' && (
          <>
            {damping && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                <Wrench className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <p className="text-[12px] font-semibold text-rose-700 leading-relaxed">
                  Self-healing — the tuner is reversing itself faster than it's converging, so the governor benched it to baseline for tomorrow's brief.
                </p>
              </div>
            )}
            {hasChart && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 pt-3 pb-2">
                <ControlHealthTrack series={series} bounds={bounds} tone={tone} />
                <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> lean-in</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> ease-off</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300" /> hold</span>
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-3 border-t border-dashed border-slate-300" /> baseline</span>
                </div>
              </div>
            )}
            <div className={cn('grid grid-cols-3 gap-1.5', hasChart && 'mt-3')}>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Swings</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', vstatus === 'unstable' ? 'text-rose-700' : 'text-slate-900')}>{flips}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">reversals</p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Settled</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', vstatus === 'stable' ? 'text-emerald-700' : 'text-slate-900')}>{settledRun}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">in a row</p>
              </div>
              <div className={cn('rounded-xl border-2 px-2 py-2.5 text-center flex flex-col items-center justify-center', act.box)}>
                <p className={cn('text-[9px] font-bold uppercase tracking-wide', act.cls)}>Action</p>
                <ActIcon className={cn('mt-1.5 w-5 h-5', act.cls)} />
                <p className={cn('mt-1 text-[10px] font-bold', act.cls)}>{act.label}</p>
              </div>
            </div>
            {subLine && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{subLine}</p>}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">governor</span> on the self-tuning loop — it watches the controller across mornings, not one move at a time.
          {' '}<span className="font-semibold text-rose-600">Hunting</span> (it keeps reversing) or <span className="font-semibold text-amber-600">pinned</span> (stuck on a rail) reads as unstable even when each move looked fine.
          {' '}When the tuner won't settle the governor <span className="font-semibold text-rose-600">self-heals</span> — benching it to baseline — so a runaway loop can't quietly distort the brief.
          {' '}Agency-only; a reader never sees their attention being tuned, let alone policed.
        </p>
      </div>
    </section>
  )
}

// ── BriefEmphasisControlTuningPanel ─────────────────────────────────────────
const CONTROL_TUNING_TONE = {
  default:  { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: CheckCircle2, label: 'Full range', fill: 'fill-emerald-400', swatch: 'bg-emerald-400' },
  detuned:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          icon: Scissors,     label: 'Narrowed',   fill: 'fill-rose-400',    swatch: 'bg-rose-400' },
  holding:  { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: Gauge,        label: 'Holding',    fill: 'fill-amber-400',   swatch: 'bg-amber-400' },
  restored: { pill: 'border-sky-200 bg-sky-50 text-sky-700',             icon: RotateCcw,    label: 'Restored',   fill: 'fill-sky-400',     swatch: 'bg-sky-400' },
}

const CONTROL_TUNING_ACTION = {
  reduce_authority:  { label: 'Narrowing',   icon: Scissors,  cls: 'text-rose-700',  box: 'border-rose-200 bg-rose-50' },
  hold_authority:    { label: 'Holding',     icon: Gauge,     cls: 'text-amber-700', box: 'border-amber-200 bg-amber-50' },
  restore_authority: { label: 'Restoring',   icon: RotateCcw, cls: 'text-sky-700',   box: 'border-sky-200 bg-sky-50' },
  none:              { label: 'Standing by', icon: Inbox,     cls: 'text-slate-400', box: 'border-slate-200 bg-slate-50' },
}

const CONTROL_TUNING_REASON = {
  insufficient_history: 'Not enough governor mornings yet to schedule the controller’s range — it builds as the brief ships.',
  no_intervention:      'The controller has stayed steady all window — it keeps its full swing range.',
  awaiting_stability:   'The controller has stopped swinging but hasn’t proven it yet — its range stays trimmed a notch until it does.',
  hunting_active:       'The controller kept over-correcting, so its swing range has been narrowed to settle it.',
  stability_proven:     'The controller has proven steady again, so its full swing range was handed back.',
}

function AuthorityBandTrack({ effective, bounds, tone }) {
  const W = 320, H = 56, padX = 18
  const innerW = W - padX * 2
  const lo = Math.min(bounds.min, bounds.base, effective.min)
  const hi = Math.max(bounds.max, bounds.base, effective.max)
  const span = (hi - lo) || 1
  const xFor = (v) => padX + ((v - lo) / span) * innerW
  const laneY = 12, laneH = 16, r = 8
  const fX1 = xFor(bounds.min), fX2 = xFor(bounds.max)
  const eX1 = xFor(effective.min), eX2 = xFor(effective.max)
  const baseX = xFor(bounds.base)
  const frozen = (effective.max - effective.min) < 0.01
  const label = (x, t) => (
    <text x={x} y={laneY + laneH + 14} textAnchor="middle" className="fill-slate-400 text-[9px] font-bold">{t}</text>
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
         aria-label="Controller authority envelope: full swing range with the currently-allowed band filled inside">
      <rect x={fX1} y={laneY} width={Math.max(0, fX2 - fX1)} height={laneH} rx={r} className="fill-slate-100" />
      {frozen
        ? <circle cx={baseX} cy={laneY + laneH / 2} r={5} className={cn(tone.fill, 'stroke-white')} strokeWidth="1.5" />
        : <rect x={eX1} y={laneY} width={Math.max(0, eX2 - eX1)} height={laneH} rx={r} className={tone.fill} />}
      <line x1={baseX} x2={baseX} y1={laneY - 4} y2={laneY + laneH + 4} className="stroke-slate-400" strokeWidth="1.5" strokeDasharray="3 2" />
      {label(xFor(bounds.min), bounds.min)}
      {label(baseX, 'base')}
      {label(xFor(bounds.max), bounds.max)}
    </svg>
  )
}

export function BriefEmphasisControlTuningPanel() {
  const [status, setStatus] = useState('loading')
  const [tune, setTune]     = useState(null)
  const [error, setError]   = useState('')

  const fetchTune = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const t = await api.getBriefEmphasisControlTuning()
      setTune(t); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load adaptive gain'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchTune() }, [fetchTune])

  const vstatus    = tune?.status || 'default'
  const tone       = CONTROL_TUNING_TONE[vstatus] || CONTROL_TUNING_TONE.default
  const StatusIcon = tone.icon
  const action     = tune?.recommended_action || 'none'
  const act        = CONTROL_TUNING_ACTION[action] || CONTROL_TUNING_ACTION.none
  const ActIcon    = act.icon
  const bounds     = tune?.bounds || { min: 1, base: 3, max: 5 }
  const effective  = tune?.effective_bounds || bounds
  const reach      = Number.isFinite(Number(tune?.reach)) ? Number(tune.reach) : 0
  const maxReach   = Number.isFinite(Number(tune?.max_reach)) ? Number(tune.max_reach) : 0
  const gov        = tune?.governor || {}
  const huntCount  = Number.isFinite(Number(gov.hunt_count)) ? Number(gov.hunt_count) : 0
  const windowN    = tune?.requested?.days || tune?.window_used || 6
  const narrative  = (tune?.narrative || '').trim()
  const reasonLine = CONTROL_TUNING_REASON[tune?.reason] || ''
  const building   = vstatus === 'default' && tune?.reason === 'insufficient_history'
  const frozen     = reach <= 0
  const narrowing  = action === 'reduce_authority'
  const restoring  = action === 'restore_authority'
  const showBanner = narrowing || restoring
  const subLine    = showBanner ? '' : (narrative || reasonLine)
  const hasChart   = !building && maxReach > 0
  const pillLabel  = vstatus === 'detuned' ? (frozen ? 'Frozen' : 'Narrowed') : tone.label

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Adaptive gain</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Scheduling the controller's authority from the governor's record · trailing {windowN} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Adaptive gain: ${vstatus}`}>
            <StatusIcon className="w-3 h-3" /> {pillLabel}
          </span>
        )}
        <button
          onClick={fetchTune}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the governor's record…
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load adaptive gain'}</p>
            <button onClick={fetchTune} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}
        {status === 'done' && building && (
          <div className="flex items-start gap-2 text-sm text-slate-400 py-2">
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{reasonLine || 'Not enough governor mornings yet to schedule the controller’s range — it builds as the brief ships.'}</p>
          </div>
        )}
        {status === 'done' && !building && (
          <>
            {narrowing && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                <Scissors className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <p className="text-[12px] font-semibold text-rose-700 leading-relaxed">
                  {frozen
                    ? 'Adaptive gain — the controller kept over-correcting morning after morning, so it’s been pinned to its baseline breadth until it stops swinging.'
                    : 'Adaptive gain — the controller kept over-correcting, so the range it’s allowed to swing was narrowed for tomorrow’s brief.'}
                </p>
              </div>
            )}
            {restoring && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5">
                <RotateCcw className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                <p className="text-[12px] font-semibold text-sky-700 leading-relaxed">
                  The controller has proven steady again for a run of mornings, so its full swing range was handed back.
                </p>
              </div>
            )}
            {hasChart && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 pt-3 pb-2">
                <AuthorityBandTrack effective={effective} bounds={bounds} tone={tone} />
                <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
                  <span className="inline-flex items-center gap-1"><span className={cn('w-2 h-2 rounded-full', tone.swatch)} /> allowed swing</span>
                  <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-200" /> full range</span>
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-3 border-t border-dashed border-slate-400" /> base</span>
                </div>
              </div>
            )}
            <div className={cn('grid grid-cols-3 gap-1.5', hasChart && 'mt-3')}>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Reach</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', vstatus === 'detuned' ? 'text-rose-700' : vstatus === 'restored' ? 'text-sky-700' : 'text-slate-900')}>{reach}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">of {maxReach} rows</p>
              </div>
              <div className="rounded-xl border border-slate-100 bg-white px-2 py-2.5 text-center">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Hunts</p>
                <p className={cn('mt-1 text-2xl font-black tabular-nums leading-none', huntCount > 0 ? 'text-rose-700' : 'text-slate-900')}>{huntCount}</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-400">of {windowN} mornings</p>
              </div>
              <div className={cn('rounded-xl border-2 px-2 py-2.5 text-center flex flex-col items-center justify-center', act.box)}>
                <p className={cn('text-[9px] font-bold uppercase tracking-wide', act.cls)}>Action</p>
                <ActIcon className={cn('mt-1.5 w-5 h-5', act.cls)} />
                <p className={cn('mt-1 text-[10px] font-bold', act.cls)}>{act.label}</p>
              </div>
            </div>
            {subLine && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{subLine}</p>}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">gain schedule</span> over the governor — it reads the governor's record across mornings, not one window at a time.
          {' '}When hunting <span className="font-semibold text-rose-600">recurs</span>, it <span className="font-semibold text-rose-600">narrows</span> how far the controller may swing at all (a smaller breadth cap), and <span className="font-semibold text-sky-600">hands the full range back</span> once the loop proves it has converged.
          {' '}It schedules off the governor's read of the <span className="font-semibold text-slate-500">raw</span> controller, so the breaker still grades an un-tuned loop.
          {' '}Agency-only; a reader never sees their attention being tuned, governed, or gain-scheduled.
        </p>
      </div>
    </section>
  )
}
