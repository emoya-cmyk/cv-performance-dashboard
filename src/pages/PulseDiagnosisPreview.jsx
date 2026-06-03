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
import { ArrowUp, ArrowDown, Minus, Activity, Sparkles, Clock, ShieldCheck, Gauge, ShieldAlert, Crosshair, AlertTriangle, AlertOctagon, Wrench, Eye, CheckCircle2, Radar, Target, SlidersHorizontal, ArrowUpCircle, TrendingDown, Scale } from 'lucide-react'
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
