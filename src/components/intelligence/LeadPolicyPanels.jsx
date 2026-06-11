import { useState, useEffect, useCallback } from 'react'
import {
  Stethoscope, Radar, Wrench, Loader2, AlertTriangle, RefreshCw,
  ShieldCheck, AlertOctagon, CheckCircle2, Activity, Minus, Clock,
  ArrowUpCircle, Scissors, SlidersHorizontal, Crosshair, RotateCcw,
  Gauge, Scale, ShieldAlert, TrendingDown, Inbox, Check,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { laneLabel } from './BriefPanels'

// ── lead-policy TONE constants ────────────────────────────────────────────────
const LEAD_POLICY_TONE = {
  tuned:     { pill: 'border-teal-200 bg-teal-50 text-teal-700',    dot: 'bg-teal-500',  label: 'Self-tuned' },
  idle:      { pill: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-300', label: 'Holding neutral' },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-300', label: 'Abstaining' },
}

const LEAD_DIR_TONE = {
  promote: { fill: 'bg-emerald-500', text: 'text-emerald-700', label: 'Lead more' },
  demote:  { fill: 'bg-amber-400',   text: 'text-amber-600',   label: 'Ease off' },
  neutral: { fill: 'bg-slate-300',   text: 'text-slate-400',   label: 'Even' },
}

const LEAD_HEALTH_TONE = {
  unstable:    { pill: 'border-rose-200 bg-rose-50 text-rose-700',       dot: 'bg-rose-500',    text: 'text-rose-500',    label: 'Oscillating',   Icon: AlertOctagon },
  constrained: { pill: 'border-amber-200 bg-amber-50 text-amber-700',    dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'At its bounds', Icon: Gauge },
  flagged:     { pill: 'border-orange-200 bg-orange-50 text-orange-700', dot: 'bg-orange-500',  text: 'text-orange-500',  label: 'Floor masking', Icon: ShieldAlert },
  settling:    { pill: 'border-sky-200 bg-sky-50 text-sky-700',          dot: 'bg-sky-500',     text: 'text-sky-500',     label: 'Settling',      Icon: Activity },
  stable:      { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Stable',     Icon: ShieldCheck },
  idle:        { pill: 'border-slate-200 bg-slate-50 text-slate-500',    dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Idle',          Icon: Minus },
  abstained:   { pill: 'border-slate-200 bg-slate-50 text-slate-500',    dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining',    Icon: Minus },
}

const LEAD_HEALTH_ACTION = {
  revert_to_neutral: { tone: 'border-rose-200 bg-rose-50 text-rose-700',       Icon: Wrench,      label: 'Reverted to neutral',        auto: true },
  widen_bounds:      { tone: 'border-amber-200 bg-amber-50 text-amber-700',    Icon: Scale,       label: 'Consider widening the band', auto: false },
  investigate_floor: { tone: 'border-orange-200 bg-orange-50 text-orange-700', Icon: ShieldAlert, label: 'Investigate the floor',      auto: false },
  hold:              { tone: 'border-sky-200 bg-sky-50 text-sky-700',          Icon: Activity,    label: 'Hold steady',                auto: false },
  trust:             { tone: 'border-emerald-200 bg-emerald-50 text-emerald-700', Icon: Check,    label: 'Trust the loop',             auto: false },
  none:              null,
}

const LEAD_HEALTH_LANE = {
  oscillating:    { fill: 'bg-rose-500',    text: 'text-rose-700',    badge: 'border-rose-200 bg-rose-50 text-rose-600',       label: 'Oscillating' },
  saturated_high: { fill: 'bg-amber-500',   text: 'text-amber-700',   badge: 'border-amber-200 bg-amber-50 text-amber-600',    label: 'Pinned high' },
  saturated_low:  { fill: 'bg-amber-500',   text: 'text-amber-700',   badge: 'border-amber-200 bg-amber-50 text-amber-600',    label: 'Pinned low' },
  floor_masked:   { fill: 'bg-orange-500',  text: 'text-orange-700',  badge: 'border-orange-200 bg-orange-50 text-orange-600', label: 'Floor-masked' },
  settling:       { fill: 'bg-sky-400',     text: 'text-sky-600',     badge: 'border-sky-200 bg-sky-50 text-sky-600',          label: 'Settling' },
  stable:         { fill: 'bg-emerald-500', text: 'text-emerald-700', badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', label: 'Stable' },
  idle:           { fill: 'bg-slate-300',   text: 'text-slate-400',   badge: 'border-slate-200 bg-slate-50 text-slate-500',    label: 'Idle' },
}

const LEAD_HEALTH_RANK = { oscillating: 0, saturated_high: 1, saturated_low: 1, floor_masked: 2, settling: 3, stable: 4, idle: 5 }

const LEAD_GOV_TONE = {
  corrected: { pill: 'border-violet-200 bg-violet-50 text-violet-700',    dot: 'bg-violet-500',  text: 'text-violet-500',  label: 'Corrected',  Icon: Wrench },
  advised:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'Advisories', Icon: Scale },
  clean:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Steady',     Icon: ShieldCheck },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining', Icon: Minus },
}

const LEAD_GOV_ACTION = {
  neutralize:    { badge: 'border-violet-200 bg-violet-50 text-violet-600', text: 'text-violet-600', Icon: Scissors,    label: 'Reset',      changed: true },
  hold_at_bound: { badge: 'border-amber-200 bg-amber-50 text-amber-600',    text: 'text-amber-600',  Icon: Gauge,       label: 'Held',       changed: false },
  respect_floor: { badge: 'border-indigo-200 bg-indigo-50 text-indigo-600', text: 'text-indigo-600', Icon: ShieldCheck, label: 'Floor kept', changed: false },
}

const LEAD_GOV_RANK = { neutralize: 0, hold_at_bound: 1, respect_floor: 2 }

const LEAD_AUDIT_TONE = {
  churning:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    text: 'text-rose-500',    label: 'Churning',   Icon: AlertOctagon },
  effective: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Effective',  Icon: ShieldCheck },
  quiet:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Quiet',      Icon: Minus },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining', Icon: Clock },
}

const LEAD_AUDIT_OUTCOME = {
  recurring:    { badge: 'border-rose-200 bg-rose-50 text-rose-600',          text: 'text-rose-600',    Icon: AlertOctagon, label: 'Recurring',    escalate: true,  rank: 0 },
  intermittent: { badge: 'border-amber-200 bg-amber-50 text-amber-600',       text: 'text-amber-600',   Icon: Activity,     label: 'Intermittent', escalate: false, rank: 1 },
  resolved:     { badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', text: 'text-emerald-600', Icon: CheckCircle2, label: 'Resolved',     escalate: false, rank: 2 },
  one_off:      { badge: 'border-slate-200 bg-slate-50 text-slate-500',       text: 'text-slate-500',   Icon: Minus,        label: 'One-off',      escalate: false, rank: 3 },
}

const LEAD_AUDIT_RANK = { recurring: 0, intermittent: 1, resolved: 2, one_off: 3 }

const LEAD_REMEDY_TONE = {
  remediation_proposed: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'Fix staged', Icon: Wrench },
  steady:               { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Holding',    Icon: ShieldCheck },
  abstained:            { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Waiting',    Icon: Clock },
}

const LEAD_REMEDY_KIND = {
  widen_neutral_band: { badge: 'border-sky-200 bg-sky-50 text-sky-700',     text: 'text-sky-600',   Icon: SlidersHorizontal, label: 'Widen dead-band', rung: 1 },
  tighten_bounds:     { badge: 'border-amber-200 bg-amber-50 text-amber-700', text: 'text-amber-600', Icon: Scissors,          label: 'Tighten bounds',  rung: 2 },
  pin_neutral:        { badge: 'border-rose-200 bg-rose-50 text-rose-700',    text: 'text-rose-600',  Icon: Crosshair,         label: 'Pin to neutral',  rung: 3 },
}

const LEAD_REMEDY_ABSTAIN = {
  safety_floored: { badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', text: 'text-emerald-600', Icon: ShieldCheck,  label: 'Safety floor', reason: 'the emergency lane — never tuned down, by design' },
  at_ceiling:     { badge: 'border-rose-200 bg-rose-50 text-rose-600',          text: 'text-rose-600',    Icon: AlertOctagon, label: 'At ceiling',   reason: 'every safe structural move is spent — a person decides the next step' },
}

// ── internal helper functions ─────────────────────────────────────────────────
function leadHealthEvidence(lane) {
  const n = (k) => (lane && Number.isFinite(lane[k]) ? lane[k] : 0)
  const mornings = (v) => `${v} ${v === 1 ? 'morning' : 'mornings'}`
  switch (lane?.state) {
    case 'oscillating':    return `${n('flips')} reversals across ${mornings(n('present'))}`
    case 'saturated_high': return `pinned at the ceiling · ${mornings(n('high_run'))}`
    case 'saturated_low':  return `pinned at the floor · ${mornings(n('low_run'))}`
    case 'floor_masked':   return `floor-caught · ${mornings(n('mask_runs'))} running`
    case 'settling':       return `still converging · spread ${n('spread').toFixed(2)}`
    case 'stable':         return `converged · holding ×${(Number.isFinite(lane?.last_weight) ? lane.last_weight : 1).toFixed(2)}`
    default:               return 'even weight — never tuned'
  }
}

function leadHealthHeadline(status) {
  switch (status) {
    case 'unstable':    return 'The loop is chasing noise — reverted to a neutral lead order'
    case 'constrained': return 'A lane has run out of band — the nudge has become a wall'
    case 'flagged':     return 'The safety floor is masking a persistent overcall'
    case 'settling':    return 'Still converging on its learned priorities'
    case 'stable':      return 'Holding steady — the learned priorities have settled'
    case 'idle':        return 'Nothing has tuned off neutral yet — nothing to watch'
    default:            return 'Not enough graded history yet to judge the loop'
  }
}

function leadLaneSub(entry) {
  const judged = entry && Number.isFinite(entry.judged) ? entry.judged : 0
  const hr = entry && Number.isFinite(entry.hit_rate) ? entry.hit_rate : null
  if (judged > 0 && hr != null) return `${Math.round(hr * 100)}% held · ${judged} resolved`
  if (judged > 0) return `${judged} resolved`
  return 'building'
}

function govStateReason(state) {
  switch (state) {
    case 'oscillating':    return 'was thrashing morning to morning'
    case 'saturated_high': return 'pinned at the ceiling of its band'
    case 'saturated_low':  return 'pinned at the floor of its band'
    case 'floor_masked':   return 'the safety floor was masking an overcall'
    default:               return state ? String(state).replace(/_/g, ' ') : 'flagged by the monitor'
  }
}

function leadGovHeadline(status, governedStatus) {
  switch (status) {
    case 'corrected':
      return governedStatus === 'tuned'
        ? 'Reset the lane that was thrashing — the rest of the learned order stands'
        : 'Reset the only thrashing lane — the order rides neutral until it settles'
    case 'advised': return 'Nothing reset — held the pinned lanes and kept the floor for a human to weigh'
    case 'clean':   return 'Nothing to correct — the tuning loop is steady this morning'
    default:        return 'No trustworthy verdict to act on — the policy rides exactly as learned'
  }
}

function auditOutcomeReason(outcome, info) {
  const runs = Number.isFinite(info?.current_run) ? info.current_run : 0
  const corr = Number.isFinite(info?.corrections) ? info.corrections : 0
  switch (outcome) {
    case 'recurring':    return `needed the same reset ${runs} morning${runs === 1 ? '' : 's'} running`
    case 'resolved':     return 'the reset stuck — it stopped needing one'
    case 'intermittent': return `reset ${corr} time${corr === 1 ? '' : 's'}, on and off — never cleanly settled`
    case 'one_off':      return 'reset once, no recurrence since'
    default:             return 'no clear pattern yet'
  }
}

function leadAuditHeadline(status, recurringCount) {
  switch (status) {
    case 'churning':
      return recurringCount === 1
        ? 'A lane keeps needing the same reset — the safe corrective is not sticking, time for a human'
        : `${recurringCount} lanes keep needing the same reset — the safe corrective is not sticking, time for a human`
    case 'effective': return "The governor's resets are sticking — corrected lanes settled and stayed settled"
    case 'quiet':     return 'Nothing to second-guess — the governor has not had to correct anything'
    default:          return "Not enough governed mornings yet to judge the governor's own track record"
  }
}

function remedyN2(x) { return Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—' }

function remedyDelta(p) {
  if (!p || typeof p !== 'object') return ''
  switch (p.remedy) {
    case 'widen_neutral_band':
      return `dead-band ${remedyN2(p.from?.neutral_band)} → ${remedyN2(p.to?.neutral_band)}`
    case 'tighten_bounds':
      return `bounds ${remedyN2(p.from?.bounds?.min)}–${remedyN2(p.from?.bounds?.max)} → ${remedyN2(p.to?.bounds?.min)}–${remedyN2(p.to?.bounds?.max)}`
    case 'pin_neutral':
      return 'adaptive → pinned at 1.0'
    default:
      return ''
  }
}

function leadRemedyHeadline(status, count) {
  switch (status) {
    case 'remediation_proposed':
      return count === 1
        ? 'A structural fix is staged — one click, fully reversible'
        : `${count} structural fixes are staged — one click each, fully reversible`
    case 'steady':
      return "Nothing to remediate — the governor's resets are holding on their own"
    default:
      return 'Not enough audited history yet to stage a structural fix'
  }
}

// ── internal sub-components ───────────────────────────────────────────────────
function LeadPolicyLaneRow({ name, entry, bounds }) {
  const dir = entry?.direction || 'neutral'
  const tone = LEAD_DIR_TONE[dir] || LEAD_DIR_TONE.neutral
  const w = Number.isFinite(entry?.weight) ? entry.weight : 1
  const min = Number.isFinite(bounds?.min) ? bounds.min : 0.8
  const max = Number.isFinite(bounds?.max) ? bounds.max : 1.2
  const rightPct = max > 1 ? Math.min(1, Math.max(0, (w - 1) / (max - 1))) * 50 : 0
  const leftPct = min < 1 ? Math.min(1, Math.max(0, (1 - w) / (1 - min))) * 50 : 0
  const Icon = dir === 'promote' ? ArrowUpCircle : dir === 'demote' ? TrendingDown : Minus
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 leading-tight" title={name}>
          <span className="truncate">{name}</span>
          {entry?.safetyFloored && (
            <ShieldCheck className="w-3 h-3 text-indigo-500 shrink-0" title="Safety lane — promotable, never eased" />
          )}
        </div>
        <p className="text-[10px] font-medium text-slate-400 leading-tight tabular-nums truncate">{leadLaneSub(entry)}</p>
      </div>
      <div
        className="relative flex-1 h-2 rounded-full bg-slate-100 overflow-hidden"
        title={`weight ×${w.toFixed(2)} · neutral 1.00 · band ${min.toFixed(2)}–${max.toFixed(2)}`}
      >
        <div className="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-slate-300" />
        {rightPct > 0 && <div className={cn('absolute inset-y-0 left-1/2 rounded-r-full transition-all', tone.fill)} style={{ width: `${rightPct}%` }} />}
        {leftPct > 0 && <div className={cn('absolute inset-y-0 rounded-l-full transition-all', tone.fill)} style={{ right: '50%', width: `${leftPct}%` }} />}
      </div>
      <span className={cn('w-12 shrink-0 inline-flex items-center justify-end gap-0.5 text-[11px] font-black tabular-nums', tone.text)}>
        <Icon className="w-3 h-3 shrink-0" />×{w.toFixed(2)}
      </span>
    </div>
  )
}

function LeadHealthSeries({ series, bounds, state }) {
  const vals = Array.isArray(series) ? series : []
  const min = Number.isFinite(bounds?.min) ? bounds.min : 0.8
  const max = Number.isFinite(bounds?.max) ? bounds.max : 1.2
  const fill = (LEAD_HEALTH_LANE[state] || LEAD_HEALTH_LANE.idle).fill
  if (!vals.length) return null
  return (
    <div className="relative h-7 w-full flex items-stretch gap-px" title="Per-morning weight — up = led more, down = eased, tick = neutral, gap = ungraded">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-slate-200" />
      {vals.map((w, i) => {
        if (!Number.isFinite(w)) return <div key={i} className="flex-1" />
        if (w === 1) {
          return (
            <div key={i} className="relative flex-1">
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-slate-300" />
            </div>
          )
        }
        const up = w > 1
        const mag = up ? (max > 1 ? (w - 1) / (max - 1) : 0) : (min < 1 ? (1 - w) / (1 - min) : 0)
        const h = Math.max(Math.min(1, Math.max(0, mag)) * 50, 4)
        return (
          <div key={i} className="relative flex-1">
            <div
              className={cn('absolute left-1/2 -translate-x-1/2 w-[60%] min-w-[3px]', fill, up ? 'bottom-1/2 rounded-t-sm' : 'top-1/2 rounded-b-sm')}
              style={{ height: `${h}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

function LeadHealthLaneRow({ name, lane, bounds }) {
  const tone = LEAD_HEALTH_LANE[lane?.state] || LEAD_HEALTH_LANE.idle
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={name}>{name}</div>
        <span className={cn('mt-0.5 inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', tone.badge)}>
          {tone.label}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <LeadHealthSeries series={lane?.series} bounds={bounds} state={lane?.state} />
      </div>
      <span className={cn('w-28 shrink-0 text-right text-[10px] font-semibold leading-tight tabular-nums', tone.text)}>
        {leadHealthEvidence(lane)}
      </span>
    </div>
  )
}

function LeadGovInterventionRow({ intervention }) {
  const meta = LEAD_GOV_ACTION[intervention?.action] || LEAD_GOV_ACTION.hold_at_bound
  const Icon = meta.Icon
  const fw = Number.isFinite(intervention?.from_weight) ? intervention.from_weight : 1
  const tw = Number.isFinite(intervention?.to_weight) ? intervention.to_weight : fw
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(intervention?.lane)}>{laneLabel(intervention?.lane)}</div>
        <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">
        {govStateReason(intervention?.state)}
      </div>
      <span className={cn('w-24 shrink-0 text-right text-[11px] font-black tabular-nums', meta.text)}>
        {meta.changed
          ? <>×{fw.toFixed(2)} <span className="text-slate-300">→</span> ×{tw.toFixed(2)}</>
          : <>held ×{fw.toFixed(2)}</>}
      </span>
    </div>
  )
}

function LeadAuditLaneRow({ lane, info }) {
  const meta = LEAD_AUDIT_OUTCOME[info?.outcome] || LEAD_AUDIT_OUTCOME.one_off
  const Icon = meta.Icon
  const runs = Number.isFinite(info?.current_run) ? info.current_run : 0
  const corr = Number.isFinite(info?.corrections) ? info.corrections : 0
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(lane)}>{laneLabel(lane)}</div>
        <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">
        {auditOutcomeReason(info?.outcome, info)}
      </div>
      <span className={cn('w-24 shrink-0 text-right text-[11px] font-black tabular-nums', meta.text)}>
        {meta.escalate
          ? <>{runs}× running</>
          : <>{corr}× total</>}
      </span>
    </div>
  )
}

function RemediationProposalCard({ proposal }) {
  const meta = LEAD_REMEDY_KIND[proposal?.remedy] || LEAD_REMEDY_KIND.widen_neutral_band
  const Icon = meta.Icon
  const severity = Number.isFinite(proposal?.severity) ? proposal.severity : 1
  const delta = remedyDelta(proposal)
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
        <span className="text-[11px] font-bold text-slate-700 truncate" title={laneLabel(proposal?.lane)}>{laneLabel(proposal?.lane)}</span>
        <span className={cn('ml-auto text-[11px] font-black tabular-nums', meta.text)}>{severity}× running</span>
      </div>
      {delta && (
        <div className="mt-1.5">
          <code className="inline-block rounded bg-white border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 tabular-nums">{delta}</code>
        </div>
      )}
      {proposal?.rationale && (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400 leading-relaxed">{proposal.rationale}</p>
      )}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">
          <Wrench className="w-2.5 h-2.5" /> One click to apply
        </span>
        {proposal?.reversible && (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-600">
            <RotateCcw className="w-2.5 h-2.5" /> Reversible
          </span>
        )}
      </div>
    </div>
  )
}

function RemediationAbstainRow({ lane, reason }) {
  const meta = LEAD_REMEDY_ABSTAIN[reason] || LEAD_REMEDY_ABSTAIN.at_ceiling
  const Icon = meta.Icon
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(lane)}>{laneLabel(lane)}</div>
        <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed', meta.badge)}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">{meta.reason}</div>
    </div>
  )
}

// ── exported panel components ─────────────────────────────────────────────────
export function LeadPolicyPanel() {
  const [status, setStatus] = useState('loading')
  const [policy, setPolicy] = useState(null)
  const [error, setError] = useState('')

  const fetchPolicy = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const p = await api.getLeadPolicy()
      setPolicy(p); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load lead policy'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchPolicy() }, [fetchPolicy])

  const st = policy?.status || 'abstained'
  const tuned = st === 'tuned'
  const tone = LEAD_POLICY_TONE[st] || LEAD_POLICY_TONE.abstained
  const narrative = (policy?.narrative || '').trim()
  const days = policy?.requested?.days || 30
  const bounds = policy?.bounds || { min: 0.8, max: 1.2 }
  const bandPct = Math.round(((bounds.max ?? 1.2) - 1) * 100)
  const minSample = policy?.min_sample || 4
  const lanes = Object.entries(policy?.lanes || {})
    .sort((a, b) => {
      const da = Math.abs((a[1]?.weight ?? 1) - 1), db = Math.abs((b[1]?.weight ?? 1) - 1)
      if (db !== da) return db - da
      const fa = a[1]?.safetyFloored ? 1 : 0, fb = b[1]?.safetyFloored ? 1 : 0
      if (fb !== fa) return fb - fa
      return (b[1]?.judged || 0) - (a[1]?.judged || 0)
    })
    .slice(0, 6)
  const promoted = policy?.promoted || 0, demoted = policy?.demoted || 0, floored = policy?.floored || 0
  const adjusted = policy?.adjusted_count || 0

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Lead-selection policy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            How the brief weights each lane for the lead · last {days} days
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Lead policy: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        {status === 'done' && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500"
            title={`Each lane's weight is bounded to ±${bandPct}% of neutral — a reprioritisation, never a silencer.`}
          >
            <Scale className="w-3 h-3" /> ±{bandPct}% band
          </span>
        )}
        <button
          onClick={fetchPolicy}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Retuning the front-page lanes…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load lead policy'}</p>
            <button onClick={fetchPolicy} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            {tuned ? (
              <>
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{adjusted}</span>
                    <span className="text-[11px] font-bold text-slate-400">{adjusted === 1 ? 'lane retuned' : 'lanes retuned'}</span>
                  </div>
                  <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
                    {[
                      promoted > 0 ? `${promoted} promoted` : null,
                      demoted > 0 ? `${demoted} eased` : null,
                      floored > 0 ? `${floored} safety-floored` : null,
                    ].filter(Boolean).join(' · ')}
                    {' '}within a ±{bandPct}% band
                  </p>
                </div>
                {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </>
            ) : (
              <div className="flex items-start gap-2 text-sm text-slate-500">
                <Minus className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
                <p className="leading-relaxed">
                  {st === 'idle'
                    ? `Every lane holds at even weight — nothing has crossed the bar to move off neutral yet. A lane needs ${minSample}+ resolved leads to tune, and the safety lane only ever lifts. It sharpens as mornings close.`
                    : `Holding the front page byte-for-byte with the live pulse — the editorial-precision record isn't graded yet, so nothing is reprioritised. It fills in as leads resolve.`}
                </p>
              </div>
            )}

            {lanes.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Per-lane weight</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />ease</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />lead more</span>
                  </span>
                </div>
                <div className="space-y-2">
                  {lanes.map(([key, entry]) => (
                    <LeadPolicyLaneRow key={key} name={laneLabel(key)} entry={entry} bounds={bounds} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <Inbox className="w-4 h-4 shrink-0" />
                No trackable lead lanes yet — this fills in as the brief leads with movements worth following.
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">tune</span> half of editorial precision: each lane's recent hit-rate becomes a bounded weight the brief applies when it picks the one lead — <span className="font-semibold text-emerald-600">lead more</span> with a lane that keeps earning the front page, <span className="font-semibold text-amber-600">ease off</span> one that keeps overcalling. Neutral = <span className="tabular-nums font-semibold text-slate-500">×1.00</span>; the band is ±{bandPct}%, so it reprioritises but never silences. <span className="font-semibold text-indigo-600">act_now is safety-floored</span> — promotable, never eased, because burying a real emergency is worse than crying wolf. Abstains until the record is graded. Agency-only.
        </p>
      </div>
    </section>
  )
}

export function LeadPolicyHealthPanel() {
  const [status, setStatus] = useState('loading')
  const [health, setHealth] = useState(null)
  const [error, setError] = useState('')

  const fetchHealth = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const h = await api.getLeadPolicyHealth()
      setHealth(h); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load policy stability'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const st = health?.status || 'abstained'
  const tone = LEAD_HEALTH_TONE[st] || LEAD_HEALTH_TONE.abstained
  const HeadIcon = tone.Icon
  const action = LEAD_HEALTH_ACTION[health?.recommended_action] || null
  const ActionIcon = action?.Icon
  const narrative = (health?.narrative || '').trim()
  const headline = leadHealthHeadline(st)
  const windowUsed = health?.window_used || health?.requested?.days || 6
  const historyLen = health?.history_len || 0
  const bounds = health?.bounds || { min: 0.8, max: 1.2 }
  const counts = health?.counts || {}
  const concerns = [
    counts.oscillating > 0 ? `${counts.oscillating} oscillating` : null,
    counts.saturated > 0 ? `${counts.saturated} at bounds` : null,
    counts.masked > 0 ? `${counts.masked} floor-masked` : null,
    counts.settling > 0 ? `${counts.settling} settling` : null,
    counts.stable > 0 ? `${counts.stable} stable` : null,
  ].filter(Boolean)
  const lanes = Object.entries(health?.lanes || {})
    .sort((a, b) => {
      const ra = LEAD_HEALTH_RANK[a[1]?.state] ?? 9, rb = LEAD_HEALTH_RANK[b[1]?.state] ?? 9
      if (ra !== rb) return ra - rb
      return (b[1]?.present || 0) - (a[1]?.present || 0)
    })
    .slice(0, 6)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Activity className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Lead-policy stability</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Watching the tuning loop for thrash · last {windowUsed} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Loop stability: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Auditing the tuning loop…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load policy stability'}</p>
            <button onClick={fetchHealth} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {action && (
              <div className="mt-3">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold', action.tone)}>
                  <ActionIcon className="w-3.5 h-3.5" /> {action.label}
                </span>
                <p className="mt-1 text-[11px] font-medium text-slate-400 leading-relaxed">
                  {action.auto
                    ? 'Applied automatically — the loop reverted itself to a neutral lead order this run; no action needed.'
                    : 'Agency advisory — surfaced for a human to weigh, never auto-applied.'}
                </p>
              </div>
            )}

            {concerns.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {concerns.join(' · ')} <span className="text-slate-300">across {historyLen} graded {historyLen === 1 ? 'morning' : 'mornings'}</span>
              </p>
            )}

            {lanes.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Per-lane trajectory</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />thrash</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />settled</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {lanes.map(([key, lane]) => (
                    <LeadHealthLaneRow key={key} name={laneLabel(key)} lane={lane} bounds={bounds} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <Inbox className="w-4 h-4 shrink-0" />
                No lanes have moved off neutral yet — nothing to watch until the loop starts tuning.
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">Watch the watcher.</span> The lead-policy loop tunes itself each morning; this reads its last {windowUsed} weights per lane and flags the failure one snapshot hides — a lane <span className="font-semibold text-rose-600">oscillating</span> on noise, one <span className="font-semibold text-amber-600">pinned to its band</span>, or a real overcall the <span className="font-semibold text-orange-600">safety floor is masking</span>. Oscillation reverts that lane to neutral on its own; the rest are surfaced for a human. Agency-only.
        </p>
      </div>
    </section>
  )
}

export function LeadPolicyGovernancePanel() {
  const [status, setStatus] = useState('loading')
  const [gov, setGov] = useState(null)
  const [error, setError] = useState('')

  const fetchGov = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const g = await api.getLeadPolicyGovernance()
      setGov(g); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load policy governance'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchGov() }, [fetchGov])

  const st = gov?.status || 'abstained'
  const tone = LEAD_GOV_TONE[st] || LEAD_GOV_TONE.abstained
  const HeadIcon = tone.Icon
  const governedStatus = gov?.governed?.status || 'idle'
  const narrative = (gov?.narrative || '').trim()
  const headline = leadGovHeadline(st, governedStatus)
  const windowUsed = gov?.requested?.days || 6
  const counts = gov?.counts || {}
  const interventions = Array.isArray(gov?.interventions) ? gov.interventions : []
  const laneTotal = Object.keys(gov?.snapshot?.lanes || {}).length
  const tally = [
    counts.neutralized > 0 ? `${counts.neutralized} reset to neutral` : null,
    counts.held > 0 ? `${counts.held} held at bound` : null,
    counts.floored_respected > 0 ? `${counts.floored_respected} floor-respected` : null,
    counts.passed > 0 ? `${counts.passed} left untouched` : null,
  ].filter(Boolean)
  const ordered = interventions
    .slice()
    .sort((a, b) => (LEAD_GOV_RANK[a?.action] ?? 9) - (LEAD_GOV_RANK[b?.action] ?? 9))
    .slice(0, 6)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Stethoscope className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Lead-policy governance</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            What the loop did about the verdict · last {windowUsed} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Governance: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchGov}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Reading what the governor did…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load policy governance'}</p>
            <button onClick={fetchGov} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {st === 'corrected' && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-violet-100 bg-violet-50/50 px-2.5 py-2">
                <Scissors className="w-3.5 h-3.5 text-violet-500 shrink-0 mt-0.5" />
                <p className="text-[11px] font-medium text-slate-500 leading-relaxed">
                  {governedStatus === 'tuned'
                    ? <><span className="font-semibold text-violet-700">A learned order still applies.</span> Only the thrashing lane snapped to neutral — the lanes that earned their lift ride untouched, where the blunt all-or-nothing revert would have lost them.</>
                    : <><span className="font-semibold text-violet-700">The order rides neutral for now.</span> The reset lane was the only one carrying weight, so the brief leads in its default order until the loop settles.</>}
                  {' '}The pre-governance weights are kept in the snapshot — every reset is reversible.
                </p>
              </div>
            )}

            {tally.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {tally.join(' · ')} <span className="text-slate-300">across {laneTotal} {laneTotal === 1 ? 'lane' : 'lanes'}</span>
              </p>
            )}

            {ordered.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">What the governor touched</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-violet-500" />reset</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />held</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {ordered.map((iv, i) => (
                    <LeadGovInterventionRow key={`${iv?.lane || 'lane'}-${i}`} intervention={iv} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {st === 'abstained'
                  ? 'No verdict to act on yet — the governor stays its hand until the loop can be judged.'
                  : 'Nothing needed correcting — every lane is learning cleanly.'}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The governor.</span> The monitor above diagnoses the loop; this <span className="font-semibold text-violet-600">acts</span> on the verdict — surgically, per lane, with no human in the path. It <span className="font-semibold text-violet-600">resets</span> only a thrashing lane to neutral and keeps every earned lane live; a lane <span className="font-semibold text-amber-600">pinned to its band</span> or one the <span className="font-semibold text-indigo-600">floor is protecting</span> it logs for a human rather than auto-widening anything. Idempotent, snapshot-backed, reversible. Agency-only.
        </p>
      </div>
    </section>
  )
}

export function LeadPolicyGovernanceAuditPanel() {
  const [status, setStatus] = useState('loading')
  const [audit, setAudit] = useState(null)
  const [error, setError] = useState('')

  const fetchAudit = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const a = await api.getLeadPolicyGovernanceAudit()
      setAudit(a); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load governance audit'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchAudit() }, [fetchAudit])

  const st = audit?.status || 'abstained'
  const tone = LEAD_AUDIT_TONE[st] || LEAD_AUDIT_TONE.abstained
  const HeadIcon = tone.Icon
  const rec = audit?.recommendation || { action: 'none', lanes: [] }
  const escalate = rec.action === 'escalate'
  const escalateLanes = Array.isArray(rec.lanes) ? rec.lanes : []
  const escalateLaneText = escalateLanes.map(laneLabel).join(', ')
  const narrative = (audit?.narrative || '').trim()
  const windowUsed = audit?.requested?.days || audit?.window_used || 8
  const counts = audit?.counts || {}
  const recurringCount = Number.isFinite(counts.recurring) ? counts.recurring : escalateLanes.length
  const correctedMornings = Number.isFinite(counts.corrected_mornings) ? counts.corrected_mornings : 0
  const headline = leadAuditHeadline(st, recurringCount || 1)
  const lanes = audit?.lanes && typeof audit.lanes === 'object' ? audit.lanes : {}
  const tally = [
    counts.recurring > 0 ? `${counts.recurring} recurring` : null,
    counts.intermittent > 0 ? `${counts.intermittent} intermittent` : null,
    counts.resolved > 0 ? `${counts.resolved} resolved` : null,
    counts.one_off > 0 ? `${counts.one_off} one-off` : null,
  ].filter(Boolean)
  const ordered = Object.entries(lanes)
    .sort((a, b) => (LEAD_AUDIT_RANK[a[1]?.outcome] ?? 9) - (LEAD_AUDIT_RANK[b[1]?.outcome] ?? 9))
    .slice(0, 6)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Governance audit</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            Is the governor's fix sticking? · last {windowUsed} mornings
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Audit: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchAudit}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Auditing the governor's track record…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load governance audit'}</p>
            <button onClick={fetchAudit} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {escalate && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50/50 px-2.5 py-2">
                <ArrowUpCircle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <p className="text-[11px] font-medium text-slate-500 leading-relaxed">
                  <span className="font-semibold text-rose-700">Escalating to a human.</span> The governor keeps applying the one safe corrective to {escalateLanes.length === 1 ? 'this lane' : 'these lanes'} and it keeps coming back. {escalateLaneText && <><span className="font-semibold text-slate-600">{escalateLaneText}</span> — </>}the fix it can make on its own is not enough to reach the root cause. It will keep holding the line every morning; this only flags that a person should look.
                </p>
              </div>
            )}

            {tally.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {tally.join(' · ')} <span className="text-slate-300">· {correctedMornings} corrected {correctedMornings === 1 ? 'morning' : 'mornings'}</span>
              </p>
            )}

            {ordered.length > 0 ? (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">The governor's track record, by lane</p>
                  <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />recurring</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />resolved</span>
                  </span>
                </div>
                <div className="space-y-2.5">
                  {ordered.map(([lane, info], i) => (
                    <LeadAuditLaneRow key={`${lane}-${i}`} lane={lane} info={info} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {st === 'abstained'
                  ? 'No governed history to audit yet — the auditor waits until the governor has a track record.'
                  : 'No lane has needed correcting — there is nothing for the auditor to second-guess.'}
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The auditor.</span> The governor acts every morning; this checks whether its fix <span className="font-semibold text-emerald-600">stuck</span>. When the same lane keeps needing the same reset morning after morning, the safe corrective is not reaching the root cause — so it <span className="font-semibold text-rose-600">escalates that lane to a human</span> rather than letting the loop churn forever. The governor keeps holding the line meanwhile. Recommends, never acts. Agency-only.
        </p>
      </div>
    </section>
  )
}

export function LeadPolicyGovernanceRemediationPanel() {
  const [status, setStatus] = useState('loading')
  const [remediation, setRemediation] = useState(null)
  const [error, setError] = useState('')

  const fetchRemediation = useCallback(async () => {
    setStatus('loading'); setError('')
    try {
      const r = await api.getLeadPolicyGovernanceRemediation()
      setRemediation(r); setStatus('done')
    } catch (e) {
      setError(e?.message || 'Could not load governance remediation'); setStatus('error')
    }
  }, [])

  useEffect(() => { fetchRemediation() }, [fetchRemediation])

  const st = remediation?.status || 'abstained'
  const tone = LEAD_REMEDY_TONE[st] || LEAD_REMEDY_TONE.abstained
  const HeadIcon = tone.Icon
  const proposals = Array.isArray(remediation?.proposals) ? remediation.proposals : []
  const abstained = Array.isArray(remediation?.abstained_lanes) ? remediation.abstained_lanes : []
  const narrative = (remediation?.narrative || '').trim()
  const headline = leadRemedyHeadline(st, proposals.length || 1)
  const kinds = proposals.reduce((m, p) => { m[p?.remedy] = (m[p?.remedy] || 0) + 1; return m }, {})
  const tally = [
    kinds.widen_neutral_band > 0 ? `${kinds.widen_neutral_band} widen` : null,
    kinds.tighten_bounds > 0 ? `${kinds.tighten_bounds} tighten` : null,
    kinds.pin_neutral > 0 ? `${kinds.pin_neutral} pin` : null,
  ].filter(Boolean)

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Wrench className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Governance remediation</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The structural fix behind the auditor's escalation
          </p>
        </div>
        {status === 'done' && (
          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', tone.pill)} title={`Remediation: ${st}`}>
            <span className={cn('w-1.5 h-1.5 rounded-full', tone.dot)} /> {tone.label}
          </span>
        )}
        <button
          onClick={fetchRemediation}
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
            <Loader2 className="w-4 h-4 animate-spin" /> Computing the least-aggressive structural fix…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load governance remediation'}</p>
            <button onClick={fetchRemediation} className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition">
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            <div className="flex items-start gap-2">
              <HeadIcon className={cn('w-4 h-4 shrink-0 mt-0.5', tone.text)} />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
                {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
              </div>
            </div>

            {tally.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold text-slate-400 leading-relaxed">
                {tally.join(' · ')}
                {abstained.length > 0 && <span className="text-slate-300"> · {abstained.length} set aside</span>}
              </p>
            )}

            {proposals.length > 0 ? (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Staged structural fixes, most-pressing first</p>
                <div className="space-y-2">
                  {proposals.map((p, i) => (
                    <RemediationProposalCard key={`${p?.lane}-${i}`} proposal={p} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {st === 'abstained'
                  ? 'No audited escalation to act on yet — the remediator waits until the auditor has flagged a churn.'
                  : "Nothing to restructure — the governor's safe resets are holding, so no knob needs changing."}
              </div>
            )}

            {abstained.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Set aside, not remediated</p>
                <div className="space-y-2.5">
                  {abstained.slice(0, 6).map((a, i) => (
                    <RemediationAbstainRow key={`${a?.lane}-${i}`} lane={a?.lane} reason={a?.reason} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The remediator.</span> The auditor escalates a churning lane; the per-morning reset can't fix it because it resets the <span className="font-semibold text-slate-600">output</span>, not the knobs that re-derive it. This stages the least-aggressive <span className="font-semibold text-sky-600">structural</span> change that would still the loop — widen the dead-band, tighten bounds, or pin to neutral — deepening only when the gentler move has already failed. Every fix is <span className="font-semibold text-amber-600">one click</span> and <span className="font-semibold text-emerald-600">reversible</span>; never auto-applied, never on the safety floor. Agency-only.
        </p>
      </div>
    </section>
  )
}
