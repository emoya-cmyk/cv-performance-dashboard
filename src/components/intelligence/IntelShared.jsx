import { useState, useEffect, useCallback } from 'react'
import {
  AlertTriangle, Brain, Loader2, RefreshCw, Clock, Sparkles, ShieldCheck,
  Radar, SlidersHorizontal, ArrowUpCircle, Target, TrendingDown,
  CheckCircle2, ChevronUp, ChevronDown, Crosshair, Eye, Check, Plug,
  BarChart3, Scale, Award,
} from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  severityMeta, kindMeta, directionIcon, metricLabel, urgencyMeta,
  precisionMeta, hasLearnedPrecision, precisionTooltip,
  forecastRange, FORECAST_RANGE_KEYS, fmtMetricValue, attributionView,
  correlateView, impactsView, escalationView,
  healthBandMeta, recoveryMeta, timeAgo, recapPosture,
} from '@/lib/insightMeta'
import StreamStatus from '@/components/StreamStatus'

/* ── alert inventory ─────────────────────────────────────────────────────────── */
export function FiredAlertsPanel({ alerts }) {
  const [open, setOpen] = useState(false)
  if (!Array.isArray(alerts) || alerts.length === 0) return null
  const shown = open ? alerts : alerts.slice(0, 5)
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Alert inventory</h2>
        <span className="text-[11px] font-semibold text-slate-400">{alerts.length} fired · last 100</span>
      </div>
      <div className="divide-y divide-slate-50">
        {shown.map((a, i) => (
          <div key={i} className="px-4 py-2.5 flex items-start gap-3">
            <div className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', a.severity === 'critical' ? 'bg-rose-500' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-400')} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-800 truncate">{a.title || 'Alert'}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] font-semibold text-slate-400 truncate">{a.client_name || '—'}</span>
                {a.fired_at && <span className="text-[10px] text-slate-300">{a.fired_at}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {alerts.length > 5 && (
        <div className="px-4 py-2 border-t border-slate-50 text-center">
          <button onClick={() => setOpen(o => !o)} className="text-[11px] font-bold text-brand-500 hover:text-brand-600 transition">
            {open ? 'Show less' : `Show all ${alerts.length}`}
          </button>
        </div>
      )}
    </div>
  )
}

/* ── hero / page header ──────────────────────────────────────────────────────── */
export function Hero({ running, onRun, disabled, connected, lastEventAt, ageMin }) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-brand-50 flex items-center justify-center shrink-0">
          <Brain className="w-5 h-5 text-brand-500" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-black text-slate-900">Intelligence</h1>
            {USE_API && <StreamStatus connected={connected} lastEventAt={lastEventAt} />}
            {ageMin != null && ageMin > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                <Clock className="w-3 h-3" /> {ageMin}m ago
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 font-medium">Autonomous portfolio analyst · sweeps every client nightly</p>
        </div>
      </div>
      <button
        onClick={onRun}
        disabled={disabled || running}
        className="inline-flex items-center gap-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-bold px-4 py-2 transition disabled:opacity-40"
      >
        {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        {running ? 'Running…' : 'Run sweep'}
      </button>
    </div>
  )
}

/* ── stat card ────────────────────────────────────────────────────────────────── */
const TONES = {
  brand:  { bg: 'bg-brand-50',   text: 'text-brand-600',   active: 'ring-2 ring-brand-400 bg-brand-50' },
  rose:   { bg: 'bg-rose-50',    text: 'text-rose-600',    active: 'ring-2 ring-rose-400 bg-rose-50' },
  amber:  { bg: 'bg-amber-50',   text: 'text-amber-600',   active: 'ring-2 ring-amber-400 bg-amber-50' },
  sky:    { bg: 'bg-sky-50',     text: 'text-sky-600',     active: 'ring-2 ring-sky-400 bg-sky-50' },
  emerald:{ bg: 'bg-emerald-50', text: 'text-emerald-600', active: 'ring-2 ring-emerald-400 bg-emerald-50' },
}

export function StatCard({ label, value, tone = 'brand', active, onClick }) {
  const t = TONES[tone] || TONES.brand
  return (
    <button
      onClick={onClick}
      className={cn(
        'bg-white rounded-2xl border border-slate-100 shadow-sm p-4 text-left w-full transition hover:shadow-md',
        active ? t.active : '',
      )}
    >
      <div className={cn('text-2xl font-black tabular-nums', t.text)}>{value}</div>
      <div className="text-[11px] font-semibold text-slate-500 mt-0.5">{label}</div>
    </button>
  )
}

/* ── weekly recap panel ──────────────────────────────────────────────────────── */
export function WeeklyRecapPanel({ clientId, clientName }) {
  const [status, setStatus] = useState('loading')
  const [recap, setRecap]   = useState(null)
  const [error, setError]   = useState('')
  const [busy, setBusy]     = useState(false)

  const fetchRecap = useCallback(async (regen) => {
    if (regen) { setBusy(true) } else { setStatus('loading'); setError('') }
    try {
      const r = regen ? await api.regenerateRecap(clientId) : await api.getRecap(clientId)
      setRecap(r); setStatus('done'); setError('')
    } catch (e) {
      if (regen) setError(e?.message || 'Regenerate failed')
      else { setError(e?.message || 'Could not load the recap'); setStatus('error') }
    } finally { setBusy(false) }
  }, [clientId])

  useEffect(() => { fetchRecap(false) }, [fetchRecap])

  const posture  = status === 'done' && recap ? recapPosture(recap.evidence_pack) : null
  const period   = recap?.evidence_pack?.period?.label || recap?.week_start || ''
  const text     = (recap?.recap_text || '').trim()
  const grounded = !!recap?.grounded

  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">This week, in plain English</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">{clientName}</p>
        </div>
        {status === 'done' && (
          grounded ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              <ShieldCheck className="w-3 h-3" /> AI-verified
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              <AlertTriangle className="w-3 h-3" /> Unverified draft
            </span>
          )
        )}
        <button
          onClick={() => fetchRecap(true)}
          disabled={busy || status === 'loading'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Regenerate
        </button>
      </div>

      <div className="px-4 py-4">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the week…
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
            <p className="text-sm font-semibold text-slate-600">{error || 'Could not load the recap'}</p>
            <button
              onClick={() => fetchRecap(false)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        {status === 'done' && (
          <>
            {period && (
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                <Clock className="w-3 h-3" /> {period}
              </div>
            )}
            {text ? (
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{text}</p>
            ) : (
              <p className="text-sm text-slate-400 italic">No recap text for this week yet.</p>
            )}
            {error && (
              <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-rose-500">
                <AlertTriangle className="w-3 h-3" /> {error}
              </p>
            )}
            {posture && <RecapPostureStrip p={posture} />}
          </>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Written by the analyst from the same verified numbers the rest of this page is scored from.
          {recap?.model ? ` Model ${recap.model}.` : ''}
        </p>
      </div>
    </section>
  )
}

/* ── recap posture strip ─────────────────────────────────────────────────────── */
function RecapPostureStrip({ p }) {
  return (
    <div className="mt-4 pt-3 border-t border-slate-50">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Where things stand now</p>
      <div className="flex flex-wrap gap-1.5">
        {p.active > 0 && (
          <PostureChip
            icon={Radar} tone="slate" label={`${p.active} open`}
            detail={[p.critical ? `${p.critical} critical` : '', p.warning ? `${p.warning} warning` : '']
              .filter(Boolean).join(' · ')}
          />
        )}
        {p.adjustingCount > 0 && (
          <PostureChip
            icon={SlidersHorizontal} tone="amber" label={`Adjusting ${p.adjustingCount}`}
            detail={p.adjusting.join(', ')}
          />
        )}
        {p.improvingCount > 0 && (
          <PostureChip
            icon={ArrowUpCircle} tone="emerald" label={`Improving ${p.improvingCount}`}
            detail={p.improving.join(', ')}
          />
        )}
        {p.onTrack > 0 && (
          <PostureChip icon={Target} tone="emerald" label={`${p.onTrack} on pace`} />
        )}
        {p.atRisk > 0 && (
          <PostureChip icon={TrendingDown} tone="rose" label={`${p.atRisk} off pace`} />
        )}
      </div>
    </div>
  )
}

const POSTURE_TONES = {
  slate:   'text-slate-600 bg-slate-50 border-slate-200',
  amber:   'text-amber-700 bg-amber-50 border-amber-200',
  emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  rose:    'text-rose-700 bg-rose-50 border-rose-200',
}
function PostureChip({ icon: Icon, tone, label, detail }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold', POSTURE_TONES[tone] || POSTURE_TONES.slate)}>
      <Icon className="w-3 h-3 shrink-0" />{label}
      {detail ? <span className="font-medium opacity-70">· {detail}</span> : null}
    </span>
  )
}

/* ── triage roster ───────────────────────────────────────────────────────────── */
export function TriageRoster({ roster, byBand, activeClient, onPick }) {
  const [showAll, setShowAll] = useState(false)

  const needAttention = roster.filter(r => r.band !== 'healthy')
  const healthyCount  = roster.length - needAttention.length
  const allHealthy    = needAttention.length === 0
  const visible = showAll ? roster : (allHealthy ? roster.slice(0, 3) : needAttention)
  const hidden  = roster.length - visible.length

  const bandOrder = ['critical', 'at_risk', 'watch', 'healthy']

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Crosshair className="w-4 h-4 text-brand-500" />
        </div>
        <h2 className="text-sm font-black text-slate-900">Where to look first</h2>
        <span className="text-[11px] font-semibold text-slate-400">
          {needAttention.length > 0
            ? `${needAttention.length} need${needAttention.length === 1 ? 's' : ''} attention`
            : `All ${roster.length} healthy`}
        </span>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {bandOrder.map(b => {
            const c = byBand?.[b] || 0
            if (!c) return null
            const m = healthBandMeta(b)
            return (
              <span key={b} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold', m.chip)}>
                <span className={cn('w-1.5 h-1.5 rounded-full', m.dot)} />{c}
              </span>
            )
          })}
        </div>
      </div>

      <div className="divide-y divide-slate-50">
        {visible.map(r => <RosterRow key={r.client_id} r={r} active={activeClient === r.client_id} onPick={onPick} />)}
      </div>

      {allHealthy && healthyCount > 0 && (
        <div className="px-4 py-3 bg-emerald-50/30 border-t border-slate-50 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <p className="text-[11px] font-semibold text-emerald-700">All clients are healthy this sweep</p>
        </div>
      )}

      {hidden > 0 && (
        <div className="px-4 py-2 border-t border-slate-50 text-center">
          <button onClick={() => setShowAll(v => !v)} className="text-[11px] font-bold text-brand-500 hover:text-brand-600 transition">
            {showAll ? 'Show less' : `Show ${hidden} more (healthy)`}
          </button>
        </div>
      )}
    </div>
  )
}

/* ── roster row ──────────────────────────────────────────────────────────────── */
export function RosterRow({ r, active, onPick }) {
  const m = healthBandMeta(r.band)
  return (
    <button
      onClick={() => onPick?.(r.client_id)}
      className={cn('w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50/60 transition', active && 'bg-brand-50/30')}
    >
      <div className={cn('w-2 h-2 rounded-full shrink-0', m.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-black text-slate-800 truncate max-w-[12rem]">{r.client_name || 'Unknown'}</span>
          <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', m.chip)}>
            {m.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {Array.isArray(r.top_metrics) && r.top_metrics.slice(0, 3).map(mk => (
            <span key={mk} className="text-[10px] font-semibold text-slate-400">{metricLabel(mk)}</span>
          ))}
          {r.open_count > 0 && (
            <CountDot count={r.open_count} severity={r.worst_severity} />
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-lg font-black tabular-nums text-slate-700">{Math.round(Number(r.score))}</div>
        <div className="text-[10px] font-semibold text-slate-400">health</div>
      </div>
    </button>
  )
}

export function CountDot({ count, severity }) {
  const m = severityMeta(severity)
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black', m.chip)}>
      {count}
    </span>
  )
}

/* ── insight card ────────────────────────────────────────────────────────────── */
export function InsightCard({ insight, onAck, onResolve, onReopen }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy]         = useState(false)

  const sm   = severityMeta(insight.severity)
  const km   = kindMeta(insight.kind)
  const KIcon = km.icon || Eye
  const dir  = directionIcon(insight.direction)
  const um   = urgencyMeta(insight)
  const pm   = hasLearnedPrecision(insight) ? precisionMeta(insight) : null
  const tip  = pm ? precisionTooltip(insight) : null
  const fr   = forecastRange(insight)
  const esc  = insight.escalation_action

  const doAction = async (fn) => {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  const attribution = attributionView(insight)
  const correlate   = correlateView(insight)
  const impacts     = impactsView(insight)
  const escalation  = escalationView(insight)

  return (
    <div className={cn('bg-white rounded-2xl border shadow-sm overflow-hidden transition', sm.border)}>
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border', sm.chip)}>
            <KIcon className="w-4 h-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{insight.client_name || 'Unknown'}</span>
              <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">
                {metricLabel(insight.metric)}
              </span>
              <span className={cn('inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', sm.chip)}>
                {sm.label}
              </span>
              {pm && (
                <span
                  title={tip || undefined}
                  className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', pm.chip)}
                >
                  <pm.Icon className="w-2.5 h-2.5" />{pm.label}
                </span>
              )}
              {um && (
                <span className={cn('inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border', um.chip)}>
                  <um.Icon className="w-2.5 h-2.5" />{um.label}
                </span>
              )}
              {insight.resolved && (
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-emerald-50 text-emerald-600 border-emerald-200">
                  <ShieldCheck className="w-2.5 h-2.5" /> Resolved
                </span>
              )}
              {!insight.resolved && insight.acknowledged && (
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-sky-50 text-sky-600 border-sky-200">
                  <Check className="w-2.5 h-2.5" /> Seen
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
              {dir && <dir className="w-3.5 h-3.5 shrink-0" />}
              <span>{insight.title || 'Insight'}</span>
            </div>

            {insight.description && (
              <p className="mt-1 text-[11px] font-medium text-slate-500 leading-relaxed">{insight.description}</p>
            )}
          </div>

          <button
            onClick={() => setExpanded(v => !v)}
            className="shrink-0 w-7 h-7 rounded-lg border border-slate-100 bg-slate-50 flex items-center justify-center hover:border-slate-200 transition mt-0.5"
          >
            {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>
        </div>

        {expanded && (
          <div className="mt-3 space-y-3 pl-10">
            {fr && (
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Forecast range</p>
                <div className="flex items-center gap-3 flex-wrap">
                  {FORECAST_RANGE_KEYS.map(k => fr[k] != null && (
                    <div key={k} className="text-center">
                      <div className="text-sm font-black tabular-nums text-slate-700">{fmtMetricValue(insight.metric, fr[k])}</div>
                      <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">{k}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {attribution && (
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Root cause</p>
                <p className="text-[11px] font-semibold text-slate-600">{attribution.headline}</p>
                {attribution.drivers?.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {attribution.drivers.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] text-slate-400">
                        <Plug className="w-3 h-3 shrink-0" />
                        <span className="font-semibold text-slate-600">{d.channel || d.metric}</span>
                        <span>{d.contribution_pct != null ? `${d.contribution_pct > 0 ? '+' : ''}${Math.round(d.contribution_pct)}%` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {correlate && (
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Linked signals</p>
                <div className="space-y-1">
                  {correlate.map((c, i) => (
                    <p key={i} className="text-[11px] font-semibold text-slate-500">{c}</p>
                  ))}
                </div>
              </div>
            )}

            {impacts && (
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Downstream impact</p>
                <div className="space-y-1">
                  {impacts.map((imp, i) => (
                    <p key={i} className="text-[11px] font-semibold text-slate-500">{imp}</p>
                  ))}
                </div>
              </div>
            )}

            {escalation && (
              <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-500 mb-1">Escalation</p>
                <p className="text-[11px] font-semibold text-amber-700">{escalation.reason}</p>
                {esc && (
                  <p className="mt-1 text-[11px] font-medium text-slate-500">{esc}</p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap pt-1">
              {!insight.acknowledged && !insight.resolved && onAck && (
                <button
                  onClick={() => doAction(onAck)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 transition disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                  Mark seen
                </button>
              )}
              {!insight.resolved && onResolve && (
                <button
                  onClick={() => doAction(onResolve)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 hover:border-emerald-300 transition disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  Mark resolved
                </button>
              )}
              {insight.resolved && onReopen && (
                <button
                  onClick={() => doAction(onReopen)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-slate-300 transition disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
                  Reopen
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── misc shared primitives ──────────────────────────────────────────────────── */
export function EmptyAllClear() {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center">
        <CheckCircle2 className="w-6 h-6 text-emerald-500" />
      </div>
      <div>
        <p className="text-sm font-black text-slate-800">All clear</p>
        <p className="text-[11px] font-medium text-slate-400 mt-0.5">No open findings for this filter</p>
      </div>
    </div>
  )
}

export function Pill({ children, className }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold border', className)}>
      {children}
    </span>
  )
}

export function FieldLabel({ children }) {
  return (
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{children}</span>
  )
}

export function fmtEv(v, metric) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return fmtMetricValue(metric, Number(v))
}

/* ── MetricDistribution and friends ──────────────────────────────────────────── */
export function MetricDistribution({ metric, b }) {
  const d       = b.distribution
  const kind    = b.kind === 'volume' ? 'volume' : 'efficiency'
  const clients = Array.isArray(b.clients) ? b.clients : []
  const best    = clients[0] || null
  const worst   = clients.length > 1 ? clients[clients.length - 1] : null
  const leader  = best && best.standout ? best : null
  const laggard = worst && worst !== best && worst.standout ? worst : null

  return (
    <div className="rounded-xl border border-slate-100 bg-gradient-to-br from-slate-50/40 to-white p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-black text-slate-800">{metricLabel(metric)}</span>
        <BenchmarkKindChip kind={kind} />
        <span className="ml-auto text-[10px] font-semibold text-slate-400 tabular-nums">{b.n} clients</span>
      </div>

      <BoxPlot dist={d} />

      <div className="flex items-center justify-between text-[10px] tabular-nums text-slate-400 mt-0.5">
        <span>{fmtBench(metric, d.min)}</span>
        <span className="font-bold text-slate-600">median {fmtBench(metric, d.median)}</span>
        <span>{fmtBench(metric, d.max)}</span>
      </div>

      {(leader || laggard) && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {leader && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"
              title={`Top performer on ${metricLabel(metric)}`}
            >
              <Award className="w-3 h-3" />
              <span className="truncate max-w-[8rem]">{leader.client_name || 'Unknown'}</span>
              <span className="tabular-nums text-emerald-600">{fmtBench(metric, leader.value)}</span>
            </span>
          )}
          {laggard && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5"
              title={`Lagging the cohort on ${metricLabel(metric)} — a triage candidate`}
            >
              <TrendingDown className="w-3 h-3" />
              <span className="truncate max-w-[8rem]">{laggard.client_name || 'Unknown'}</span>
              <span className="tabular-nums text-rose-600">{fmtBench(metric, laggard.value)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function BenchmarkKindChip({ kind }) {
  if (kind === 'volume') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-sky-50 text-sky-600 border-sky-200"
        title="Volume metric — naturally scales with account size"
      >
        <BarChart3 className="w-3 h-3" /> Volume
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-violet-50 text-violet-600 border-violet-200"
      title="Efficiency metric — size-neutral, compares quality regardless of account size"
    >
      <Scale className="w-3 h-3" /> Efficiency
    </span>
  )
}

export function BoxPlot({ dist }) {
  if (!dist) return null
  const { min, max, p25, p75, median } = dist
  const span = Number.isFinite(max) && Number.isFinite(min) ? max - min : 0
  const pos  = (v) => (span > 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, ((v - min) / span) * 100)) : 50)
  const boxL = pos(p25)
  const boxR = pos(p75)
  const med  = pos(median)

  return (
    <div className="relative h-7">
      <div className="absolute top-1/2 left-0 right-0 h-px bg-slate-200 -translate-y-1/2" />
      <div className="absolute top-1/2 left-0  w-px h-3 bg-slate-300 -translate-y-1/2" />
      <div className="absolute top-1/2 right-0 w-px h-3 bg-slate-300 -translate-y-1/2" />
      <div
        className="absolute top-1/2 h-4 rounded bg-brand-100 border border-brand-200 -translate-y-1/2"
        style={{ left: `${boxL}%`, width: `${Math.max(boxR - boxL, 0)}%` }}
      />
      <div className="absolute top-1/2 w-0.5 h-4 bg-brand-600 rounded -translate-y-1/2" style={{ left: `${med}%`, marginLeft: '-1px' }} />
    </div>
  )
}

export function fmtRatio(n, suffix) {
  const r = Math.round(Number(n) * 10) / 10
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1)
  return `${s}${suffix}`
}

export function fmtBench(metric, v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (metric === 'roas')       return fmtRatio(n, '×')
  if (metric === 'close_rate') return fmtRatio(n, '%')
  return fmtMetricValue(metric, n)
}
