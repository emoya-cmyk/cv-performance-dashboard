import {
  BarChart3, Clock, CheckCircle2, Check, Radar, Users, Plug, TrendingDown,
  Target, ArrowLeftRight, ArrowRight, Gauge, Minus, Activity, ShieldAlert,
  AlertOctagon, ShieldCheck, Stethoscope, Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  healthBandMeta, metricLabel, fmtMetricValue,
  recoveryMeta, timeAgo, kindMeta, directionIcon, severityMeta,
} from '@/lib/insightMeta'
import { MetricDistribution } from './IntelShared'

// ── internal TONE constants ───────────────────────────────────────────────────
const BENCHMARK_METRIC_ORDER = ['close_rate', 'avg_ticket', 'lead_conversion', 'ltv', 'churn_rate', 'nps']

const RECOVERIES_SHOWN = 5
const SYSTEMIC_SHOWN = 4
const SYSTEMIC_CLIENTS_SHOWN = 3
const TRAJECTORY_SHOWN = 5
const CROSSING_KIND = {
  breakout:    { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', label: 'Breakout' },
  breach:      { pill: 'border-rose-200 bg-rose-50 text-rose-700',         dot: 'bg-rose-500',    label: 'Breach' },
  approaching: { pill: 'border-amber-200 bg-amber-50 text-amber-700',      dot: 'bg-amber-500',   label: 'Approaching' },
  recovery:    { pill: 'border-sky-200 bg-sky-50 text-sky-700',            dot: 'bg-sky-500',     label: 'Recovery' },
}
const PACE_SHOWN = 5
const PACE_STATUS_META = {
  ahead:    { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500', label: 'Ahead' },
  on_track: { pill: 'border-teal-200 bg-teal-50 text-teal-700',          bar: 'bg-teal-500',    label: 'On track' },
  lagging:  { pill: 'border-amber-200 bg-amber-50 text-amber-700',       bar: 'bg-amber-400',   label: 'Lagging' },
  at_risk:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          bar: 'bg-rose-500',    label: 'At risk' },
}
const PACE_MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const REALLOC_SHOWN = 5
const REALLOC_STRENGTH_META = {
  strong:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500',  label: 'Strong' },
  moderate: { pill: 'border-teal-200 bg-teal-50 text-teal-700',          bar: 'bg-teal-500',     label: 'Moderate' },
  mild:     { pill: 'border-amber-200 bg-amber-50 text-amber-700',       bar: 'bg-amber-400',    label: 'Mild' },
  weak:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       bar: 'bg-slate-300',    label: 'Weak' },
}
const REALLOC_EFF_BAND_META = {
  excellent: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500', label: 'Excellent' },
  good:      { pill: 'border-teal-200 bg-teal-50 text-teal-700',          bar: 'bg-teal-500',    label: 'Good' },
  fair:      { pill: 'border-amber-200 bg-amber-50 text-amber-700',       bar: 'bg-amber-400',   label: 'Fair' },
  poor:      { pill: 'border-rose-200 bg-rose-50 text-rose-700',          bar: 'bg-rose-500',    label: 'Poor' },
}
const REALLOC_STRENGTH_LABEL = { strong: 'Strong', moderate: 'Moderate', mild: 'Mild', weak: 'Weak' }
const REALLOC_CHANNEL_LABEL  = { paid_search: 'Paid search', paid_social: 'Paid social', organic: 'Organic', referral: 'Referral', direct: 'Direct', email: 'Email', sms: 'SMS', other: 'Other' }
const EFF_SHOWN = 5
const EFF_BAND_META = {
  excellent: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500', label: 'Excellent' },
  good:      { pill: 'border-teal-200 bg-teal-50 text-teal-700',          bar: 'bg-teal-500',    label: 'Good' },
  fair:      { pill: 'border-amber-200 bg-amber-50 text-amber-700',       bar: 'bg-amber-400',   label: 'Fair' },
  poor:      { pill: 'border-rose-200 bg-rose-50 text-rose-700',          bar: 'bg-rose-500',    label: 'Poor' },
}
const REALLOC_HEALTH_ACTION = {
  reallocate_now:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          Icon: ArrowLeftRight, label: 'Reallocate now' },
  rebalance:       { pill: 'border-amber-200 bg-amber-50 text-amber-700',       Icon: Gauge,          label: 'Rebalance' },
  maintain:        { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: ShieldCheck,    label: 'Maintain' },
  investigate:     { pill: 'border-orange-200 bg-orange-50 text-orange-700',    Icon: Stethoscope,    label: 'Investigate' },
  monitor:         { pill: 'border-slate-200 bg-slate-50 text-slate-500',       Icon: Minus,          label: 'Monitor' },
}

// ── internal helpers ──────────────────────────────────────────────────────────
function orderedBenchmarkMetrics(benchmarks) {
  if (!benchmarks || typeof benchmarks !== 'object') return []
  const keys = Object.keys(benchmarks)
  const ordered = BENCHMARK_METRIC_ORDER.filter(k => keys.includes(k))
  const rest = keys.filter(k => !BENCHMARK_METRIC_ORDER.includes(k)).sort()
  return [...ordered, ...rest]
}

function paceStatusMeta(status) {
  return PACE_STATUS_META[status] || PACE_STATUS_META.on_track
}

function fmtMonthLabel(m) {
  if (!m) return '?'
  const parts = String(m).split('-')
  const month = parseInt(parts[1], 10) - 1
  return Number.isFinite(month) && month >= 0 && month < 12 ? PACE_MONTH_NAMES[month] : m
}

function fmtCatchup(days) {
  if (!Number.isFinite(days)) return ''
  if (days <= 0) return ''
  return `${Math.round(days)}d to catch up`
}

function reallocStrengthMeta(s) { return REALLOC_STRENGTH_META[s] || REALLOC_STRENGTH_META.weak }
function fmtReallocUsd(v) { return Number.isFinite(v) ? `$${Math.round(v).toLocaleString()}` : '—' }
function fmtReallocPct(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—' }
function reallocEffBandMeta(b) { return REALLOC_EFF_BAND_META[b] || REALLOC_EFF_BAND_META.fair }
function reallocStrengthLabel(s) { return REALLOC_STRENGTH_LABEL[s] || (s || 'Unknown') }
function reallocChannelLabel(c) { return REALLOC_CHANNEL_LABEL[c] || (c ? String(c).replace(/_/g, ' ') : 'Channel') }
function reallocPairLabel(r) {
  const from = reallocChannelLabel(r?.from_channel)
  const to = reallocChannelLabel(r?.to_channel)
  return `${from} → ${to}`
}
function reallocCalVerdict(r) {
  const roi = Number.isFinite(r?.projected_roi_delta) ? r.projected_roi_delta : null
  if (roi != null) return `+${Math.round(roi * 100)}% ROI est.`
  const cac = Number.isFinite(r?.projected_cac_delta) ? r.projected_cac_delta : null
  if (cac != null) return `${cac > 0 ? '+' : ''}${Math.round(cac * 100)}% CAC est.`
  return ''
}
function fmtCalFactor(r) {
  const f = Number.isFinite(r?.calibration_factor) ? r.calibration_factor : null
  if (f == null) return ''
  return `×${f.toFixed(2)} calibrated`
}
function reallocPctWidth(v, max = 1) {
  if (!Number.isFinite(v) || !Number.isFinite(max) || max <= 0) return '0%'
  return `${Math.min(100, Math.round((v / max) * 100))}%`
}
function reallocHealthMeta(status) { return REALLOC_HEALTH_ACTION[status] || REALLOC_HEALTH_ACTION.monitor }
function reallocHealthBarH(delta) {
  if (!Number.isFinite(delta)) return { h: '2px', up: false }
  return { h: `${Math.max(2, Math.min(100, Math.abs(delta) * 200))}%`, up: delta >= 0 }
}
function reallocHealthDirColor(up) { return up ? 'bg-emerald-500' : 'bg-rose-500' }
function fmtRecoverDays(d) {
  if (!Number.isFinite(d)) return ''
  return `${Math.round(d)}d`
}
function effBandMeta(b) { return EFF_BAND_META[b] || EFF_BAND_META.fair }

// ── internal sub-components ───────────────────────────────────────────────────
function RecoveryRow({ rec, index }) {
  const meta = recoveryMeta(rec?.pattern)
  const Icon = meta?.Icon || Activity
  const DirIcon = directionIcon(rec?.direction)
  const days = fmtRecoverDays(rec?.days_recovering)
  const age = rec?.first_seen ? timeAgo(rec.first_seen) : null
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <Icon className="w-3.5 h-3.5 text-sky-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(rec?.metric)}</span>
          {rec?.client && <span className="text-[11px] font-semibold text-slate-400">{rec.client}</span>}
          {days && <span className="inline-flex items-center gap-0.5 rounded-full border border-sky-200 bg-sky-50 px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed text-sky-700"><Clock className="w-2.5 h-2.5" /> {days}</span>}
        </div>
        {rec?.current_value != null && (
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500 tabular-nums leading-tight">
            <DirIcon className="inline w-3 h-3 mr-0.5" />
            {fmtMetricValue(rec.metric, rec.current_value)}
            {rec?.prior_value != null && <span className="ml-1 text-slate-300">from {fmtMetricValue(rec.metric, rec.prior_value)}</span>}
          </p>
        )}
        {age && <p className="mt-0.5 text-[10px] text-slate-400">Started {age}</p>}
      </div>
    </div>
  )
}

function SystemicRow({ issue, index }) {
  const kMeta = kindMeta(issue?.kind)
  const KIcon = kMeta?.Icon || Activity
  const clients = Array.isArray(issue?.clients) ? issue.clients.slice(0, SYSTEMIC_CLIENTS_SHOWN) : []
  const extra = (issue?.client_count || 0) - SYSTEMIC_CLIENTS_SHOWN
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <KIcon className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(issue?.metric)}</span>
          <span className="inline-flex items-center gap-0.5 rounded-full border border-rose-200 bg-rose-50 px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed text-rose-700">
            <Users className="w-2.5 h-2.5" /> {issue?.client_count || clients.length}
          </span>
        </div>
        {clients.length > 0 && (
          <p className="mt-0.5 text-[10px] font-semibold text-slate-400 leading-tight">
            {clients.join(', ')}{extra > 0 ? ` +${extra}` : ''}
          </p>
        )}
        {issue?.summary && <p className="mt-0.5 text-[11px] text-slate-500 leading-snug">{issue.summary}</p>}
      </div>
    </div>
  )
}

function TrajectoryRow({ item, index }) {
  const kind = CROSSING_KIND[item?.crossing_kind] || CROSSING_KIND.approaching
  const DirIcon = directionIcon(item?.direction)
  const eta = item?.eta_days != null ? `${Math.round(item.eta_days)}d` : null
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <DirIcon className={cn('w-3.5 h-3.5', kind.dot === 'bg-emerald-500' ? 'text-emerald-500' : kind.dot === 'bg-rose-500' ? 'text-rose-500' : 'text-amber-500')} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(item?.metric)}</span>
          {item?.client && <span className="text-[11px] font-semibold text-slate-400">{item.client}</span>}
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', kind.pill)}>{kind.label}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {item?.current_value != null && (
            <span className="text-[11px] font-semibold text-slate-500 tabular-nums">{fmtMetricValue(item.metric, item.current_value)}</span>
          )}
          {item?.threshold != null && (
            <span className="text-[10px] text-slate-400">threshold {fmtMetricValue(item.metric, item.threshold)}</span>
          )}
          {eta && (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-sky-200 bg-sky-50 px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed text-sky-700">
              <Clock className="w-2.5 h-2.5" /> {eta}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function PacingRow({ item, index }) {
  const meta = paceStatusMeta(item?.status)
  const catchup = fmtCatchup(item?.catchup_days)
  const pct = Number.isFinite(item?.pct_complete) ? Math.min(100, Math.round(item.pct_complete * 100)) : 0
  const monthLabel = fmtMonthLabel(item?.month)
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(item?.metric)}</span>
          {item?.client && <span className="text-[11px] font-semibold text-slate-400">{item.client}</span>}
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.pill)}>{meta.label}</span>
          {monthLabel && <span className="text-[10px] text-slate-400">{monthLabel}</span>}
        </div>
        <div className="mt-1 relative h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={cn('absolute inset-y-0 left-0 rounded-full transition-all', meta.bar)} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-[10px] font-semibold text-slate-400 tabular-nums">{pct}% complete</span>
          {catchup && <span className="text-[10px] text-slate-400">{catchup}</span>}
        </div>
      </div>
    </div>
  )
}

function ReallocationRow({ r, index }) {
  const strMeta = reallocStrengthMeta(r?.signal_strength)
  const verdict = reallocCalVerdict(r)
  const calFactor = fmtCalFactor(r)
  const fromAmt = fmtReallocUsd(r?.from_spend)
  const toAmt = fmtReallocUsd(r?.to_spend)
  const movePct = fmtReallocPct(r?.move_pct)
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <ArrowLeftRight className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{reallocPairLabel(r)}</span>
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', strMeta.pill)}>{strMeta.label}</span>
          {verdict && <span className="text-[10px] font-semibold text-emerald-600">{verdict}</span>}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap text-[10px] text-slate-400">
          {fromAmt !== '—' && <span>{fromAmt} → {toAmt} ({movePct})</span>}
          {calFactor && <span className="text-slate-300">{calFactor}</span>}
        </div>
        {r?.rationale && <p className="mt-0.5 text-[11px] text-slate-500 leading-snug">{r.rationale}</p>}
      </div>
    </div>
  )
}

function ReallocationEfficacyRow({ r, index }) {
  const effMeta = reallocEffBandMeta(r?.efficacy_band)
  const pct = Number.isFinite(r?.pct_of_lift) ? Math.round(r.pct_of_lift * 100) : 0
  const maxPct = 100
  const barW = reallocPctWidth(r?.pct_of_lift, 1)
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{reallocPairLabel(r)}</span>
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', effMeta.pill)}>{effMeta.label}</span>
        </div>
        <div className="mt-1 relative h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={cn('absolute inset-y-0 left-0 rounded-full transition-all', effMeta.bar)} style={{ width: barW }} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] font-semibold text-slate-400 tabular-nums">{pct}% of projected lift captured</span>
        </div>
      </div>
    </div>
  )
}

function EfficacyRow({ r, index }) {
  const bMeta = effBandMeta(r?.band)
  const DirIcon = directionIcon(r?.direction)
  const sev = severityMeta(r?.severity)
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <DirIcon className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(r?.metric)}</span>
          {r?.client && <span className="text-[11px] font-semibold text-slate-400">{r.client}</span>}
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', bMeta.pill)}>{bMeta.label}</span>
          {sev && <span className={cn('text-[10px] font-semibold', sev.text)}>{sev.label}</span>}
        </div>
        {r?.value != null && (
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500 tabular-nums leading-tight">
            {fmtMetricValue(r.metric, r.value)}
            {r?.benchmark != null && <span className="ml-1 text-slate-300">/ {fmtMetricValue(r.metric, r.benchmark)} bench</span>}
          </p>
        )}
      </div>
    </div>
  )
}

// ── exported panel components ─────────────────────────────────────────────────
export function BenchmarkPanel({ data }) {
  if (!data) return null
  const benchmarks = data.benchmarks || {}
  const metricKeys = orderedBenchmarkMetrics(benchmarks)
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <BarChart3 className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Benchmarks</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">How the portfolio sits against industry norms</p>
        </div>
      </div>
      <div className="px-4 py-4">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-3">{summary}</p>}
        {metricKeys.length > 0 ? (
          <div className="space-y-3">
            {metricKeys.map(key => {
              const b = benchmarks[key]
              if (!b) return null
              const hMeta = healthBandMeta(b.band)
              return (
                <div key={key}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[12px] font-bold text-slate-700">{metricLabel(key)}</span>
                    {b.band && (
                      <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', hMeta?.pill || 'border-slate-200 bg-slate-50 text-slate-500')}>
                        {hMeta?.label || b.band}
                      </span>
                    )}
                    {b.percentile != null && (
                      <span className="ml-auto text-[10px] font-semibold text-slate-400 tabular-nums">{Math.round(b.percentile)}th pct</span>
                    )}
                  </div>
                  <MetricDistribution metric={key} data={b} />
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <BarChart3 className="w-4 h-4 shrink-0" /> No benchmark data yet
          </div>
        )}
      </div>
    </section>
  )
}

export function RecoveriesPanel({ data }) {
  if (!data) return null
  const items = Array.isArray(data.recoveries) ? data.recoveries.slice(0, RECOVERIES_SHOWN) : []
  const count = data.total_count || items.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Recoveries</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Metrics bouncing back after a dip</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {items.length > 0 ? (
          items.map((rec, i) => <RecoveryRow key={`${rec?.metric}-${rec?.client}-${i}`} rec={rec} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <Activity className="w-4 h-4 shrink-0" /> No active recoveries
          </div>
        )}
      </div>
    </section>
  )
}

export function SystemicPanel({ data }) {
  if (!data) return null
  const issues = Array.isArray(data.issues) ? data.issues.slice(0, SYSTEMIC_SHOWN) : []
  const count = data.total_count || issues.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Systemic issues</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Patterns surfacing across multiple clients</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {issues.length > 0 ? (
          issues.map((issue, i) => <SystemicRow key={`${issue?.metric}-${i}`} issue={issue} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <ShieldCheck className="w-4 h-4 shrink-0" /> No systemic issues detected
          </div>
        )}
      </div>
    </section>
  )
}

export function TrajectoryPanel({ data }) {
  if (!data) return null
  const items = Array.isArray(data.crossings) ? data.crossings.slice(0, TRAJECTORY_SHOWN) : []
  const count = data.total_count || items.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Target className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Trajectory</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Upcoming threshold crossings by trend</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {items.length > 0 ? (
          items.map((item, i) => <TrajectoryRow key={`${item?.metric}-${item?.client}-${i}`} item={item} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <Target className="w-4 h-4 shrink-0" /> No imminent crossings
          </div>
        )}
      </div>
    </section>
  )
}

export function PacingPanel({ data }) {
  if (!data) return null
  const items = Array.isArray(data.metrics) ? data.metrics.slice(0, PACE_SHOWN) : []
  const count = data.total_count || items.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Clock className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Pacing</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Month-to-date progress vs. target</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {items.length > 0 ? (
          items.map((item, i) => <PacingRow key={`${item?.metric}-${item?.client}-${i}`} item={item} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <Clock className="w-4 h-4 shrink-0" /> No pacing data yet
          </div>
        )}
      </div>
    </section>
  )
}

export function ReallocationPanel({ data }) {
  if (!data) return null
  const items = Array.isArray(data.recommendations) ? data.recommendations.slice(0, REALLOC_SHOWN) : []
  const count = data.total_count || items.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <ArrowLeftRight className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Reallocation</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Budget-shift signals ranked by strength</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {items.length > 0 ? (
          items.map((r, i) => <ReallocationRow key={`${r?.from_channel}-${r?.to_channel}-${i}`} r={r} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <ArrowLeftRight className="w-4 h-4 shrink-0" /> No reallocation signals
          </div>
        )}
      </div>
    </section>
  )
}

export function ReallocationEfficacyPanel({ data }) {
  if (!data) return null
  const items = Array.isArray(data.moves) ? data.moves.slice(0, REALLOC_SHOWN) : []
  const count = data.total_count || items.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Reallocation efficacy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Did the last move deliver its projected lift?</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {items.length > 0 ? (
          items.map((r, i) => <ReallocationEfficacyRow key={`${r?.from_channel}-${r?.to_channel}-${i}`} r={r} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> No efficacy data yet
          </div>
        )}
      </div>
    </section>
  )
}

export function ReallocationEfficacyHealthPanel({ data }) {
  if (!data) return null
  const status = data.status || 'monitor'
  const healthMeta = reallocHealthMeta(status)
  const HealthIcon = healthMeta.Icon
  const summary = (data.narrative || '').trim()
  const actions = Array.isArray(data.actions) ? data.actions : []

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Stethoscope className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Reallocation health</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Overall verdict on the budget-shift playbook</p>
        </div>
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', healthMeta.pill)}>
          <HealthIcon className="w-3 h-3" /> {healthMeta.label}
        </span>
      </div>
      <div className="px-4 py-4">
        {summary && <p className="text-sm text-slate-600 leading-relaxed">{summary}</p>}
        {actions.length > 0 && (
          <div className="mt-3 space-y-1">
            {actions.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <ArrowRight className="w-3 h-3 text-brand-400 shrink-0" /> {a}
              </div>
            ))}
          </div>
        )}
        {!summary && !actions.length && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <Stethoscope className="w-4 h-4 shrink-0" /> Awaiting reallocation history
          </div>
        )}
      </div>
    </section>
  )
}

export function EfficacyPanel({ data }) {
  if (!data) return null
  const items = Array.isArray(data.metrics) ? data.metrics.slice(0, EFF_SHOWN) : []
  const count = data.total_count || items.length
  const summary = (data.narrative || '').trim()

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Efficacy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">How well each metric is tracking its benchmark</p>
        </div>
        {count > 0 && <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{count}</span>}
      </div>
      <div className="px-4 py-3">
        {summary && <p className="text-sm text-slate-600 leading-relaxed mb-2">{summary}</p>}
        {items.length > 0 ? (
          items.map((r, i) => <EfficacyRow key={`${r?.metric}-${r?.client}-${i}`} r={r} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
            <Sparkles className="w-4 h-4 shrink-0" /> No efficacy data yet
          </div>
        )}
      </div>
    </section>
  )
}
