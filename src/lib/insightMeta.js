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
