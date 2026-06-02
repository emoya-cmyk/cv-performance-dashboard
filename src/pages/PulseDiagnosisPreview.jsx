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
import { ArrowUp, ArrowDown, Minus, Activity, Sparkles, Clock, ShieldCheck, Gauge, ShieldAlert, Crosshair, AlertTriangle, Eye, Radar } from 'lucide-react'
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

// Shaped EXACTLY like lib/pulseTriage.rankPulseSignals(roster, { adverseOnly: true }) output:
// each row already carries priority_rank + lane + triage_reason and the reliability fields the
// rank was computed from. Ordered by priority (severity × reliability × magnitude) desc. THE
// HEADLINE lives at ranks 2–3: a RELIABLE Warning (worth a look) outranks a NOISY Critical
// (verify) — exactly the cross this layer exists to make. Sample numbers; names fictional.
const ACT_TODAY = [
  { client_id: 'c1', client_name: 'Skyline Dental',    label: 'Leads',   adverse: true, severity: 'critical', delta_pct: -48, lane: 'act_now',      priority_rank: 1, reliability_label: 'reliable', reliability_note: 'Reliable — this leads alert held up 9 of the last 11 times it fired for Skyline Dental.',     triage_reason: 'Leads is critical and this alert has a reliable track record — act today.' },
  { client_id: 'c2', client_name: 'Harbor Family Law', label: 'Revenue', adverse: true, severity: 'warning',  delta_pct: -24, lane: 'worth_a_look', priority_rank: 2, reliability_label: 'reliable', reliability_note: 'Reliable — this revenue alert held up 8 of the last 10 times it fired for Harbor Family Law.', triage_reason: 'Revenue is slipping and this alert has held up before — worth a look today.' },
  { client_id: 'c3', client_name: 'Vista Auto Group',  label: 'Leads',   adverse: true, severity: 'critical', delta_pct: -51, lane: 'verify',       priority_rank: 3, reliability_label: 'noisy',    reliability_note: 'Noisy — this leads alert reverted 7 of the last 9 times it fired for Vista Auto Group.',      triage_reason: 'Leads is critical, but this alert has been noisy lately — confirm before acting.' },
  { client_id: 'c4', client_name: 'Peak Roofing Co.',  label: 'Spend',   adverse: true, severity: 'warning',  delta_pct: 31,  lane: 'monitor',      priority_rank: 4, reliability_label: 'mixed',    reliability_note: 'Mixed — this spend alert held up 5 of the last 11 times it fired for Peak Roofing Co.',       triage_reason: 'Spend is slipping, but this alert flickers (mixed) — monitor for now.' },
]

// One ranked decision: lane-tinted rank badge (order + call), client + metric, the action
// LANE chip, and the learned CONFIDENCE chip that DROVE the rank (hover for the count). The
// grounded one-liner is the engine's own agency narration of the lane.
function ActTodayRowPreview({ r }) {
  const lane     = laneTone(r)
  const rel      = RELIABILITY_TONE[r.reliability_label] || null
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

// ── agency row (Intelligence ▸ Daily pulse) + diagnosis ───────────────────────
function PreviewPulseRow({ r }) {
  const tone     = pulseTone(r)
  const Dir      = r.direction === 'down' ? ArrowDown : r.direction === 'up' ? ArrowUp : Minus
  const delta    = Math.round(Number(r.delta_pct))
  const deltaStr = `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%`
  const baseN    = Number(r.baseline?.n)
  const rel      = RELIABILITY_TONE[r.reliability_label] || null   // learned trust grade for THIS metric's firing history
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
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[11px] font-semibold text-slate-400">
            <span className={`tabular-nums font-bold ${tone.text}`}>{fmtMetricValue(r.metric, r.latest)}</span>
            <span className="text-slate-300">this past week · usual ≈</span>
            <span className="tabular-nums font-bold text-slate-600">{fmtMetricValue(r.metric, r.baseline?.median)}</span>
            {baseN > 0 && (<><span className="text-slate-300">·</span><span className="tabular-nums">{baseN}-wk base</span></>)}
          </div>
          <DriverBreakdown message={r.diagnosis_message} diagnosis={r.diagnosis} tone={tone} audience="agency" />
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
          </div>
          {s.client_message && <p className="text-xs text-slate-600 leading-relaxed font-medium mt-1">{s.client_message}</p>}
          <DriverBreakdown message={s.diagnosis_client_message} diagnosis={s.diagnosis} tone={tone} audience="client" />
          {s.reliability_client_note && (
            <p className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 mt-1.5">
              <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />
              {s.reliability_client_note}
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
    diagnosis: { metric: 'jobs', direction: 'down', lead: 'leads',
      drivers: [{ metric: 'leads', pct: -50, share: 1, share_pct: 100 }, { metric: 'close_rate', pct: 0, share: 0, share_pct: 0 }] },
    diagnosis_message: 'Jobs won is down 50% — the driver is Leads (down 50%), while Close rate held.' },

  { client_id: 'b', client_name: 'Harbor Mechanical', metric: 'revenue', label: 'Revenue',
    adverse: true, severity: 'warning', direction: 'down', delta_pct: -30, latest: 700, baseline: { median: 1000, n: 8 },
    reliability: 0.3333, reliability_label: 'noisy',
    reliability_note: 'Revenue alerts for this client have held up 2 of 6 times recently (~33%) — a noisy signal, read it with care.',
    diagnosis: { metric: 'revenue', direction: 'down', lead: 'spend',
      drivers: [{ metric: 'spend', pct: -50, share: 1.9434, share_pct: 194.3 }, { metric: 'roas', pct: 40, share: -0.9434, share_pct: -94.3 }] },
    diagnosis_message: 'Revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop.' },

  { client_id: 'c', client_name: 'Cedar & Stone Roofing', metric: 'jobs', label: 'Jobs won',
    adverse: true, severity: 'warning', direction: 'down', delta_pct: -60, latest: 8, baseline: { median: 20, n: 6 },
    reliability: 0.5, reliability_label: 'mixed',
    reliability_note: 'Jobs won alerts for this client have held up 3 of 6 times recently (~50%) — a mixed signal.',
    diagnosis: { metric: 'jobs', direction: 'down', lead: 'close_rate',
      drivers: [{ metric: 'leads', pct: -20, share: 0.2435, share_pct: 24.3 }, { metric: 'close_rate', pct: -50, share: 0.7565, share_pct: 75.7 }] },
    diagnosis_message: 'Jobs won is down 60% — the driver is Close rate (down 50%), with Leads also down 20%.' },

  { client_id: 'd', client_name: 'BlueWave Pools', metric: 'revenue', label: 'Revenue',
    adverse: false, severity: 'info', direction: 'up', delta_pct: 43, latest: 1144, baseline: { median: 800, n: 8 },
    reliability: 0.8889, reliability_label: 'reliable',
    reliability_note: 'Revenue alerts for this client have held up 8 of 9 times recently (~89%) — a reliable signal.',
    diagnosis: { metric: 'revenue', direction: 'up', lead: 'roas',
      drivers: [{ metric: 'spend', pct: 10, share: 0.2665, share_pct: 26.6 }, { metric: 'roas', pct: 30, share: 0.7335, share_pct: 73.3 }] },
    diagnosis_message: 'Revenue is up 43% — the driver is ROAS (up 30%), with Ad spend also up 10%.' },
]

const CLIENT = [
  { metric: 'jobs', label: 'Jobs won', adverse: true, severity: 'critical', direction: 'down', delta_pct: -50,
    client_message: 'Jobs won is tracking about 50% below your usual week so far.',
    reliability_client_note: 'This has been a consistent signal lately.',
    diagnosis: { metric: 'jobs', direction: 'down', lead: 'leads',
      drivers: [{ metric: 'leads', pct: -50, share: 1, share_pct: 100 }, { metric: 'close_rate', pct: 0, share: 0, share_pct: 0 }] },
    diagnosis_client_message: 'Your jobs won is down 50% — the driver is Leads (down 50%), while Close rate held.' },

  { metric: 'revenue', label: 'Revenue', adverse: true, severity: 'warning', direction: 'down', delta_pct: -30,
    client_message: 'Revenue is running about 30% under your usual week.',
    reliability_client_note: '',
    diagnosis: { metric: 'revenue', direction: 'down', lead: 'spend',
      drivers: [{ metric: 'spend', pct: -50, share: 1.9434, share_pct: 194.3 }, { metric: 'roas', pct: 40, share: -0.9434, share_pct: -94.3 }] },
    diagnosis_client_message: 'Your revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop.' },

  { metric: 'revenue', label: 'Revenue', adverse: false, severity: 'info', direction: 'up', delta_pct: 43,
    client_message: 'Revenue is pacing about 43% ahead of your usual week — nice momentum.',
    reliability_client_note: 'This has been a consistent signal lately.',
    diagnosis: { metric: 'revenue', direction: 'up', lead: 'roas',
      drivers: [{ metric: 'spend', pct: 10, share: 0.2665, share_pct: 26.6 }, { metric: 'roas', pct: 30, share: 0.7335, share_pct: 73.3 }] },
    diagnosis_client_message: 'Your revenue is up 43% — the driver is ROAS (up 30%), with Ad spend also up 10%.' },
]

export default function PulseDiagnosisPreview() {
  return (
    <div className="min-h-screen bg-slate-100/70 p-6 sm:p-10">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-600">Design preview · intel-v7 (2) + (3) + (4)</p>
          <h1 className="text-2xl font-black text-slate-900 mt-1">Daily Pulse → diagnosis → reliability → act today</h1>
          <p className="text-sm text-slate-500 font-medium mt-1.5 max-w-3xl leading-relaxed">
            The pulse already says <span className="font-bold text-slate-700">what</span> moved this week, and (2) adds the{' '}
            <span className="font-bold text-slate-700">why</span> — decomposing each composite move (revenue ≡ spend × ROAS,
            jobs ≡ leads × close rate) into its exact drivers in log space. (3) adds{' '}
            <span className="font-bold text-slate-700">how much to trust it</span>: the sensor grades its own past firings against
            this client&rsquo;s own history and labels each live signal <span className="font-bold text-emerald-600">reliable</span> /{' '}
            <span className="font-bold text-slate-500">mixed</span> / <span className="font-bold text-slate-400">noisy</span>. Now (4)
            does the agency&rsquo;s triage <span className="font-bold text-slate-700">for</span> it — crossing each alarm&rsquo;s{' '}
            <span className="font-bold text-indigo-600">severity × that learned reliability</span> into one ranked &ldquo;Act today&rdquo;
            list with an action lane, so the first hour lands by evidence rather than by how loud the alarm is. No model, no tuning;
            every figure traces to a stored daily fact. Sample numbers; client names fictional.
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
                  that&rsquo;s also Reliable is act-now; a Critical that&rsquo;s Noisy is watch-don&rsquo;t-overreact. Agency-only.
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
              <p className="text-xs text-slate-500 font-medium mb-4 leading-relaxed">
                An early read on the week in progress — with the reason behind each move, in your own numbers.
              </p>
              <div className="space-y-3">
                {CLIENT.map((s, i) => <PreviewClientPulseRow key={`${s.metric}:${i}`} s={s} />)}
              </div>
              <p className="text-[10px] text-slate-400 mt-3.5 pt-3 border-t border-slate-50 leading-relaxed">
                Watched live off your daily numbers and refreshed every day. When a number moves, we break down what drove it —
                so you see the cause days before the week officially closes. When a signal has a steady track record, a small{' '}
                <span className="font-semibold text-emerald-600">consistent-signal</span> note appears; a flickery one stays
                quiet, so you&rsquo;re never shown a number you can&rsquo;t lean on.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
