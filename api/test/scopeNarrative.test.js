'use strict'

// intel-v13 C3 (step b) — the on-demand scope→narrative adapter. Two layers:
//   1. PURE spec-builder / shaping helpers — leak-safety + contract locks that
//      need no DB (drivers ALWAYS by channel, client-dim filters dropped,
//      tenancy from scope only, label by channel name never a raw id).
//   2. INTEGRATION — runScopeInsight() driven through the REAL semantic compiler
//      (runQuerySpec) with a fake `query` returning canned fact_metric rows, so
//      we prove current/previous/drivers map correctly end-to-end with no HTTP/DB.

const { test } = require('node:test')
const assert = require('node:assert')

const {
  runScopeInsight,
  SCOPE_METRICS,
  MAX_CHANNELS,
  pickMetrics,
  clientsForScope,
  channelFiltersFrom,
  buildTotalsSpec,
  buildChannelDriversSpec,
  windowLabelFrom,
  compareLabelFrom,
  pickMetricValues,
  driversFromChannelRows,
} = require('../lib/scopeNarrative')

const EN = '–' // en-dash, the range glyph windowLabelFrom emits

// ──────────────────────────────────────────────────────────────────────────
// Layer 1 — pure contract + leak-safety
// ──────────────────────────────────────────────────────────────────────────

test('SCOPE_METRICS is the six-KPI allow-list, in order', () => {
  assert.deepStrictEqual(SCOPE_METRICS, ['revenue', 'leads', 'spend', 'roas', 'cpl', 'close_rate'])
  assert.strictEqual(MAX_CHANNELS, 12)
})

test('pickMetrics: empty/garbage → full set; drops unknown; preserves SCOPE order; dedups', () => {
  assert.deepStrictEqual(pickMetrics(undefined), SCOPE_METRICS)
  assert.deepStrictEqual(pickMetrics([]), SCOPE_METRICS)
  // `jobs` is in ask.js but NOT a queryable registry metric → must be dropped.
  assert.deepStrictEqual(pickMetrics(['jobs', 'revenue', 'leads']), ['revenue', 'leads'])
  // request order is ignored — SCOPE_METRICS order wins (stable narration order).
  assert.deepStrictEqual(pickMetrics(['leads', 'revenue']), ['revenue', 'leads'])
  // all-unknown → fall back to the full set rather than an empty narration.
  assert.deepStrictEqual(pickMetrics(['jobs', 'bogus']), SCOPE_METRICS)
  // de-dupe.
  assert.deepStrictEqual(pickMetrics(['revenue', 'revenue']), ['revenue'])
})

test('clientsForScope: tenancy comes only from the resolved scope', () => {
  assert.strictEqual(clientsForScope(null), 'all')
  assert.strictEqual(clientsForScope(undefined), 'all')
  assert.deepStrictEqual(clientsForScope('7'), ['7'])
  assert.deepStrictEqual(clientsForScope(7), ['7']) // coerced to string id
})

test('channelFiltersFrom: keeps channel filters, DROPS client-dim filters (leak invariant)', () => {
  const out = channelFiltersFrom([
    { dim: 'client', op: 'in', values: ['999'] }, // must be dropped — would narrow into a tenant
    { dim: 'channel', op: 'in', values: ['google_ads', 'meta'] },
    { dim: 'channel', values: ['lsa'] },          // op omitted → defaulted, kept
    { dim: 'channel', values: [] },               // empty values → dropped
    'nonsense',                                   // junk → dropped
  ])
  assert.deepStrictEqual(out, [
    { dim: 'channel', op: 'in', values: ['google_ads', 'meta'] },
    { dim: 'channel', op: 'in', values: ['lsa'] },
  ])
  assert.deepStrictEqual(channelFiltersFrom(null), [])
  assert.deepStrictEqual(channelFiltersFrom('x'), [])
})

test('buildChannelDriversSpec: drivers are ALWAYS by channel, NEVER by client', () => {
  const spec = buildChannelDriversSpec({
    metrics: SCOPE_METRICS, dateRange: { start: '2026-05-01', end: '2026-05-31' },
    clients: ['7'], channelFilters: [], compareTo: 'previous_period',
  })
  assert.deepStrictEqual(spec.groupBy, ['channel'])
  assert.ok(!spec.groupBy.includes('client'), 'driver groupBy must never include client')
  assert.strictEqual(spec.limit, MAX_CHANNELS)
})

test('build*Spec: clients key present only when scoped to a client; omitted for portfolio', () => {
  const base = {
    metrics: SCOPE_METRICS, dateRange: { start: '2026-05-01', end: '2026-05-31' },
    channelFilters: [{ dim: 'channel', op: 'in', values: ['google_ads'] }], compareTo: 'previous_period',
  }
  const agency = buildTotalsSpec({ ...base, clients: 'all' })
  assert.ok(!('clients' in agency), 'portfolio spec must omit clients → compiler defaults to all')
  assert.deepStrictEqual(agency.groupBy, [])
  assert.deepStrictEqual(agency.filters, base.channelFilters)

  const scoped = buildTotalsSpec({ ...base, clients: ['7'] })
  assert.deepStrictEqual(scoped.clients, ['7'])
})

test('windowLabelFrom: single day / same month / same year / cross year', () => {
  assert.strictEqual(windowLabelFrom({ start: '2026-05-01', end: '2026-05-01' }), 'May 1, 2026')
  assert.strictEqual(windowLabelFrom({ start: '2026-05-01', end: '2026-05-31' }), `May 1${EN}31, 2026`)
  assert.strictEqual(windowLabelFrom({ start: '2026-05-01', end: '2026-06-15' }), `May 1 ${EN} Jun 15, 2026`)
  assert.strictEqual(windowLabelFrom({ start: '2025-12-20', end: '2026-01-05' }), `Dec 20, 2025 ${EN} Jan 5, 2026`)
  assert.strictEqual(windowLabelFrom(null), null)
  assert.strictEqual(windowLabelFrom({ start: '2026-05-01' }), null)
})

test('compareLabelFrom: always carries the literal "vs " prefix, null when no compare window', () => {
  assert.strictEqual(compareLabelFrom('previous_period', { start: '2026-04-01', end: '2026-04-30' }), 'vs the prior period')
  assert.strictEqual(compareLabelFrom('previous_year', { start: '2025-05-01', end: '2025-05-31' }), 'vs the same period last year')
  assert.strictEqual(compareLabelFrom({ start: '2026-03-01', end: '2026-03-31' }, { start: '2026-03-01', end: '2026-03-31' }), `vs Mar 1${EN}31, 2026`)
  assert.strictEqual(compareLabelFrom('previous_period', null), null)
  // every non-null label MUST be spliceable verbatim after a clause.
  for (const lbl of [
    compareLabelFrom('previous_period', { start: '2026-04-01', end: '2026-04-30' }),
    compareLabelFrom('previous_year', { start: '2025-05-01', end: '2025-05-31' }),
    compareLabelFrom({ start: '2026-03-01', end: '2026-03-31' }, { start: '2026-03-01', end: '2026-03-31' }),
  ]) {
    assert.ok(lbl.startsWith('vs '), `compare label must start with "vs ": ${lbl}`)
  }
})

test('pickMetricValues: only scoped, finite numbers survive', () => {
  const out = pickMetricValues({ revenue: 100, leads: 'x', spend: null, roas: 0, extra: 9 }, SCOPE_METRICS)
  assert.deepStrictEqual(out, { revenue: 100, roas: 0 }) // leads non-numeric, spend null, extra out-of-scope
  assert.deepStrictEqual(pickMetricValues(null, SCOPE_METRICS), {})
})

test('driversFromChannelRows: labels by CHANNEL name, never a raw id or client id', () => {
  const drivers = driversFromChannelRows([
    { channel: 'google_ads', revenue: 8000, _compare: { revenue: 6000 } },
    { channel: 'meta', revenue: 2000, _compare: { revenue: 2000 } },
    { channel: 'totally_unknown', revenue: 5 }, // unknown key → string fallback, never a throw
    { revenue: 1 },                              // no channel → skipped
  ], ['revenue'])
  assert.strictEqual(drivers.dim, 'channel')
  assert.deepStrictEqual(drivers.rows.map(r => r.label), ['Google Ads', 'Meta Ads', 'totally_unknown'])
  // a human channel label, NOT the registry id — the anti-leak labelling contract.
  assert.ok(!drivers.rows.some(r => r.label === 'google_ads'))
  assert.strictEqual(drivers.rows[0].current.revenue, 8000)
  assert.strictEqual(drivers.rows[0].previous.revenue, 6000)
  assert.strictEqual(driversFromChannelRows([], ['revenue']), null)
  assert.strictEqual(driversFromChannelRows(null, ['revenue']), null)
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2 — integration through the REAL compiler with a fake query
// ──────────────────────────────────────────────────────────────────────────

// Canned fact_metric grain rows: {client_id, channel_id, date, metric_key, sum_v, avg_v}.
// channel_id 1 = google_ads, 2 = meta. metric_key === public id for every base metric,
// so these feed totals (groupBy:[]) AND channel drivers (groupBy:['channel']) AND the
// ratio metrics (roas/cpl/close_rate, computed post-aggregation from their num/den keys).
function rawRows(channelId, date, kv) {
  return Object.entries(kv).map(([metric_key, sum_v]) => ({
    client_id: '7', channel_id: channelId, date, metric_key, sum_v, avg_v: null,
  }))
}
const CURRENT_RAW = [
  ...rawRows(1, '2026-05-15', { revenue: 8000, spend: 2000, leads: 100, closed_won: 20, raw_leads: 200 }),
  ...rawRows(2, '2026-05-15', { revenue: 2000, spend: 1000, leads: 50, closed_won: 5, raw_leads: 100 }),
]
const PREVIOUS_RAW = [
  ...rawRows(1, '2026-04-15', { revenue: 6000, spend: 2000, leads: 120, closed_won: 15, raw_leads: 240 }),
  ...rawRows(2, '2026-04-15', { revenue: 2000, spend: 1000, leads: 60, closed_won: 5, raw_leads: 120 }),
]
// Totals — current: rev 10000 / spend 3000 / leads 150 ; previous: rev 8000 / spend 3000 / leads 180.
// So revenue +25% (favorable), leads −16.7% (adverse→warning), spend flat (steady).

// The fake `query` branches by WINDOW only (the current window's start date appears in
// params for the current call, not the compare call) — totals and channel specs share
// identical SQL+params per window, so one fixture per window serves both projections.
function fakeQuery(current, previous) {
  return async (_sql, params) => ({ rows: params.includes('2026-05-01') ? current : previous })
}
const INPUT = { dateRange: { start: '2026-05-01', end: '2026-05-31' } } // metrics + compareTo defaulted

test('integration: client scope narrates current vs previous with channel drivers', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })

  // tenancy + echoed scope come from the resolved scope, not the body.
  assert.deepStrictEqual(result.scope_applied.clients, ['7'])
  assert.deepStrictEqual(result.scope_applied.metrics, SCOPE_METRICS)
  assert.deepStrictEqual(result.window, { start: '2026-05-01', end: '2026-05-31' })
  assert.strictEqual(result.compare_window.end, '2026-04-30') // prevEnd = day before window start

  // revenue rose 8000 → 10000, attributed to the bigger-moving channel by its LABEL.
  const rev = result.findings.find(f => f.metric === 'revenue')
  assert.ok(rev, 'expected a revenue finding')
  assert.strictEqual(rev.evidence.current, 10000)
  assert.strictEqual(rev.evidence.previous, 8000)
  assert.strictEqual(rev.direction, 'up')
  assert.strictEqual(rev.improved, true)
  assert.strictEqual(rev.driver.label, 'Google Ads') // channel name, never 'google_ads' / a client id

  // leads fell 180 → 150 → adverse warning, driver also by channel label.
  const leads = result.findings.find(f => f.metric === 'leads')
  assert.strictEqual(leads.evidence.current, 150)
  assert.strictEqual(leads.evidence.previous, 180)
  assert.strictEqual(leads.direction, 'down')
  assert.strictEqual(leads.severity, 'warning')
  assert.strictEqual(leads.driver.label, 'Google Ads')

  // spend held flat → folded into "steady", not a card.
  assert.strictEqual(result.findings.find(f => f.metric === 'spend'), undefined)
  assert.strictEqual(result.meta.steady, 1)
  assert.strictEqual(result.meta.with_compare, 6)
  assert.strictEqual(result.meta.metrics_considered, 6)

  // headline is scoped to the resolved window + carries the compare voice.
  assert.ok(result.headline.startsWith(`For May 1${EN}31, 2026,`), result.headline)
  assert.ok(result.headline.includes('vs the prior period'))
  assert.ok(result.headline.includes('(1 held steady)'))

  // no driver row is ever labelled by a raw channel id or the client id.
  for (const f of result.findings) {
    if (f.driver) {
      assert.notStrictEqual(f.driver.label, 'google_ads')
      assert.notStrictEqual(f.driver.label, '7')
    }
  }
})

test('integration: agency (portfolio) scope → clients "all"', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: null, role: 'agency' })
  assert.strictEqual(result.scope_applied.clients, 'all')
  assert.strictEqual(result.scope_applied.role, 'agency')
  assert.strictEqual(result.findings.find(f => f.metric === 'revenue').evidence.current, 10000)
})

test('integration: a client-dim filter in the body can NEITHER narrow NOR break scope', async () => {
  // An agency caller; body tries to slip in a client filter for tenant 999. It must be
  // dropped before the spec is built — scope stays the whole portfolio, narration still works.
  const result = await runScopeInsight(
    { ...INPUT, filters: [{ dim: 'client', op: 'in', values: ['999'] }] },
    fakeQuery(CURRENT_RAW, PREVIOUS_RAW),
    { scopeClientId: null, role: 'agency' })
  assert.strictEqual(result.scope_applied.clients, 'all') // NOT narrowed to ['999']
  assert.strictEqual(result.findings.find(f => f.metric === 'revenue').evidence.current, 10000)
})

test('integration: empty scope → honest "No data in scope" headline, no findings', async () => {
  const emptyQuery = async () => ({ rows: [] })
  const result = await runScopeInsight(INPUT, emptyQuery, { scopeClientId: '7', role: 'client' })
  assert.match(result.headline, /^No data in scope for /)
  assert.strictEqual(result.findings.length, 0)
  assert.strictEqual(result.meta.metrics_considered, 0)
  assert.deepStrictEqual(result.scope_applied.clients, ['7'])
})
