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
  Zap, TrendingUp, LineChart, Gauge, Activity, Shuffle, Lightbulb, Sparkles,
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

// ── kind → icon + label ───────────────────────────────────────────────────────
// Mirrors the kinds the engine emits (see migrations/013_intelligence.sql).
export const KIND = {
  anomaly:        { icon: Zap,        label: 'Anomaly' },
  trend:          { icon: TrendingUp, label: 'Trend' },
  forecast:       { icon: LineChart,  label: 'Forecast' },
  pacing:         { icon: Gauge,      label: 'Pacing' },
  data_health:    { icon: Activity,   label: 'Data Health' },
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
// Centralised here so the rule is taught once — any future client-facing surface
// (digest email, mobile) inherits the same audience filter instead of re-deciding.
export const CLIENT_HIDDEN_KINDS = new Set(['data_health'])
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

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
