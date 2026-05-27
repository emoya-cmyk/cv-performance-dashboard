/**
 * Shared formatting helpers used across dashboard components.
 */

/** Merge class names (simple version — no clsx dependency needed) */
export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}

/** Format an integer with thousands separators, e.g. 1234567 → "1,234,567" */
export function fmtN(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return Number(n).toLocaleString()
}

/** Format as percentage, e.g. 0.123 → "12.3%" or 12.3 → "12.3%" */
export function fmtPct(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const v = n > 1 ? n : n * 100
  return `${Number(v).toFixed(decimals)}%`
}

/** Format as a multiplier, e.g. 4.2 → "4.2×" */
export function fmtX(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return `${Number(n).toFixed(decimals)}×`
}

/** Format as USD currency, e.g. 12345 → "$12,345" */
export function fmtDollar(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style:    'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n)
}

/** Alias for fmtDollar */
export const fmt$ = fmtDollar

/** Short dollar format: 1500 → "$1.5k", 2500000 → "$2.5M" */
export function fmtDollarShort(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`
  return `$${Math.round(n)}`
}

/** Delta badge: +12% or -5% with sign */
export function fmtDelta(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${Number(n).toFixed(decimals)}%`
}

/** Clamp a value between min and max */
export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max)
}

/** Return ISO week-start (Monday) for a given Date */
export function toWeekStart(date = new Date()) {
  const d   = new Date(date)
  const day = d.getDay()                   // 0=Sun
  const diff = day === 0 ? -6 : 1 - day   // shift to Monday
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

/** Parse a YYYY-MM-DD string safely */
export function parseDate(str) {
  if (!str) return null
  const d = new Date(str + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

/** Alias: fmt$$ = fmtDollar (used by ExecView, Dashboard, Clients, etc.) */
export const fmt$$ = fmtDollar

/** Compute percent change: delta(current, previous) → { pct, positive, significant } */
export function delta(current, previous) {
  if (!previous || previous === 0) return { pct: null, positive: true, significant: false }
  const pct = ((current - previous) / Math.abs(previous)) * 100
  return {
    pct:         parseFloat(pct.toFixed(1)),
    positive:    pct >= 0,
    significant: Math.abs(pct) >= 5,
  }
}

/** Format a YYYY-MM-DD week_start as "Mon DD" e.g. "Apr 07" */
export function weekLabel(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
