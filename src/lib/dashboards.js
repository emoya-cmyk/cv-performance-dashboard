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

// ── free-form 2-D grid (Phase 3 — reserved widgets[].layout {x,y,w,h}) ───────
// A widget MAY carry a `layout` { x, y, w, h } placing it on a fixed-column grid
// (x/w in columns, y/h in row units). Phase-3 RESERVED this field; until a tile
// is moved/resized a dashboard has NO layouts and renders in the existing linear
// order. Everything below is pure (no React, no network) so the drag/resize UI
// stays dumb and the rules are unit-testable. The whole layout is persisted as
// part of the widgets array through the SAME tenant-guarded PUT /api/dashboards/:id.

export const GRID_COLS = 4   // tiles span 1..GRID_COLS columns
const DEFAULT_W = 2          // a freshly-laid-out tile is half-width, one row tall
const DEFAULT_H = 1

// True when a value is a finite, non-negative integer (grid coordinates are ints).
function isCoord(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Math.floor(n) === n }

// A layout is valid only if x/y/w/h are all sane integers, w≥1, and the tile fits
// within GRID_COLS. Anything else (missing, partial, off-grid) is treated as "no
// layout" so a malformed blob can never break the render — it just falls back to
// linear order. Returns a normalized {x,y,w,h} or null.
export function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object') return null
  const { x, y, w, h } = layout
  if (![x, y, w, h].every(isCoord)) return null
  if (w < 1 || h < 1) return null
  if (x + w > GRID_COLS) return null
  return { x, y, w, h }
}

// Does a widget array carry ANY usable layout? (Determines linear vs. grid mode.)
export function hasLayout(widgets) {
  return Array.isArray(widgets) && widgets.some((w) => normalizeLayout(w && w.layout))
}

// Resolve every widget to a concrete {x,y,w,h} for rendering. BACKWARD-COMPAT:
// a dashboard with NO layouts at all keeps the existing linear flow — tiles get
// sequential default placements that read identically to today's grid (left→right,
// top→bottom, DEFAULT_W wide). A dashboard that already has layouts keeps each
// valid one and back-fills any missing/invalid widget into the first free slot,
// so a newly-added (Explore "Save as widget") tile always lands somewhere visible.
// Returns [{ widget, layout:{x,y,w,h} }] in the input order.
export function resolveLayouts(widgets, cols = GRID_COLS) {
  const list = Array.isArray(widgets) ? widgets : []
  const placed = []
  const taken = [] // taken[y] = bitmask of occupied columns in row y

  const fits = (x, y, w, h) => {
    if (x < 0 || x + w > cols) return false
    for (let r = y; r < y + h; r++) {
      const mask = taken[r] || 0
      for (let c = x; c < x + w; c++) if (mask & (1 << c)) return false
    }
    return true
  }
  const occupy = (x, y, w, h) => {
    for (let r = y; r < y + h; r++) {
      let mask = taken[r] || 0
      for (let c = x; c < x + w; c++) mask |= (1 << c)
      taken[r] = mask
    }
  }
  const firstFree = (w, h) => {
    for (let y = 0; ; y++) {
      for (let x = 0; x + w <= cols; x++) if (fits(x, y, w, h)) return { x, y }
    }
  }

  // Pass 1: honour widgets that already carry a valid, non-overlapping layout.
  const deferred = []
  for (const widget of list) {
    const lay = normalizeLayout(widget && widget.layout)
    if (lay && lay.x + lay.w <= cols && fits(lay.x, lay.y, lay.w, lay.h)) {
      occupy(lay.x, lay.y, lay.w, lay.h)
      placed.push({ widget, layout: lay })
    } else {
      deferred.push({ widget, lay })
    }
  }
  // Pass 2: place the rest (no layout, or an overlapping/off-grid one) into the
  // first free slot — keeping each tile's own size when it had a valid one.
  for (const { widget, lay } of deferred) {
    const w = lay ? lay.w : DEFAULT_W
    const h = lay ? lay.h : DEFAULT_H
    const { x, y } = firstFree(w, h)
    occupy(x, y, w, h)
    placed.push({ widget, layout: { x, y, w, h } })
  }
  // Restore input order (placed/deferred interleave above).
  const byWidget = new Map(placed.map((p) => [p.widget, p]))
  return list.map((widget) => byWidget.get(widget))
}

// Stamp the resolved layout back onto each widget so the WHOLE arrangement can be
// persisted via PUT. Used the first time a linear dashboard is rearranged (every
// tile gets an explicit {x,y,w,h}) and after each move/resize. Returns a new
// widgets array; widgets keep their id/title/viz/spec untouched.
export function applyLayouts(widgets) {
  return resolveLayouts(widgets).map(({ widget, layout }) => ({ ...widget, layout }))
}

// Move the widget `id` so its top-left lands at (x,y), then re-resolve so any
// tile it now overlaps is pushed to a free slot (no two tiles share a cell). The
// moved tile keeps its size; x is clamped into the grid. Returns a new widgets
// array with explicit layouts on every tile, or the original ref on a no-op.
export function moveWidget(widgets, id, x, y) {
  if (!Array.isArray(widgets)) return widgets
  const resolved = applyLayouts(widgets)
  const idx = resolved.findIndex((w) => w && w.id === id)
  if (idx < 0) return widgets
  const cur = resolved[idx].layout
  const nx = Math.max(0, Math.min(x, GRID_COLS - cur.w))
  const ny = Math.max(0, y)
  if (nx === cur.x && ny === cur.y) return widgets
  // Put the moved tile FIRST so resolveLayouts honours its new spot and reflows
  // the others around it.
  const moved = { ...resolved[idx], layout: { ...cur, x: nx, y: ny } }
  const rest = resolved.filter((_, i) => i !== idx)
  const reflowed = applyLayouts([moved, ...rest])
  // Return in the ORIGINAL widget order (persisted order is the spec order; only
  // layout coordinates move).
  const byId = new Map(reflowed.map((w) => [w.id, w]))
  return resolved.map((w) => byId.get(w.id) || w)
}

// Resize the widget `id` to (w,h) columns/rows, clamped to 1..GRID_COLS and kept
// on-grid (x pulled left if the wider tile would overflow), then reflow overlaps.
// Returns a new widgets array with explicit layouts, or the original on a no-op.
export function resizeWidget(widgets, id, w, h) {
  if (!Array.isArray(widgets)) return widgets
  const resolved = applyLayouts(widgets)
  const idx = resolved.findIndex((ww) => ww && ww.id === id)
  if (idx < 0) return widgets
  const cur = resolved[idx].layout
  const nw = Math.max(1, Math.min(Math.round(w), GRID_COLS))
  const nh = Math.max(1, Math.round(h))
  const nx = Math.min(cur.x, GRID_COLS - nw)
  if (nw === cur.w && nh === cur.h && nx === cur.x) return widgets
  const resized = { ...resolved[idx], layout: { x: nx, y: cur.y, w: nw, h: nh } }
  const rest = resolved.filter((_, i) => i !== idx)
  const reflowed = applyLayouts([resized, ...rest])
  const byId = new Map(reflowed.map((ww) => [ww.id, ww]))
  return resolved.map((ww) => byId.get(ww.id) || ww)
}

// Append a freshly-built widget to a dashboard's widgets array, giving it a
// sensible default placement. BACKWARD-COMPAT: if the dashboard has NO layouts
// yet (linear mode), the new tile is appended WITHOUT a layout so the board stays
// in linear flow exactly as before (resolveLayouts lays it out sequentially). If
// the dashboard is ALREADY in grid mode (some tile carries a layout), we stamp the
// new tile into the first free slot (reusing the same firstFree placement the grid
// uses) so it lands somewhere visible rather than overlapping. Pure (no React, no
// network); the caller persists the returned array via the tenant-guarded PUT.
export function appendWidget(widgets, widget) {
  const list = Array.isArray(widgets) ? widgets : []
  if (!widget || typeof widget !== 'object') return list
  if (!hasLayout(list)) return [...list, widget]
  // Grid mode: resolve current placements, find the first free slot for a
  // default-sized tile, and stamp it onto the new widget.
  const resolved = resolveLayouts([...list, { ...widget, layout: undefined }])
  const placed = resolved[resolved.length - 1]
  return [...list, { ...widget, layout: placed.layout }]
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
