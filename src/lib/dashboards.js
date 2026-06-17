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

// ── layout / reordering (Phase 3 — persisted tile arrangement) ───────────────
// Drag-drop reorders the widget array; widget array order IS the layout (the
// renderer and POST /:id/run both walk widgets in array order). reorderWidgets
// returns a NEW array with the dragged widget moved to occupy `toId`'s slot —
// pure and id-based so it's unit-testable and the drag UI can stay dumb. A no-op
// (same id, or an unknown id) returns the original array unchanged.
export function reorderWidgets(widgets, fromId, toId) {
  if (!Array.isArray(widgets) || fromId === toId) return widgets
  const from = widgets.findIndex((w) => w && w.id === fromId)
  const to   = widgets.findIndex((w) => w && w.id === toId)
  if (from < 0 || to < 0) return widgets
  const next = widgets.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

// ── drill-down (Phase 3 — click a tile → grounded detail) ────────────────────
// Read the breakdown value off a result row for the widget's group-by axis. For
// a categorical widget this is the channel/client the clicked bar/row represents
// ('google_ads', a client id); for a date widget it's the bucket's date.
export function drillDimValue(widget, row) {
  if (!row) return null
  const g = widgetGroupBy(widget)
  if (g === 'channel') return row.channel ?? null
  if (g === 'client')  return row.client ?? row.client_id ?? null
  return row.date ?? null // date grain
}

// Build a POST /api/query spec that drills INTO the clicked category: keep the
// widget's metrics + dateRange, pin the clicked categorical value as a filter,
// and re-group by a weekly time series so the detail view shows that slice's
// trend over the same window. (A date-grouped widget instead drills sideways to
// a channel breakdown for the whole window.) Returns null when there's nothing
// meaningful to drill into. The spec is run through the SAME tenant-clamped
// POST /api/query — every figure stays grounded and can't widen tenant scope.
export function buildDrillSpec(widget, row) {
  const spec = widget?.spec
  if (!spec || !Array.isArray(spec.metrics) || !spec.metrics.length) return null
  const g = widgetGroupBy(widget)
  const value = drillDimValue(widget, row)
  if (value == null || value === '') return null

  const base = {
    metrics: [...spec.metrics],
    ...(spec.dateRange ? { dateRange: { ...spec.dateRange } } : {}),
  }
  // Carry forward the widget's own non-drill filters (e.g. a saved channel scope)
  // so the detail view stays consistent with the tile, then add the clicked dim.
  const carried = Array.isArray(spec.filters)
    ? spec.filters.filter((f) => f && f.dim !== g && f.dim !== 'client')
    : []

  if (g === 'channel') {
    return { ...base, groupBy: ['date:week'], filters: [...carried, { dim: 'channel', op: 'in', values: [value] }] }
  }
  if (g === 'client') {
    // A client breakdown drills into that client's weekly trend. (A client token
    // is already tenant-pinned server-side; this filter is dropped for them and
    // re-applied by the clamp, so it only narrows for an agency viewer.)
    return { ...base, groupBy: ['date:week'], filters: [...carried, { dim: 'client', op: 'in', values: [value] }] }
  }
  // date grain → sideways into a channel breakdown for the same window.
  return { ...base, groupBy: ['channel'], filters: carried }
}

// A human label for the drilled-into slice, shown in the detail panel header.
export function drillTitle(widget, row, channelLabel) {
  const g = widgetGroupBy(widget)
  const value = drillDimValue(widget, row)
  if (g === 'channel') return `${(channelLabel && channelLabel(value)) || value} over time`
  if (g === 'client')  return `${row?.client_name || value} over time`
  return 'Channel breakdown'
}
