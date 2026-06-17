import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from '@/lib/api'
import { setToken, clearToken } from '@/lib/auth'
import {
  buildSpec, buildWidget, vizForGroupBy, defaultTitle, widgetGroupBy,
  reorderWidgets, buildDrillSpec, drillDimValue, drillTitle,
  GRID_COLS, normalizeLayout, hasLayout, resolveLayouts, applyLayouts,
  moveWidget, resizeWidget, appendWidget,
} from '@/lib/dashboards'

// ── api client: dashboards methods (path, method, auth header, body) ──────────
let calls
function stubFetch() {
  calls = []
  globalThis.fetch = vi.fn((url, opts) => {
    calls.push({ url, opts })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  })
}
beforeEach(() => { localStorage.clear(); stubFetch() })
afterEach(() => { vi.restoreAllMocks(); clearToken() })

describe('dashboards api client', () => {
  it('lists dashboards with a Bearer token', async () => {
    setToken('tok-1')
    await api.listDashboards()
    expect(calls[0].url).toBe('http://api.test/api/dashboards')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tok-1')
  })

  it('gets one dashboard by id', async () => {
    await api.getDashboard(42)
    expect(calls[0].url).toBe('http://api.test/api/dashboards/42')
  })

  it('creates a dashboard with a JSON body + content-type', async () => {
    setToken('tok-c')
    await api.createDashboard({ name: 'Board', widgets: [] })
    const { url, opts } = calls[0]
    expect(url).toBe('http://api.test/api/dashboards')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers.Authorization).toBe('Bearer tok-c')
    expect(JSON.parse(opts.body)).toEqual({ name: 'Board', widgets: [] })
  })

  it('updates a dashboard via PUT to its id', async () => {
    await api.updateDashboard(7, { name: 'Renamed' })
    const { url, opts } = calls[0]
    expect(url).toBe('http://api.test/api/dashboards/7')
    expect(opts.method).toBe('PUT')
    expect(JSON.parse(opts.body)).toEqual({ name: 'Renamed' })
  })

  it('deletes a dashboard via DELETE to its id', async () => {
    await api.deleteDashboard(9)
    expect(calls[0].url).toBe('http://api.test/api/dashboards/9')
    expect(calls[0].opts.method).toBe('DELETE')
  })

  it('runs a dashboard via POST to /:id/run with an empty body', async () => {
    await api.runDashboard(5)
    const { url, opts } = calls[0]
    expect(url).toBe('http://api.test/api/dashboards/5/run')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({})
  })
})

// ── pure widget/spec helpers ──────────────────────────────────────────────────
describe('widget spec helpers', () => {
  it('buildSpec assembles the POST /api/query shape', () => {
    const spec = buildSpec({ metrics: ['spend', 'leads'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31' })
    expect(spec).toEqual({
      metrics: ['spend', 'leads'],
      dateRange: { start: '2024-01-01', end: '2024-01-31' },
      groupBy: ['channel'],
    })
  })

  it('buildSpec adds a channel filter when channels are selected', () => {
    const spec = buildSpec({ metrics: ['spend'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31', channelFilter: ['google_ads'] })
    expect(spec.filters).toEqual([{ dim: 'channel', op: 'in', values: ['google_ads'] }])
  })

  it('buildSpec adds compareTo only when compare is on AND not a date grain', () => {
    expect(buildSpec({ metrics: ['spend'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31', compare: true }).compareTo).toBe('previous_period')
    expect(buildSpec({ metrics: ['spend'], groupBy: 'date:week', start: '2024-01-01', end: '2024-01-31', compare: true }).compareTo).toBeUndefined()
  })

  it('vizForGroupBy is area for date grains, bar otherwise', () => {
    expect(vizForGroupBy('date:day')).toBe('area')
    expect(vizForGroupBy('channel')).toBe('bar')
    expect(vizForGroupBy('client')).toBe('bar')
  })

  it('defaultTitle reads "<metrics> by <breakdown>" using labels when present', () => {
    expect(defaultTitle({ metrics: ['spend', 'leads'], groupBy: 'channel', metricLabels: { spend: 'Spend', leads: 'Leads' } }))
      .toBe('Spend, Leads by Channel')
    expect(defaultTitle({ metrics: ['roas'], groupBy: 'date:week' })).toBe('Roas by Week')
  })

  it('buildWidget produces a complete, distinct widget', () => {
    const w = buildWidget({ metrics: ['spend'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31', metricLabels: { spend: 'Spend' } })
    expect(w.id).toMatch(/^w-/)
    expect(w.title).toBe('Spend by Channel')
    expect(w.viz).toBe('bar')
    expect(w.spec.metrics).toEqual(['spend'])
    expect(widgetGroupBy(w)).toBe('channel')
  })

  it('buildWidget honours an explicit title', () => {
    const w = buildWidget({ metrics: ['spend'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31', title: '  My Widget ' })
    expect(w.title).toBe('My Widget')
  })
})

// ── in-app widget builder: append a built widget with a default placement ─────
describe('appendWidget', () => {
  const w = (id, layout) => ({ id, title: id, viz: 'bar', spec: { metrics: ['spend'], groupBy: ['channel'] }, ...(layout ? { layout } : {}) })

  it('appends WITHOUT a layout when the board is in linear mode (backward-compat)', () => {
    const before = [w('a'), w('b')]                       // no layouts → linear
    const widget = buildWidget({ metrics: ['leads'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31' })
    const after = appendWidget(before, widget)
    expect(after).toHaveLength(3)
    expect(after[2].layout).toBeUndefined()               // stays layout-free → linear flow
    expect(after[2].id).toBe(widget.id)
    expect(before).toHaveLength(2)                          // original untouched
    expect(hasLayout(after)).toBe(false)
  })

  it('places the new widget into the first free slot when the board is in grid mode', () => {
    // a occupies cols 0-1, b occupies cols 2-3 on row 0 → first free slot is row 1, col 0.
    const before = [w('a', { x: 0, y: 0, w: 2, h: 1 }), w('b', { x: 2, y: 0, w: 2, h: 1 })]
    const widget = buildWidget({ metrics: ['leads'], groupBy: 'channel', start: '2024-01-01', end: '2024-01-31' })
    const after = appendWidget(before, widget)
    expect(after).toHaveLength(3)
    const placed = after[2].layout
    expect(placed).toBeTruthy()
    expect(placed.y).toBe(1)                               // pushed below the full first row
    expect(placed.x).toBe(0)
    // The new tile never overlaps an existing one (resolveLayouts is the witness).
    expect(resolveLayouts(after).every((p) => p && p.layout)).toBe(true)
  })

  it('returns the list unchanged for a non-widget input', () => {
    const before = [w('a')]
    expect(appendWidget(before, null)).toBe(before)
    expect(appendWidget(undefined, w('x'))).toEqual([w('x')])
  })
})

// ── layout / reordering (drag-drop persists via PUT widgets array order) ──────
describe('reorderWidgets', () => {
  const ws = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('moves a widget to occupy the target slot, returning a new array', () => {
    const out = reorderWidgets(ws, 'a', 'c')
    expect(out.map((w) => w.id)).toEqual(['b', 'c', 'a'])
    expect(out).not.toBe(ws)       // new array
    expect(ws.map((w) => w.id)).toEqual(['a', 'b', 'c']) // original untouched
  })

  it('moves backward too', () => {
    expect(reorderWidgets(ws, 'c', 'a').map((w) => w.id)).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op (same array ref) for same id or unknown ids', () => {
    expect(reorderWidgets(ws, 'a', 'a')).toBe(ws)
    expect(reorderWidgets(ws, 'a', 'zzz')).toBe(ws)
    expect(reorderWidgets(ws, 'zzz', 'a')).toBe(ws)
    expect(reorderWidgets(null, 'a', 'b')).toBe(null)
  })
})

// ── free-form 2-D grid (reserved widgets[].layout {x,y,w,h}) ──────────────────
describe('layout normalization', () => {
  it('accepts a sane on-grid layout and returns a clean copy', () => {
    expect(normalizeLayout({ x: 0, y: 0, w: 2, h: 1 })).toEqual({ x: 0, y: 0, w: 2, h: 1 })
    expect(normalizeLayout({ x: 2, y: 3, w: 2, h: 2, extra: 'x' })).toEqual({ x: 2, y: 3, w: 2, h: 2 })
  })

  it('rejects missing / partial / non-integer / off-grid layouts as null', () => {
    expect(normalizeLayout(null)).toBe(null)
    expect(normalizeLayout({})).toBe(null)
    expect(normalizeLayout({ x: 0, y: 0, w: 2 })).toBe(null)        // missing h
    expect(normalizeLayout({ x: 0, y: 0, w: 0, h: 1 })).toBe(null)  // w < 1
    expect(normalizeLayout({ x: -1, y: 0, w: 1, h: 1 })).toBe(null) // negative x
    expect(normalizeLayout({ x: 0.5, y: 0, w: 1, h: 1 })).toBe(null) // non-integer
    expect(normalizeLayout({ x: 3, y: 0, w: 2, h: 1 })).toBe(null)  // x+w > GRID_COLS (4)
  })
})

describe('hasLayout / backward-compat fallback', () => {
  it('reports no layout when no widget carries a valid one (→ linear mode)', () => {
    expect(hasLayout([{ id: 'a' }, { id: 'b' }])).toBe(false)
    expect(hasLayout([{ id: 'a', layout: { x: 9 } }])).toBe(false) // invalid → still none
    expect(hasLayout([])).toBe(false)
  })

  it('reports a layout once any widget carries a valid one', () => {
    expect(hasLayout([{ id: 'a' }, { id: 'b', layout: { x: 0, y: 0, w: 2, h: 1 } }])).toBe(true)
  })
})

describe('resolveLayouts', () => {
  it('lays out a NO-layout dashboard in linear order (left→right, top→bottom)', () => {
    const out = resolveLayouts([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(out.map((p) => p.widget.id)).toEqual(['a', 'b', 'c']) // input order preserved
    expect(out[0].layout).toEqual({ x: 0, y: 0, w: 2, h: 1 })
    expect(out[1].layout).toEqual({ x: 2, y: 0, w: 2, h: 1 })
    expect(out[2].layout).toEqual({ x: 0, y: 1, w: 2, h: 1 }) // wraps to next row
  })

  it('honours valid explicit layouts and back-fills the rest into free slots', () => {
    const out = resolveLayouts([
      { id: 'a', layout: { x: 0, y: 0, w: 4, h: 1 } }, // full width row 0
      { id: 'b' },                                     // no layout → row 1
    ])
    expect(out[0].layout).toEqual({ x: 0, y: 0, w: 4, h: 1 })
    expect(out[1].layout.y).toBe(1) // pushed below the full-width tile
  })

  it('never overlaps: an explicit clash is reflowed to a free slot', () => {
    const out = resolveLayouts([
      { id: 'a', layout: { x: 0, y: 0, w: 2, h: 1 } },
      { id: 'b', layout: { x: 0, y: 0, w: 2, h: 1 } }, // same cell as a
    ])
    const cells = out.map((p) => `${p.layout.x},${p.layout.y}`)
    expect(new Set(cells).size).toBe(2) // distinct placements
  })

  it('preserves input order in the returned array', () => {
    const out = resolveLayouts([
      { id: 'a', layout: { x: 2, y: 0, w: 2, h: 1 } },
      { id: 'b', layout: { x: 0, y: 0, w: 2, h: 1 } },
    ])
    expect(out.map((p) => p.widget.id)).toEqual(['a', 'b'])
  })
})

describe('applyLayouts', () => {
  it('stamps an explicit {x,y,w,h} onto every widget, keeping id/spec', () => {
    const out = applyLayouts([{ id: 'a', spec: { metrics: ['spend'] } }, { id: 'b' }])
    expect(out[0]).toMatchObject({ id: 'a', spec: { metrics: ['spend'] } })
    expect(normalizeLayout(out[0].layout)).toEqual(out[0].layout)
    expect(out.every((w) => normalizeLayout(w.layout))).toBe(true)
  })
})

describe('moveWidget', () => {
  const ws = [
    { id: 'a', layout: { x: 0, y: 0, w: 2, h: 1 } },
    { id: 'b', layout: { x: 2, y: 0, w: 2, h: 1 } },
  ]
  it('moves a tile to a new cell and keeps the persisted (spec) order', () => {
    const out = moveWidget(ws, 'a', 2, 1)
    expect(out.map((w) => w.id)).toEqual(['a', 'b']) // order unchanged
    expect(out.find((w) => w.id === 'a').layout).toMatchObject({ x: 2, y: 1, w: 2, h: 1 })
  })
  it('clamps x within the grid (cannot place a w=2 tile at x=3)', () => {
    const out = moveWidget(ws, 'a', 99, 0)
    expect(out.find((w) => w.id === 'a').layout.x).toBe(GRID_COLS - 2)
  })
  it('reflows so no two tiles overlap after a move onto an occupied cell', () => {
    const out = moveWidget(ws, 'a', 2, 0) // onto b's cell
    const cells = out.map((w) => `${w.layout.x},${w.layout.y}`)
    expect(new Set(cells).size).toBe(2)
  })
  it('is a no-op (original ref) for an unknown id or unchanged position', () => {
    expect(moveWidget(ws, 'zzz', 0, 0)).toBe(ws)
    expect(moveWidget(ws, 'a', 0, 0)).toBe(ws)
    expect(moveWidget(null, 'a', 0, 0)).toBe(null)
  })
})

describe('resizeWidget', () => {
  const ws = [
    { id: 'a', layout: { x: 0, y: 0, w: 2, h: 1 } },
    { id: 'b', layout: { x: 2, y: 0, w: 2, h: 1 } },
  ]
  it('resizes a tile, clamping w to 1..GRID_COLS', () => {
    expect(resizeWidget(ws, 'a', 4, 2).find((w) => w.id === 'a').layout).toMatchObject({ w: 4, h: 2 })
    expect(resizeWidget(ws, 'a', 99, 1).find((w) => w.id === 'a').layout.w).toBe(GRID_COLS)
    expect(resizeWidget(ws, 'a', 0, 1).find((w) => w.id === 'a').layout.w).toBe(1)
  })
  it('pulls x left so a widened tile stays on-grid', () => {
    const out = resizeWidget(ws, 'b', 4, 1) // b is at x=2; widening to 4 must shift to x=0
    expect(out.find((w) => w.id === 'b').layout.x).toBe(0)
  })
  it('is a no-op for an unknown id or unchanged size', () => {
    expect(resizeWidget(ws, 'zzz', 2, 2)).toBe(ws)
    expect(resizeWidget(ws, 'a', 2, 1)).toBe(ws)
  })
})

// ── drill-down (click a tile row → grounded POST /api/query detail) ───────────
describe('drill-down spec builder', () => {
  const channelWidget = { id: 'w1', spec: { metrics: ['spend', 'leads'], dateRange: { start: '2024-01-01', end: '2024-01-31' }, groupBy: ['channel'] } }
  const clientWidget  = { id: 'w2', spec: { metrics: ['roas'], dateRange: { start: '2024-01-01', end: '2024-01-31' }, groupBy: ['client'] } }
  const dateWidget    = { id: 'w3', spec: { metrics: ['spend'], dateRange: { start: '2024-01-01', end: '2024-01-31' }, groupBy: ['date:week'] } }

  it('reads the clicked dim value off a row', () => {
    expect(drillDimValue(channelWidget, { channel: 'google_ads' })).toBe('google_ads')
    expect(drillDimValue(clientWidget,  { client: 'c-7' })).toBe('c-7')
    expect(drillDimValue(dateWidget,    { date: '2024-01-08' })).toBe('2024-01-08')
    expect(drillDimValue(channelWidget, {})).toBe(null)
  })

  it('drills a channel row into that channel\'s weekly trend (carrying metrics + range)', () => {
    const spec = buildDrillSpec(channelWidget, { channel: 'google_ads', spend: 100 })
    expect(spec).toEqual({
      metrics: ['spend', 'leads'],
      dateRange: { start: '2024-01-01', end: '2024-01-31' },
      groupBy: ['date:week'],
      filters: [{ dim: 'channel', op: 'in', values: ['google_ads'] }],
    })
  })

  it('drills a client row into that client\'s weekly trend', () => {
    const spec = buildDrillSpec(clientWidget, { client: 'c-7' })
    expect(spec.groupBy).toEqual(['date:week'])
    expect(spec.filters).toEqual([{ dim: 'client', op: 'in', values: ['c-7'] }])
  })

  it('drills a date row sideways into a channel breakdown', () => {
    const spec = buildDrillSpec(dateWidget, { date: '2024-01-08' })
    expect(spec.groupBy).toEqual(['channel'])
  })

  it('carries forward the widget\'s own non-drill filters', () => {
    const w = { id: 'w', spec: { metrics: ['spend'], dateRange: { start: '2024-01-01', end: '2024-01-31' }, groupBy: ['channel'], filters: [{ dim: 'channel', op: 'in', values: ['x'] }] } }
    // the existing same-dim (channel) filter is replaced by the clicked one
    const spec = buildDrillSpec(w, { channel: 'meta' })
    expect(spec.filters).toEqual([{ dim: 'channel', op: 'in', values: ['meta'] }])
  })

  it('returns null when there is nothing to drill into', () => {
    expect(buildDrillSpec(channelWidget, {})).toBe(null)
    expect(buildDrillSpec({ id: 'x', spec: { metrics: [] } }, { channel: 'g' })).toBe(null)
    expect(buildDrillSpec(null, { channel: 'g' })).toBe(null)
  })

  it('drillTitle labels the drilled slice', () => {
    expect(drillTitle(channelWidget, { channel: 'google_ads' }, (k) => k === 'google_ads' ? 'Google Ads' : k)).toBe('Google Ads over time')
    expect(drillTitle(clientWidget, { client: 'c-7', client_name: 'Acme' })).toBe('Acme over time')
    expect(drillTitle(dateWidget, { date: '2024-01-08' })).toBe('Channel breakdown')
  })
})
