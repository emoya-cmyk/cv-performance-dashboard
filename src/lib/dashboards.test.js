import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from '@/lib/api'
import { setToken, clearToken } from '@/lib/auth'
import { buildSpec, buildWidget, vizForGroupBy, defaultTitle, widgetGroupBy } from '@/lib/dashboards'

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
