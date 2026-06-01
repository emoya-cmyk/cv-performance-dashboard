/**
 * insightMeta — the single source of presentation truth for engine findings.
 *
 * Both the agency-wide Intelligence page and the Dashboard AnomalyStrip render the
 * same `insights` rows (GET /api/insights). Keeping severity palettes, kind icons,
 * direction glyphs and metric labels here means the two surfaces can never drift —
 * a "critical" looks identical wherever it appears, and a new finding kind only has
 * to be taught once.
 *
 * Pure data + lucide component references — no JSX — so it stays a plain .js module.
 */
import {
  Zap, TrendingUp, LineChart, Gauge, Activity, Unplug, Shuffle, Lightbulb, Sparkles,
  ArrowUpRight, ArrowDownRight, Minus,
  Flame, CalendarClock, Eye,
  SignalHigh, SignalMedium, SignalLow,
} from 'lucide-react'

// ── severity → light-theme palette ───────────────────────────────────────────
// `accent` is the hex used for the card's left rail; the class strings are Tailwind
// utilities applied to chips, dots and text.
export const SEVERITY = {
  critical: { rank: 3, label: 'Critical', accent: '#e11d48', dot: 'bg-rose-500',  text: 'text-rose-700',  chipBg: 'bg-rose-50',  chipText: 'text-rose-600',  border: 'border-rose-200',  ring: 'ring-rose-200 border-rose-200 bg-rose-50/50' },
  warning:  { rank: 2, label: 'Warning',  accent: '#f59e0b', dot: 'bg-amber-500', text: 'text-amber-700', chipBg: 'bg-amber-50', chipText: 'text-amber-600', border: 'border-amber-200', ring: 'ring-amber-200 border-amber-200 bg-amber-50/50' },
  info:     { rank: 1, label: 'Info',     accent: '#0ea5e9', dot: 'bg-sky-500',   text: 'text-sky-700',   chipBg: 'bg-sky-50',   chipText: 'text-sky-600',   border: 'border-sky-200',   ring: 'ring-sky-200 border-sky-200 bg-sky-50/50' },
}
export const severityMeta = (s) => SEVERITY[s] || SEVERITY.info

// ── health band → score palette ───────────────────────────────────────────────
// lib/health.js rolls a client's open findings into ONE 0–100 score and bands it
// (healthy ≥85 · watch ≥65 · at_risk ≥40 · critical ≥0). Where SEVERITY paints a
// single finding, this paints the whole-client verdict the synthesis produces — the
// triage roster's worst-first leaderboard (agency) and the one-number badge on the
// client dashboard. Defined beside SEVERITY because the band IS the roll-up of
// severities and shares its worst-case color (rose), running a legible traffic-light
// gradient up the scale: emerald → amber → orange → rose. Both surfaces read these
// class strings so a "watch" looks identical wherever the verdict appears.
// `bar` is the meter-fill class for the score gauge; `ring` highlights a roster row.
export const HEALTH_BAND = {
  healthy:  { rank: 0, label: 'Healthy',  accent: '#10b981', dot: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', ring: 'ring-emerald-200 border-emerald-200 bg-emerald-50/50', bar: 'bg-emerald-500' },
  watch:    { rank: 1, label: 'Watch',    accent: '#f59e0b', dot: 'bg-amber-500',   text: 'text-amber-700',   chip: 'bg-amber-50 text-amber-700 border-amber-200',       ring: 'ring-amber-200 border-amber-200 bg-amber-50/50',       bar: 'bg-amber-500' },
  at_risk:  { rank: 2, label: 'At risk',  accent: '#f97316', dot: 'bg-orange-500',  text: 'text-orange-700',  chip: 'bg-orange-50 text-orange-700 border-orange-200',    ring: 'ring-orange-200 border-orange-200 bg-orange-50/50',    bar: 'bg-orange-500' },
  critical: { rank: 3, label: 'Critical', accent: '#e11d48', dot: 'bg-rose-500',    text: 'text-rose-700',    chip: 'bg-rose-50 text-rose-700 border-rose-200',          ring: 'ring-rose-200 border-rose-200 bg-rose-50/50',          bar: 'bg-rose-500' },
}
// Unknown/garbage band → healthy, mirroring the pure module's own clamping contract
// (healthBand(999) → 'healthy', scoreClient(garbage) → a driverless 100). The FE
// vocabulary and the BE synthesis agree on the totality case rather than inventing a
// grey "unknown" colour that maps to no real band.
export const healthBandMeta = (band) => HEALTH_BAND[band] || HEALTH_BAND.healthy

// ── kind → icon + label ───────────────────────────────────────────────────────
// Mirrors the kinds the engine emits (see migrations/013_intelligence.sql).
export const KIND = {
  anomaly:        { icon: Zap,        label: 'Anomaly' },
  trend:          { icon: TrendingUp, label: 'Trend' },
  forecast:       { icon: LineChart,  label: 'Forecast' },
  pacing:         { icon: Gauge,      label: 'Pacing' },
  data_health:    { icon: Activity,   label: 'Data Health' },
  coverage_gap:   { icon: Unplug,     label: 'Connection' },
  mix_shift:      { icon: Shuffle,    label: 'Mix Shift' },
  recommendation: { icon: Lightbulb,  label: 'Recommendation' },
}
export const kindMeta = (k) => KIND[k] || { icon: Sparkles, label: titleCase(k) }

// ── direction glyph ───────────────────────────────────────────────────────────
export const directionIcon = (dir) => (dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus)

// ── recommended-action urgency → lane chip ────────────────────────────────────
// The engine pairs every finding's advice with an urgency lane mapped from
// severity (critical→act_now, warning→plan, info→monitor). This is the visual
// vocabulary for that lane: a label + icon + chip palette. Kept here so the
// portfolio page, the client view and any future digest badge it identically.
export const URGENCY = {
  act_now: { rank: 3, label: 'Act now',   icon: Flame,        chip: 'bg-rose-50 text-rose-600 border-rose-200' },
  plan:    { rank: 2, label: 'This week', icon: CalendarClock, chip: 'bg-amber-50 text-amber-600 border-amber-200' },
  monitor: { rank: 1, label: 'Monitor',   icon: Eye,          chip: 'bg-sky-50 text-sky-600 border-sky-200' },
}
export const urgencyMeta = (u) => URGENCY[u] || URGENCY.monitor

// ── precision band → learned-confidence chip ──────────────────────────────────
// lib/precision.js — the engine's SECOND self-improving organ — reads the insight
// LIFECYCLE as a free relevance signal: a finding a client's team acknowledges or
// resolves was useful; one they let auto-expire was noise. It rolls that history
// into a per-(client, signature) confidence band (Beta-Bernoulli shrunk toward the
// client's own base rate). Surfacing the band here is the visible proof the
// intelligence layer reads its own audience — an alert type this team reliably acts
// on reads "High signal", one they routinely ignore reads "Low", with no hand-tuned
// threshold anywhere. The signal-strength glyph makes the learned level legible at a
// glance. Shown ONLY once a signature has decided history (precision.n > 0); below
// evidence the prior is neutral and the chip hides, so the engine never guesses out
// loud. The agency page renders it in full; it is deliberately NOT surfaced to the
// end client, where "your team ignores these" would misframe the client's own behavior.
export const PRECISION = {
  high:   { rank: 3, label: 'High signal',  icon: SignalHigh,   chip: 'bg-emerald-50 text-emerald-600 border-emerald-200', dot: 'bg-emerald-500' },
  medium: { rank: 2, label: 'Mixed signal', icon: SignalMedium, chip: 'bg-slate-50 text-slate-500 border-slate-200',       dot: 'bg-slate-400' },
  low:    { rank: 1, label: 'Low signal',   icon: SignalLow,    chip: 'bg-slate-100 text-slate-400 border-slate-200',      dot: 'bg-slate-300' },
}
export const precisionMeta = (band) => PRECISION[band] || PRECISION.medium

// A finding carries a learned band only once its signature has decided history for
// this client (precision.n > 0). Below that the precision block is the neutral prior
// — the chip hides rather than show a guess, matching the engine's "neutral below
// evidence" contract that keeps ranking byte-identical until there's something learned.
export const hasLearnedPrecision = (insight) =>
  !!(insight && insight.precision && Number(insight.precision.n) > 0)

// One-line human gloss for the chip's tooltip — turns the raw decided tallies into a
// plain statement of WHAT was learned and from how much evidence. confidence is the
// shrunk posterior (so 1-of-1 reads as cautious, not a triumphant 100%), shown beside
// the raw fraction so the discipline is visible rather than hidden. null when there's
// no learned history (caller already gates on hasLearnedPrecision, but be defensive).
export function precisionTooltip(insight) {
  const p = insight && insight.precision
  if (!p || !(Number(p.n) > 0)) return null
  const engaged = Number(p.engaged) || 0
  const n       = Number(p.n) || 0
  const pct     = Math.round((Number(p.confidence) || 0) * 100)
  const noun    = n === 1 ? 'finding' : 'findings'
  return `Learned from your team's engagement: acted on ${engaged} of ${n} ${noun} like this (${pct}% confidence). The feed ranks findings like this to match — no thresholds set by hand.`
}

// ── audience: which kinds reach the end client ────────────────────────────────
// The agency Intelligence page shows every finding the engine emits. The consumer
// view withholds a subset that's meaningless or alarming to a business owner:
//   • data_health — an internal data-pipeline concern owned by the account team.
//     A client can't reconnect their own feed, and the advice copy ("re-sync this
//     client's data sources… every metric is running blind") is written for the
//     operator, not the client. Surfacing it would read as a scary defect, not an
//     insight. The agency still sees it on /intelligence.
//   • coverage_gap — one ad/CRM channel has gone dark beyond its own cadence
//     (lib/coverage.js). The only fix is "reconnect <channel>," and that account is
//     owned and administered by the agency — the client has no console to reconnect
//     it, and "your Meta Ads stopped reporting" would read as a defect they can't act
//     on. Same audience as data_health: agency/internal-only, shown on /intelligence.
// Centralised here so the rule is taught once — any future client-facing surface
// (digest email, mobile) inherits the same audience filter instead of re-deciding.
export const CLIENT_HIDDEN_KINDS = new Set(['data_health', 'coverage_gap'])
export const isClientFacing = (insight) =>
  !!insight && !CLIENT_HIDDEN_KINDS.has(insight.kind)

// ── metric labels ─────────────────────────────────────────────────────────────
// Keeps acronyms cased correctly (ROAS/CPL) where a naive title-case would mangle
// them. Falls back to title-case for anything the engine adds later.
export const METRIC_LABEL = {
  revenue: 'Revenue', leads: 'Leads', jobs: 'Jobs', spend: 'Spend',
  roas: 'ROAS', cpl: 'CPL', close_rate: 'Close Rate',
}
export const metricLabel = (m) => METRIC_LABEL[m] || titleCase(m)

// ── self-tuned forecast interval → a visible "likely range" ───────────────────
// lib/selftune.js#intervalFor is the VISIBLE half of the forecast self-tuning loop:
// once a client has a realized track record, the engine's learned forecast error
// (mape) sizes an 80% prediction band around a projection — tighter as the client
// earns accuracy, wider when they're noisy, with no hand-set width anywhere. The
// engine writes the band INTO a forecast finding's evidence (projected_low /
// projected_high / interval_pct), so a narrated range can never drift from the
// numbers behind it. forecastRange() pulls those keys back out as one typed object
// the surfaces render as a prominent "likely range" line. It returns null whenever
// the band wasn't earned (the keystone no-op — a fresh forecast shows a clean point,
// exactly as before the loop existed).
export function forecastRange(insight) {
  const e = insight && insight.evidence
  if (!e) return null
  const lo = Number(e.projected_low)
  const hi = Number(e.projected_high)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null
  const point = Number(e.projected_total)
  const pct   = Number(e.interval_pct)
  return {
    lo, hi,
    point: Number.isFinite(point) ? point : null,
    pct:   Number.isFinite(pct)   ? pct   : null,
    // The engine stamps goal_in_band when the goal still falls inside this band and
    // it therefore SOFTENED the alarm (lib/insights.js#detectForecast — the calibrated
    // alarm). Read it straight off evidence rather than re-deriving target-vs-band on
    // the surface, so the note can never disagree with the severity the engine chose.
    goalInBand: e.goal_in_band === true,
  }
}

// ── driver attribution → the model-free "why" behind a composite move ──────────
// lib/attribution.js (the engine's "why" organ) decomposes a move in a composite KPI
// into the EXACT contributions of its stored drivers — revenue into spend × roas, jobs
// into leads × close_rate — and the engine stamps that whole decomposition onto a trend
// or anomaly finding under ONE nested evidence.attribution key (lib/insights.js#attach-
// Attribution). The nesting is deliberate: an object value is already skipped by every
// surface's number|string evidence-chip filter, so — unlike the forecast band — there is
// NO keys-to-exclude set to maintain here. attributionView pulls that object back out as
// one typed, presentation-ready shape both surfaces render from the same truth: the agency
// as a full signed breakdown ("spend ↑12% — 100% of the move"), the client as one plain
// sentence ("driven mostly by leads, down 15%"). Returns null whenever the finding carries
// no decomposition — every non-composite metric, every degenerate endpoint — the keystone
// no-op, so a finding without a "why" renders exactly as it did before this layer existed.
//
// `share` is SIGNED (see attribution.js): a driver that moved OPPOSITE the composite carries
// a negative share — it CUSHIONED the move rather than caused it — while the dominant aligned
// driver carries a share > 1 to compensate. We pass that signedness through as `cushioned` so
// a surface can label it honestly instead of printing a baffling "−50% of the move". `dirWord`
// and `pctAbs` are the driver's OWN movement, pre-split so the two surfaces phrase it
// identically and never re-derive the sign.
export function attributionView(insight) {
  const a = insight && insight.evidence && insight.evidence.attribution
  if (!a || !Array.isArray(a.drivers) || a.drivers.length === 0) return null

  const drivers = a.drivers.map((d) => {
    const share    = Number(d.share)
    const pct      = Number(d.pct)
    const sharePct = Number.isFinite(Number(d.share_pct))
      ? Number(d.share_pct)
      : Math.round((Number.isFinite(share) ? share : 0) * 100)
    return {
      metric:  d.metric,
      label:   metricLabel(d.metric),
      pct:     Number.isFinite(pct) ? pct : 0,            // signed % change of the driver
      pctAbs:  Number.isFinite(pct) ? Math.abs(pct) : 0,
      dirWord: !Number.isFinite(pct) || pct === 0 ? 'flat' : pct > 0 ? 'up' : 'down',
      share:   Number.isFinite(share) ? share : 0,
      sharePct,
      isLead:  d.metric === a.lead,
      // negative share ⇒ moved opposite the composite ⇒ softened, not caused, the move
      cushioned: Number.isFinite(share) && share < 0,
    }
  })

  return {
    metric:    a.metric,
    label:     metricLabel(a.metric),
    direction: a.direction === 'down' ? 'down' : 'up',
    pct:       Number.isFinite(Number(a.pct)) ? Number(a.pct) : 0,
    // the dominant lever — the driver to pull; always aligned with `direction`
    lead:      drivers.find((d) => d.isLead) || drivers[0],
    drivers,                                              // presentation order, signed
  }
}

// ── root-cause linking → the dark channel behind a fallen metric ───────────────
// lib/correlate.js (the engine's "what's dragging this" organ) connects a downstream
// adverse metric finding (an anomaly/trend that FELL) to an upstream channel that went
// dark (a coverage_gap) WHEN that channel materially fed the metric. The engine stamps
// the connection onto evidence as TWO nested keys (lib/insights.js#applyCoverageLinks):
//   • caused_by — on the SYMPTOM finding: { channel, channel_label, category, share_pct,
//     days_dark } — the dominant lost contributor, the one we name as the likely cause.
//   • impacts   — on the ROOT coverage_gap:  [{ metric, share_pct }], worst share first —
//     the channel's blast radius, every metric it is measurably dragging.
// Both are NESTED (object / array), so — exactly like evidence.attribution — they are
// already skipped by every surface's scalar number|string evidence-chip filter AND by the
// grounding verifier; there is NO keys-to-exclude set to maintain here. The two views
// below pull each back out as a typed, presentation-ready shape both surfaces render from
// the same truth. Each returns null when its key is absent — the keystone no-op, so a
// finding the engine couldn't link renders exactly as it did before this layer existed.

// correlateView — the SYMPTOM side. Reads evidence.caused_by off an anomaly/trend and
// pairs it with that finding's OWN metric (the thing that fell), so a surface can phrase
// "Likely cause: Meta Ads dark 30d (~44% of Leads)" — channel from caused_by, metric from
// the finding. It exposes the PARTS and lets each surface choose how much to say: the
// agency renders the full named line, while the client gets a deliberately vague note (the
// dark channel is the agency's account to reconnect, never the client's — naming "your
// Meta Ads stopped reporting" would read as a defect they can't act on). days_dark / share
// may be null when the engine couldn't ground them; the caller already guards each.
export function correlateView(insight) {
  const c = insight && insight.evidence && insight.evidence.caused_by
  if (!c || c.channel == null) return null
  const sharePct = Number(c.share_pct)
  const daysDark = Number(c.days_dark)
  return {
    channel:      String(c.channel),
    channelLabel: c.channel_label || String(c.channel),
    category:     c.category || null,
    sharePct:     Number.isFinite(sharePct) ? sharePct : null,
    daysDark:     Number.isFinite(daysDark) ? daysDark : null,
    metric:       insight.metric || null,
    metricLabel:  insight.metric ? metricLabel(insight.metric) : null,
  }
}

// impactsView — the ROOT side. Reads evidence.impacts off a coverage_gap into a typed,
// already-worst-first blast-radius list (the engine sorted it: share_pct desc, then metric
// name). Returns null when the dark channel is dragging nothing measurable — no entry, no
// over-claiming, no line. The agency-only counterpart to correlateView: it names the
// metrics a reconnect would recover, so the operator sees the STAKES of the gap, not just
// that a channel went quiet. (Client-hidden along with the coverage_gap kind that carries it.)
export function impactsView(insight) {
  const imp = insight && insight.evidence && insight.evidence.impacts
  if (!Array.isArray(imp) || imp.length === 0) return null
  const metrics = imp
    .map((m) => {
      if (!m || m.metric == null) return null
      const sharePct = Number(m.share_pct)
      return { metric: String(m.metric), label: metricLabel(m.metric), sharePct: Number.isFinite(sharePct) ? sharePct : null }
    })
    .filter(Boolean)
  return metrics.length ? metrics : null
}

// The three evidence keys forecastRange() consumes. The collapsed evidence list on
// each surface filters these OUT — they read as one "likely range" line instead of
// three lonely raw numbers — but they STAY in evidence as the grounded data layer the
// LLM narration, the API and the tests read. De-duplication, not suppression.
export const FORECAST_RANGE_KEYS = new Set(['projected_low', 'projected_high', 'interval_pct'])

// Metric-aware value formatter for the range line: money metrics render as whole
// dollars ($2,715), counts as comma-grouped integers (1,200). Self-contained (mirrors
// utils.fmtDollar output) so insightMeta stays a dependency-free presentation module.
const MONEY_METRICS = new Set(['revenue', 'spend', 'cpl'])
export function fmtMetricValue(metric, v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (MONEY_METRICS.has(metric)) {
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  }
  return Math.round(n).toLocaleString('en-US')
}

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
