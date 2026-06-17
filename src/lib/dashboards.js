// ── saved-dashboard widget helpers (Phase 3) ─────────────────────────────────
// Pure builders shared by Explore's "Save as widget" action and the Dashboards
// renderer. No React, no network — just the spec/widget shape, so they're unit
// testable in isolation.
//
// A widget is { id, title, viz, spec } where spec is the SAME shape POST /api/query
// accepts: { metrics, dateRange:{start,end}, groupBy:[...], filters?, compareTo? }.
// The server clamps the spec to the caller's tenant at render time, so building a
// widget here is purely presentational — it can never widen access.

// Build a query spec from Explore's individual controls (the same assembly
// Explore.jsx does inline, factored out so a widget and a live query agree).
export function buildSpec({ metrics, groupBy, start, end, channelFilter = [], compare = false }) {
  const isDateGrain = typeof groupBy === 'string' && groupBy.startsWith('date:')
  const spec = { metrics: [...metrics], dateRange: { start, end }, groupBy: [groupBy] }
  if (channelFilter.length) spec.filters = [{ dim: 'channel', op: 'in', values: [...channelFilter] }]
  if (compare && !isDateGrain) spec.compareTo = 'previous_period'
  return spec
}

// The viz a widget renders as, inferred from its breakdown: a date grouping is a
// time-series (area), anything else is a categorical bar. Kept in sync with how
// Explore's ResultChart picks its chart.
export function vizForGroupBy(groupBy) {
  return typeof groupBy === 'string' && groupBy.startsWith('date:') ? 'area' : 'bar'
}

// Assemble a complete widget from Explore's control state. `title` defaults to a
// human label ("Spend, Leads by Channel").
export function buildWidget({ metrics, groupBy, start, end, channelFilter, compare, title, metricLabels }) {
  const spec = buildSpec({ metrics, groupBy, start, end, channelFilter, compare })
  return {
    id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: (title && title.trim()) || defaultTitle({ metrics, groupBy, metricLabels }),
    viz: vizForGroupBy(groupBy),
    spec,
  }
}

const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// "Spend, Leads by Channel" — a readable default title from the metrics + breakdown.
export function defaultTitle({ metrics, groupBy, metricLabels = {} }) {
  const labels = (metrics || []).map((id) => metricLabels[id] || titleCase(id))
  const by = typeof groupBy === 'string' && groupBy.startsWith('date:')
    ? titleCase(groupBy.slice(5))
    : titleCase(groupBy || '')
  return `${labels.join(', ')}${by ? ` by ${by}` : ''}`
}

// The breakdown axis a widget result is grouped by ('channel' | 'client' |
// 'date'), read off the saved spec's groupBy token.
export function widgetGroupBy(widget) {
  const g = widget?.spec?.groupBy?.[0]
  return typeof g === 'string' ? g : 'channel'
}
