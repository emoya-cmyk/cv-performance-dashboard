import {
  Activity, Clock, ShieldCheck, Gauge, ShieldAlert, Target, Crosshair,
  Radar, SlidersHorizontal, AlertTriangle, Eye, CheckCircle2, Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { directionIcon, metricLabel, fmtMetricValue } from '@/lib/insightMeta'
import DriverBreakdown from '@/components/DriverBreakdown'

// ── pulse TONE constants ──────────────────────────────────────────────────────
const PULSE_SHOWN = 8
const PULSE_TONE = {
  strong:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700',  bar: 'bg-emerald-500', label: 'Strong' },
  healthy:  { pill: 'border-teal-200 bg-teal-50 text-teal-700',          bar: 'bg-teal-500',     label: 'Healthy' },
  moderate: { pill: 'border-amber-200 bg-amber-50 text-amber-700',        bar: 'bg-amber-400',    label: 'Moderate' },
  weak:     { pill: 'border-rose-200 bg-rose-50 text-rose-700',           bar: 'bg-rose-500',     label: 'Weak' },
  absent:   { pill: 'border-slate-200 bg-slate-50 text-slate-500',        bar: 'bg-slate-300',    label: 'Absent' },
}
const RELIABILITY_TONE = {
  high:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: ShieldCheck, label: 'Reliable' },
  medium: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       Icon: Gauge,       label: 'Mixed' },
  low:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',          Icon: ShieldAlert, label: 'Unreliable' },
}
const ACCURACY_TONE = {
  high:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: Target,    label: 'On-target' },
  medium: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       Icon: Crosshair, label: 'Partial' },
  low:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',          Icon: AlertTriangle, label: 'Off-target' },
}
const TUNING_TONE = {
  aggressive: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          Icon: SlidersHorizontal, label: 'Aggressive' },
  moderate:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       Icon: SlidersHorizontal, label: 'Moderate' },
  conservative:{ pill: 'border-emerald-200 bg-emerald-50 text-emerald-700',Icon: SlidersHorizontal, label: 'Conservative' },
}
const PULSE_POSTURE = {
  realtime: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: Activity,  label: 'Real-time' },
  recent:   { pill: 'border-teal-200 bg-teal-50 text-teal-700',          Icon: Clock,     label: 'Recent' },
  lagged:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       Icon: Clock,     label: 'Lagged' },
  stale:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',          Icon: AlertTriangle, label: 'Stale' },
}
const CONFIDENCE_TONE = {
  high:   { text: 'text-emerald-600', label: 'High' },
  medium: { text: 'text-amber-600',   label: 'Medium' },
  low:    { text: 'text-rose-600',    label: 'Low' },
}
const BRIEFING_STAT_TONE = {
  positive: { val: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  negative: { val: 'text-rose-700',    bg: 'bg-rose-50',    border: 'border-rose-200' },
  neutral:  { val: 'text-slate-700',   bg: 'bg-slate-50',   border: 'border-slate-200' },
}
const CONTINUITY_CHIP = {
  maintained: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: CheckCircle2,  label: 'Maintained' },
  disrupted:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          Icon: AlertTriangle, label: 'Disrupted' },
  new:        { pill: 'border-sky-200 bg-sky-50 text-sky-700',             Icon: Sparkles,      label: 'New' },
  resumed:    { pill: 'border-teal-200 bg-teal-50 text-teal-700',          Icon: Activity,      label: 'Resumed' },
}
const ACT_TODAY_SHOWN = 5
const LANE_TONE = {
  urgent:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',    dot: 'bg-rose-500',    label: 'Urgent' },
  soon:    { pill: 'border-amber-200 bg-amber-50 text-amber-700', dot: 'bg-amber-500',   label: 'Soon' },
  routine: { pill: 'border-sky-200 bg-sky-50 text-sky-700',       dot: 'bg-sky-400',     label: 'Routine' },
  monitor: { pill: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-400',   label: 'Monitor' },
}

// ── internal helpers ──────────────────────────────────────────────────────────
function pulseTone(score) {
  if (!Number.isFinite(score)) return PULSE_TONE.absent
  if (score >= 0.8) return PULSE_TONE.strong
  if (score >= 0.6) return PULSE_TONE.healthy
  if (score >= 0.4) return PULSE_TONE.moderate
  if (score > 0) return PULSE_TONE.weak
  return PULSE_TONE.absent
}

function laneTone(urgency) {
  return LANE_TONE[urgency] || LANE_TONE.routine
}

// ── internal sub-components ───────────────────────────────────────────────────
function PulseRow({ r, index }) {
  const tone = pulseTone(r?.score)
  const DirIcon = directionIcon(r?.direction)
  const score = Number.isFinite(r?.score) ? r.score : 0
  const conf = CONFIDENCE_TONE[r?.confidence] || CONFIDENCE_TONE.medium
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className="text-[10px] font-black text-slate-300 tabular-nums">{index + 1}</span>
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <DirIcon className={cn('w-3.5 h-3.5', tone.pill.includes('rose') ? 'text-rose-500' : tone.pill.includes('emerald') ? 'text-emerald-500' : tone.pill.includes('amber') ? 'text-amber-500' : 'text-slate-400')} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(r?.metric)}</span>
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', tone.pill)}>{tone.label}</span>
          {r?.confidence && (
            <span className={cn('text-[10px] font-semibold', conf.text)}>{conf.label} confidence</span>
          )}
        </div>
        {r?.value != null && (
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500 tabular-nums leading-tight">
            {fmtMetricValue(r.metric, r.value)}
            {r?.benchmark != null && (
              <span className="ml-1 text-slate-300">/ {fmtMetricValue(r.metric, r.benchmark)} bench</span>
            )}
          </p>
        )}
        {r?.diagnosis_message && (
          <DriverBreakdown message={r.diagnosis_message} diagnosis={r.diagnosis} tone={tone} audience="agency" />
        )}
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1 mt-0.5">
        <div className="relative w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={cn('absolute inset-y-0 left-0 rounded-full transition-all', tone.bar)} style={{ width: `${Math.round(score * 100)}%` }} />
        </div>
        <span className="text-[10px] font-black text-slate-400 tabular-nums">{Math.round(score * 100)}%</span>
      </div>
    </div>
  )
}

function BriefingStat({ label, value, tone: toneKey = 'neutral' }) {
  const tone = BRIEFING_STAT_TONE[toneKey] || BRIEFING_STAT_TONE.neutral
  return (
    <div className={cn('flex flex-col items-center rounded-xl border px-3 py-2 min-w-[72px]', tone.bg, tone.border)}>
      <span className={cn('text-lg font-black leading-none tabular-nums', tone.val)}>{value}</span>
      <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400 text-center leading-tight">{label}</span>
    </div>
  )
}

function ContinuityChip({ status }) {
  const meta = CONTINUITY_CHIP[status] || CONTINUITY_CHIP.maintained
  const Icon = meta.Icon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', meta.pill)}>
      <Icon className="w-3 h-3" /> {meta.label}
    </span>
  )
}

function ContinuityRibbon({ continuity }) {
  if (!continuity || typeof continuity !== 'object') return null
  const entries = Object.entries(continuity).filter(([, v]) => v)
  if (!entries.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {entries.map(([key, status]) => (
        <div key={key} className="flex items-center gap-1">
          <span className="text-[10px] font-semibold text-slate-500 capitalize">{key.replace(/_/g, ' ')}:</span>
          <ContinuityChip status={status} />
        </div>
      ))}
    </div>
  )
}

function ActTodayRow({ item, index }) {
  const tone = laneTone(item?.urgency)
  const DirIcon = directionIcon(item?.direction)
  return (
    <div className={cn('flex items-start gap-2.5 py-1.5', index > 0 && 'border-t border-slate-50')}>
      <div className="flex items-center gap-1 w-5 shrink-0 mt-0.5">
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', tone.dot)} />
      </div>
      <div className="w-6 h-6 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={{ background: '#f8fafc' }}>
        <DirIcon className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-bold text-slate-800 leading-tight">{metricLabel(item?.metric)}</span>
          <span className={cn('inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', tone.pill)}>{tone.label}</span>
        </div>
        {item?.action && (
          <p className="mt-0.5 text-[11px] font-medium text-slate-500 leading-snug">{item.action}</p>
        )}
        {item?.due && (
          <p className="mt-0.5 text-[10px] font-semibold text-slate-400 leading-tight">Due: {item.due}</p>
        )}
      </div>
    </div>
  )
}

// ── exported components ───────────────────────────────────────────────────────
export function PulseBriefingBanner({ data }) {
  if (!data) return null
  const { overall_pulse, reliability, accuracy, tuning, posture, stats, continuity } = data
  const tone = pulseTone(overall_pulse?.score)
  const relMeta = RELIABILITY_TONE[reliability?.level] || null
  const accMeta = ACCURACY_TONE[accuracy?.level] || null
  const tuneMeta = TUNING_TONE[tuning?.level] || null
  const postureMeta = PULSE_POSTURE[posture] || null

  return (
    <div className="rounded-2xl border border-brand-100 bg-white shadow-sm px-4 pt-4 pb-3">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Live pulse</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight">Agency performance signal right now</p>
        </div>
        {overall_pulse?.score != null && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.bar)} /> {tone.label}
          </span>
        )}
        {postureMeta && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', postureMeta.pill)}>
            <postureMeta.Icon className="w-3 h-3" /> {postureMeta.label}
          </span>
        )}
      </div>

      {stats && (
        <div className="flex flex-wrap gap-2 mb-3">
          {stats.map((s, i) => (
            <BriefingStat key={i} label={s.label} value={s.value} tone={s.tone} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {relMeta && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', relMeta.pill)}>
            <relMeta.Icon className="w-3 h-3" /> {relMeta.label}
          </span>
        )}
        {accMeta && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', accMeta.pill)}>
            <accMeta.Icon className="w-3 h-3" /> {accMeta.label}
          </span>
        )}
        {tuneMeta && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tuneMeta.pill)}>
            <tuneMeta.Icon className="w-3 h-3" /> {tuneMeta.label}
          </span>
        )}
      </div>

      {continuity && <ContinuityRibbon continuity={continuity} />}

      {overall_pulse?.summary && (
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">{overall_pulse.summary}</p>
      )}
    </div>
  )
}

export function ActTodayStrip({ data }) {
  if (!data) return null
  const items = Array.isArray(data.items) ? data.items.slice(0, ACT_TODAY_SHOWN) : []
  if (!items.length) return null
  return (
    <div className="rounded-2xl border border-brand-100 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Eye className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Act today</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight">Top actions sorted by urgency</p>
        </div>
        <span className="ml-auto text-[11px] font-bold text-slate-400 tabular-nums">{items.length}</span>
      </div>
      <div className="px-4 py-2">
        {items.map((item, i) => (
          <ActTodayRow key={`${item?.metric}-${i}`} item={item} index={i} />
        ))}
      </div>
    </div>
  )
}

export function PulsePanel({ data }) {
  if (!data) return null
  const rows = Array.isArray(data.metrics) ? data.metrics.slice(0, PULSE_SHOWN) : []
  const overall = data.overall_pulse || {}
  const tone = pulseTone(overall?.score)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Pulse metrics</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Per-metric live readings</p>
        </div>
        {overall?.score != null && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.bar)} /> {tone.label}
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        {rows.length > 0 ? (
          rows.map((r, i) => <PulseRow key={`${r?.metric}-${i}`} r={r} index={i} />)
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Activity className="w-4 h-4 shrink-0" /> No pulse data yet
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Live readings weighted by reliability and recency — higher score = stronger positive signal. Agency-only.
        </p>
      </div>
    </section>
  )
}
