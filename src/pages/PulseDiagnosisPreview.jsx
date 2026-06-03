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
import { ArrowUp, ArrowDown, Minus, Activity, Sparkles, Clock, ShieldCheck, Gauge, ShieldAlert, Crosshair, AlertTriangle, AlertOctagon, Wrench, Eye, CheckCircle2, Radar, Target, SlidersHorizontal, ArrowUpCircle, TrendingDown, Scale, Check, Inbox, Scissors, Stethoscope, RotateCcw, ThumbsUp } from 'lucide-react'
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
    // Honest trust line — present ONLY because our recent morning leads earned it (label
    // 'earned'). Server-folded verbatim from narrateBriefImpact's 'client' branch; '' (absent)
    // on 'fair'/'overcalled'/un-graded. No grade, percentage or lane split ever rides along.
    impact_reinforcement: 'When we lead your morning brief with something, it has usually held up.',
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
  // Mirror of ClientView: the honest trust line rides the pack ONLY when earned, '' otherwise.
  const reinforcement = (brief?.pack?.impact_reinforcement || '').trim()
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
      {reinforcement && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-2">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-px" />
          <p className="text-[11px] font-semibold text-emerald-800 leading-relaxed">{reinforcement}</p>
        </div>
      )}
      <p className="text-[10px] text-slate-400 mt-4 pt-3 border-t border-slate-50 leading-relaxed">
        A fresh read each morning — written by your account&rsquo;s AI analyst from your verified
        numbers, days before your Monday recap.
      </p>
    </div>
  )
}

// ── narration reliability (10c) — copied from Intelligence.jsx BriefHealthPanel (cn → template
// strings so the preview matches). The morning brief grading its OWN history: coverage (how often the
// analyst wrote in its own words vs the safe template) shown rigidly ORTHOGONAL to the grounded-trust
// chip. Agency-only — the model ids and fallback streak are internal calibration a client never sees.
const BRIEF_HEALTH_TONE = {
  rich:            { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'Writing freely' },
  mixed:           { pill: 'border-sky-200 bg-sky-50 text-sky-700',             dot: 'bg-sky-500',     bar: 'bg-sky-500',     label: 'Mostly its words' },
  'template-only': { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'On the template' },
  quiet:           { pill: 'border-slate-200 bg-slate-50 text-slate-600',       dot: 'bg-slate-400',   bar: 'bg-slate-300',   label: 'Quiet stretch' },
  'no-data':       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   bar: 'bg-slate-200',   label: 'No briefs yet' },
}
function briefCoverageView(b) {
  if (!b || !b.total) return { state: 'none',  pct: null, narrated: 0, narratable: 0 }
  if (!b.narratable)  return { state: 'quiet', pct: null, narrated: 0, narratable: 0 }
  return { state: 'graded', pct: b.coverage != null ? Math.round(b.coverage * 100) : 0, narrated: b.narrated || 0, narratable: b.narratable }
}
function BriefHealthStatPreview({ label, view }) {
  return (
    <div className="flex-1 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 truncate">{label}</p>
      {view.state === 'none'
        ? <p className="text-sm font-black text-slate-300 leading-tight">—</p>
        : view.state === 'quiet'
        ? <p className="text-sm font-bold text-slate-400 leading-tight">Quiet</p>
        : <p className="text-sm font-black text-slate-800 leading-tight tabular-nums">{view.pct}%<span className="ml-1 text-[11px] font-semibold text-slate-400">{view.narrated}/{view.narratable}</span></p>}
    </div>
  )
}

// Shaped EXACTLY like GET /api/ai/brief-health over a 7-day history: 9 of 12 briefs were worth
// narrating, the model wrote 7 of those (mixed — just under the 0.8 "rich" bar) and fell back twice,
// the two most recent so the streak heads-up fires; every row still grounded. Client briefs sit at the
// rich line (4/5); the portfolio brief is mixed (3/4). narrative is verbatim narrateBriefHealth(overall).
const BRIEF_HEALTH = {
  total: 12,
  window: { from: '2026-05-27', to: '2026-06-02', days: 7 },
  grounded_rate: 1,
  all_grounded: true,
  overall: {
    total: 12, narratable: 9, quiet: 3, narrated: 7, fellback: 2,
    coverage: 0.7778, models: { 'claude-opus-4-7': 7, template: 2 },
    latest: { as_of: '2026-06-02', state: 'fellback' }, streak_fellback: 2, health: 'mixed',
  },
  by_audience: {
    client: { total: 7, narratable: 5, quiet: 2, narrated: 4, fellback: 1, coverage: 0.8,  models: { 'claude-opus-4-7': 4, template: 1 }, latest: { as_of: '2026-06-02', state: 'narrated' }, streak_fellback: 0, health: 'rich' },
    agency: { total: 5, narratable: 4, quiet: 1, narrated: 3, fellback: 1, coverage: 0.75, models: { 'claude-opus-4-7': 3, template: 1 }, latest: { as_of: '2026-06-02', state: 'fellback' }, streak_fellback: 1, health: 'mixed' },
  },
  requested: { as_of: null, days: 30 },
  narrative:
    'The AI wrote 7 of 9 morning briefs in its own words; the rest used the safe template — all grounded to your verified numbers. ' +
    'Heads up — the last 2 fell back to the template.',
}

// Same shape, the failure case the banner exists for: the AGENCY brief stalled — its last 3 portfolio
// mornings all fell back to the safe template (an expired key / rate limit / outage), while the CLIENT
// stream kept writing freely. assessBriefDelivery grades per-audience worst-of, so the agency stall
// drives a rose 'stalled' verdict even though clients never slipped. `delivery` is verbatim what
// GET /api/ai/brief-health returns (narrative = narrateBriefDelivery(signal, { audience: 'agency' })).
const BRIEF_HEALTH_STALLED = {
  total: 12,
  window: { from: '2026-05-27', to: '2026-06-02', days: 7 },
  grounded_rate: 1,
  all_grounded: true,
  overall: {
    total: 12, narratable: 9, quiet: 3, narrated: 5, fellback: 4,
    coverage: 0.5556, models: { 'claude-opus-4-7': 5, template: 4 },
    latest: { as_of: '2026-06-02', state: 'fellback' }, streak_fellback: 3, health: 'mixed',
  },
  by_audience: {
    client: { total: 7, narratable: 5, quiet: 2, narrated: 4, fellback: 1, coverage: 0.8,  models: { 'claude-opus-4-7': 4, template: 1 }, latest: { as_of: '2026-06-02', state: 'narrated' }, streak_fellback: 0, health: 'rich' },
    agency: { total: 5, narratable: 4, quiet: 1, narrated: 1, fellback: 3, coverage: 0.25, models: { 'claude-opus-4-7': 1, template: 3 }, latest: { as_of: '2026-06-02', state: 'fellback' }, streak_fellback: 3, health: 'template-only' },
  },
  requested: { as_of: null, days: 30 },
  narrative:
    'The AI wrote 5 of 9 morning briefs in its own words; the rest used the safe template — all grounded to your verified numbers. ' +
    'Heads up — the last 3 fell back to the template.',
  delivery: {
    status: 'stalled', severity: 'critical', alert: true, reason: 'stalled-streak',
    streak: 3, coverage: 0.25, narratable: 4, latest_as_of: '2026-06-02', audience: 'agency',
    action: 'Check the narration model now — an expired API key, a rate limit, or a provider outage — then regenerate.',
    narrative:
      'The portfolio morning brief has fallen back to the safe template 3 times running (most recent 2026-06-02). ' +
      'Check the narration model now — an expired API key, a rate limit, or a provider outage — then regenerate. ' +
      'Every number stayed grounded throughout.',
    streams: {
      client: { audience: 'client', status: 'ok',      reason: 'ok',             alert: false, streak: 0, coverage: 0.8,  narratable: 5, latest_as_of: '2026-06-02' },
      agency: { audience: 'agency', status: 'stalled', reason: 'stalled-streak', alert: true,  streak: 3, coverage: 0.25, narratable: 4, latest_as_of: '2026-06-02' },
    },
  },
}

// ── the narrator's own self-check banner (intel-v7 11c) — preview twin of BriefDeliveryBanner on
// Intelligence.jsx (cn → template strings so the preview matches this file). Fires ONLY when a
// per-audience fallback run crosses the graded threshold (amber = degrading ≥2, rose = stalled ≥3);
// silent on healthy/quiet. The narrative already embeds the self-heal action + grounded tail, so the
// banner peels both known suffixes off and re-renders them as their own chip + reassurance line —
// nothing shows twice. Agency-only: a client never sees that the writer itself stumbled.
const BRIEF_DELIVERY_TONE = {
  stalled:  { wrap: 'border-rose-200 bg-rose-50',   icon: 'text-rose-500',  kicker: 'text-rose-600',  head: 'text-rose-900',  body: 'text-rose-800/80',  chip: 'border-rose-200 bg-white text-rose-700',  label: 'Narration stalled' },
  degraded: { wrap: 'border-amber-200 bg-amber-50', icon: 'text-amber-500', kicker: 'text-amber-600', head: 'text-amber-900', body: 'text-amber-800/80', chip: 'border-amber-200 bg-white text-amber-700', label: 'Narration degrading' },
}
const BRIEF_GROUNDED_TAIL = 'Every number stayed grounded throughout.'

function BriefDeliveryBannerPreview({ delivery }) {
  if (!delivery || !delivery.alert) return null
  const t      = BRIEF_DELIVERY_TONE[delivery.status] || BRIEF_DELIVERY_TONE.degraded
  const Icon   = delivery.status === 'stalled' ? AlertOctagon : AlertTriangle
  const action = (delivery.action || '').trim()
  let body = (delivery.narrative || '').trim()
  if (body.endsWith(BRIEF_GROUNDED_TAIL)) body = body.slice(0, -BRIEF_GROUNDED_TAIL.length).trim()
  if (action && body.endsWith(action))    body = body.slice(0, -action.length).trim()
  if (!body) body = `The ${delivery.audience === 'agency' ? 'portfolio' : 'client'} morning brief keeps falling back to the safe template.`
  return (
    <div className={`mb-4 rounded-xl border px-3.5 py-3 ${t.wrap}`} role="alert">
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${t.icon}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-[10px] font-black uppercase tracking-wider ${t.kicker}`}>Narrator self-check · {t.label}</p>
          <p className={`mt-0.5 text-[13px] font-bold leading-snug ${t.head}`}>{body}</p>
          {action && (
            <div className="mt-2 flex items-start gap-1.5">
              <span className={`mt-px inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider shrink-0 ${t.chip}`}>
                <Wrench className="w-2.5 h-2.5" /> Self-heal
              </span>
              <span className={`text-[11px] font-medium leading-snug ${t.body}`}>{action}</span>
            </div>
          )}
          <p className={`mt-2 text-[10px] font-medium leading-snug ${t.body}`}>
            Clients were never affected — their dashboards and digests already fell back to the same safe, fully-grounded template, so every number they saw stayed correct.
          </p>
        </div>
      </div>
    </div>
  )
}

function BriefHealthPanelPreview({ data }) {
  const o = data.overall
  const tone = BRIEF_HEALTH_TONE[o.health] || BRIEF_HEALTH_TONE['no-data']
  const coveragePct = o.coverage != null ? Math.round(o.coverage * 100) : 0
  const groundedPct = data.grounded_rate != null ? Math.round(data.grounded_rate * 100) : null
  const models = Object.entries(o.models || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(' · ')
  return (
    <div className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Radar className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Narration reliability</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">How often the analyst writes the brief itself · last {data.requested.days} days</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
        {groundedPct != null && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
            <ShieldCheck className="w-3 h-3" /> {groundedPct}% grounded
          </span>
        )}
      </div>
      <div className="px-4 py-4">
        <BriefDeliveryBannerPreview delivery={data.delivery} />
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{coveragePct}%</span>
            <span className="text-[11px] font-bold text-slate-400">narrated</span>
          </div>
          <p className="text-[11px] font-semibold text-slate-400 pb-0.5">{o.narrated} of {o.narratable} briefs worth narrating, in its own words</p>
        </div>
        <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${coveragePct}%` }} />
        </div>
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">{data.narrative}</p>
        <div className="mt-3 flex items-center gap-4 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2">
          <BriefHealthStatPreview label="Client briefs"   view={briefCoverageView(data.by_audience.client)} />
          <span className="w-px self-stretch bg-slate-200" />
          <BriefHealthStatPreview label="Portfolio brief" view={briefCoverageView(data.by_audience.agency)} />
        </div>
        {models && <p className="mt-2 text-[10px] font-medium text-slate-400 truncate">Writers: {models}</p>}
        {o.streak_fellback >= 2 && !data.delivery && (
          <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
            <AlertTriangle className="w-3 h-3 shrink-0" /> The last {o.streak_fellback} briefs fell back to the template — the narration model may be unreachable.
          </p>
        )}
      </div>
      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          Two separate questions, never conflated: <span className="font-semibold text-slate-500">coverage</span> is how often the analyst wrote in its own words (vs the safe template);
          {' '}<span className="font-semibold text-emerald-600">grounded</span> is whether every number stayed verified — which holds even when it falls back. Quiet mornings count against neither.
          {` Graded over ${o.total} briefs, ${data.window.from} – ${data.window.to}.`} Agency-only.
        </p>
      </div>
    </div>
  )
}

// ── EDITORIAL PRECISION (intel-v7 12c) — preview twin of BriefImpactPanel on Intelligence.jsx.
// The THIRD and sharpest self-audit of the morning brief: not "did we write it" (reliability) or
// "did we deliver it" (the self-check banner), but "did the call we LED with hold up?" Each shipped
// lead is replayed over the WINDOW mornings that followed it and graded earned / fair / overcalled —
// a disjoint third vocabulary so it never blurs with narration coverage. Static graded render (cn →
// template strings, no fetch/loading/error/no-data) so the preview matches this file. Agency-only.
const BRIEF_IMPACT_TONE = {
  earned:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'Well-aimed' },
  fair:       { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'A fair record' },
  overcalled: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    bar: 'bg-rose-400',    label: 'Overcalling' },
  'no-data':  { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   bar: 'bg-slate-200',   label: 'Building record' },
}
// One impact bucket → a three-state view: 'none' (no leads, —), 'pending' (leads logged but none
// resolved — young calls still abstaining, not a 0%), 'graded' (carries its hit-rate %). Mirrors
// briefCoverageView's shape so the stat atoms read identically across the panels.
function briefImpactView(b) {
  if (!b || !b.sample)  return { state: 'none',    pct: null, hits: 0, judged: 0, sample: 0 }
  if (!b.judged)        return { state: 'pending',  pct: null, hits: 0, judged: 0, sample: b.sample }
  return { state: 'graded', pct: b.hit_rate != null ? Math.round(b.hit_rate * 100) : 0, hits: b.hits, judged: b.judged, sample: b.sample }
}
// Humanize a triage-lane key ('act_now'→'Act now', 'worth_a_look'→'Worth a look', ''→'Unspecified').
function laneLabel(key) {
  const s = String(key || '').trim().replace(/_/g, ' ')
  if (!s) return 'Unspecified'
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function BriefImpactStatPreview({ label, view }) {
  return (
    <div className="flex-1 min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 truncate">{label}</p>
      {view.state === 'none'
        ? <p className="text-sm font-black text-slate-300 leading-tight">—</p>
        : view.state === 'pending'
        ? <p className="text-sm font-bold text-slate-400 leading-tight" title="Leads logged, none resolved yet — still abstaining">Building</p>
        : <p className="text-sm font-black text-slate-800 leading-tight tabular-nums">{view.pct}%<span className="ml-1 text-[11px] font-semibold text-slate-400">{view.hits}/{view.judged}</span></p>}
    </div>
  )
}
// One lane row: name · mini hit-rate bar · pct · hits/judged. A lane still abstaining shows an empty
// track and a calm "—", never a misleading 0%.
function BriefImpactLaneRowPreview({ name, bucket }) {
  const view = briefImpactView(bucket)
  const tone = BRIEF_IMPACT_TONE[bucket?.label] || BRIEF_IMPACT_TONE['no-data']
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] font-semibold text-slate-500 truncate" title={name}>{name}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        {view.state === 'graded' && <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${view.pct}%` }} />}
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-700">
        {view.state === 'graded' ? `${view.pct}%` : '—'}
      </span>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold text-slate-400 tabular-nums">
        {view.state === 'graded' ? `${view.hits}/${view.judged}` : `0/${view.sample}`}
      </span>
    </div>
  )
}

// Shaped EXACTLY like GET /api/ai/brief-impact over a 30-day brief history graded on a 7-morning
// follow-through: 14 trackable leads shipped, 11 resolved, 6 held up (~55% → 'fair'). The audience
// split does real work — CLIENT leads earned their place (5/6, 83%) while PORTFOLIO leads overcalled
// (1/5, 20%), netting to a fair overall. by_lane shows which triage lanes earned the lead: act_now
// confirms best (3/4), tailwind is fair (2/3), worth_a_look overcalls (1/4), and verify is still
// abstaining (0 resolved). Every bucket honours hits+misses+unknown===sample, and the audience and
// lane splits each sum back to the overall. narrative is verbatim narrateBriefImpact(impact,'agency').
const BRIEF_IMPACT = {
  status: 'graded', reason: 'graded', window: 7, min_sample: 4,
  sample: 14, judged: 11, hits: 6, misses: 5, unknown: 3,
  hit_rate: 6 / 11, label: 'fair',
  by_lane: {
    act_now:      { sample: 5, judged: 4, hits: 3, misses: 1, unknown: 1, hit_rate: 3 / 4, label: 'earned' },
    tailwind:     { sample: 3, judged: 3, hits: 2, misses: 1, unknown: 0, hit_rate: 2 / 3, label: 'fair' },
    worth_a_look: { sample: 4, judged: 4, hits: 1, misses: 3, unknown: 0, hit_rate: 1 / 4, label: 'overcalled' },
    verify:       { sample: 2, judged: 0, hits: 0, misses: 0, unknown: 2, hit_rate: null, label: null },
  },
  by_audience: {
    client: { sample: 8, judged: 6, hits: 5, misses: 1, unknown: 2, hit_rate: 5 / 6, label: 'earned' },
    agency: { sample: 6, judged: 5, hits: 1, misses: 4, unknown: 1, hit_rate: 1 / 5, label: 'overcalled' },
  },
  requested: { as_of: null, days: 30 },
  narrative: 'Our morning leads have earned their place 6 of 11 times recently (~55%) — a fair record.',
}

function BriefImpactPanelPreview({ data }) {
  const tone      = BRIEF_IMPACT_TONE[data.label] || BRIEF_IMPACT_TONE['no-data']
  const hitPct    = data.hit_rate != null ? Math.round(data.hit_rate * 100) : 0
  const narrative = (data.narrative || '').trim()
  const days      = data.requested.days
  const window    = data.window
  const lanes     = Object.entries(data.by_lane || {})
    .sort((a, b) => {
      const ra = a[1]?.hit_rate, rb = b[1]?.hit_rate
      if (ra == null && rb == null) return (b[1]?.sample || 0) - (a[1]?.sample || 0)
      if (ra == null) return 1
      if (rb == null) return -1
      return rb - ra
    })
    .slice(0, 6)
  return (
    <div className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Crosshair className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Editorial precision</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Did the call we led with hold up · last {days} days</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500">
          <Clock className="w-3 h-3" /> {window}-morning follow-through
        </span>
      </div>
      <div className="px-4 py-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{hitPct}%</span>
            <span className="text-[11px] font-bold text-slate-400">held up</span>
          </div>
          <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
            {data.hits} of {data.judged} {data.judged === 1 ? 'lead' : 'leads'} held up over the following mornings
            {data.unknown > 0 ? ` · ${data.unknown} still abstaining` : ''}
          </p>
        </div>
        <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${hitPct}%` }} />
        </div>
        {narrative && <p className="mt-3 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
        <div className="mt-3 flex items-center gap-4 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2">
          <BriefImpactStatPreview label="Client leads"    view={briefImpactView(data.by_audience.client)} />
          <span className="w-px self-stretch bg-slate-200" />
          <BriefImpactStatPreview label="Portfolio leads" view={briefImpactView(data.by_audience.agency)} />
        </div>
        {lanes.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Which lanes earned the lead</p>
            <div className="space-y-1.5">
              {lanes.map(([key, bucket]) => (
                <BriefImpactLaneRowPreview key={key} name={laneLabel(key)} bucket={bucket} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          A third, separate question — not did we <span className="font-semibold text-slate-500">write</span> the brief or <span className="font-semibold text-slate-500">deliver</span> it, but did the call we
          {' '}<span className="font-semibold text-slate-500">led with</span> hold up. A lead is graded only once its {window}-morning follow-through resolves — young calls abstain, never count against us.
          {' '}<span className="font-semibold text-emerald-600">earned</span> ≥70% · <span className="font-semibold text-amber-600">fair</span> 40–69% · <span className="font-semibold text-rose-600">overcalled</span> &lt;40%. Agency-only.
        </p>
      </div>
    </div>
  )
}

// ── 13c learned lead policy (agency · Intelligence) ─────────────────────────────
// Preview twin of LeadPolicyPanel. Editorial precision (12c) MEASURES whether the call we led
// with held up; this is the TUNE half — each lane's front-page hit-rate becomes a bounded weight
// in [0.8, 1.2] the morning brief applies when it ranks candidates for the one lead. promote a
// lane that keeps earning the front page, ease one that keeps overcalling, with act_now safety-
// floored (promotable, never demoted). Static graded render with template-string classNames;
// laneLabel() is reused from the 12c block above. Fictional client names.
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
function leadLaneSub(entry) {
  const judged = entry && Number.isFinite(entry.judged) ? entry.judged : 0
  const hr = entry && Number.isFinite(entry.hit_rate) ? entry.hit_rate : null
  if (judged > 0 && hr != null) return `${Math.round(hr * 100)}% held · ${judged} resolved`
  if (judged > 0) return `${judged} resolved`
  return 'building'
}
function LeadPolicyLaneRowPreview({ name, entry, bounds }) {
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
        <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 leading-tight">
          <span className="truncate">{name}</span>
          {entry?.safetyFloored && <ShieldCheck className="w-3 h-3 text-indigo-500 shrink-0" />}
        </div>
        <p className="text-[10px] font-medium text-slate-400 leading-tight tabular-nums truncate">{leadLaneSub(entry)}</p>
      </div>
      <div className="relative flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-slate-300" />
        {rightPct > 0 && <div className={`absolute inset-y-0 left-1/2 rounded-r-full ${tone.fill}`} style={{ width: `${rightPct}%` }} />}
        {leftPct > 0 && <div className={`absolute inset-y-0 rounded-l-full ${tone.fill}`} style={{ right: '50%', width: `${leftPct}%` }} />}
      </div>
      <span className={`w-12 shrink-0 inline-flex items-center justify-end gap-0.5 text-[11px] font-black tabular-nums ${tone.text}`}>
        <Icon className="w-3 h-3 shrink-0" />×{w.toFixed(2)}
      </span>
    </div>
  )
}

// fixture A — the TUNE of the very grade shown in 12c above: act_now earned the front page
// (3/4) → lifted to ×1.10; worth_a_look kept overcalling (1/4) → eased to ×0.90; tailwind looks
// fair but only 3 resolved (under the 4-sample bar) so it abstains at neutral; verify has nothing
// resolved yet. Shaped exactly like GET /api/ai/lead-policy (deriveLeadPolicy + requested + narrative).
const LEAD_POLICY = {
  status: 'tuned',
  neutral_rate: 0.5,
  min_sample: 4,
  bounds: { min: 0.8, max: 1.2 },
  safety_floor_lanes: ['act_now'],
  lanes: {
    act_now:      { weight: 1.10, direction: 'promote', adjusted: true,  judged: 4, hit_rate: 0.75, label: 'earned',     reason: 'promoted',            safetyFloored: false },
    worth_a_look: { weight: 0.90, direction: 'demote',  adjusted: true,  judged: 4, hit_rate: 0.25, label: 'overcalled', reason: 'demoted',             safetyFloored: false },
    tailwind:     { weight: 1.0,  direction: 'neutral', adjusted: false, judged: 3, hit_rate: 0.667, label: 'fair',      reason: 'insufficient_sample', safetyFloored: false },
    verify:       { weight: 1.0,  direction: 'neutral', adjusted: false, judged: 0, hit_rate: null,  label: null,        reason: 'insufficient_sample', safetyFloored: false },
  },
  promoted: 1, demoted: 1, floored: 0, adjusted_count: 2,
  requested: { as_of: null, days: 30 },
  narrative: "From our own front-page track record, we've learned to lead more with act now and ease off worth a look.",
}

// fixture B — the safety floor FIRING, the rarer but most important case: act_now actually
// underperformed (1/5) and EARNED a demotion to ×0.88 — but it's a safety lane, so it's pinned
// back to ×1.00 (shield), promotable but never eased. Meanwhile tailwind maxed out (4/4 → ×1.20)
// and worth_a_look earned a lift (≈0.88 → ×1.15). Shows the asymmetry no other panel can.
const LEAD_POLICY_FLOORED = {
  status: 'tuned',
  neutral_rate: 0.5,
  min_sample: 4,
  bounds: { min: 0.8, max: 1.2 },
  safety_floor_lanes: ['act_now'],
  lanes: {
    tailwind:     { weight: 1.20, direction: 'promote', adjusted: true,  judged: 4, hit_rate: 1.0,   label: 'earned',     reason: 'promoted',      safetyFloored: false },
    worth_a_look: { weight: 1.15, direction: 'promote', adjusted: true,  judged: 4, hit_rate: 0.875, label: 'earned',     reason: 'promoted',      safetyFloored: false },
    act_now:      { weight: 1.0,  direction: 'neutral', adjusted: false, judged: 5, hit_rate: 0.2,   label: 'overcalled', reason: 'safety_floored', safetyFloored: true },
    verify:       { weight: 1.0,  direction: 'neutral', adjusted: false, judged: 4, hit_rate: 0.5,   label: 'fair',       reason: 'neutral',       safetyFloored: false },
  },
  promoted: 2, demoted: 0, floored: 1, adjusted_count: 2,
  requested: { as_of: null, days: 30 },
  narrative: "From our own front-page track record, we've learned to lead more with tailwind and worth a look.",
}

function LeadPolicyPanelPreview({ data }) {
  const st = data?.status || 'abstained'
  const tuned = st === 'tuned'
  const tone = LEAD_POLICY_TONE[st] || LEAD_POLICY_TONE.abstained
  const narrative = (data?.narrative || '').trim()
  const days = data?.requested?.days || 30
  const bounds = data?.bounds || { min: 0.8, max: 1.2 }
  const bandPct = Math.round(((bounds.max ?? 1.2) - 1) * 100)
  const minSample = data?.min_sample || 4
  const lanes = Object.entries(data?.lanes || {})
    .sort((a, b) => {
      const da = Math.abs((a[1]?.weight ?? 1) - 1), db = Math.abs((b[1]?.weight ?? 1) - 1)
      if (db !== da) return db - da
      const fa = a[1]?.safetyFloored ? 1 : 0, fb = b[1]?.safetyFloored ? 1 : 0
      if (fb !== fa) return fb - fa
      return (b[1]?.judged || 0) - (a[1]?.judged || 0)
    })
    .slice(0, 6)
  const promoted = data?.promoted || 0, demoted = data?.demoted || 0, floored = data?.floored || 0
  const adjusted = data?.adjusted_count || 0
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
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500">
          <Scale className="w-3 h-3" /> ±{bandPct}% band
        </span>
      </div>

      <div className="px-4 py-4">
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
                ? `Every lane holds at even weight — nothing has crossed the bar to move off neutral yet. A lane needs ${minSample}+ resolved leads to tune, and the safety lane only ever lifts.`
                : `Holding the front page byte-for-byte with the live pulse — the editorial-precision record isn't graded yet, so nothing is reprioritised.`}
            </p>
          </div>
        )}

        {lanes.length > 0 && (
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
                <LeadPolicyLaneRowPreview key={key} name={laneLabel(key)} entry={entry} bounds={bounds} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          The <span className="font-semibold text-slate-500">tune</span> half of editorial precision: each lane's recent hit-rate becomes a bounded weight the brief applies when it picks the one lead — <span className="font-semibold text-emerald-600">lead more</span> with a lane that keeps earning the front page, <span className="font-semibold text-amber-600">ease off</span> one that keeps overcalling. Neutral = <span className="tabular-nums font-semibold text-slate-500">×1.00</span>; the band is ±{bandPct}%, so it reprioritises but never silences. <span className="font-semibold text-indigo-600">act_now is safety-floored</span> — promotable, never eased. Abstains until the record is graded. Agency-only.
        </p>
      </div>
    </section>
  )
}

// ── 14c LEAD-POLICY STABILITY — "watch the watcher" ───────────────────────────
// The panel above tunes itself each morning; this one audits whether that loop is trustworthy
// right now. A FIFTH disjoint vocabulary (stable / settling / unstable / constrained / flagged /
// idle / abstained) over a per-lane verdict, shaped EXACTLY like GET /api/ai/lead-policy-health
// (assessLeadPolicyHealth + requested + narrative). The per-lane weight SERIES renders as a
// divergent sparkline so the failure a single snapshot hides becomes visible: a zigzag is
// oscillation, a flat-topped run is saturation, bars collapsing to the line are convergence.
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
function LeadHealthSeriesPreview({ series, bounds, state }) {
  const vals = Array.isArray(series) ? series : []
  const min = Number.isFinite(bounds?.min) ? bounds.min : 0.8
  const max = Number.isFinite(bounds?.max) ? bounds.max : 1.2
  const fill = (LEAD_HEALTH_LANE[state] || LEAD_HEALTH_LANE.idle).fill
  if (!vals.length) return null
  return (
    <div className="relative h-7 w-full flex items-stretch gap-px">
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
              className={`absolute left-1/2 -translate-x-1/2 w-[60%] min-w-[3px] ${fill} ${up ? 'bottom-1/2 rounded-t-sm' : 'top-1/2 rounded-b-sm'}`}
              style={{ height: `${h}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}
function LeadHealthLaneRowPreview({ name, lane, bounds }) {
  const tone = LEAD_HEALTH_LANE[lane?.state] || LEAD_HEALTH_LANE.idle
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate">{name}</div>
        <span className={`mt-0.5 inline-flex items-center rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed ${tone.badge}`}>
          {tone.label}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <LeadHealthSeriesPreview series={lane?.series} bounds={bounds} state={lane?.state} />
      </div>
      <span className={`w-28 shrink-0 text-right text-[10px] font-semibold leading-tight tabular-nums ${tone.text}`}>
        {leadHealthEvidence(lane)}
      </span>
    </div>
  )
}

// fixture A — the loop THRASHING: worth_a_look's weight ping-pongs above and below neutral on
// noise (4 reversals → oscillating), so the verdict is unstable and the loop reverts that lane to
// ×1.00 on its own. act_now has been pinned to the ceiling for 4 straight mornings (saturated_high
// → the nudge became a wall), and a quiet tailwind has settled.
const LEAD_HEALTH_UNSTABLE = {
  status: 'unstable',
  recommended_action: 'revert_to_neutral',
  as_of: null,
  window_used: 6,
  history_len: 6,
  bounds: { min: 0.8, max: 1.2 },
  lanes: {
    worth_a_look: { state: 'oscillating',    flips: 4, high_run: 1, low_run: 1, mask_runs: 0, spread: 0.34, last_weight: 1.12, last_direction: 'promote', present: 6, series: [1.12, 0.88, 1.15, 0.85, 1.10, 0.90] },
    act_now:      { state: 'saturated_high', flips: 0, high_run: 4, low_run: 0, mask_runs: 0, spread: 0.04, last_weight: 1.20, last_direction: 'promote', present: 6, series: [1.06, 1.12, 1.20, 1.20, 1.20, 1.20] },
    tailwind:     { state: 'settling',       flips: 1, high_run: 0, low_run: 0, mask_runs: 0, spread: 0.06, last_weight: 1.04, last_direction: 'promote', present: 5, series: [null, 1.10, 1.02, 1.06, 1.03, 1.04] },
    verify:       { state: 'idle',           flips: 0, high_run: 0, low_run: 0, mask_runs: 0, spread: 0.00, last_weight: 1.00, last_direction: 'neutral', present: 6, series: [1, 1, 1, 1, 1, 1] },
  },
  counts: { oscillating: 1, saturated: 1, masked: 0, settling: 1, stable: 0, idle: 1, active: 3 },
  verdict_reason: 'worth_a_look oscillating (4 reversals in 6 mornings)',
  requested: { as_of: null, days: 6 },
  narrative: "The lead order is thrashing: worth a look has flipped direction 4 times in 6 mornings, so we've reset it to neutral and will let it re-earn its place on a calmer record.",
}

// fixture B — the loop CONVERGED and SAFE: every active lane has settled within band, the safety
// floor isn't masking anything, and the verdict is stable → trust the loop. The sparklines are
// near-flat, the calm shape that says "no human needed". The agency narration is brief; the panel's
// own headline carries the rest.
const LEAD_HEALTH_STABLE = {
  status: 'stable',
  recommended_action: 'trust',
  as_of: null,
  window_used: 6,
  history_len: 6,
  bounds: { min: 0.8, max: 1.2 },
  lanes: {
    act_now:      { state: 'stable',   flips: 0, high_run: 1, low_run: 0, mask_runs: 0, spread: 0.03, last_weight: 1.10, last_direction: 'promote', present: 6, series: [1.08, 1.10, 1.09, 1.11, 1.10, 1.10] },
    worth_a_look: { state: 'stable',   flips: 0, high_run: 0, low_run: 1, mask_runs: 0, spread: 0.02, last_weight: 0.92, last_direction: 'demote',  present: 6, series: [0.94, 0.92, 0.93, 0.91, 0.92, 0.92] },
    tailwind:     { state: 'settling', flips: 1, high_run: 0, low_run: 0, mask_runs: 0, spread: 0.05, last_weight: 1.03, last_direction: 'promote', present: 5, series: [null, 1.07, 1.01, 1.04, 1.02, 1.03] },
    verify:       { state: 'idle',     flips: 0, high_run: 0, low_run: 0, mask_runs: 0, spread: 0.00, last_weight: 1.00, last_direction: 'neutral', present: 6, series: [1, 1, 1, 1, 1, 1] },
  },
  counts: { oscillating: 0, saturated: 0, masked: 0, settling: 1, stable: 2, idle: 1, active: 4 },
  verdict_reason: 'all active lanes within band, no oscillation or saturation',
  requested: { as_of: null, days: 6 },
  narrative: "The tuning loop has settled — every lane it has moved is holding inside its band with no thrash, so the learned lead order can be trusted as-is.",
}

function LeadPolicyHealthPanelPreview({ data }) {
  const st = data?.status || 'abstained'
  const tone = LEAD_HEALTH_TONE[st] || LEAD_HEALTH_TONE.abstained
  const HeadIcon = tone.Icon
  const action = LEAD_HEALTH_ACTION[data?.recommended_action] || null
  const ActionIcon = action?.Icon
  const narrative = (data?.narrative || '').trim()
  const headline = leadHealthHeadline(st)
  const windowUsed = data?.window_used || data?.requested?.days || 6
  const historyLen = data?.history_len || 0
  const bounds = data?.bounds || { min: 0.8, max: 1.2 }
  const counts = data?.counts || {}
  const concerns = [
    counts.oscillating > 0 ? `${counts.oscillating} oscillating` : null,
    counts.saturated > 0 ? `${counts.saturated} at bounds` : null,
    counts.masked > 0 ? `${counts.masked} floor-masked` : null,
    counts.settling > 0 ? `${counts.settling} settling` : null,
    counts.stable > 0 ? `${counts.stable} stable` : null,
  ].filter(Boolean)
  const lanes = Object.entries(data?.lanes || {})
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
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
      </div>

      <div className="px-4 py-4">
        <div className="flex items-start gap-2">
          <HeadIcon className={`w-4 h-4 shrink-0 mt-0.5 ${tone.text}`} />
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800 leading-snug">{headline}</p>
            {narrative && <p className="mt-1 text-sm text-slate-600 leading-relaxed">{narrative}</p>}
          </div>
        </div>

        {action && (
          <div className="mt-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${action.tone}`}>
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

        {lanes.length > 0 && (
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
                <LeadHealthLaneRowPreview key={key} name={laneLabel(key)} lane={lane} bounds={bounds} />
              ))}
            </div>
          </div>
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

/* ── 15c LEAD-POLICY GOVERNANCE — "the governor". The monitor above DIAGNOSES the loop;
    this one ACTS on the verdict — the surgeon that consumes the stability read and applies the
    safe per-lane corrective with no human in the path. It resets ONLY a thrashing lane to neutral
    and keeps every earned lane live (where layer 14's blunt all-or-nothing revert would have lost
    them); a lane pinned to its band or one the safety floor is masking it LOGS for a human, never
    auto-widening anything. Snapshot-backed and reversible. A SIXTH disjoint vocabulary —
    corrected / advised / clean / abstained — so it never blurs with the five it sits beneath.
    Preview twin of <LeadPolicyGovernancePanel/>: reads a `data` prop, never fetches. ─────────── */
const LEAD_GOV_TONE = {
  corrected: { pill: 'border-violet-200 bg-violet-50 text-violet-700',    dot: 'bg-violet-500',  text: 'text-violet-500',  label: 'Corrected',  Icon: Wrench },
  advised:   { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'Advisories', Icon: Scale },
  clean:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Steady',     Icon: ShieldCheck },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining', Icon: Minus },
}
// neutralize is the ONE that changed a weight (the surgeon's cut, applied); hold/floor changed
// nothing — they're logged for a human, never auto-applied.
const LEAD_GOV_ACTION = {
  neutralize:    { badge: 'border-violet-200 bg-violet-50 text-violet-600', text: 'text-violet-600', Icon: Scissors,    label: 'Reset',      changed: true },
  hold_at_bound: { badge: 'border-amber-200 bg-amber-50 text-amber-600',    text: 'text-amber-600',  Icon: Gauge,       label: 'Held',       changed: false },
  respect_floor: { badge: 'border-indigo-200 bg-indigo-50 text-indigo-600', text: 'text-indigo-600', Icon: ShieldCheck, label: 'Floor kept', changed: false },
}
const LEAD_GOV_RANK = { neutralize: 0, hold_at_bound: 1, respect_floor: 2 }
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
function LeadGovInterventionRowPreview({ intervention }) {
  const meta = LEAD_GOV_ACTION[intervention?.action] || LEAD_GOV_ACTION.hold_at_bound
  const Icon = meta.Icon
  const fw = Number.isFinite(intervention?.from_weight) ? intervention.from_weight : 1
  const tw = Number.isFinite(intervention?.to_weight) ? intervention.to_weight : fw
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(intervention?.lane)}>{laneLabel(intervention?.lane)}</div>
        <span className={`mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed ${meta.badge}`}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">
        {govStateReason(intervention?.state)}
      </div>
      <span className={`w-24 shrink-0 text-right text-[11px] font-black tabular-nums ${meta.text}`}>
        {meta.changed
          ? <>×{fw.toFixed(2)} <span className="text-slate-300">→</span> ×{tw.toFixed(2)}</>
          : <>held ×{fw.toFixed(2)}</>}
      </span>
    </div>
  )
}

// corrected-with-survivor: the thrashing lane snaps to neutral, the EARNED lanes ride untouched —
// governed.status stays 'tuned' because a learned order still applies. This is the case layer 14's
// blunt revert-everything would have got wrong.
const GOV_CORRECTED_SURVIVOR = {
  status: 'corrected',
  verdict_status: 'unstable',
  source_status: 'tuned',
  governed: { status: 'tuned' },
  interventions: [
    { lane: 'worth_a_look', action: 'neutralize', state: 'oscillating', from_weight: 1.10, to_weight: 1.00, from_direction: 'promote', to_direction: 'neutral', reason: 'oscillation' },
  ],
  snapshot: { lanes: {
    act_now:      { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: true },
    verify:       { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: false },
    worth_a_look: { weight: 1.10, direction: 'promote', adjusted: true,  safetyFloored: false },
    monitor:      { weight: 0.95, direction: 'demote',  adjusted: true,  safetyFloored: false },
    tailwind:     { weight: 1.15, direction: 'promote', adjusted: true,  safetyFloored: false },
  } },
  counts: { neutralized: 1, held: 0, floored_respected: 0, passed: 4 },
  requested: { as_of: '2026-06-03', days: 6 },
  narrative: 'Reset Worth a look to neutral — it flipped direction four times across the last six mornings, which is noise, not learning. Tailwind keeps its earned ×1.15 and the rest ride as learned; the pre-reset weights are kept for rollback.',
}
// corrected-sole-lane: the reset lane was the ONLY one carrying weight, so neutralising it drops the
// adjusted count to zero — governed.status falls to 'idle' and the brief leads in default order.
const GOV_CORRECTED_SOLE = {
  status: 'corrected',
  verdict_status: 'unstable',
  source_status: 'tuned',
  governed: { status: 'idle' },
  interventions: [
    { lane: 'verify', action: 'neutralize', state: 'oscillating', from_weight: 0.90, to_weight: 1.00, from_direction: 'demote', to_direction: 'neutral', reason: 'oscillation' },
  ],
  snapshot: { lanes: {
    act_now:      { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: true },
    verify:       { weight: 0.90, direction: 'demote',  adjusted: true,  safetyFloored: false },
    worth_a_look: { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: false },
    monitor:      { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: false },
    tailwind:     { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: false },
  } },
  counts: { neutralized: 1, held: 0, floored_respected: 0, passed: 4 },
  requested: { as_of: '2026-06-03', days: 6 },
  narrative: 'Reset Verify to neutral — it was the only lane carrying weight and it was thrashing. With nothing else tuned, the brief leads in its default order until the loop re-earns a lift; the pre-reset weight is kept for rollback.',
}
// advised: nothing reset — a saturated lane HELD at its bound and a floor-masked lane RESPECTED,
// both logged for a human, never auto-applied. The narrator stays silent on non-corrected verdicts,
// so the headline carries the meaning.
const GOV_ADVISED = {
  status: 'advised',
  verdict_status: 'constrained',
  source_status: 'tuned',
  governed: { status: 'tuned' },
  interventions: [
    { lane: 'tailwind', action: 'hold_at_bound', state: 'saturated_high', from_weight: 1.20, to_weight: 1.20, from_direction: 'promote', to_direction: 'promote', reason: 'saturation' },
    { lane: 'act_now',  action: 'respect_floor', state: 'floor_masked',   from_weight: 1.00, to_weight: 1.00, from_direction: 'neutral', to_direction: 'neutral', reason: 'floor_mask' },
  ],
  snapshot: { lanes: {
    act_now:      { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: true },
    verify:       { weight: 1.05, direction: 'promote', adjusted: true,  safetyFloored: false },
    worth_a_look: { weight: 1.10, direction: 'promote', adjusted: true,  safetyFloored: false },
    monitor:      { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: false },
    tailwind:     { weight: 1.20, direction: 'promote', adjusted: true,  safetyFloored: false },
  } },
  counts: { neutralized: 0, held: 1, floored_respected: 1, passed: 3 },
  requested: { as_of: '2026-06-03', days: 6 },
  narrative: '',
}
// clean: every lane learning cleanly — nothing touched, the empty-state ShieldCheck path.
const GOV_CLEAN = {
  status: 'clean',
  verdict_status: 'stable',
  source_status: 'tuned',
  governed: { status: 'tuned' },
  interventions: [],
  snapshot: { lanes: {
    act_now:      { weight: 1.00, direction: 'neutral', adjusted: false, safetyFloored: true },
    verify:       { weight: 1.05, direction: 'promote', adjusted: true,  safetyFloored: false },
    worth_a_look: { weight: 1.10, direction: 'promote', adjusted: true,  safetyFloored: false },
    monitor:      { weight: 0.95, direction: 'demote',  adjusted: true,  safetyFloored: false },
    tailwind:     { weight: 1.15, direction: 'promote', adjusted: true,  safetyFloored: false },
  } },
  counts: { neutralized: 0, held: 0, floored_respected: 0, passed: 5 },
  requested: { as_of: '2026-06-03', days: 6 },
  narrative: '',
}
function LeadPolicyGovernancePanelPreview({ data }) {
  const st = data?.status || 'abstained'
  const tone = LEAD_GOV_TONE[st] || LEAD_GOV_TONE.abstained
  const HeadIcon = tone.Icon
  const governedStatus = data?.governed?.status || 'idle'
  const narrative = (data?.narrative || '').trim()
  const headline = leadGovHeadline(st, governedStatus)
  const windowUsed = data?.requested?.days || 6
  const counts = data?.counts || {}
  const interventions = Array.isArray(data?.interventions) ? data.interventions : []
  const laneTotal = Object.keys(data?.snapshot?.lanes || {}).length
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
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
      </div>

      <div className="px-4 py-4">
        <div className="flex items-start gap-2">
          <HeadIcon className={`w-4 h-4 shrink-0 mt-0.5 ${tone.text}`} />
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
                <LeadGovInterventionRowPreview key={`${iv?.lane || 'lane'}-${i}`} intervention={iv} />
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
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The governor.</span> The monitor above diagnoses the loop; this <span className="font-semibold text-violet-600">acts</span> on the verdict — surgically, per lane, with no human in the path. It <span className="font-semibold text-violet-600">resets</span> only a thrashing lane to neutral and keeps every earned lane live; a lane <span className="font-semibold text-amber-600">pinned to its band</span> or one the <span className="font-semibold text-indigo-600">floor is protecting</span> it logs for a human rather than auto-widening anything. Idempotent, snapshot-backed, reversible. Agency-only.
        </p>
      </div>
    </section>
  )
}

/* ── 16c LEAD-POLICY GOVERNANCE AUDIT — "the auditor". The governor above ACTS on the verdict every
    morning; this one grades the GOVERNOR — across mornings. It never grades a single morning's work;
    it watches the governor's OWN track record and asks one question: when the governor keeps applying
    the same safe reset to a lane, is that fix actually STICKING? A lane the learner keeps re-oscillating
    and the governor keeps neutralising looks handled each single morning while the root cause never
    resolves — so when the same reset recurs morning after morning, the auditor ESCALATES that one lane
    to a human rather than letting the loop churn forever. The governor keeps holding the line meanwhile;
    the auditor only recommends, never acts. A SEVENTH disjoint vocabulary — churning / effective / quiet
    / abstained at the roll-up, recurring / intermittent / resolved / one_off per lane — so it never blurs
    with the six it sits beneath. Preview twin of <LeadPolicyGovernanceAuditPanel/>: reads a `data` prop,
    never fetches. Four instances: churning (the escalation), effective (resets sticking, an intermittent
    lane held as context), quiet (nothing to correct), abstained (too little governed history). ──────── */
const LEAD_AUDIT_TONE = {
  churning:  { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    text: 'text-rose-500',    label: 'Churning',   Icon: AlertOctagon },
  effective: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Effective',  Icon: ShieldCheck },
  quiet:     { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Quiet',      Icon: Minus },
  abstained: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Abstaining', Icon: Clock },
}
// per-lane intervention OUTCOME → its badge + the colour of the run stat. recurring is the ONE that
// escalates (the safe corrective keeps not sticking); the rest are track-record context, never escalated.
const LEAD_AUDIT_OUTCOME = {
  recurring:    { badge: 'border-rose-200 bg-rose-50 text-rose-600',          text: 'text-rose-600',    Icon: AlertOctagon, label: 'Recurring',    escalate: true,  rank: 0 },
  intermittent: { badge: 'border-amber-200 bg-amber-50 text-amber-600',       text: 'text-amber-600',   Icon: Activity,     label: 'Intermittent', escalate: false, rank: 1 },
  resolved:     { badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', text: 'text-emerald-600', Icon: CheckCircle2, label: 'Resolved',     escalate: false, rank: 2 },
  one_off:      { badge: 'border-slate-200 bg-slate-50 text-slate-500',       text: 'text-slate-500',   Icon: Minus,        label: 'One-off',      escalate: false, rank: 3 },
}
const LEAD_AUDIT_RANK = { recurring: 0, intermittent: 1, resolved: 2, one_off: 3 }
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
function LeadAuditLaneRowPreview({ lane, info }) {
  const meta = LEAD_AUDIT_OUTCOME[info?.outcome] || LEAD_AUDIT_OUTCOME.one_off
  const Icon = meta.Icon
  const runs = Number.isFinite(info?.current_run) ? info.current_run : 0
  const corr = Number.isFinite(info?.corrections) ? info.corrections : 0
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(lane)}>{laneLabel(lane)}</div>
        <span className={`mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed ${meta.badge}`}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">
        {auditOutcomeReason(info?.outcome, info)}
      </div>
      <span className={`w-24 shrink-0 text-right text-[11px] font-black tabular-nums ${meta.text}`}>
        {meta.escalate
          ? <>{runs}× running</>
          : <>{corr}× total</>}
      </span>
    </div>
  )
}

// churning: the headline escalation case — Worth a look keeps needing the same reset three mornings
// running, so the auditor recommends a human. Verify, by contrast, was reset early and stayed settled.
const AUDIT_CHURNING = {
  status: 'churning',
  recommendation: { action: 'escalate', lanes: ['worth_a_look'] },
  as_of: '2026-06-03', window_used: 8, history_len: 8,
  lanes: {
    worth_a_look: { outcome: 'recurring', series: [1, 1, 0, 1, 1, 1], current_run: 3, max_run: 3, corrections: 5, last_action: 'neutralize' },
    verify:       { outcome: 'resolved',  series: [1, 1, 0, 0, 0, 0], current_run: 0, max_run: 2, corrections: 2, last_action: 'neutralize' },
  },
  counts: { recurring: 1, intermittent: 0, resolved: 1, one_off: 0, corrected_mornings: 5, advisory_mornings: 1, quiet_mornings: 2 },
  audit_reason: 'recurring_intervention',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: 'Worth a look has needed the same reset three mornings running — the governor keeps snapping it to neutral and the learner keeps re-earning the same thrash. The safe corrective is holding the line but not reaching the root cause, so this escalates that one lane to a human. Verify, for contrast, was reset early in the window and has stayed settled since — that is the fix working as intended.',
}
// effective: the governor is mostly working — Verify settled and stayed settled (resolved), Tailwind
// needed a single reset that never recurred (one_off), and Worth a look is reset on-and-off but is NOT
// on a runaway streak (intermittent) — so the auditor holds fire: intermittent is context, not alarm.
const AUDIT_EFFECTIVE = {
  status: 'effective',
  recommendation: { action: 'none', lanes: [] },
  as_of: '2026-06-03', window_used: 8, history_len: 8,
  lanes: {
    verify:       { outcome: 'resolved',     series: [1, 1, 0, 0, 0, 0], current_run: 0, max_run: 2, corrections: 2, last_action: 'neutralize' },
    worth_a_look: { outcome: 'intermittent', series: [1, 0, 1, 0, 1, 0], current_run: 0, max_run: 1, corrections: 3, last_action: 'neutralize' },
    tailwind:     { outcome: 'one_off',      series: [0, 0, 1, 0, 0, 0], current_run: 0, max_run: 1, corrections: 1, last_action: 'neutralize' },
  },
  counts: { recurring: 0, intermittent: 1, resolved: 1, one_off: 1, corrected_mornings: 4, advisory_mornings: 2, quiet_mornings: 2 },
  audit_reason: 'corrections_settling',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: '',
}
// quiet: the governor has had nothing to correct across the window — no resets, nothing to second-guess.
const AUDIT_QUIET = {
  status: 'quiet',
  recommendation: { action: 'none', lanes: [] },
  as_of: '2026-06-03', window_used: 8, history_len: 8,
  lanes: {},
  counts: { recurring: 0, intermittent: 0, resolved: 0, one_off: 0, corrected_mornings: 0, advisory_mornings: 1, quiet_mornings: 7 },
  audit_reason: 'no_corrections',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: '',
}
// abstained: too little governed history to judge the governor's own track record yet.
const AUDIT_ABSTAINED = {
  status: 'abstained',
  recommendation: { action: 'none', lanes: [] },
  as_of: '2026-06-03', window_used: 8, history_len: 1,
  lanes: {},
  counts: { recurring: 0, intermittent: 0, resolved: 0, one_off: 0, corrected_mornings: 0, advisory_mornings: 0, quiet_mornings: 1 },
  audit_reason: 'insufficient_history',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: '',
}
function LeadPolicyGovernanceAuditPanelPreview({ data }) {
  const st = data?.status || 'abstained'
  const tone = LEAD_AUDIT_TONE[st] || LEAD_AUDIT_TONE.abstained
  const HeadIcon = tone.Icon
  const rec = data?.recommendation || { action: 'none', lanes: [] }
  const escalate = rec.action === 'escalate'
  const escalateLanes = Array.isArray(rec.lanes) ? rec.lanes : []
  const escalateLaneText = escalateLanes.map(laneLabel).join(', ')
  const narrative = (data?.narrative || '').trim()
  const windowUsed = data?.requested?.days || data?.window_used || 8
  const counts = data?.counts || {}
  const recurringCount = Number.isFinite(counts.recurring) ? counts.recurring : escalateLanes.length
  const correctedMornings = Number.isFinite(counts.corrected_mornings) ? counts.corrected_mornings : 0
  const headline = leadAuditHeadline(st, recurringCount || 1)
  const lanes = data?.lanes && typeof data.lanes === 'object' ? data.lanes : {}
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
            Is the governor&rsquo;s fix sticking? · last {windowUsed} mornings
          </p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
      </div>

      <div className="px-4 py-4">
        <div className="flex items-start gap-2">
          <HeadIcon className={`w-4 h-4 shrink-0 mt-0.5 ${tone.text}`} />
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
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">The governor&rsquo;s track record, by lane</p>
              <span className="inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-wide text-slate-300">
                <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />recurring</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />resolved</span>
              </span>
            </div>
            <div className="space-y-2.5">
              {ordered.map(([lane, info], i) => (
                <LeadAuditLaneRowPreview key={`${lane}-${i}`} lane={lane} info={info} />
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
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The auditor.</span> The governor acts every morning; this checks whether its fix <span className="font-semibold text-emerald-600">stuck</span>. When the same lane keeps needing the same reset morning after morning, the safe corrective is not reaching the root cause — so it <span className="font-semibold text-rose-600">escalates that lane to a human</span> rather than letting the loop churn forever. The governor keeps holding the line meanwhile. Recommends, never acts. Agency-only.
        </p>
      </div>
    </section>
  )
}

/* ── 17c LEAD-POLICY GOVERNANCE REMEDIATION — "the remediator". The auditor above only RECOMMENDS:
    when its safe reset keeps not sticking it escalates a lane to a human and stops there. THIS rung
    turns that escalation into a concrete, bounded, reversible STRUCTURAL fix — staged for one agency
    click. Three remedies, escalating: widen the dead-band (gentlest — stop noise from moving the lane),
    tighten the weight bounds (deeper — the swing can't carry as far), pin to neutral (last resort —
    stop tuning the lane at all). It never tunes a lane down past safety: the emergency lane (act_now)
    is abstained by design, and a lane that has spent every safe structural move is handed to a person
    rather than forced further. An EIGHTH disjoint vocabulary — remediation_proposed / steady /
    abstained at the roll-up, widen / tighten / pin per proposal — so it never blurs with the seven it
    sits beneath. Closes SENSE→ACT→AUDIT→REMEDIATE: the auditor says "this reset isn't curing", the
    remediator answers "here is the structural change that will — one click, fully reversible". Preview
    twin of <LeadPolicyGovernanceRemediationPanel/>: reads a `data` prop, never fetches. Three
    instances: proposed (mixed-rung fixes + lanes set aside by safety / at-ceiling), steady (auditor
    settling on its own, nothing to restructure), abstained (no audited escalation to act on yet). ── */
const LEAD_REMEDY_TONE = {
  remediation_proposed: { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   text: 'text-amber-500',   label: 'Fix staged', Icon: Wrench },
  steady:               { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Holding',    Icon: ShieldCheck },
  abstained:            { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   text: 'text-slate-400',   label: 'Waiting',    Icon: Clock },
}
// per-proposal REMEDY → its badge + the escalating rung. widen is the gentlest first move, pin the last
// resort. The colour gradient (sky → amber → rose) reads as "how hard a structural change this is".
const LEAD_REMEDY_KIND = {
  widen_neutral_band: { badge: 'border-sky-200 bg-sky-50 text-sky-700',      text: 'text-sky-600',   Icon: SlidersHorizontal, label: 'Widen dead-band', rung: 1 },
  tighten_bounds:     { badge: 'border-amber-200 bg-amber-50 text-amber-700', text: 'text-amber-600', Icon: Scissors,          label: 'Tighten bounds',  rung: 2 },
  pin_neutral:        { badge: 'border-rose-200 bg-rose-50 text-rose-700',    text: 'text-rose-600',  Icon: Crosshair,         label: 'Pin to neutral',  rung: 3 },
}
// the two principled refusals — a lane the remediator will NOT restructure. safety_floored is good
// (the emergency lane, protected by design); at_ceiling is the genuine human hand-off (moves spent).
const LEAD_REMEDY_ABSTAIN = {
  safety_floored: { badge: 'border-emerald-200 bg-emerald-50 text-emerald-600', text: 'text-emerald-600', Icon: ShieldCheck,  label: 'Safety floor', reason: 'the emergency lane — never tuned down, by design' },
  at_ceiling:     { badge: 'border-rose-200 bg-rose-50 text-rose-600',          text: 'text-rose-600',    Icon: AlertOctagon, label: 'At ceiling',   reason: 'every safe structural move is spent — a person decides the next step' },
}
const remedyN2 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—')
function remedyDelta(p) {
  if (!p || typeof p !== 'object') return ''
  switch (p.remedy) {
    case 'widen_neutral_band': return `dead-band ${remedyN2(p.from?.neutral_band)} → ${remedyN2(p.to?.neutral_band)}`
    case 'tighten_bounds':     return `bounds ${remedyN2(p.from?.bounds?.min)}–${remedyN2(p.from?.bounds?.max)} → ${remedyN2(p.to?.bounds?.min)}–${remedyN2(p.to?.bounds?.max)}`
    case 'pin_neutral':        return 'adaptive → pinned at 1.0'
    default:                   return ''
  }
}
function leadRemedyHeadline(status, count) {
  switch (status) {
    case 'remediation_proposed':
      return count === 1
        ? 'A structural fix is staged — one click, fully reversible'
        : `${count} structural fixes are staged — one click each, fully reversible`
    case 'steady': return "Nothing to remediate — the governor's resets are holding on their own"
    default:       return 'Not enough audited history yet to stage a structural fix'
  }
}
function RemediationProposalCardPreview({ proposal }) {
  const meta = LEAD_REMEDY_KIND[proposal?.remedy] || LEAD_REMEDY_KIND.widen_neutral_band
  const Icon = meta.Icon
  const severity = Number.isFinite(proposal?.severity) ? proposal.severity : 1
  const delta = remedyDelta(proposal)
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${meta.badge}`}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
        <span className="text-[11px] font-bold text-slate-700 truncate" title={laneLabel(proposal?.lane)}>{laneLabel(proposal?.lane)}</span>
        <span className={`ml-auto text-[11px] font-black tabular-nums ${meta.text}`}>{severity}× running</span>
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
function RemediationAbstainRowPreview({ lane, reason }) {
  const meta = LEAD_REMEDY_ABSTAIN[reason] || LEAD_REMEDY_ABSTAIN.at_ceiling
  const Icon = meta.Icon
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-24 shrink-0 min-w-0">
        <div className="text-[11px] font-semibold text-slate-600 leading-tight truncate" title={laneLabel(lane)}>{laneLabel(lane)}</div>
        <span className={`mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold uppercase tracking-wide leading-relaxed ${meta.badge}`}>
          <Icon className="w-2.5 h-2.5" /> {meta.label}
        </span>
      </div>
      <div className="flex-1 min-w-0 text-[10px] font-medium text-slate-400 leading-tight">{meta.reason}</div>
    </div>
  )
}

// proposed: the headline case. The auditor escalated worth_a_look (churning); the remediator answers
// with three escalating, reversible structural fixes (widen → tighten → pin), and sets two lanes
// aside untouched — act_now by safety (the emergency lane) and monitor at its structural ceiling.
const REMEDY_PROPOSED = {
  status: 'remediation_proposed',
  proposals: [
    { lane: 'worth_a_look', remedy: 'widen_neutral_band', severity: 3, from: { neutral_band: 0 }, to: { neutral_band: 0.1 }, reversible: true, rationale: 're-reset for 3 mornings running — widen its dead-band so day-to-day noise stops moving it' },
    { lane: 'verify',       remedy: 'tighten_bounds',     severity: 2, from: { bounds: { min: 0.8, max: 1.2 } }, to: { bounds: { min: 0.9, max: 1.1 } }, reversible: true, rationale: 'dead-band not enough after 2 mornings — tighten its weight bounds toward neutral' },
    { lane: 'tailwind',     remedy: 'pin_neutral',        severity: 1, from: { pinned: false }, to: { pinned: true }, reversible: true, rationale: 'tightened bounds still churning after 1 morning — pin the lane to neutral and stop tuning it' },
  ],
  abstained_lanes: [
    { lane: 'act_now', reason: 'safety_floored' },
    { lane: 'monitor', reason: 'at_ceiling' },
  ],
  lanes_considered: ['worth_a_look', 'verify', 'tailwind', 'act_now', 'monitor'],
  as_of: '2026-06-03',
  remediation_reason: 'audit_escalation',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: 'Our lead-selection auto-tuner keeps fighting worth a look (plus 2 other lanes flagged) — recommend we widen its dead-band so day-to-day noise stops moving it; staged for one click and fully reversible.',
}
// steady: the auditor is not escalating anything — its safe resets are sticking on their own — so
// there is no structural change to stage. The remediator stays out of the way.
const REMEDY_STEADY = {
  status: 'steady',
  proposals: [],
  abstained_lanes: [],
  lanes_considered: [],
  as_of: '2026-06-03',
  remediation_reason: 'audit_not_escalating',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: '',
}
// abstained: the auditor itself has too little governed history to judge, so it hands nothing down —
// and the remediator refuses to invent a structural change without an audited escalation behind it.
const REMEDY_ABSTAINED = {
  status: 'abstained',
  proposals: [],
  abstained_lanes: [],
  lanes_considered: [],
  as_of: '2026-06-03',
  remediation_reason: 'audit_unusable',
  requested: { as_of: '2026-06-03', days: 8 },
  narrative: '',
}
function LeadPolicyGovernanceRemediationPanelPreview({ data }) {
  const st = data?.status || 'abstained'
  const tone = LEAD_REMEDY_TONE[st] || LEAD_REMEDY_TONE.abstained
  const HeadIcon = tone.Icon
  const proposals = Array.isArray(data?.proposals) ? data.proposals : []
  const abstained = Array.isArray(data?.abstained_lanes) ? data.abstained_lanes : []
  const narrative = (data?.narrative || '').trim()
  const windowUsed = data?.requested?.days || 8
  const headline = leadRemedyHeadline(st, proposals.length || 1)
  const kinds = {
    widen: proposals.filter((p) => p?.remedy === 'widen_neutral_band').length,
    tighten: proposals.filter((p) => p?.remedy === 'tighten_bounds').length,
    pin: proposals.filter((p) => p?.remedy === 'pin_neutral').length,
  }
  const tally = [
    kinds.widen > 0 ? `${kinds.widen} widen` : null,
    kinds.tighten > 0 ? `${kinds.tighten} tighten` : null,
    kinds.pin > 0 ? `${kinds.pin} pin` : null,
  ].filter(Boolean)
  const ordered = [...proposals]
    .sort((a, b) => (Number(b?.severity) || 0) - (Number(a?.severity) || 0))
    .slice(0, 6)
  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Wrench className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Governance remediation</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">
            The structural fix behind the auditor&rsquo;s escalation · last {windowUsed} mornings
          </p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
      </div>

      <div className="px-4 py-4">
        <div className="flex items-start gap-2">
          <HeadIcon className={`w-4 h-4 shrink-0 mt-0.5 ${tone.text}`} />
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

        {ordered.length > 0 ? (
          <div className="mt-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Staged structural fixes, most-pressing first</p>
            <div className="space-y-2">
              {ordered.map((p, i) => (
                <RemediationProposalCardPreview key={`${p?.lane}-${i}`} proposal={p} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2 mt-1">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            {st === 'abstained'
              ? 'No audited escalation to act on yet — the remediator waits until the auditor hands it a recurring lane.'
              : 'Nothing to restructure — the auditor is settling its lanes without a structural change.'}
          </div>
        )}

        {abstained.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Set aside, not remediated</p>
            <div className="space-y-2.5">
              {abstained.slice(0, 6).map((a, i) => (
                <RemediationAbstainRowPreview key={`${a?.lane}-${i}`} lane={a?.lane} reason={a?.reason} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 bg-brand-50/30 border-t border-slate-50">
        <p className="text-[11px] font-medium text-slate-400 leading-relaxed">
          <span className="font-semibold text-slate-500">The remediator.</span> The auditor escalates a lane it cannot cure with a safe reset; this turns that escalation into a concrete <span className="font-semibold text-slate-600">structural change</span> — widen the dead-band, tighten the bounds, or pin the lane to neutral — <span className="font-semibold text-emerald-600">staged for one click and fully reversible</span>. It never tunes the emergency lane down, and a lane that has spent every safe move is <span className="font-semibold text-rose-600">handed to a person</span> rather than forced further. Proposes, never auto-applies. Agency-only.
        </p>
      </div>
    </section>
  )
}

// ── CONSUMER ENGAGEMENT (intel-v8 18c) — preview twin of BriefEngagementPanel on Intelligence.jsx.
// The one OUTWARD loop. Every panel above is the system grading itself — reliability, editorial
// precision, the self-tuning policy and its governance/remediation. This is the only rung where the
// HUMAN READER grades the system: a 👍/👎 on the morning brief, aggregated agency-side into a reception
// score. Static graded render (cn → template strings, no fetch/loading/error/not-graded) so the preview
// matches this file. PRIVACY: the aggregate, the per-client board and the watch list are AGENCY-ONLY —
// a client only ever sees their own vote reflected back, never this surface.
const BRIEF_ENGAGEMENT_TONE = {
  well_received:   { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500', label: 'Well received' },
  fair:            { pill: 'border-amber-200 bg-amber-50 text-amber-700',       dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'A fair reception' },
  poorly_received: { pill: 'border-rose-200 bg-rose-50 text-rose-700',          dot: 'bg-rose-500',    bar: 'bg-rose-400',    label: 'Landing flat' },
  'no-data':       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       dot: 'bg-slate-300',   bar: 'bg-slate-200',   label: 'Listening' },
}
// One client bucket → a three-state view: 'none' (no votes, —), 'pending' (votes logged but under the
// min-votes bar — still abstaining, not a 0%), 'graded' (carries its helpful-rate %). Mirrors the live
// engagementClientView so the row reads identically across panel and preview.
function engagementClientView(c) {
  if (!c || !c.n)            return { state: 'none',    pct: null, helpful: 0, n: 0 }
  if (c.status !== 'graded') return { state: 'pending', pct: null, helpful: c.helpful || 0, n: c.n }
  return { state: 'graded', pct: c.helpful_rate != null ? Math.round(c.helpful_rate * 100) : 0, helpful: c.helpful || 0, n: c.n }
}
// One client row: a watched dot · name · mini helpful-rate bar · pct · helpful/n. A client still under
// the vote bar shows an empty track and a calm '·', never a misleading 0%.
function BriefEngagementClientRowPreview({ client, watched }) {
  const view = engagementClientView(client)
  const tone = BRIEF_ENGAGEMENT_TONE[client?.label] || BRIEF_ENGAGEMENT_TONE['no-data']
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${watched ? 'bg-rose-500' : 'bg-slate-200'}`} />
      <span className="w-24 shrink-0 text-[11px] font-semibold text-slate-500 truncate" title={client?.name || 'Unnamed client'}>{client?.name || 'Unnamed client'}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        {view.state === 'graded' && <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${view.pct}%` }} />}
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-700">
        {view.state === 'graded' ? `${view.pct}%` : view.state === 'pending' ? '·' : '—'}
      </span>
      <span className="w-9 shrink-0 text-right text-[10px] font-semibold text-slate-400 tabular-nums">
        {view.helpful}/{view.n}
      </span>
    </div>
  )
}

// intel-v9 layer 19c — the engagement loop's RESPONSE, by direction. Everything above is the GRADE
// (did the reader find the brief useful); this dresses what the grade EARNED for tomorrow's brief —
// the supporting-cast breadth carried beneath the one headline. widen = the brief earned room to say
// a little more (emerald, Sparkles); tighten = landing flat, lead with the essentials (amber, Scissors
// — the safe direction); neutral = graded but held at the usual depth (slate, Minus).
const BRIEF_EMPHASIS_TONE = {
  widen:   { wrap: 'border-emerald-100 bg-emerald-50/50', chip: 'bg-emerald-100 text-emerald-700', accent: 'text-emerald-700', icon: Sparkles, verb: 'Carrying a little more' },
  tighten: { wrap: 'border-amber-100 bg-amber-50/50',     chip: 'bg-amber-100 text-amber-700',     accent: 'text-amber-700',   icon: Scissors, verb: 'Leading tighter' },
  neutral: { wrap: 'border-slate-100 bg-slate-50/60',     chip: 'bg-slate-100 text-slate-600',     accent: 'text-slate-600',   icon: Minus,    verb: 'Holding steady' },
}
// Mirrors the live BriefEmphasisStrip: reads the emphasis object the engine folds into the
// /brief-engagement payload (deriveBriefEmphasis: { status, direction, also_cap, base_cap, ... }) plus
// the agency narrator sentence — no second fetch. 'tuned' = the cap moved (widen/tighten); 'idle' =
// graded but held at the neutral base. The headline NEVER flexes — only the supporting tail — so
// reception can make the brief richer or leaner but can never bury what matters most. The narrator is
// '' for the client audience AND for idle, so the strip synthesizes a calm steady-state line when held.
function BriefEmphasisStripPreview({ emphasis, narrative }) {
  if (!emphasis || emphasis.status === 'abstained') return null
  const dir  = emphasis.direction === 'widen' || emphasis.direction === 'tighten' ? emphasis.direction : 'neutral'
  const tone = BRIEF_EMPHASIS_TONE[dir]
  const Icon = tone.icon
  const cap  = emphasis.also_cap
  const base = emphasis.base_cap
  const item = (n) => (n === 1 ? 'item' : 'items')
  const line = (narrative || '').trim() ||
    `Reception is steady, so tomorrow's brief keeps its usual depth — ${cap} supporting ${item(cap)} beneath the headline.`
  return (
    <div className={`mt-3 rounded-xl border px-3 py-2.5 ${tone.wrap}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5 flex items-center gap-1">
        <SlidersHorizontal className="w-3 h-3" /> What reception earns tomorrow's brief
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${tone.chip}`}>
          <Icon className="w-3 h-3" /> {tone.verb}
        </span>
        {dir === 'neutral' ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
            <span className={`tabular-nums font-black ${tone.accent}`}>{cap}</span>
            <span className="text-slate-400">supporting {item(cap)} · unchanged</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
            <span className="tabular-nums text-slate-400">{base}</span>
            <span className={`font-black ${tone.accent}`}>→</span>
            <span className={`tabular-nums font-black ${tone.accent}`}>{cap}</span>
            <span className="text-slate-400">supporting {item(cap)}</span>
          </span>
        )}
        <span className="ml-auto text-[10px] font-medium text-slate-400">headline never moves</span>
      </div>
      <p className="mt-2 text-[12px] text-slate-500 leading-relaxed">{line}</p>
    </div>
  )
}

// Shaped EXACTLY like GET /api/ai/brief-engagement over a 30-day window graded at 3+ votes/client:
// 72 ratings across 6 clients, 52 were 👍 (~72% → 'fair'), and reception is improving (recent 80% vs
// older 64%). The board sums back to the portfolio (52/72) and arrives worst-reception-first: Pioneer
// is landing flat (4/10, 40%), Lakeside is fair but slipping (7/12, 58%), up to Harbor at 19/20 (95%);
// Summit has only 2 votes so it abstains (pending '·', never a rate off noise). watch carries the two
// the agency should look at — Pioneer (poorly received) and Lakeside (slipping). narrative is verbatim
// narrateBriefEngagement(engagement, { audience: 'agency' }).
const BRIEF_ENGAGEMENT = {
  status: 'graded', reason: 'graded', min_votes: 3, requested_min_votes: 3,
  window: { from: '2026-05-04', to: '2026-06-02', days: 30 },
  total: 72, helpful: 52, not_helpful: 20, ignored: 0, n: 72,
  helpful_rate: 52 / 72, label: 'fair',
  trend: 'improving', recent_rate: 0.80, older_rate: 0.64,
  clients_graded: 5, clients_total: 6,
  by_client: [
    { client_id: 'c-pioneer',  name: 'Pioneer Roofing', status: 'graded',       helpful_rate: 4 / 10,  label: 'poorly_received', trend: 'steady',    helpful: 4,  not_helpful: 6, n: 10 },
    { client_id: 'c-lakeside', name: 'Lakeside Law',    status: 'graded',       helpful_rate: 7 / 12,  label: 'fair',            trend: 'declining', helpful: 7,  not_helpful: 5, n: 12 },
    { client_id: 'c-cedar',    name: 'Cedar HVAC',      status: 'graded',       helpful_rate: 8 / 12,  label: 'fair',            trend: 'steady',    helpful: 8,  not_helpful: 4, n: 12 },
    { client_id: 'c-vista',    name: 'Vista Medispa',   status: 'graded',       helpful_rate: 13 / 16, label: 'well_received',   trend: 'steady',    helpful: 13, not_helpful: 3, n: 16 },
    { client_id: 'c-harbor',   name: 'Harbor Dental',   status: 'graded',       helpful_rate: 19 / 20, label: 'well_received',   trend: 'improving', helpful: 19, not_helpful: 1, n: 20 },
    { client_id: 'c-summit',   name: 'Summit Solar',    status: 'insufficient', helpful_rate: null,    label: null,              trend: null,        helpful: 1,  not_helpful: 1, n: 2 },
  ],
  watch: [
    { client_id: 'c-pioneer',  name: 'Pioneer Roofing', label: 'poorly_received', helpful_rate: 4 / 10 },
    { client_id: 'c-lakeside', name: 'Lakeside Law',    label: 'fair',            helpful_rate: 7 / 12 },
  ],
  requested: { as_of: null, days: 30 },
  narrative: 'Clients found the morning brief useful 52 of 72 times recently (~72%) — a fair reception. Reception has been improving lately.',
  // emphasis is deriveBriefEmphasis(this grade) verbatim: a 'fair' portfolio (neither well- nor
  // poorly-received) sits in the neutral dead-band, and an 'improving' trend never widens (only a
  // proven LEVEL earns more attention) — so the cap holds at the base 3 and the loop stays idle.
  // emphasis_narrative is narrateBriefEmphasis(emphasis, { audience: 'agency' }) — '' when held.
  emphasis: {
    status: 'idle', also_cap: 3, base_cap: 3, min_cap: 1, max_cap: 5,
    delta: 0, direction: 'neutral', helpful_rate: 52 / 72, label: 'fair', trend: 'improving', n: 72,
    reason: 'steady_reception',
  },
  emphasis_narrative: '',
}

function BriefEngagementPanelPreview({ data }) {
  const tone      = BRIEF_ENGAGEMENT_TONE[data.label] || BRIEF_ENGAGEMENT_TONE['no-data']
  const pct       = data.helpful_rate != null ? Math.round(data.helpful_rate * 100) : 0
  const narrative = (data.narrative || '').trim()
  const days      = data.requested.days
  const minVotes  = data.requested_min_votes || 3
  const watch     = Array.isArray(data.watch) ? data.watch : []
  const watchIds  = new Set(watch.map((c) => c.client_id))
  // by_client arrives worst-reception-first (ungraded last); cap the board so it stays scannable.
  const board     = (Array.isArray(data.by_client) ? data.by_client : []).slice(0, 6)
  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <ThumbsUp className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Consumer engagement</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Did the reader find the brief useful · last {days} days</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} /> {tone.label}
        </span>
        {data.trend === 'improving' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
            <ArrowUpCircle className="w-3 h-3" /> Improving
          </span>
        )}
        {data.trend === 'declining' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700">
            <TrendingDown className="w-3 h-3" /> Slipping
          </span>
        )}
      </div>

      <div className="px-4 py-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-black text-slate-900 leading-none tabular-nums">{pct}%</span>
            <span className="text-[11px] font-bold text-slate-400">found it useful</span>
          </div>
          <p className="text-[11px] font-semibold text-slate-400 pb-0.5">
            {data.helpful} of {data.n} {data.n === 1 ? 'rating' : 'ratings'} were 👍
            {data.clients_graded > 0 ? ` · ${data.clients_graded} of ${data.clients_total} ${data.clients_total === 1 ? 'client' : 'clients'} rated` : ''}
          </p>
        </div>

        <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${pct}%` }} />
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
                <BriefEngagementClientRowPreview key={c.client_id} client={c} watched={watchIds.has(c.client_id)} />
              ))}
            </div>
          </div>
        )}

        <BriefEmphasisStripPreview emphasis={data.emphasis} narrative={data.emphasis_narrative} />
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

// ── emphasis efficacy — intel-v9 (20c) preview twin ────────────────────────────────────────────
// Mirrors the live BriefEmphasisEfficacyPanel: reads GET /api/ai/brief-emphasis-efficacy (agency-
// only). The engagement panel above is the ACT half of the loop — layer 19 flexes tomorrow's
// supporting-cast cap on every reception grade — but it flexes with FIXED steps and never checks
// whether the flex worked. This is the rung that grades the loop's OWN moves: it pairs each
// persisted morning's emphasis decision with the reception that FOLLOWED, scores each direction
// against the control of mornings the brief held steady (widening should SUSTAIN reception,
// tightening should RECOVER it), and emits a bounded learned step-scale (0.5×–1.25×) a future
// controller feeds back to make layer 19 self-improving. Static graded render off a fixture.
const EMPHASIS_EFFICACY_TONE = {
  endorsed:     { pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: ArrowUpCircle, label: 'Leaning in' },
  tempered:     { pill: 'border-amber-200 bg-amber-50 text-amber-700',       icon: RotateCcw,     label: 'Easing off' },
  steady:       { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Minus,         label: 'Holding calibration' },
  insufficient: { pill: 'border-slate-200 bg-slate-50 text-slate-500',       icon: Inbox,         label: 'Listening' },
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
const EFFICACY_MIN_N = 4 // mirrors NOTE_MIN_N — a direction is graded only past this many decided outcomes
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
function EmphasisDirectionCardPreview({ dir, score, stepScale, hasControl }) {
  const meta = EMPHASIS_DIRECTION_META[dir]
  const Icon = meta.icon
  const view = efficacyDirectionView(score)
  const st   = stepScaleTone(stepScale)
  const StepIcon = st.Icon
  const scaleLabel = Number.isFinite(Number(stepScale)) ? `×${Number(stepScale).toFixed(2)}` : '×1.00'
  const liftClass = view.liftPp > 0 ? 'text-emerald-600' : view.liftPp < 0 ? 'text-amber-600' : 'text-slate-400'
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${view.state === 'graded' ? 'border-slate-100 bg-slate-50/40' : 'border-slate-100 bg-white'}`}>
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-[11px] font-black text-slate-700">{meta.label}</span>
        <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${st.chip}`} title={`Learned step-scale — the loop is ${st.verb}`}>
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
              <span className={`font-black tabular-nums ${liftClass}`}>{view.liftPp > 0 ? '+' : ''}{view.liftPp} pp</span>
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

// Shaped EXACTLY like GET /api/ai/brief-emphasis-efficacy over a 90-day window. The loop has flexed
// 12 decided mornings: WIDENING is paying off — when the brief carried more, reception held up 65%
// of the time (6 of 7), +25pp over the 40% the brief earned on the 6 mornings it held steady — so
// the learned widen step-scale leans in to ×1.12. TIGHTENING is graded but in line with the control
// (45% over 5, +5pp), so its step stays at the neutral ×1.00. Verdict 'endorsed', reason
// 'widen_sustaining'. narrative is verbatim narrateEmphasisEfficacy(summary, { audience: 'agency' }).
const BRIEF_EMPHASIS_EFFICACY = {
  status: 'graded', n: 12,
  control_rate: 0.40, control_n: 6, prior: 0.40,
  directions: {
    widen:   { n: 7, successes: 6, failures: 1, rate: 6 / 7, efficacy: 0.646, lower: 0.52, lift: 0.246, lower_lift: 0.12, band: 'moderate', credibility: 0.538, median_delta: 0.028 },
    tighten: { n: 5, successes: 3, failures: 2, rate: 0.6,   efficacy: 0.45,  lower: 0.30, lift: 0.05,  lower_lift: -0.1, band: 'moderate', credibility: 0.455, median_delta: 0.01 },
  },
  recommendation: { widen_step_scale: 1.12, tighten_step_scale: 1.0, verdict: 'endorsed', reason: 'widen_sustaining' },
  requested: { as_of: null, days: 90 },
  narrative: 'Widening is holding up — reception sustained 65% of the time when the brief carried more (6 of 7), vs 40% when the brief held steady, so the loop is leaning in (step ×1.12).',
}

function BriefEmphasisEfficacyPanelPreview({ data }) {
  const graded      = data.status === 'graded'
  const verdict     = data.recommendation?.verdict || 'insufficient'
  const tone        = EMPHASIS_EFFICACY_TONE[verdict] || EMPHASIS_EFFICACY_TONE.insufficient
  const VerdictIcon = tone.icon
  const narrative   = (data.narrative || '').trim()
  const days        = data.requested?.days || 90
  const dirs        = data.directions || {}
  const rec         = data.recommendation || {}
  const controlRate = data.control_rate
  const controlN    = data.control_n || 0
  const ctrlPct     = controlRate != null ? Math.round(controlRate * 100) : null
  return (
    <section className="bg-white rounded-2xl border border-brand-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <span className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
          <Gauge className="w-4 h-4 text-brand-600" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900 leading-tight">Emphasis efficacy</h2>
          <p className="text-[11px] font-medium text-slate-400 leading-tight truncate">Is the brief's self-tuning paying off · last {days} days</p>
        </div>
        {graded && (
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone.pill}`} title={`Loop verdict: ${verdict}`}>
            <VerdictIcon className="w-3 h-3" /> {tone.label}
          </span>
        )}
      </div>

      <div className="px-4 py-4">
        {graded ? (
          <>
            {narrative && <p className="text-sm text-slate-600 leading-relaxed">{narrative}</p>}
            <div className={`grid grid-cols-2 gap-2 ${narrative ? 'mt-3' : ''}`}>
              <EmphasisDirectionCardPreview dir="widen"   score={dirs.widen}   stepScale={rec.widen_step_scale}   hasControl={controlRate != null} />
              <EmphasisDirectionCardPreview dir="tighten" score={dirs.tighten} stepScale={rec.tighten_step_scale} hasControl={controlRate != null} />
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
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Inbox className="w-4 h-4 shrink-0" />
            The reception loop hasn't flexed enough to grade yet — this fills in as widen / tighten mornings accrue the reception that follows.
          </div>
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

export default function PulseDiagnosisPreview() {
  return (
    <div className="min-h-screen bg-slate-100/70 p-6 sm:p-10">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-600">Design preview · intel-v7 (2) → (11)</p>
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
            no confidence, no badge, and no regenerate</span>. Posture speaks only as &ldquo;Worth a look.&rdquo; The one editorial-precision
            artifact that ever crosses to the client is the <span className="font-bold text-emerald-600">earned</span> trust line beneath the
            brief — shown <span className="font-bold text-slate-600">only when our recent morning leads actually held up</span> (the agency&rsquo;s{' '}
            <span className="font-bold text-emerald-600">earned / fair / overcalled</span> grade stays server-side; a &lsquo;fair&rsquo; or
            &lsquo;overcalled&rsquo; month simply shows nothing). Never the percentage, the sample, or the lane split — just the one sentence, honestly earned.
          </p>
        </div>

        {/* ── NARRATION RELIABILITY — the agency self-audit of the morning brief (layer 10c),
            full width. The brief grading its OWN history: how often the analyst actually wrote in
            its own words vs fell back to the safe template — kept rigidly orthogonal to the
            grounded-trust chip. Pure read (listRecentBriefs never regenerates), agency-only: model
            ids and the fallback streak are internal calibration the client never sees. ─────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Narration reliability</p>
          <BriefHealthPanelPreview data={BRIEF_HEALTH} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The capstone&rsquo;s self-grade: every other layer in this chain grades itself, so the most visible one does too. It reads the stored
            brief HISTORY and reports the one honest narration signal — <span className="font-bold text-sky-600">coverage</span>, how often the model
            wrote the brief in its own words (here <span className="font-bold text-sky-600">78%</span>, just under the &ldquo;writing freely&rdquo; bar) vs
            degraded to the deterministic template — while keeping it rigidly separate from{' '}
            <span className="font-bold text-emerald-600">grounded</span>: the template fallback is grounded-by-construction, so &ldquo;is the AI still
            writing?&rdquo; can never be confused with &ldquo;are the numbers still verified?&rdquo; A two-in-a-row fallback trips an early-warning, and quiet
            mornings (nothing worth narrating) never count as misses. <span className="font-bold text-slate-600">Agency-only</span> — model names and
            fallback streaks stay out of the client&rsquo;s morning brief entirely.
          </p>
        </div>

        {/* ── NARRATOR SELF-CHECK — the delivery alarm the reliability panel raises when its OWN
            writer stalls (layer 11c), full width. Same panel as above, fed the failure fixture: the
            agency brief's last three portfolio mornings all fell back, so a rose banner leads with the
            graded verdict + one self-heal step, and the legacy streak line steps aside. The twin's
            point: prove the alarm is silent on the healthy panel above and loud only here, and that it
            reassures clients were never touched. Rides a separate agency-only channel (BRIEF_ALERT_TO),
            never a client digest. ─────────────────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Narration reliability <span className="text-rose-400">· self-check firing</span></p>
          <BriefHealthPanelPreview data={BRIEF_HEALTH_STALLED} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The same panel, the morning its own writer stalls. When a single audience&rsquo;s brief falls back{' '}
            <span className="font-bold text-rose-600">three mornings running</span>, the self-check stops being a footnote and becomes the
            lead: a <span className="font-bold text-rose-600">rose banner</span> states the graded verdict, attaches the one{' '}
            <span className="font-bold text-slate-600">self-heal step</span> (check the model — expired key, rate limit, or outage — then
            regenerate), and the old streak line steps aside so the alarm never doubles up. Graded{' '}
            <span className="font-bold text-slate-600">per audience</span>, so the portfolio brief can raise the alarm while the client stream
            keeps <span className="font-bold text-emerald-600">writing freely</span> — and because every fallback is grounded-by-construction,
            the banner says it plainly: <span className="font-bold text-slate-600">clients were never affected</span>. It rides a separate
            agency-only alert channel, never a client&rsquo;s digest.
          </p>
        </div>

        {/* ── EDITORIAL PRECISION — the agency's THIRD self-audit of the morning brief (layer 12c),
            full width. Reliability asks "did we write it"; the self-check asks "did we deliver it";
            this asks the sharpest question of all — "did the call we LED with hold up?" Each shipped
            lead is replayed over the WINDOW mornings that followed and graded earned/fair/overcalled
            on a disjoint third vocabulary, so editorial precision can never be confused with narration
            coverage or grounded-trust. Pure read (it replays the same verified day-pulse, never
            regenerates), agency-only: the hit-rate and lane grades are internal calibration. ───────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Editorial precision</p>
          <BriefImpactPanelPreview data={BRIEF_IMPACT} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The chain&rsquo;s final, hardest self-grade: not whether the brief was <span className="font-bold text-sky-600">written</span> or{' '}
            <span className="font-bold text-emerald-600">delivered</span>, but whether the call it <span className="font-bold text-slate-600">led with held up</span>.
            Every shipped lead is replayed over the <span className="font-bold text-slate-600">7 mornings that followed</span> — a call still firing the
            same way <span className="font-bold text-emerald-600">confirms</span>, a reverted one <span className="font-bold text-rose-600">refutes</span> — and
            young leads <span className="font-bold text-slate-600">abstain</span> rather than count against us. Here 6 of 11 resolved leads held up
            (<span className="font-bold text-amber-600">~55% → fair</span>), and the split does the real teaching: the{' '}
            <span className="font-bold text-emerald-600">client</span> leads earned their place (5/6) while the <span className="font-bold text-rose-600">portfolio</span> leads
            overcalled (1/5), so we know exactly where to tighten selection. The lane breakdown ranks which calls deserve the front page —{' '}
            <span className="font-bold text-emerald-600">Act now</span> confirms best, <span className="font-bold text-rose-600">Worth a look</span> overcalls, and a still-abstaining{' '}
            <span className="font-bold text-slate-600">Verify</span> shows a calm &ldquo;—&rdquo; instead of a misleading 0%. A <span className="font-bold text-slate-600">third, disjoint
            vocabulary</span> — earned / fair / overcalled — so it can never blur with narration coverage or grounded trust. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* ── 13c LEAD-SELECTION POLICY — the closing of the loop. Editorial precision (12c) just
            MEASURED how each lane's front-page calls held up; this is the TUNE half — those hit-rates
            become bounded per-lane weights the morning brief applies when it picks the one lead.
            A FOURTH disjoint vocabulary (promote / demote / neutral) so it never blurs with the grade
            it's built on. Two instances: the common case (the very grade above, tuned) and the rarer
            safety-floor firing. Pure read, agency-only, abstains until graded. ─────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead policy</p>
          <LeadPolicyPanelPreview data={LEAD_POLICY} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The grade above doesn&rsquo;t just sit there — it <span className="font-bold text-slate-600">feeds back into selection</span>. This is the same
            front-page record from <span className="font-bold text-slate-600">editorial precision</span>, turned into the dial that decides what leads tomorrow.
            <span className="font-bold text-emerald-600"> Act now</span> kept earning the front page (3 of 4 held) so the brief is told to{' '}
            <span className="font-bold text-emerald-600">lead with it a little more</span> (<span className="tabular-nums font-bold text-emerald-700">×1.10</span>); {' '}
            <span className="font-bold text-amber-600">Worth a look</span> kept overcalling (1 of 4) so it&rsquo;s <span className="font-bold text-amber-600">eased back</span>{' '}
            (<span className="tabular-nums font-bold text-amber-600">×0.90</span>). Lanes under the <span className="font-bold text-slate-600">{(LEAD_POLICY.min_sample)}-resolved bar hold
            at even</span> rather than guess. The band is hard-capped at <span className="tabular-nums font-bold text-slate-600">±20%</span>, so it{' '}
            <span className="font-bold text-slate-600">reprioritises but never silences</span> a lane — and because it&rsquo;s built straight from measured outcomes,
            it <span className="font-bold text-slate-600">retunes itself every morning with zero operator input</span>.
          </p>
        </div>

        {/* second instance — the safety floor FIRING, the asymmetry that makes this safe to run unattended */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead policy · safety floor firing</p>
          <LeadPolicyPanelPreview data={LEAD_POLICY_FLOORED} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The rarer case that proves the loop is <span className="font-bold text-indigo-600">safe to run unattended</span>. Here{' '}
            <span className="font-bold text-emerald-600">Tailwind</span> went a perfect 4 of 4 and maxed out (<span className="tabular-nums font-bold text-emerald-700">×1.20</span>),{' '}
            <span className="font-bold text-emerald-600">Worth a look</span> earned a lift (<span className="tabular-nums font-bold text-emerald-700">×1.15</span>) — but{' '}
            <span className="font-bold text-slate-600">Act now actually missed</span> (1 of 5). A naïve tuner would <span className="font-bold text-rose-600">demote the urgent lane</span>,
            and a quiet morning would bury a genuine emergency. Because <span className="font-bold text-indigo-600">act_now is safety-floored</span>{' '}
            (<ShieldCheck className="inline w-3 h-3 text-indigo-500 align-text-bottom" />), its earned demotion is{' '}
            <span className="font-bold text-indigo-600">pinned back to ×1.00</span> — promotable when it&rsquo;s right, never eased when it&rsquo;s wrong. The one
            lane where a miss is dangerous is the one the system is forbidden to quiet. <span className="font-bold text-slate-600">A fourth, disjoint vocabulary</span> —
            promote / ease / even — so it never blurs with the grade it&rsquo;s built on. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* ── 14c LEAD-POLICY STABILITY — "watch the watcher". The panel above tunes itself every
            morning; nothing was watching whether that loop is itself trustworthy. This reads its last
            six weights PER LANE and renders the SEQUENCE a single snapshot can't show: a zigzag is a
            lane chasing noise, a flat-topped run is a lane jammed against its band, bars collapsing to
            the line is convergence. A FIFTH disjoint vocabulary (stable / settling / unstable /
            constrained / flagged) so it never blurs with the four below it. Two instances: the loop
            thrashing (auto-reverts itself) and the loop settled (trust it). ────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead-policy stability · thrashing</p>
          <LeadPolicyHealthPanelPreview data={LEAD_HEALTH_UNSTABLE} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The self-tuning loop needs its own supervisor, or a single bad streak quietly poisons what leads tomorrow.
            Here <span className="font-bold text-rose-600">Worth a look</span> has <span className="font-bold text-rose-600">flipped direction four times in six mornings</span> —
            the sparkline zigzags above and below the line. That isn&rsquo;t learning, it&rsquo;s <span className="font-bold text-rose-600">chasing noise</span>, so the loop{' '}
            <span className="font-bold text-rose-600">reverts that lane to neutral on its own</span> (<Wrench className="inline w-3 h-3 text-rose-500 align-text-bottom" /> applied automatically, no human needed).
            Meanwhile <span className="font-bold text-amber-600">Act now</span> has been <span className="font-bold text-amber-600">pinned to the ceiling four mornings running</span> — the flat-topped bars say the{' '}
            nudge has <span className="font-bold text-amber-600">become a wall</span>, surfaced for a human to weigh but never auto-touched. <span className="font-bold text-slate-600">A fifth, disjoint vocabulary</span> —
            stable / settling / unstable / constrained — so it never blurs with the policy it audits. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* second instance — the loop CONVERGED and trustworthy, the calm shape that says "leave it alone" */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead-policy stability · settled</p>
          <LeadPolicyHealthPanelPreview data={LEAD_HEALTH_STABLE} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The same supervisor on a <span className="font-bold text-emerald-600">healthy morning</span>: every lane it has moved is <span className="font-bold text-emerald-600">holding inside its band</span> —
            the sparklines sit nearly flat against the line — with <span className="font-bold text-emerald-600">no oscillation and nothing jammed against a bound</span>.
            The verdict is <span className="font-bold text-emerald-600">stable</span> and the recommendation is simply <span className="font-bold text-emerald-600">trust the loop</span>: no revert, no advisory, no human.
            That asymmetry is the point — <span className="font-bold text-slate-600">the watcher stays silent when the loop is fine and only speaks when it isn&rsquo;t</span>,
            which is exactly what lets the whole self-tuning stack <span className="font-bold text-indigo-600">run unattended</span>. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* ── 15c LEAD-POLICY GOVERNANCE — "the governor". 14c watches the loop and DIAGNOSES it;
            this one CLOSES that loop — it consumes the verdict and autonomously applies the safe
            per-lane corrective with no human in the path. The headline case is the one a blunt
            revert-everything gets wrong: reset ONLY the thrashing lane and keep every EARNED lane
            live. Saturation and floor-masking it logs for a human, never auto-widening the band.
            A SIXTH disjoint vocabulary — corrected / advised / clean / abstained. Four instances:
            corrected-with-survivor (a learned order survives), corrected-sole-lane (rides neutral),
            advised (held + floor-kept, nothing reset), and clean (nothing to touch). ──────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead-policy governance · corrected, learned order survives</p>
          <LeadPolicyGovernancePanelPreview data={GOV_CORRECTED_SURVIVOR} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The verdict said one lane was thrashing, so the governor <span className="font-bold text-violet-600">acted on it</span> — autonomously, no human in the path.{' '}
            <span className="font-bold text-violet-600">Worth a look</span> flipped direction across the week, so it <span className="font-bold text-violet-600">snaps to neutral</span>{' '}
            (<Scissors className="inline w-3 h-3 text-violet-500 align-text-bottom" /> ×1.10 → ×1.00). But <span className="font-bold text-emerald-600">Tailwind kept its earned ×1.15</span> —
            this is the case layer 14&rsquo;s <span className="font-bold text-slate-600">blunt revert-everything would have got wrong</span>, throwing away a genuinely learned lift to quiet one noisy lane.
            The governor is a <span className="font-bold text-violet-600">surgeon, not a sledgehammer</span>: it cuts the one lane and <span className="font-bold text-slate-600">keeps the rest of the order</span>, so governed status stays{' '}
            <span className="font-bold text-emerald-600">tuned</span>. Every reset is <span className="font-bold text-slate-600">snapshot-backed and reversible</span>. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* second instance — the reset lane was the ONLY one carrying weight, so the order rides neutral */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead-policy governance · corrected, order rides neutral</p>
          <LeadPolicyGovernancePanelPreview data={GOV_CORRECTED_SOLE} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The same surgical reset, but here the thrashing <span className="font-bold text-violet-600">Verify</span> lane was the <span className="font-bold text-slate-600">only one carrying weight</span>.
            Neutralising it drops the tuned count to zero, so governed status honestly falls to <span className="font-bold text-slate-500">idle</span> and the brief simply{' '}
            <span className="font-bold text-slate-600">leads in its default order</span> until the loop re-earns a lift — no pretending a learned order still applies when it doesn&rsquo;t.
            The distinction from the case above is the whole point: the governor reports <span className="font-bold text-slate-600">tuned vs. idle truthfully</span>, never inflating its own footprint. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* third instance — nothing reset; a saturated lane HELD and a floor-masked lane RESPECTED, both logged for a human */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead-policy governance · advised, nothing auto-applied</p>
          <LeadPolicyGovernancePanelPreview data={GOV_ADVISED} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The asymmetry that makes this <span className="font-bold text-indigo-600">safe to run unattended</span>: the governor only ever auto-applies <span className="font-bold text-violet-600">one</span> move — resetting a thrashing lane.
            Everything else it <span className="font-bold text-amber-600">logs and leaves</span>. Here <span className="font-bold text-emerald-600">Tailwind</span> is pinned at the ceiling of its band, so it&rsquo;s{' '}
            <span className="font-bold text-amber-600">held</span> (<Gauge className="inline w-3 h-3 text-amber-500 align-text-bottom" />) — surfaced for a human, never auto-widened — and <span className="font-bold text-indigo-600">Act now</span>{' '}
            shows a real overcall the safety floor is masking, so the floor is <span className="font-bold text-indigo-600">kept</span> (<ShieldCheck className="inline w-3 h-3 text-indigo-500 align-text-bottom" />) rather than quietly lifted.
            <span className="font-bold text-slate-600">Nothing was reset</span>; the verdict is an advisory for a human to weigh. A loud system would widen bounds on its own — this one knows the difference between <span className="italic">act</span> and <span className="italic">flag</span>. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* fourth instance — the calm morning: every lane learning cleanly, nothing to touch */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Lead-policy governance · clean</p>
          <LeadPolicyGovernancePanelPreview data={GOV_CLEAN} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The governor on a <span className="font-bold text-emerald-600">healthy morning</span>: the loop is steady, every tuned lane is learning cleanly, and so it{' '}
            <span className="font-bold text-emerald-600">does nothing</span> — five lanes left untouched, no cut, no advisory. Like the monitor above it, the governor{' '}
            <span className="font-bold text-slate-600">stays silent when the loop is fine and only acts when it isn&rsquo;t</span>. That restraint is what earns it the right to run with{' '}
            <span className="font-bold text-violet-600">no human in the path</span>: it touches the policy only on proof, and the proof here says leave it alone. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* ── 16c GOVERNANCE AUDIT — "the auditor" (layer 16), agency-only, sits ABOVE the governor it
            grades. The governor acts every morning; this watches its OWN track record across mornings
            and asks whether the fix STUCK. Four states: churning (a reset that will not stick → escalate
            to a human), effective (resets sticking, an intermittent lane held as context), quiet (nothing
            to correct), abstained (too little governed history to judge). Closes the SENSE→ACT→LEARN→ADJUST
            loop — the only layer that ever hands a problem back to a person, and only when its own safe
            corrective demonstrably is not enough. ──────────────────────────────────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance audit · churning — a reset that will not stick, escalated</p>
          <LeadPolicyGovernanceAuditPanelPreview data={AUDIT_CHURNING} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The auditor&rsquo;s headline case. The governor has reset <span className="font-bold text-rose-600">worth a look</span> the same way three mornings running and the learner keeps re-earning the thrash — so the safe corrective is{' '}
            <span className="font-bold text-slate-600">holding the line but not curing the cause</span>. Rather than let that loop churn forever, the auditor{' '}
            <span className="font-bold text-rose-600">escalates that one lane to a human</span> — the only place in the whole stack where the machine says &ldquo;I have done what I safely can; a person should look.&rdquo; Verify, reset early and{' '}
            <span className="font-bold text-emerald-600">settled since</span>, is the contrast: that is the fix working. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance audit · effective — resets sticking, one lane still on-and-off</p>
          <LeadPolicyGovernanceAuditPanelPreview data={AUDIT_EFFECTIVE} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The governor <span className="font-bold text-emerald-600">earning its autonomy</span>. Verify was reset and <span className="font-bold text-emerald-600">stayed settled</span>; tailwind needed a single nudge that never came back — the resets{' '}
            <span className="font-bold text-emerald-600">stuck</span>. Worth a look is reset on-and-off (intermittent) but is <span className="font-bold text-amber-600">not on a runaway streak</span>, so the auditor{' '}
            <span className="font-bold text-slate-600">holds fire</span>: intermittent is context, not alarm. Only a <span className="font-bold text-rose-600">recurring</span> reset escalates — the discrimination that keeps the auditor from crying wolf. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance audit · quiet — nothing to correct, nothing to audit</p>
          <LeadPolicyGovernanceAuditPanelPreview data={AUDIT_QUIET} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            A morning with <span className="font-bold text-slate-600">nothing for the auditor to do</span>. The governor never had to reset a single lane, so there is{' '}
            <span className="font-bold text-slate-600">no track record to second-guess</span> — the panel says so and stays out of the way. Like every layer in this stack, the auditor{' '}
            <span className="font-bold text-emerald-600">adds noise only when there is signal</span>; an empty audit is the system reporting health, not a gap. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance audit · abstained — too little governed history yet</p>
          <LeadPolicyGovernanceAuditPanelPreview data={AUDIT_ABSTAINED} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The auditor <span className="font-bold text-slate-600">refusing to grade on one data point</span>. With a single governed morning on record it <span className="font-bold text-slate-600">declines to judge</span> the governor&rsquo;s track record at all —{' '}
            a verdict needs a <span className="font-bold text-slate-600">pattern</span>, and one morning is not one. It waits, the same way the monitor and governor below it wait for enough history before they move.{' '}
            <span className="font-bold text-emerald-600">Abstention is a feature</span>: the stack would rather say &ldquo;not yet&rdquo; than escalate on noise. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        {/* ── 17c GOVERNANCE REMEDIATION — "the remediator" (layer 17), agency-only, sits ABOVE the
            auditor it answers. The auditor only escalates — says "this safe reset is not curing" and
            stops; this rung turns that escalation into a concrete, bounded, reversible STRUCTURAL fix
            staged for one agency click. Three escalating remedies (widen the dead-band → tighten the
            bounds → pin to neutral), and two principled refusals (the emergency lane is never tuned
            down; a lane that has spent every safe move goes to a person). Closes the whole loop
            SENSE→ACT→AUDIT→REMEDIATE — the machine's own structural self-repair, with a human holding
            the apply switch. Three states: proposed (the fix), steady (nothing to restructure),
            abstained (no audited escalation behind it yet). ──────────────────────────────────────── */}
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance remediation · fixes staged — the auditor&rsquo;s escalation, made actionable</p>
          <LeadPolicyGovernanceRemediationPanelPreview data={REMEDY_PROPOSED} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The remediator&rsquo;s headline case. The auditor flagged <span className="font-bold text-rose-600">worth a look</span> as churning; this answers with concrete, reversible structural change instead of one more reset that will not stick — and it escalates the move to fit the history: a <span className="font-bold text-sky-600">gentle widen</span> first, a <span className="font-bold text-amber-600">deeper tighten</span> where the dead-band was not enough, a <span className="font-bold text-rose-600">last-resort pin</span> where the softer moves are already spent — each one click, each undoable. <span className="font-bold text-emerald-600">act_now</span> is set aside untouched (the emergency lane is <span className="font-bold text-slate-600">never tuned down, by design</span>) and <span className="font-bold text-rose-600">monitor</span> has spent every safe structural move, so it goes to a person rather than being forced further. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance remediation · steady — the auditor settling on its own, nothing to restructure</p>
          <LeadPolicyGovernanceRemediationPanelPreview data={REMEDY_STEADY} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The remediator <span className="font-bold text-emerald-600">staying out of the way</span>. The auditor is not escalating anything — its safe resets are sticking on their own — so there is <span className="font-bold text-slate-600">no structural change to stage</span>. Like every rung in this stack, the remediator <span className="font-bold text-emerald-600">acts only on a standing escalation</span>; a quiet auditor means a quiet remediator, and the structural toolkit waits, untouched, until it is genuinely needed. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Governance remediation · abstained — no audited escalation to act on yet</p>
          <LeadPolicyGovernanceRemediationPanelPreview data={REMEDY_ABSTAINED} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The remediator <span className="font-bold text-slate-600">declining to restructure on thin evidence</span>. The auditor itself has too little governed history to judge, so it hands nothing down — and the remediator <span className="font-bold text-slate-600">refuses to invent a structural change</span> without an audited escalation behind it. It waits, the same way every layer beneath it waits for a pattern before it moves. <span className="font-bold text-emerald-600">Abstention is a feature</span>: no escalation, no surgery. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Consumer engagement</p>
          <BriefEngagementPanelPreview data={BRIEF_ENGAGEMENT} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The one rung that faces <span className="font-bold text-slate-600">outward</span>. Every panel above is the system grading itself — reliability, editorial precision, the self-tuning policy and its governance. This is the only place the <span className="font-bold text-slate-600">human reader</span> grades the system: a 👍 / 👎 on the morning brief, folded agency-side into a reception score, with the clients it is <span className="font-bold text-rose-600">landing flat</span> with surfaced to watch. Graded only past 3+ votes, so a thin record abstains rather than swing on noise. And now the loop <span className="font-bold text-slate-600">closes</span>: that reception score feeds the strip below, flexing how much of the supporting picture tomorrow's brief carries — <span className="font-bold text-emerald-600">a well-received brief earns a little more depth</span>, a flat one leads tighter. The <span className="font-bold text-slate-600">headline never moves</span>, and widening must be <span className="font-bold text-emerald-600">earned by a proven level</span>, never by a hopeful trend. <span className="font-bold text-emerald-600">The aggregate is agency-only</span> — a client only ever sees their own vote, never this surface. <span className="font-bold text-slate-600">Agency-only</span>.
          </p>
        </div>

        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Agency · Intelligence ▸ Emphasis efficacy · is the self-tuning paying off</p>
          <BriefEmphasisEfficacyPanelPreview data={BRIEF_EMPHASIS_EFFICACY} />
          <p className="mt-2 px-1 text-[11px] font-medium text-slate-400 leading-relaxed">
            The rung that closes the loop on the loop. The panel above flexes tomorrow's brief on every reception grade — but it flexes with <span className="font-bold text-slate-600">fixed steps and never checks whether the flex worked</span>. This is the first rung that <span className="font-bold text-slate-600">grades the self-tuning's own moves</span>: it pairs each morning's emphasis decision with the reception that <span className="font-bold text-slate-600">followed</span> — free, off history already on disk — and scores each direction against the control of mornings the brief held steady. <span className="font-bold text-emerald-600">Widening should sustain</span> reception; <span className="font-bold text-amber-600">tightening should recover</span> it. Here widening is holding up — 65% sustained, <span className="font-bold text-emerald-600">+25pp over the 40% control</span> — so the learned step-scale leans in to ×1.12; tightening is in line with the control, so it holds at ×1.00. The scale stays <span className="font-bold text-slate-600">bounded 0.5×–1.25×</span> — easy to ease off a losing bet, earned to lean into a winning one — the very knob a future controller feeds back to make the panel above self-improving. Honest by abstention: a direction under a handful of decided outcomes shows no rate, and a thin history reads <span className="font-bold text-slate-600">Listening</span>, never a verdict off noise. <span className="font-bold text-slate-600">Agency-only</span> — a reader never sees their attention being tuned.
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
