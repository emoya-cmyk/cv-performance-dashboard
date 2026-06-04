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

// ──────────────────────────────────────────────────────────────────────────
// Layer 2b — intel-v14 D1: the optional "since you last looked" delta block.
// Proves the WIRING (runScopeInsight reads body.since, attaches a delta computed
// from the REAL narration); the diff semantics themselves are owned by
// scopeDelta.test.js. The diff is additive — absent `since`, the envelope is
// byte-identical to every pre-D1 caller.
// ──────────────────────────────────────────────────────────────────────────

// "Fresh data lands" for the SAME scope: google_ads revenue 8000 → 10400, so the
// scope total moves 10000 → 12400. Everything else is identical to CURRENT_RAW, so
// only revenue (and the revenue-derived roas) move between the two reads.
const NEXT_RAW = [
  ...rawRows(1, '2026-05-15', { revenue: 10400, spend: 2000, leads: 100, closed_won: 20, raw_leads: 200 }),
  ...rawRows(2, '2026-05-15', { revenue: 2000, spend: 1000, leads: 50, closed_won: 5, raw_leads: 100 }),
]

test('intel-v14 D1: omitting `since` ⇒ NO delta key (additive, byte-identical envelope)', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('delta' in result, false)
})

test('intel-v14 D1: `since:[]` ⇒ baseline delta (the panel had nothing to diff yet)', async () => {
  const result = await runScopeInsight({ ...INPUT, since: [] }, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.ok(result.delta, 'delta present when since is supplied')
  assert.strictEqual(result.delta.status, 'baseline')
  assert.strictEqual(result.delta.headline, null)
  assert.deepStrictEqual(result.delta.changes, [])
})

test('intel-v14 D1: a real cross-read move surfaces as a `delta` ("since you last looked")', async () => {
  // Read 1 — the panel's current state. Snapshot its findings the way the FE will:
  // a compact [{metric,current}] of exactly what is on screen.
  const read1 = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  const since = read1.findings.map(f => ({ metric: f.metric, current: f.evidence.current }))
  assert.ok(since.find(s => s.metric === 'revenue' && s.current === 10000), 'snapshot carries the on-screen revenue level')

  // Read 2 — fresh data lands; the FE replays the SAME scope with that snapshot as
  // `since` to get the session-relative diff alongside the fresh narration.
  const read2 = await runScopeInsight({ ...INPUT, since }, fakeQuery(NEXT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })

  assert.ok(read2.delta, 'delta attached when since supplied')
  assert.strictEqual(read2.delta.status, 'changed')

  const rev = read2.delta.changes[0]            // biggest |Δ cents| ⇒ first
  assert.strictEqual(rev.metric, 'revenue')
  assert.strictEqual(rev.from, 10000)
  assert.strictEqual(rev.to, 12400)
  assert.strictEqual(rev.delta, 2400)
  assert.strictEqual(rev.direction, 'up')
  assert.strictEqual(rev.improved, true)        // revenue up = good
  assert.ok(read2.delta.headline.startsWith('Since you last looked: revenue +$2,400'), read2.delta.headline)

  // leads did NOT move between the two reads (150 → 150) ⇒ never a change row…
  assert.ok(read2.delta.changes.every(c => c.metric !== 'leads'), 'unmoved metric must not be a change')
  // …even though leads is still a CARD in the fresh narration (it moved vs the COMPARE
  // window). This is the whole point: the delta is session-relative, not period-over-period.
  assert.ok(read2.findings.find(f => f.metric === 'leads'), 'leads is still a narrated card')

  // leak-safe: the session diff embeds no tenant identity — only the global channel axis.
  const serialized = JSON.stringify(read2.delta)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `delta leaked tenant identity: ${needle}`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2c — intel-v14 D2: the optional cross-read `trend` block. Proves the
// WIRING (runScopeInsight reads body.history, APPENDS this fresh narration as the
// newest read, and attaches a trend computed over the stream); the run/streak
// semantics themselves are owned by scopeTrend.test.js. Additive — absent / empty
// `history`, the envelope is byte-identical to every pre-D2 caller.
// ──────────────────────────────────────────────────────────────────────────

test('intel-v14 D2: omitting `history` ⇒ NO trend key (additive, byte-identical envelope)', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('trend' in result, false)
})

test('intel-v14 D2: `history:[]` ⇒ NO trend key (an empty buffer is not a stream)', async () => {
  const result = await runScopeInsight({ ...INPUT, history: [] }, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('trend' in result, false)
})

test('intel-v14 D2: one prior read ⇒ trend present but status "insufficient" (a run needs ≥3 reads)', async () => {
  // history(1) + the appended fresh narration = 2 reads — below the default 3-read
  // floor. The block still ATTACHES (presence keys on `history` being non-empty, not
  // on a run existing), but there is no streak yet.
  const result = await runScopeInsight(
    { ...INPUT, history: [[{ metric: 'revenue', current: 9000 }]] },
    fakeQuery(CURRENT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  assert.ok(result.trend, 'trend attached when history is non-empty')
  assert.strictEqual(result.trend.status, 'insufficient')
  assert.deepStrictEqual(result.trend.trends, [])
})

test('intel-v14 D2: a multi-read streak surfaces as a `trend` ("climbed N straight updates")', async () => {
  // Two PRIOR reads the FE buffered (oldest→newest), as the compact [{metric,current}]
  // snapshots snapOf emits: revenue 8000 then 10000. The fresh read (NEXT_RAW) totals
  // 12400 — appended server-side as the newest read ⇒ a 3-read revenue series climbing
  // every step ⇒ a 2-step up-run from 8000 to the fresh narration's REAL 12400.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  assert.ok(result.trend, 'trend attached when history supplied')
  assert.strictEqual(result.trend.status, 'trending')

  const rev = result.trend.trends[0]
  assert.strictEqual(rev.metric, 'revenue')
  assert.strictEqual(rev.from, 8000)
  assert.strictEqual(rev.to, 12400)              // the fresh narration is the run's endpoint
  assert.strictEqual(rev.runSteps, 2)
  assert.strictEqual(rev.direction, 'up')
  assert.strictEqual(rev.improving, true)        // revenue up = good
  assert.ok(result.trend.headline.startsWith('Revenue has climbed 2 straight updates'), result.trend.headline)

  // the trend rides ALONGSIDE the normal narration, not instead of it.
  assert.ok(result.findings.find(f => f.metric === 'revenue'), 'fresh narration still present beside the trend')

  // leak-safe: the cross-read trend embeds no tenant identity — only the global channel axis.
  const serialized = JSON.stringify(result.trend)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `trend leaked tenant identity: ${needle}`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2d — intel-v14 D3: the optional live `nowcast` block. Proves the WIRING
// (runScopeInsight projects the trend forward ONLY once it is on a confirmed
// streak); the projection math itself is owned by scopeNowcast.test.js. The
// nowcast rides strictly on top of D2 — no streak ⇒ no `trend` ⇒ no `nowcast`,
// so the envelope is byte-identical to every pre-D3 caller.
// ──────────────────────────────────────────────────────────────────────────

test('intel-v14 D3: omitting `history` ⇒ NO nowcast key (rides on the trend block)', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('trend' in result, false)
  assert.strictEqual('nowcast' in result, false)
})

test('intel-v14 D3: a trend that is not yet trending ⇒ NO nowcast key (a blip is not a streak)', async () => {
  // history(1) + the fresh read = 2 reads ⇒ trend present but status "insufficient".
  // Nothing is streaking, so there is nothing to project forward.
  const result = await runScopeInsight(
    { ...INPUT, history: [[{ metric: 'revenue', current: 9000 }]] },
    fakeQuery(CURRENT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  assert.ok(result.trend, 'trend attached when history is non-empty')
  assert.notStrictEqual(result.trend.status, 'trending')
  assert.strictEqual('nowcast' in result, false)
})

test('intel-v14 D3: a confirmed streak surfaces a `nowcast` projecting the run forward at pace', async () => {
  // Same setup as the D2 streak: prior reads 8000 then 10000, fresh read (NEXT_RAW) totals
  // 12400 ⇒ a 2-step up-run from 8000 to 12400. The nowcast continues it AT PACE: the run's
  // average step is (12400 − 8000) ÷ 2 = 2200, so the next update projects to ~14600.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // it only attaches once the trend is actually trending…
  assert.strictEqual(result.trend.status, 'trending')
  assert.ok(result.nowcast, 'nowcast attached when the trend is on a streak')
  assert.strictEqual(result.nowcast.status, 'projected')

  const rev = result.nowcast.projections[0]
  assert.strictEqual(rev.metric, 'revenue')
  assert.strictEqual(rev.current, 12400)         // launch point = the run's latest (fresh) value
  assert.strictEqual(rev.pace, 2200)             // (12400 − 8000) ÷ 2 steps — the average step
  assert.strictEqual(rev.projected, 14600)       // 12400 + 2200
  assert.strictEqual(rev.projectedDelta, 2200)
  assert.strictEqual(rev.improving, true)        // revenue up = good
  assert.strictEqual(rev.clamped, false)
  assert.ok(result.nowcast.headline.startsWith('At this pace, revenue reaches ~$14,600 next update'), result.nowcast.headline)

  // the nowcast rides ALONGSIDE the trend and the normal narration, never instead of them.
  assert.ok(result.trend.trends.find(t => t.metric === 'revenue'), 'trend still present beside the nowcast')
  assert.ok(result.findings.find(f => f.metric === 'revenue'), 'fresh narration still present beside the nowcast')

  // leak-safe: the live projection embeds no tenant identity — only the global channel axis.
  const serialized = JSON.stringify(result.nowcast)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `nowcast leaked tenant identity: ${needle}`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2d — intel-v14 D4: the optional `nowcast.accuracy` sub-block. Proves the
// WIRING (runScopeInsight backtests its OWN nowcast over the buffered series and
// attaches a confidence grade) — the backtest math itself is owned by
// scopeNowcastAccuracy.test.js. accuracy rides strictly on top of D3: it appears
// ONLY when there is a projected nowcast AND enough buffered reads to grade (≥4),
// so a fresh streak on a short buffer is byte-identical to a pre-D4 caller.
// ──────────────────────────────────────────────────────────────────────────

test('intel-v14 D4: a streak with enough buffered history ⇒ nowcast.accuracy grades the projections', async () => {
  // Three prior reads (8000, 10000, 12000) + the fresh read (NEXT_RAW totals 12400) = a
  // 4-read buffer — the floor at which the backtest can replay one interior projection and
  // check it. The lone interior prefix [8000,10000,12000] projects 14000 (pace 2000); the
  // read that actually followed is 12400, so |14000−12400| ÷ 13200 = 12.12% → graded 'fair'.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // it still rides on the live D3 nowcast — accuracy never replaces it…
  assert.strictEqual(result.trend.status, 'trending')
  assert.ok(result.nowcast, 'nowcast still present')
  assert.strictEqual(result.nowcast.status, 'projected')

  // …and now grades that projection against the buffer it was drawn from.
  assert.ok(result.nowcast.accuracy, 'accuracy attached once there are ≥4 buffered reads to backtest')
  assert.strictEqual(result.nowcast.accuracy.status, 'graded')
  assert.strictEqual(result.nowcast.accuracy.overall.samples, 1)   // one interior prefix was gradeable
  assert.strictEqual(result.nowcast.accuracy.overall.smape, 12.12)
  assert.strictEqual(result.nowcast.accuracy.overall.grade, 'fair')
  assert.strictEqual(
    result.nowcast.accuracy.headline,
    'Recent projections have landed within ~12% of actual — 1 check.')
  assert.strictEqual(result.nowcast.accuracy.metrics[0].metric, 'revenue')

  // leak-safe: the self-grade embeds no tenant identity — only metric labels + bare stats.
  const serialized = JSON.stringify(result.nowcast.accuracy)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `accuracy leaked tenant identity: ${needle}`)
  }
})

test('intel-v14 D4: a fresh streak on a SHORT buffer ⇒ nowcast but NO accuracy sub-key (byte-identical to D3)', async () => {
  // The D3 streak setup exactly: two prior reads + the fresh read = a 3-read buffer — below
  // the 4-read floor the backtest needs (it must hold out a read to grade against). So the
  // nowcast projects, but there is nothing yet to grade ⇒ the `accuracy` key never appears.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  assert.ok(result.nowcast, 'nowcast present on the streak')
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('accuracy' in result.nowcast, false)
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2e — intel-v14 D5: the optional per-projection `band` (a calibrated
// interval). Proves the WIRING (runScopeInsight sizes each projection's band
// from the metric's OWN measured sMAPE and pins it onto projections[i].band);
// the band math itself is owned by scopeNowcastBand.test.js. The band rides
// strictly on top of D4 — it is computed only INSIDE the graded-accuracy branch,
// so a projection with no `accuracy` carries no `band` either, byte-identical to
// a pre-D5 caller.
// ──────────────────────────────────────────────────────────────────────────

test('intel-v14 D5: a graded streak ⇒ each projection carries a calibrated `band` sized by its own sMAPE', async () => {
  // The D4 grading fixture exactly: prior reads 8000, 10000, 12000 + the fresh read
  // (NEXT_RAW totals 12400) = a 4-read buffer that grades the interior projection at
  // sMAPE 12.12%. D5 then draws the LIVE projection's band at ±12.12% about its own
  // projected value — honest precision lifted straight from the backtest.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // it rides on top of the D4 accuracy, which rides on the D3 nowcast — none replaced.
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.ok(result.nowcast.accuracy, 'accuracy still present')
  assert.strictEqual(result.nowcast.accuracy.status, 'graded')

  const proj = result.nowcast.projections[0]
  assert.strictEqual(proj.metric, 'revenue')
  assert.ok(proj.band, 'a calibrated band is pinned onto the projection')

  const b = proj.band
  assert.strictEqual(b.metric, 'revenue')
  assert.strictEqual(b.metric_label, 'Revenue')
  assert.strictEqual(b.basis, 'metric')                         // revenue was graded individually
  // the half-width IS the measured sMAPE — the band is drawn from the record, not invented.
  assert.strictEqual(b.halfPct, result.nowcast.accuracy.metrics[0].smape)
  assert.strictEqual(b.halfPct, 12.12)
  assert.strictEqual(b.drawnHalfPct, 12.12)                     // <200 → drawn in full
  assert.strictEqual(b.samples, 1)
  assert.strictEqual(b.floored, false)
  // the band straddles the SAME projected value the nowcast headline speaks — rounded to
  // cents for the payload (the live projection itself keeps full precision).
  assert.strictEqual(b.projected, Math.round(proj.projected * 100) / 100)
  assert.ok(b.lo < b.projected && b.projected < b.hi, 'a real interval around the projection')
  assert.ok(Number.isInteger(b.loCents) && Number.isInteger(b.hiCents))
  // rendered through the shared currency oracle — reads in the projection's own voice.
  assert.match(b.rangeLabel, /^\$[\d,]+–\$[\d,]+$/)
  assert.strictEqual(b.rangeLabel, `${b.loLabel}–${b.hiLabel}`)

  // leak-safe: the calibrated band embeds no tenant identity — metric labels + bare bounds only.
  const serialized = JSON.stringify(proj.band)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `band leaked tenant identity: ${needle}`)
  }
})

test('intel-v14 D5: a streak on a SHORT buffer ⇒ nowcast but NO band on any projection (byte-identical to D4)', async () => {
  // The D3/D4 short-buffer setup: two prior reads + the fresh read = a 3-read buffer, below
  // the grading floor. No accuracy ⇒ no band — the projection is unchanged from pre-D5.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('accuracy' in result.nowcast, false)
  assert.ok(result.nowcast.projections.every(p => !('band' in p)), 'no band without a measured accuracy')
})

test('intel-v14 D5: omitting `history` ⇒ no nowcast ⇒ no band (additive, byte-identical envelope)', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('nowcast' in result, false)
})
