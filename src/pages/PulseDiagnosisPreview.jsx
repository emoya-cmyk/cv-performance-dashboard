// ============================================================
// PulseDiagnosisPreview.jsx — DESIGN PREVIEW (not wired into the app data flow).
//
// Shows how intel-v7 (2) "intra-week driver diagnosis" renders on top of the
// existing Daily Pulse: when a COMPOSITE flow metric (revenue ≡ spend × roas,
// jobs ≡ leads × close_rate) slides intra-week, we decompose the move into its
// exact drivers (lib/pulseDiagnose → attributeChange, log-space, no model) and
// paint the "why" right under the pulse signal — agency-toned on Intelligence,
// own-numbers / client-framed on the dashboard. intel-v7 (3) then layers the
// sensor's SELF-GRADED reliability over each row: an agency confidence chip
// (reliable / mixed / noisy, from lib/pulseReliability replaying dayPulse over the
// client's OWN firing history) and a client-safe consistency note that surfaces
// only when the signal has earned trust — severity says HOW BAD, reliability HOW SURE.
//
// Sample numbers below are shaped EXACTLY like pulseDiagnose()'s + pulseReliability()'s
// output (drivers:[{metric,pct,share,share_pct}], lead, direction; reliability_label +
// reliability_note + reliability_client_note) so this is a faithful look at the real
// surface. Reachable at /pulse-preview (no auth) for review; the shared DriverBreakdown
// lifts straight into ClientView + Intelligence (2c/2d), and the confidence chip /
// consistency note are the live 3c/3d surfaces. Client names here are fictional.
// ============================================================
import { ArrowUp, ArrowDown, Minus, Activity, Sparkles, Clock, ShieldCheck, Gauge, ShieldAlert, Crosshair, AlertTriangle, Eye, CheckCircle2, Radar, Target, SlidersHorizontal } from 'lucide-react'
import { fmtMetricValue } from '@/lib/insightMeta'
import DriverBreakdown from '@/components/DriverBreakdown'   // the now-shared component this preview helped design (2c/2d)

// ── tone (copied from Intelligence.jsx / ClientView.jsx so the preview matches) ──
const PULSE_TONE = {
  critical: { chip: 'bg-rose-50 text-rose-600 border-rose-200',          text: 'text-rose-600',    accent: '#f43f5e', label: 'Critical' },
  warning:  { chip: 'bg-amber-50 text-amber-600 border-amber-200',       text: 'text-amber-600',   accent: '#f59e0b', label: 'Warning'  },
  good:     { chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', text: 'text-emerald-600', accent: '#10b981', label: 'Tailwind' },
}
const pulseTone = (r) => (!r?.adverse ? PULSE_TONE.good : r.severity === 'critical' ? PULSE_TONE.critical : PULSE_TONE.warning)

function pulseClientTone(s) {
  if (!s?.adverse)
    return { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-600', accent: '#10b981', label: 'Tailwind' }
  return s.severity === 'critical'
    ? { chip: 'bg-rose-50 text-rose-600 border-rose-200',    text: 'text-rose-600',  accent: '#f43f5e', label: 'Heads up'     }
    : { chip: 'bg-amber-50 text-amber-700 border-amber-200', text: 'text-amber-600', accent: '#f59e0b', label: 'Keep an eye' }
}

// ── reliability grade tone (copied from Intelligence.jsx 3c so the preview matches) ──
// Orthogonal to severity: a Critical alert can be Reliable (act now) or Noisy (watch,
// don't over-react). Shield family so it never competes with the rose/amber severity fill.
const RELIABILITY_TONE = {
  reliable: { chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', Icon: ShieldCheck, label: 'Reliable' },
  mixed:    { chip: 'bg-slate-50 text-slate-500 border-slate-200',       Icon: Gauge,       label: 'Mixed'    },
  noisy:    { chip: 'bg-slate-100 text-slate-400 border-slate-200',      Icon: ShieldAlert, label: 'Noisy'    },
}

// ── predictive-precision tone (copied from Intelligence.jsx 5c so the preview matches) ──
// The third, FORESIGHT axis beside severity and reliability — the pulse's PREDICTIVE-PRECISION
// self-audit (lib/pulseAccuracy): how often THIS metric's early call actually proved out by
// week-close, and how far ahead. Target/crosshair family in violet so it reads as a track record
// of the EARLY call and never competes with the shield-family reliability chip or the rose/amber
// severity fill. Keyed by the engine's accuracy label; absent → no chip. Reliability says HOW SURE
// the call is now; this says HOW OFTEN that kind of call has actually proven out before.
const ACCURACY_TONE = {
  proven:     { chip: 'bg-violet-50 text-violet-600 border-violet-200',   Icon: Target,    label: 'Proven'     },
  developing: { chip: 'bg-violet-50/60 text-violet-500 border-violet-100', Icon: Crosshair, label: 'Developing' },
  learning:   { chip: 'bg-slate-50 text-slate-400 border-slate-200',      Icon: Radar,     label: 'Learning'   },
}

// ── self-tuning tone (copied from Intelligence.jsx 6c so the preview matches) ──
// The FOURTH axis — and the only one that reports an ACT, not a grade. lib/pulseTuning reads the
// foresight precision and, where the early call has earned it, MOVES this metric's live trigger
// band: a proven sensor trips on less movement ('Sharper'), a mixed one needs more before it speaks
// ('Calmer'). Teal slider family so it reads as a dial the system turned, distinct from the violet
// foresight, the emerald/slate shield, and the rose/amber severity. Keyed by the engine's tuning
// direction; absent (no earned adjustment → canonical band, unchanged) → no chip. The precision that
// drives it is always measured at the canonical band, so the loop never chases its own tail.
const TUNING_TONE = {
  sensitize: { chip: 'bg-teal-50 text-teal-600 border-teal-200',    Icon: SlidersHorizontal, label: 'Sharper' },
  tighten:   { chip: 'bg-teal-50/60 text-teal-500 border-teal-100', Icon: SlidersHorizontal, label: 'Calmer'  },
}

// ── action-lane tone (copied from Intelligence.jsx 4c so the preview matches) ──
// The cross of severity × learned reliability rendered as ONE decision + a heat gradient:
// act_now (rose) → verify (amber, critical-but-unproven) → worth_a_look (sky, slipping-and-
// held) → monitor (slate, slipping-but-flickers). The numbered rank badge carries the fill,
// so ORDER and DECISION read in one glance.
const LANE_TONE = {
  act_now:      { badge: 'bg-rose-500 text-white',  chip: 'bg-rose-50 text-rose-600 border-rose-200',    text: 'text-rose-600',  Icon: AlertTriangle, label: 'Act now' },
  verify:       { badge: 'bg-amber-500 text-white', chip: 'bg-amber-50 text-amber-600 border-amber-200', text: 'text-amber-600', Icon: Crosshair,     label: 'Verify' },
  worth_a_look: { badge: 'bg-sky-500 text-white',   chip: 'bg-sky-50 text-sky-600 border-sky-200',       text: 'text-sky-600',   Icon: Eye,           label: 'Worth a look' },
  monitor:      { badge: 'bg-slate-400 text-white', chip: 'bg-slate-50 text-slate-500 border-slate-200', text: 'text-slate-500', Icon: Radar,         label: 'Monitor' },
}
const laneTone = (r) => LANE_TONE[r?.lane] || LANE_TONE.monitor

// ── client-side action lane (copied from ClientView.jsx 4d so the preview matches) ──
// The SAME severity × reliability cross, re-voiced for the client: the agency's first-person
// response ("we're on it / confirming / reviewing / watching"), softened from the internal words
// (a noisy Critical reads "Confirming", never "noisy"), and pairing with — not repeating — the
// severity chip's HOW-BAD. Tailwinds carry no lane pill; the emerald chip already says it.
const PULSE_LANE_CLIENT = {
  act_now:      { label: 'On it today', chip: 'bg-rose-50 text-rose-600 border-rose-200',     Icon: AlertTriangle },
  verify:       { label: 'Confirming',  chip: 'bg-amber-50 text-amber-700 border-amber-200',  Icon: Crosshair },
  worth_a_look: { label: 'Reviewing',   chip: 'bg-sky-50 text-sky-700 border-sky-200',        Icon: Eye },
  monitor:      { label: 'Watching',    chip: 'bg-slate-100 text-slate-500 border-slate-200', Icon: Radar },
}
const pulseLaneClient = (s) => (s?.adverse ? PULSE_LANE_CLIENT[s?.lane] || null : null)

// Mirrors ClientView.jsx orderClientPulse (4d): adverse desc → reliability-weighted priority desc
// → |z| desc → metric asc. So the client deck leads with what the triage layer is most sure is
// worth attention — a reliable Heads-up can sit above a noisier Critical, the same call the
// agency's Act-today list makes — instead of the server's raw severity×|z| roster order.
function orderClientPulse(signals) {
  return [...signals].sort((a, b) =>
    (Number(!!b?.adverse) - Number(!!a?.adverse)) ||
    ((Number(b?.priority) || 0) - (Number(a?.priority) || 0)) ||
    (Math.abs(Number(b?.z) || 0) - Math.abs(Number(a?.z) || 0)) ||
    String(a?.metric || '').localeCompare(String(b?.metric || ''))
  )
}

// Shaped EXACTLY like lib/pulseTriage.rankPulseSignals(roster, { adverseOnly: true }) output:
// each row already carries priority_rank + lane + triage_reason and the reliability fields the
// rank was computed from. Ordered by priority (severity × reliability × magnitude) desc. THE
// HEADLINE lives at ranks 2–3: a RELIABLE Warning (worth a look) outranks a NOISY Critical
// (verify) — exactly the cross this layer exists to make. Sample numbers; names fictional.
const ACT_TODAY = [
  { client_id: 'c1', client_name: 'Skyline Dental',    label: 'Leads',   adverse: true, severity: 'critical', delta_pct: -48, lane: 'act_now',      priority_rank: 1, reliability_label: 'reliable', reliability_note: 'Reliable — this leads alert held up 9 of the last 11 times it fired for Skyline Dental.',     accuracy_label: 'proven',     accuracy_note: 'Leads early-warnings for this client have called the week right 8 of 9 times recently (~89%), about 5 days before it closed — a proven lead.',          tuning: { status: 'tuned', factor: 0.9056, direction: 'sensitize', warn: 1.811, crit: 2.717, base_warn: 2, base_crit: 3, precision: 0.8889, label: 'proven' }, tuning_note: "Leads early-warnings here have proven out, so the sensor now trips on about 9% less movement — it's earned a lighter trigger.", triage_reason: 'Leads is critical and this alert has a reliable track record — act today.' },
  { client_id: 'c2', client_name: 'Harbor Family Law', label: 'Revenue', adverse: true, severity: 'warning',  delta_pct: -24, lane: 'worth_a_look', priority_rank: 2, reliability_label: 'reliable', reliability_note: 'Reliable — this revenue alert held up 8 of the last 10 times it fired for Harbor Family Law.', accuracy_label: 'proven',     accuracy_note: 'Revenue early-warnings for this client have called the week right 7 of 8 times recently (~88%), about 6 days before it closed — a proven lead.',         tuning: { status: 'tuned', factor: 0.9125, direction: 'sensitize', warn: 1.825, crit: 2.738, base_warn: 2, base_crit: 3, precision: 0.875, label: 'proven' }, tuning_note: "Revenue early-warnings here have proven out, so the sensor now trips on about 9% less movement — it's earned a lighter trigger.", triage_reason: 'Revenue is slipping and this alert has held up before — worth a look today.' },
  { client_id: 'c3', client_name: 'Vista Auto Group',  label: 'Leads',   adverse: true, severity: 'critical', delta_pct: -51, lane: 'verify',       priority_rank: 3, reliability_label: 'noisy',    reliability_note: 'Noisy — this leads alert reverted 7 of the last 9 times it fired for Vista Auto Group.',      accuracy_label: 'learning',   accuracy_note: 'Leads early-warnings for this client have called the week right 2 of 7 times recently (~29%) — still learning.',                                       tuning: { status: 'tuned', factor: 1.2072, direction: 'tighten', warn: 2.414, crit: 3.622, base_warn: 2, base_crit: 3, precision: 0.2857, label: 'learning' }, tuning_note: 'Leads early-warnings here have been mixed, so the sensor now needs about 21% more movement before it speaks — fewer false alarms.', triage_reason: 'Leads is critical, but this alert has been noisy lately — confirm before acting.' },
  { client_id: 'c4', client_name: 'Peak Roofing Co.',  label: 'Spend',   adverse: true, severity: 'warning',  delta_pct: 31,  lane: 'monitor',      priority_rank: 4, reliability_label: 'mixed',    reliability_note: 'Mixed — this spend alert held up 5 of the last 11 times it fired for Peak Roofing Co.',       accuracy_label: 'developing', accuracy_note: 'Spend early-warnings for this client have called the week right 4 of 8 times recently (~50%), about 3 days before it closed — developing.',                tuning: { status: 'tuned', factor: 1.1, direction: 'tighten', warn: 2.2, crit: 3.3, base_warn: 2, base_crit: 3, precision: 0.5, label: 'developing' }, tuning_note: 'Spend early-warnings here have been mixed, so the sensor now needs about 10% more movement before it speaks — fewer false alarms.', triage_reason: 'Spend is slipping, but this alert flickers (mixed) — monitor for now.' },
]

// One ranked decision: lane-tinted rank badge (order + call), client + metric, the action
// LANE chip, and the learned CONFIDENCE chip that DROVE the rank (hover for the count). The
// grounded one-liner is the engine's own agency narration of the lane.
function ActTodayRowPreview({ r }) {
  const lane     = laneTone(r)
  const rel      = RELIABILITY_TONE[r.reliability_label] || null
  const acc      = ACCURACY_TONE[r.accuracy_label] || null         // predictive track record; null until gradeable
  const tun      = (r.tuning && TUNING_TONE[r.tuning.direction]) || null  // self-tuning act; null until earned
  const deltaStr = `${r.delta_pct >= 0 ? '+' : '−'}${Math.abs(r.delta_pct)}%`
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 text-xs font-black tabular-nums ${lane.badge}`}>
          {r.priority_rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{r.client_name}</span>
            <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">{r.label}</span>
            <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${lane.chip}`}>
              <lane.Icon className="w-2.5 h-2.5" />{lane.label}
            </span>
            {rel && (
              <span title={r.reliability_note} className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${rel.chip}`}>
                <rel.Icon className="w-2.5 h-2.5" />{rel.label}
              </span>
            )}
            {/* FORESIGHT (5c) rides beside reliability: how often this early call has actually
                proven out by week-close, and how far ahead. Hover for precision + lead-days. */}
            {acc && (
              <span title={r.accuracy_note || undefined} className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${acc.chip}`}>
                <acc.Icon className="w-2.5 h-2.5" />{acc.label}
              </span>
            )}
            {/* SELF-TUNING (6c) rides last — the one chip that reports an ACT: where the foresight
                earned it, this row's live trigger has actually moved. Sharper / Calmer. Hover for why. */}
            {tun && (
              <span title={r.tuning_note || undefined} className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${tun.chip}`}>
                <tun.Icon className="w-2.5 h-2.5" />{tun.label}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[11px] font-semibold text-slate-500 leading-relaxed">{r.triage_reason}</p>
        </div>
        <div className="shrink-0 text-right w-20">
          <div className={`text-lg font-black tabular-nums leading-none ${lane.text}`}>{deltaStr}</div>
          <div className="text-[10px] font-semibold text-slate-400 mt-0.5">vs usual</div>
        </div>
      </div>
    </div>
  )
}

// ── morning briefing banner (intel-v7 layer 7 / 7c) — the synthesis capstone ──────
// Copied from Intelligence.jsx PulseBriefingBanner (cn → template strings so it matches
// this file). Collapses the whole ranked Act-today feed into ONE thing to do, a one-word
// posture, and a confidence read — SUBTRACTING surface area. Rides ABOVE the Act-today
// strip; the headline IS Act-today #1 by construction (lib/pulseBriefing re-ranks with the
// identical pulseTriage call), so the hero sentence can never disagree with the list below.
// posture: act (rose, touch something now) · watch (amber, eyes up) · steady (emerald, clear).
const PULSE_POSTURE = {
  act:    { pill: 'bg-rose-500 text-white',    Icon: AlertTriangle, label: 'Act' },
  watch:  { pill: 'bg-amber-500 text-white',   Icon: Eye,           label: 'Watch' },
  steady: { pill: 'bg-emerald-500 text-white', Icon: CheckCircle2,  label: 'Steady' },
}
// the system grading its OWN briefing: what share of today's calls come from sensors that
// have earned credibility (accuracy 'proven' / reliability 'reliable') vs ones still building.
const CONFIDENCE_TONE = {
  high:     { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: ShieldCheck, label: 'High confidence'     },
  moderate: { chip: 'bg-amber-50 text-amber-700 border-amber-200',       Icon: Gauge,       label: 'Moderate confidence' },
  building: { chip: 'bg-slate-100 text-slate-500 border-slate-200',      Icon: Radar,       label: 'Building confidence' },
  'n/a':    { chip: 'bg-slate-50 text-slate-400 border-slate-200',       Icon: Radar,       label: 'No calls today'      },
}
const BRIEFING_STAT_TONE = {
  rose:    'bg-rose-50 text-rose-600 border-rose-200',
  amber:   'bg-amber-50 text-amber-600 border-amber-200',
  emerald: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  slate:   'bg-slate-50 text-slate-500 border-slate-200',
}
function BriefingStat({ tone, label }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${BRIEFING_STAT_TONE[tone] || BRIEFING_STAT_TONE.slate}`}>
      {label}
    </span>
  )
}

// ── the morning-memory ribbon (intel-v7 layer 8 / 8c) — continuity across mornings ──
// Copied from Intelligence.jsx ContinuityRibbon (cn → template strings). Reads the portfolio
// continuity aggregate (lib/pulseContinuity.summarizePortfolioContinuity) and renders it in
// lifecycle order: new → ongoing → worsening → resolved. The engine's canonical sentence is
// "N ongoing (M worsening)" — worsening is a SHARPENING of ongoing (escalating ⊆ persisting),
// never summed beside it. Rides in BOTH banner modes: a quiet book that resolved something
// overnight is exactly the win to surface. Degrades to null on a calm morning.
const CONTINUITY_CHIP = {
  new:       { chip: 'bg-indigo-50 text-indigo-600 border-indigo-200',   Icon: Sparkles },
  ongoing:   { chip: 'bg-amber-50 text-amber-600 border-amber-200',      Icon: Radar },
  worsening: { chip: 'bg-rose-50 text-rose-600 border-rose-200',         Icon: AlertTriangle },
  resolved:  { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
}
function ContinuityChip({ tone, label, title }) {
  const t = CONTINUITY_CHIP[tone] || CONTINUITY_CHIP.ongoing
  return (
    <span title={title || undefined} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${t.chip}`}>
      <t.Icon className="w-3 h-3" /> {label}
    </span>
  )
}
function ContinuityRibbon({ cont }) {
  if (!cont) return null
  const nw = Number(cont.new_count) || 0
  const pe = Number(cont.persisting_count) || 0          // all persisting (includes worsening)
  const es = Number(cont.escalating_count) || 0          // ⊆ persisting — a sharpening, never summed
  const rc = Number(cont.resolved_count) || 0
  if (nw + pe + rc === 0) return null                    // calm morning → no ribbon
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const resolvedNames = Array.isArray(cont.resolved) && cont.resolved.length
    ? cont.resolved.map((r) => `${r.client_name || 'Unknown'} — ${(r.label || r.metric || '').toLowerCase()}`).join(', ')
    : ''
  return (
    <div className="mt-3 flex items-center gap-1.5 flex-wrap">
      <span title={cont.note || undefined} className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        <Clock className="w-3 h-3" /> Morning memory
      </span>
      {nw > 0 && (<ContinuityChip tone="new" label={`${nw} new today`}
        title={cont.clients_new ? `${plural(cont.clients_new, 'client')} with a fresh alert this morning` : undefined} />)}
      {pe > 0 && (<ContinuityChip tone="ongoing" label={`${pe} ongoing`}
        title="Firing a second morning or more — carried over from yesterday" />)}
      {es > 0 && (<ContinuityChip tone="worsening" label={`${es} worsening`}
        title={`Of those ongoing, ${plural(es, 'metric')} ${es === 1 ? 'is' : 'are'} trending worse than yesterday${cont.clients_escalating ? ` · ${plural(cont.clients_escalating, 'client')}` : ''}`} />)}
      {rc > 0 && (<ContinuityChip tone="resolved" label={`${rc} resolved overnight`}
        title={resolvedNames || undefined} />)}
    </div>
  )
}

// Shaped EXACTLY like lib/pulseBriefing.summarizePortfolioPulse(roster) over the ACT_TODAY
// rows above: headline = ACT_TODAY[0] (Skyline), also = ACT_TODAY[1..3]. 2 of the 4 alerts
// are credible (Skyline + Harbor are proven AND reliable; Vista learning/noisy + Peak
// developing/mixed are not) → proven_share 0.5 → 'high'. posture 'act' because #1 is act_now.
const BRIEFING = {
  status: 'briefing',
  posture: 'act',
  counts: { adverse: 4, clients: 4, act_now: 1, tailwinds: 2, proven: 2, learning: 0 },
  headline: ACT_TODAY[0],
  headline_text: '4 alerts across 4 clients today. First up, Skyline Dental: Leads is critical and this alert has a reliable track record — act today.',
  also: ACT_TODAY.slice(1, 4),
  also_text: 'Next: Harbor Family Law — revenue (worth a look), Vista Auto Group — leads (verify), Peak Roofing Co. — spend (monitor).',
  confidence: {
    proven_share: 0.5,
    graded_share: 1,
    label: 'high',
    note: "Most of today's alerts come from sensors with a proven track record — this read is well-grounded.",
  },
}

// Shaped EXACTLY like lib/pulseContinuity.summarizePortfolioContinuity(clientMemories) — the
// sibling of `briefing` in getPortfolioPulse's return. The morning story over the same book:
// of the 4 alerts, 2 are fresh this morning and 2 carried over from yesterday (1 of those 2 is
// sharpening) — and one client that's quiet today (Meridian, not in the Act-today feed above)
// CLEARED overnight, the win the ribbon resurfaces. note === narratePortfolioContinuity(agg).
const CONTINUITY = {
  new_count: 2,
  persisting_count: 2,
  escalating_count: 1,                                   // ⊆ persisting — Vista is worsening
  resolved_count: 1,
  resolved: [{ client_id: 'meridian', client_name: 'Meridian Dental', metric: 'leads', label: 'Leads' }],
  clients_new: 2,
  clients_escalating: 1,
  clients_resolved: 1,
  note: '2 new this morning · 2 ongoing (1 worsening) · 1 resolved since yesterday',
}

function PulseBriefingBannerPreview({ data, continuity }) {
  const b = data
  if (!b || !b.headline_text) return null                  // no synthesis → degrade to no banner
  const quiet   = b.status !== 'briefing'
  const posture = PULSE_POSTURE[b.posture] || PULSE_POSTURE.steady
  const conf    = CONFIDENCE_TONE[b.confidence?.label] || CONFIDENCE_TONE['n/a']
  const c       = b.counts || {}
  return (
    <div className={`rounded-2xl border shadow-sm overflow-hidden ${quiet ? 'border-emerald-100 bg-gradient-to-br from-emerald-50/70 to-white' : 'border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-white'}`}>
      <div className="px-5 pt-4 pb-4">
        {/* eyebrow: the synthesis label, the one-word posture, and the confidence read */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-indigo-500">
            <Activity className="w-3.5 h-3.5" /> Today&rsquo;s pulse
          </span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${posture.pill}`}>
            <posture.Icon className="w-3 h-3" /> {posture.label}
          </span>
          {!quiet && (
            <span title={b.confidence?.note || undefined} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${conf.chip}`}>
              <conf.Icon className="w-3 h-3" /> {conf.label}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
            <Sparkles className="w-3 h-3" /> the one thing first
          </span>
        </div>

        {/* the hero — the morning's ONE sentence, the top of the same ranked feed below */}
        <p className={`mt-3 font-black leading-snug ${quiet ? 'text-base text-slate-700' : 'text-lg text-slate-900'}`}>
          {b.headline_text}
        </p>

        {/* the supporting cast — muted, only when more than the headline fired */}
        {b.also_text && (
          <p className="mt-1.5 text-xs font-medium text-slate-500 leading-relaxed">{b.also_text}</p>
        )}

        {/* the book at a glance — counts the engine already produced */}
        {!quiet && (
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            <BriefingStat tone="rose" label={`${c.adverse} to act on`} />
            {c.clients > 1   && <BriefingStat tone="slate"   label={`${c.clients} clients`} />}
            {c.proven > 0    && <BriefingStat tone="emerald" label={`${c.proven} proven`} />}
            {c.learning > 0  && <BriefingStat tone="slate"   label={`${c.learning} still learning`} />}
            {c.tailwinds > 0 && <BriefingStat tone="emerald" label={`${c.tailwinds} pacing ahead`} />}
          </div>
        )}

        {/* the morning-memory ribbon — continuity across mornings. Rides in BOTH modes:
            a quiet book that RESOLVED something overnight is exactly the win to surface. */}
        <ContinuityRibbon cont={continuity} />
      </div>

      {/* the confidence note as a grounding footer — the system explaining its own call */}
      {!quiet && b.confidence?.note && (
        <div className="px-5 py-2.5 bg-white/60 border-t border-indigo-50">
          <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
            <span className="font-bold text-slate-500">How sure: </span>{b.confidence.note}
          </p>
        </div>
      )}
    </div>
  )
}

// ── agency row (Intelligence ▸ Daily pulse) + diagnosis ───────────────────────
function PreviewPulseRow({ r }) {
  const tone     = pulseTone(r)
  const Dir      = r.direction === 'down' ? ArrowDown : r.direction === 'up' ? ArrowUp : Minus
  const delta    = Math.round(Number(r.delta_pct))
  const deltaStr = `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%`
  const baseN    = Number(r.baseline?.n)
  const rel      = RELIABILITY_TONE[r.reliability_label] || null   // learned trust grade for THIS metric's firing history
  const acc      = ACCURACY_TONE[r.accuracy_label] || null         // predictive track record (5c); null until gradeable
  const tun      = (r.tuning && TUNING_TONE[r.tuning.direction]) || null  // self-tuning act (6c); null until earned
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border ${tone.chip}`}>
          <Dir className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black text-slate-800 truncate max-w-[14rem]">{r.client_name}</span>
            <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">{r.label}</span>
            <span className={`inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${tone.chip}`}>{tone.label}</span>
            {rel && (
              <span
                title={r.reliability_note || undefined}
                className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${rel.chip}`}
              >
                <rel.Icon className="w-2.5 h-2.5" />
                {rel.label}
              </span>
            )}
            {/* FORESIGHT (5c) — the predictive-precision track record beside the trust grade:
                how often this client's early call on THIS metric proved out by week-close, and
                how far ahead. Hover for the grounded precision + lead-days. Silent until graded. */}
            {acc && (
              <span
                title={r.accuracy_note || undefined}
                className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${acc.chip}`}
              >
                <acc.Icon className="w-2.5 h-2.5" />
                {acc.label}
              </span>
            )}
            {/* SELF-TUNING (6c) — the fourth chip, and the only one that reports an ACT the system
                took ON ITSELF: where the foresight proved out, this client's live trigger on THIS
                metric has actually moved (Sharper / Calmer). Hover for the plain-language why. Silent
                until earned — a canonical, unchanged band shows no chip. Agency-only. */}
            {tun && (
              <span
                title={r.tuning_note || undefined}
                className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${tun.chip}`}
              >
                <tun.Icon className="w-2.5 h-2.5" />
                {tun.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span className={`tabular-nums font-bold ${tone.text}`}>{fmtMetricValue(r.metric, r.latest)}</span>
            <span className="text-slate-300">this past week · usual ≈</span>
            <span className="tabular-nums font-bold text-slate-600">{fmtMetricValue(r.metric, r.baseline?.median)}</span>
            {baseN > 0 && (<><span className="text-slate-300">·</span><span className="tabular-nums">{baseN}-wk base</span></>)}
          </div>
          <DriverBreakdown message={r.diagnosis_message} diagnosis={r.diagnosis} tone={tone} audience="agency" />
          {/* per-row morning memory — how many mornings this exact alert has run, and which way it's bending (8c) */}
          {r.continuity_note && (
            <div className="flex items-center gap-1 mt-1 text-[10px] font-semibold text-slate-400">
              <Clock className="w-3 h-3 shrink-0" />
              <span>{r.continuity_note}</span>
            </div>
          )}
        </div>
        <div className="shrink-0 text-right w-24">
          <div className={`text-lg font-black tabular-nums leading-none ${tone.text}`}>{deltaStr}</div>
          <div className="text-[10px] font-semibold text-slate-400 mt-0.5">vs usual week</div>
        </div>
      </div>
    </div>
  )
}

// ── client row (My Dashboard ▸ This Week So Far) + diagnosis ──────────────────
function PreviewClientPulseRow({ s }) {
  const tone     = pulseClientTone(s)
  const lane     = pulseLaneClient(s)   // reliability-crossed action posture (4d), null for tailwinds
  const DirIcon  = s.direction === 'down' ? ArrowDown : s.direction === 'up' ? ArrowUp : Minus
  const d        = Number(s.delta_pct)
  const deltaStr = `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d))}%`
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3.5" style={{ borderLeftWidth: 3, borderLeftColor: tone.accent }}>
      <div className="flex items-start gap-2.5">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border ${tone.chip}`}>
          <DirIcon className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-black text-slate-800">{s.label}</span>
            <span className={`inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${tone.chip}`}>{tone.label}</span>
            {/* reliability-crossed action lane (4d) — what WE'll do, in the agency's voice, pairing
                with the severity chip rather than repeating it; grounded posture on hover. */}
            {lane && (
              <span title={s.triage_client_reason || undefined} className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${lane.chip}`}>
                <lane.Icon className="w-2.5 h-2.5" />{lane.label}
              </span>
            )}
          </div>
          {s.client_message && <p className="text-xs text-slate-600 leading-relaxed font-medium mt-1">{s.client_message}</p>}
          <DriverBreakdown message={s.diagnosis_client_message} diagnosis={s.diagnosis} tone={tone} audience="client" />
          {s.reliability_client_note && (
            <p className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 mt-1.5">
              <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />
              {s.reliability_client_note}
            </p>
          )}
          {/* FORESIGHT companion (5d) — present ONLY when the engine graded THIS client's own
              early-warning history on THIS metric as 'proven' (the client branch of
              narratePulseAccuracy stays silent for developing/learning, and the proven sentence
              carries no raw number). Block-level so it lands on its own line below the consistency
              note; the two compound into one calm trust statement — "steady signal" + "we catch
              shifts like this early and they prove out" — never repeating each other. */}
          {s.accuracy_client_note && (
            <p className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 mt-1.5">
              <Target className="w-3 h-3 text-violet-500 shrink-0" />
              {s.accuracy_client_note}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-lg font-black tabular-nums leading-none ${tone.text}`}>{deltaStr}</div>
          <div className="text-[10px] font-semibold text-slate-400 mt-0.5">vs usual week</div>
        </div>
      </div>
    </div>
  )
}

// ── sample data — shaped exactly like pulseDiagnose() output ───────────────────
const AGENCY = [
  { client_id: 'a', client_name: 'Summit Exteriors', metric: 'jobs', label: 'Jobs won',
    adverse: true, severity: 'critical', direction: 'down', delta_pct: -50, latest: 10, baseline: { median: 20, n: 8 },
    reliability: 0.9, reliability_label: 'reliable',
    reliability_note: 'Jobs won alerts for this client have held up 9 of 10 times recently (~90%) — a reliable signal.',
    accuracy_label: 'proven',
    accuracy_note: 'Jobs won early-warnings for this client have called the week right 8 of 9 times recently (~89%), about 4 days before it closed — a proven lead.',
    tuning: { status: 'tuned', factor: 0.9056, direction: 'sensitize', warn: 1.811, crit: 2.717, base_warn: 2, base_crit: 3, precision: 0.8889, label: 'proven' },
    tuning_note: "Jobs won early-warnings here have proven out, so the sensor now trips on about 9% less movement — it's earned a lighter trigger.",
    continuity_note: '3rd morning running — and worsening.',
    diagnosis: { metric: 'jobs', direction: 'down', lead: 'leads',
      drivers: [{ metric: 'leads', pct: -50, share: 1, share_pct: 100 }, { metric: 'close_rate', pct: 0, share: 0, share_pct: 0 }] },
    diagnosis_message: 'Jobs won is down 50% — the driver is Leads (down 50%), while Close rate held.' },

  { client_id: 'b', client_name: 'Harbor Mechanical', metric: 'revenue', label: 'Revenue',
    adverse: true, severity: 'warning', direction: 'down', delta_pct: -30, latest: 700, baseline: { median: 1000, n: 8 },
    reliability: 0.3333, reliability_label: 'noisy',
    reliability_note: 'Revenue alerts for this client have held up 2 of 6 times recently (~33%) — a noisy signal, read it with care.',
    accuracy_label: 'learning',
    accuracy_note: 'Revenue early-warnings for this client have called the week right 2 of 6 times recently (~33%) — still learning.',
    tuning: { status: 'tuned', factor: 1.1834, direction: 'tighten', warn: 2.367, crit: 3.55, base_warn: 2, base_crit: 3, precision: 0.3333, label: 'learning' },
    tuning_note: 'Revenue early-warnings here have been mixed, so the sensor now needs about 18% more movement before it speaks — fewer false alarms.',
    continuity_note: 'New this morning.',
    diagnosis: { metric: 'revenue', direction: 'down', lead: 'spend',
      drivers: [{ metric: 'spend', pct: -50, share: 1.9434, share_pct: 194.3 }, { metric: 'roas', pct: 40, share: -0.9434, share_pct: -94.3 }] },
    diagnosis_message: 'Revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop.' },

  { client_id: 'c', client_name: 'Cedar & Stone Roofing', metric: 'jobs', label: 'Jobs won',
    adverse: true, severity: 'warning', direction: 'down', delta_pct: -60, latest: 8, baseline: { median: 20, n: 6 },
    reliability: 0.5, reliability_label: 'mixed',
    reliability_note: 'Jobs won alerts for this client have held up 3 of 6 times recently (~50%) — a mixed signal.',
    accuracy_label: 'developing',
    accuracy_note: 'Jobs won early-warnings for this client have called the week right 3 of 6 times recently (~50%), about 2 days before it closed — developing.',
    tuning: { status: 'tuned', factor: 1.1, direction: 'tighten', warn: 2.2, crit: 3.3, base_warn: 2, base_crit: 3, precision: 0.5, label: 'developing' },
    tuning_note: 'Jobs won early-warnings here have been mixed, so the sensor now needs about 10% more movement before it speaks — fewer false alarms.',
    continuity_note: '2nd morning running, though easing.',
    diagnosis: { metric: 'jobs', direction: 'down', lead: 'close_rate',
      drivers: [{ metric: 'leads', pct: -20, share: 0.2435, share_pct: 24.3 }, { metric: 'close_rate', pct: -50, share: 0.7565, share_pct: 75.7 }] },
    diagnosis_message: 'Jobs won is down 60% — the driver is Close rate (down 50%), with Leads also down 20%.' },

  { client_id: 'd', client_name: 'BlueWave Pools', metric: 'revenue', label: 'Revenue',
    adverse: false, severity: 'info', direction: 'up', delta_pct: 43, latest: 1144, baseline: { median: 800, n: 8 },
    reliability: 0.8889, reliability_label: 'reliable',
    reliability_note: 'Revenue alerts for this client have held up 8 of 9 times recently (~89%) — a reliable signal.',
    accuracy_label: 'proven',
    accuracy_note: 'Revenue early-warnings for this client have called the week right 8 of 9 times recently (~89%), about 5 days before it closed — a proven lead.',
    tuning: { status: 'tuned', factor: 0.9056, direction: 'sensitize', warn: 1.811, crit: 2.717, base_warn: 2, base_crit: 3, precision: 0.8889, label: 'proven' },
    tuning_note: "Revenue early-warnings here have proven out, so the sensor now trips on about 9% less movement — it's earned a lighter trigger.",
    diagnosis: { metric: 'revenue', direction: 'up', lead: 'roas',
      drivers: [{ metric: 'spend', pct: 10, share: 0.2665, share_pct: 26.6 }, { metric: 'roas', pct: 30, share: 0.7335, share_pct: 73.3 }] },
    diagnosis_message: 'Revenue is up 43% — the driver is ROAS (up 30%), with Ad spend also up 10%.' },
]

// One coherent client's week. Authored in naive worst-by-magnitude order (Leads −51% first) so the
// 4d reorder is visible: orderClientPulse floats the trusted Revenue slip ABOVE the louder-but-noisy
// Leads dip — the same reliability-weighted call the agency's Act-today list makes. Leads is atomic
// (no driver breakdown) and noisy (no consistency note → the "Confirming" lane is its only cue, so
// the client gets calibration without ever being shown the word "noisy").
const CLIENT = [
  { metric: 'leads', label: 'Leads', adverse: true, severity: 'critical', direction: 'down', delta_pct: -51,
    z: -3.1, priority: 0.40, lane: 'verify',
    client_message: 'Leads are tracking about 51% below your usual week so far.',
    reliability_client_note: '',
    accuracy_client_note: '',
    triage_client_reason: "Your leads dipped — we're confirming it before we act." },

  { metric: 'revenue', label: 'Revenue', adverse: true, severity: 'warning', direction: 'down', delta_pct: -24,
    z: -2.3, priority: 0.60, lane: 'worth_a_look',
    client_message: 'Revenue is running about 24% under your usual week.',
    reliability_client_note: 'This has been a consistent signal lately.',
    accuracy_client_note: "We've been spotting shifts like this early — and they've usually proven out.",
    triage_client_reason: 'Your revenue is worth a look this week.',
    diagnosis: { metric: 'revenue', direction: 'down', lead: 'roas',
      drivers: [{ metric: 'roas', pct: -20, share: 0.813, share_pct: 81.3 }, { metric: 'spend', pct: -5, share: 0.187, share_pct: 18.7 }] },
    diagnosis_client_message: 'Your revenue is down 24% — the driver is ROAS (down 20%), with Ad spend down a touch (5%).' },

  { metric: 'close_rate', label: 'Close rate', adverse: false, severity: 'info', direction: 'up', delta_pct: 18,
    z: 2.2, priority: 0.55, lane: 'tailwind',
    client_message: 'Your close rate is pacing about 18% ahead of your usual week — nice momentum.',
    reliability_client_note: 'This has been a consistent signal lately.',
    accuracy_client_note: '',
    triage_client_reason: 'Your close rate is pacing ahead — nice momentum.' },
]

// ── client "your pulse in one sentence" (layer 7 / 7d) — the consumer synthesis capstone ──
// Mirror of ClientView.jsx ClientPulseHeadline: lib/pulseBriefing.summarizeClientPulse collapses
// THIS client's ranked pulse into ONE calm sentence + a single focus chip, replacing the generic
// "an early read…" intro. Machinery-free by construction — focus carries only label/direction/
// delta_pct/lane and the sentence is the engine's own client_reason — so no z/baseline/tuning ever
// reaches the consumer surface. posture in the client's voice. CLIENT_BRIEFING below is computed by
// running that module over the CLIENT deck: the adverseOnly triage floats revenue (priority .60)
// above the louder-but-noisy leads dip (.40), so revenue is the focus; posture 'watch' (no act_now
// lane in play); also_count 1 (the leads drop rides just beneath, named only as "1 other metric").
const PULSE_POSTURE_CLIENT = {
  act:    { dot: 'bg-rose-500',    text: 'text-rose-600',    label: 'Needs a look'  },
  watch:  { dot: 'bg-amber-500',   text: 'text-amber-600',   label: 'Worth a glance' },
  steady: { dot: 'bg-emerald-500', text: 'text-emerald-600', label: 'Looking good'  },
}
const CLIENT_BRIEFING = {
  status: 'briefing',
  posture: 'watch',
  headline_text: "Your revenue is worth a look this week. We're also keeping an eye on 1 other metric.",
  focus: { metric: 'revenue', label: 'Revenue', direction: 'down', delta_pct: -24, lane: 'worth_a_look' },
  also_count: 1,
}
// morning memory (8d) — the same two engine strings ClientView folds beneath the one sentence, both
// verbatim narrateContinuity / narrateResolved CLIENT-voice output (the UI only places them). The focus
// metric (revenue) is on its 3rd morning and still bending the wrong way → the streak note grounds the
// headline as "the same story as yesterday, not a fresh scare". The resolved line names a Calls alert
// that settled overnight — deliberately OFF today's deck (a cleared alarm stops firing, so it's absent
// from the live pulse) yet resurfaced here, so a heavy morning still opens with a win. Per-client payload
// → no peer metric or name can reach this surface.
const CLIENT_FOCUS_NOTE    = "We've been tracking this for 3 days, and it hasn't turned around yet."
const CLIENT_RESOLVED_NOTE = 'Good news — your calls alert from yesterday has settled back into your normal range.'
function ClientPulseHeadlinePreview({ briefing, focusNote, resolvedNote }) {
  const b = briefing
  if (!b || !b.headline_text) return null
  const posture = PULSE_POSTURE_CLIENT[b.posture] || PULSE_POSTURE_CLIENT.steady
  const f       = b.focus
  const lane    = f ? (PULSE_LANE_CLIENT[f.lane] || null) : null
  const dpct    = f && Number.isFinite(Number(f.delta_pct)) ? Number(f.delta_pct) : null
  return (
    <div className="mb-4">
      {/* the one sentence — posture-toned, the engine's own client-voiced synthesis */}
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${posture.dot}`} />
        <p className="text-sm font-bold text-slate-800 leading-snug">{b.headline_text}</p>
      </div>
      {/* the one metric that matters — focus chip, machinery-free (label + lane + own delta) */}
      {f && (
        <div className="mt-2 ml-4 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">{f.label}</span>
          {lane && (
            <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 border ${lane.chip}`}>
              <lane.Icon className="w-2.5 h-2.5" /> {lane.label}
            </span>
          )}
          {dpct !== null && (
            <span className={`inline-flex items-center text-[10px] font-black tabular-nums ${posture.text}`}>
              {dpct >= 0 ? '+' : '−'}{Math.abs(Math.round(dpct))}%
            </span>
          )}
          {b.also_count > 0 && (
            <span className="text-[10px] font-semibold text-slate-400">· +{b.also_count} more watched</span>
          )}
        </div>
      )}
      {/* morning memory (8d) — the focus metric's streak in the client's own voice, and any overnight
          win that's already settled back to normal. The streak grounds the headline ("is this new, or
          the same story as yesterday?"); the resolved line leads with good news even on a heavy morning. */}
      {(focusNote || resolvedNote) && (
        <div className="mt-2 ml-4 space-y-1">
          {focusNote && (
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
              <Clock className="w-3 h-3 shrink-0" />
              <span>{focusNote}</span>
            </div>
          )}
          {resolvedNote && (
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
              <CheckCircle2 className="w-3 h-3 shrink-0" />
              <span>{resolvedNote}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── client "your morning brief" (layer 9 / 9d) — the grounded narration capstone ──
// Where the layer-7 one-liner above collapses this morning to ONE sentence, layer 9 expands it
// into the short paragraph that opens the client's morning note: lib/pulseBrief builds a numbers-
// only evidence pack from THIS client's own pulse (period/posture/focus/memory/resolved — no peer,
// no severity statistic, no reliability/accuracy/tuning machinery), lib/ai narrates it, and a
// grounding verifier rejects any draft that cites a number the pack doesn't carry — falling back to
// a deterministic template (so it works with no API key and never invents a figure). CLIENT_BRIEF
// below is the prose of the SAME morning the deck above depicts: leads with the overnight calls win,
// names revenue (−24%, the focus) as the one thing to watch, grounds it with the same 3-day streak,
// and nods at the 1 other metric riding beneath — every figure tracing to CLIENT_BRIEFING / the
// memory notes. The card is deliberately bare of operator chrome: no regenerate, model name,
// confidence chip, or verification badge — posture speaks only in the client's voice.
const CLIENT_BRIEF = {
  audience: 'client',
  as_of: '2026-06-02',
  grounded: true,
  brief_text:
    "Good news first — your calls alert from yesterday has settled back into your normal range. " +
    "The one thing worth a look this week is revenue: it's running about 24% below your usual pace. " +
    "We've been tracking this for 3 days now and it hasn't turned around yet, so your team is already " +
    "on it — and we're keeping a quiet eye on one other metric just beneath it.",
  pack: {
    audience: 'client',
    as_of: '2026-06-02',
    period: { label: '2026-06-02', week_start: '2026-06-02', week_end: '2026-06-02' },
    posture: 'watch',
    status: 'briefing',
  },
}
// Friendly weekday framing for the brief's as-of date ('2026-06-02' → 'Monday, Jun 2'), parsed from
// parts as a LOCAL date so it never slips a day across the UTC-midnight boundary (mirror of ClientView).
function fmtBriefDay(raw) {
  const s = String(raw || '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}
function ClientMorningBriefPreview({ brief }) {
  const text = (brief?.brief_text || '').trim()
  if (!text) return null
  const day     = fmtBriefDay(brief?.pack?.period?.label || brief?.as_of)
  const posture = PULSE_POSTURE_CLIENT[brief?.pack?.posture] || null
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Your Morning Brief</p>
        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
          <Sparkles className="w-3 h-3" /> AI Analyst
        </span>
      </div>
      {(posture || day) && (
        <div className="flex items-center gap-2 mb-3">
          {posture && (
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${posture.dot}`} />
              <span className={`text-[11px] font-bold ${posture.text}`}>{posture.label}</span>
            </span>
          )}
          {day && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
              <Clock className="w-3 h-3" /> {day}
            </span>
          )}
        </div>
      )}
      <p className="text-sm text-slate-600 leading-relaxed font-medium whitespace-pre-line">{text}</p>
      <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50 leading-relaxed">
        A fresh read each morning — written by your account&rsquo;s AI analyst from your verified
        numbers, days before your Monday recap.
      </p>
    </div>
  )
}

export default function PulseDiagnosisPreview() {
  return (
    <div className="min-h-screen bg-slate-100/70 p-6 sm:p-10">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-600">Design preview · intel-v7 (2) → (9)</p>
          <h1 className="text-2xl font-black text-slate-900 mt-1">Daily Pulse → diagnosis → reliability → act today → track record → self-tuning → morning brief</h1>
          <p className="text-sm text-slate-500 font-medium mt-1.5 max-w-3xl leading-relaxed">
            The pulse already says <span className="font-bold text-slate-700">what</span> moved this week, and (2) adds the{' '}
            <span className="font-bold text-slate-700">why</span> — decomposing each composite move (revenue ≡ spend × ROAS,
            jobs ≡ leads × close rate) into its exact drivers in log space. (3) adds{' '}
            <span className="font-bold text-slate-700">how much to trust it</span>: the sensor grades its own past firings against
            this client&rsquo;s own history and labels each live signal <span className="font-bold text-emerald-600">reliable</span> /{' '}
            <span className="font-bold text-slate-500">mixed</span> / <span className="font-bold text-slate-400">noisy</span>. Now (4)
            does the agency&rsquo;s triage <span className="font-bold text-slate-700">for</span> it — crossing each alarm&rsquo;s{' '}
            <span className="font-bold text-indigo-600">severity × that learned reliability</span> into one ranked &ldquo;Act today&rdquo;
            list with an action lane, so the first hour lands by evidence rather than by how loud the alarm is. And (5) closes the loop
            on <span className="font-bold text-violet-600">foresight</span>: it checks whether each early-warning actually called the
            eventual weekly outcome right — scoring past firings against how the week truly closed — and labels its own track record{' '}
            <span className="font-bold text-violet-600">proven</span> / <span className="font-bold text-violet-500">developing</span> /{' '}
            <span className="font-bold text-slate-400">learning</span>, so a sensor that keeps calling the week early (often days ahead)
            carries earned weight while a thin or weak record stays quiet. Finally (6) acts on that record —{' '}
            <span className="font-bold text-teal-600">self-tuning</span> each client&rsquo;s own trigger: where the foresight has proven out the
            sensor earns a lighter touch (<span className="font-bold text-teal-600">Sharper</span> — it speaks sooner), and where it&rsquo;s been
            mixed it sets a higher bar (<span className="font-bold text-teal-500">Calmer</span> — fewer false alarms), always graded against the
            canonical band and never its own tuned one, so the loop can never chase its own tail. No LLM and no human-set dial anywhere in the
            chain; every figure traces to a stored daily fact. Sample numbers; client names fictional.
          </p>
        </div>

        {/* ── MORNING BRIEFING — the synthesis capstone (layer 7), full width, ABOVE Act today.
            Collapses the ranked strip below into ONE thing + posture + confidence; the headline
            is Act-today #1 by construction. This is the "subtract surface area" payoff: nine
            chips become one sentence, with the detail one glance below. ───────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Today&rsquo;s pulse</p>
          <PulseBriefingBannerPreview data={BRIEFING} continuity={CONTINUITY} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The capstone reads the SAME ranked feed below and answers one question — &ldquo;if you do one thing today, do this&rdquo; —
            then grades its own call <span className="font-bold text-emerald-600">high confidence</span> because 2 of the 4 alerts come from
            sensors that have already <span className="font-bold text-violet-600">proven out</span>. Synthesis on top, never a new sensor; it
            reuses the headline signal&rsquo;s own triage sentence verbatim and only counts what&rsquo;s already on the roster.
          </p>
        </div>

        {/* ── YOUR MORNING BRIEF — the client narration capstone (layer 9 / 9d), full width.
            Where the agency banner above collapses the morning to ONE sentence, the client gets
            the short PARAGRAPH that expansion opens into — the same grounded read, written in the
            client's own voice. A deliberately consumer-only surface: this is the entire reason the
            number machinery exists, said back to the person who pays for the work, with zero of the
            machinery showing. ─────────────────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Client · My Dashboard ▸ Your Morning Brief</p>
          <div className="max-w-2xl">
            <ClientMorningBriefPreview brief={CLIENT_BRIEF} />
          </div>
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed max-w-2xl">
            The full read the agency one-liner above expands into — the same morning, in the client&rsquo;s words. A numbers-only
            evidence pack from this client&rsquo;s OWN pulse is narrated by the model, then a grounding check{' '}
            <span className="font-bold text-slate-600">rejects any draft that cites a figure the pack doesn&rsquo;t carry</span> and falls
            back to a deterministic template — so it works with no API key and can never invent a number. It leads with the overnight win,
            names the one thing to watch (<span className="font-bold text-amber-600">revenue, −24%</span>) with the same 3-day continuity, and
            nods at the one metric beneath it — yet shows <span className="font-bold text-slate-600">no peer, no severity, no z, no model name,
            no confidence, no badge, and no regenerate</span>. Posture speaks only as &ldquo;Worth a look.&rdquo;
          </p>
        </div>

        {/* ── ACT TODAY — the agency decision strip (layer 4), full width above the two surfaces.
            Same adverse signals as the pulse below, re-ranked by severity × learned reliability and
            tagged with an action lane + 1-based priority rank. The headline is at ranks 2–3: a
            RELIABLE Warning (#2, worth a look) outranks a NOISY Critical (#3, verify). ─────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Act today</p>
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50 bg-indigo-50/30">
              <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                <Crosshair className="w-4 h-4 text-indigo-500" />
              </div>
              <h2 className="text-sm font-black text-slate-900">Act today</h2>
              <span className="text-[11px] font-semibold text-slate-400">1 needs action now · 4 ranked by severity × reliability</span>
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                <Sparkles className="w-3 h-3" /> reliability-weighted
              </span>
            </div>
            <div className="divide-y divide-slate-50">
              {ACT_TODAY.map((r) => <ActTodayRowPreview key={`${r.client_id}:${r.metric}`} r={r} />)}
            </div>
            <div className="px-4 py-2.5 bg-indigo-50/20 border-t border-slate-50">
              <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
                Notice <span className="font-bold text-slate-600">#2 over #3</span>: Harbor&rsquo;s <span className="font-semibold">Warning</span>{' '}
                outranks Vista&rsquo;s <span className="font-semibold">Critical</span> because we&rsquo;ve been{' '}
                <span className="font-bold text-emerald-600">right about Harbor</span> and Vista&rsquo;s leads alarm keeps{' '}
                <span className="font-bold text-slate-500">crying wolf</span> — so the louder alarm drops to{' '}
                <span className="font-bold text-amber-600">verify</span> while the quieter, trustworthy one rises to{' '}
                <span className="font-bold text-sky-600">worth a look</span>. Severity says <span className="italic">how bad</span>;
                reliability says <span className="italic">how sure</span>; the rank is their product. Sharpens as more alarms mature.
              </p>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 items-start">
          {/* AGENCY */}
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Daily pulse</p>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
                <div className="w-7 h-7 rounded-lg bg-sky-50 flex items-center justify-center shrink-0">
                  <Activity className="w-4 h-4 text-sky-500" />
                </div>
                <h2 className="text-sm font-black text-slate-900">Daily pulse</h2>
                <span className="text-[11px] font-semibold text-slate-400">3 clients off their usual week</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                  <Clock className="w-3 h-3" /> trailing 7 days · through 2026-06-02
                </span>
              </div>
              <div className="divide-y divide-slate-50">
                {AGENCY.map((r) => <PreviewPulseRow key={r.client_id} r={r} />)}
              </div>
              <div className="px-4 py-2.5 bg-sky-50/30 border-t border-slate-50">
                <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
                  When a composite metric moves, the pulse names the{' '}
                  <span className="font-bold text-sky-600">lever behind it</span> — leads vs close rate, spend vs ROAS — and the{' '}
                  <span className="font-bold text-emerald-600">confidence chip</span> beside the severity says whether this
                  client&rsquo;s alerts on that metric have held up before (hover for the track record). Severity says{' '}
                  <span className="italic">how bad</span>; reliability says <span className="italic">how sure</span> — a Critical
                  that&rsquo;s also Reliable is act-now; a Critical that&rsquo;s Noisy is watch-don&rsquo;t-overreact. The violet{' '}
                  <span className="font-bold text-violet-600">foresight chip</span> goes one step further — it says whether those
                  early-warnings have actually <span className="font-bold text-violet-600">called the eventual week right</span> (hover
                  for the precision and how many days ahead): a <span className="font-semibold text-violet-600">proven</span> track
                  record has earned the right to move you; a <span className="font-semibold text-slate-400">learning</span> one
                  hasn&rsquo;t yet. Reliability is whether the alarm was true; foresight is whether it was early. And the teal{' '}
                  <span className="font-bold text-teal-600">Sharper</span> / <span className="font-bold text-teal-500">Calmer</span> chip,
                  when it shows, is the system <span className="font-semibold text-teal-600">acting on that foresight</span> — a proven
                  sensor here has earned a lighter trigger (it now speaks on less movement), a mixed one a higher bar (fewer false
                  alarms), retuned automatically against the canonical band so it never chases its own tail (hover for the
                  plain-language why). Agency-only.
                </p>
              </div>
            </div>
          </div>

          {/* CLIENT */}
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Client · My Dashboard ▸ This Week So Far</p>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">This Week So Far</p>
                <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">
                  <Sparkles className="w-3 h-3" /> AI Analyst
                </span>
              </div>
              {/* the one sentence first (7d) — the synthesised briefing replaces the generic
                  "early read" intro; the per-metric rows below become its supporting detail. */}
              <ClientPulseHeadlinePreview briefing={CLIENT_BRIEFING} focusNote={CLIENT_FOCUS_NOTE} resolvedNote={CLIENT_RESOLVED_NOTE} />
              <div className="space-y-3">
                {orderClientPulse(CLIENT).map((s, i) => <PreviewClientPulseRow key={`${s.metric}:${i}`} s={s} />)}
              </div>
              <p className="text-[10px] text-slate-400 mt-3.5 pt-3 border-t border-slate-50 leading-relaxed">
                Watched live off your daily numbers and refreshed every day. When a number moves, we break down what drove it —
                so you see the cause days before the week officially closes. When a signal has a steady track record, a small{' '}
                <span className="font-semibold text-emerald-600">consistent-signal</span> note appears; a flickery one stays
                quiet, so you&rsquo;re never shown a number you can&rsquo;t lean on. And when we&rsquo;ve been{' '}
                <span className="font-semibold text-violet-600">spotting shifts like this early</span> and they&rsquo;ve usually
                proven out, we say so too — quietly, and only once that track record is real. They&rsquo;re ordered the same way your team
                works them — your steady <span className="font-semibold text-slate-600">Revenue</span> dip leads, and the louder{' '}
                <span className="font-semibold text-slate-600">Leads</span> drop sits just below at{' '}
                <span className="font-semibold text-amber-600">Confirming</span> while we make sure it&rsquo;s real before acting.
                The little status tag on each — <span className="font-semibold text-rose-600">On it today</span>,{' '}
                <span className="font-semibold text-amber-600">Confirming</span>,{' '}
                <span className="font-semibold text-sky-600">Reviewing</span> — tells you exactly where we are on it.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
