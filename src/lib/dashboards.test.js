import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from '@/lib/api'
import { setToken, clearToken } from '@/lib/auth'
import {
  buildSpec, buildWidget, vizForGroupBy, defaultTitle, widgetGroupBy,
  reorderWidgets, buildDrillSpec, drillDimValue, drillTitle,
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
