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

// ──────────────────────────────────────────────────────────────────────────
// Layer 2f — intel-v14 D6: the optional `nowcast.voice` — the HEADLINE re-voiced
// at its measured confidence. Proves the WIRING (runScopeInsight gates the lead
// projection's headline by its OWN measured sMAPE — the lead band's halfPct —
// and attaches `voice` only when status 'voiced'); the confidence-ladder copy is
// owned by scopeNowcastVoice.test.js. The voice rides strictly on top of D5 — it
// is computed only INSIDE the graded branch and only when the lead metric earned
// a calibrated band, so a projection with no `band` carries no `voice` either,
// byte-identical to a pre-D6 caller. Crucially it does NOT mutate nowcast.headline:
// the D3 line still rides untouched as the fallback the surface can fall back to.
// ──────────────────────────────────────────────────────────────────────────

test('intel-v14 D6: a graded streak ⇒ nowcast.voice re-voices the headline at its MEASURED confidence', async () => {
  // The D5 band fixture exactly: prior reads 8000, 10000, 12000 + the fresh read
  // (NEXT_RAW totals 12400) grade the lead band at sMAPE 12.12%, which lands in the
  // MEASURED tier (>firm 5, ≤measured 15) — reliable but not tight.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // it rides on top of the D5 band → D4 accuracy → D3 nowcast — none replaced.
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.ok(result.nowcast.accuracy, 'accuracy still present')
  const proj = result.nowcast.projections[0]
  assert.ok(proj.band, 'the calibrated band is still pinned on the projection')

  // the re-voiced headline rides ALONGSIDE the D3 line as nowcast.voice.
  const voice = result.nowcast.voice
  assert.ok(voice, 'voice attached once the lead metric earned a calibrated band')
  assert.strictEqual(voice.status, 'voiced')
  assert.strictEqual(voice.leadMetric, 'revenue')
  assert.strictEqual(voice.leadLabel, 'Revenue')
  assert.strictEqual(voice.basis, 'metric')                  // revenue graded individually
  assert.strictEqual(voice.confidence, 'measured')
  assert.strictEqual(voice.speaksNumber, true)
  // the half-width IS the lead band's measured sMAPE — voiced straight from the record.
  assert.strictEqual(voice.halfPct, proj.band.halfPct)
  assert.strictEqual(voice.halfPct, 12.12)
  // measured keeps the soft "~" and appends the SAME range the band cites.
  assert.match(voice.headline, /^At this pace, revenue reaches ~\$[\d,]+(?:\.\d+)? next update — likely \$[\d,]+(?:\.\d+)?–\$[\d,]+(?:\.\d+)?\.$/)
  assert.ok(voice.headline.includes(proj.band.rangeLabel), 'voice cites the band range verbatim')
  assert.strictEqual(voice.hedge, `likely ${proj.band.rangeLabel}`)

  // it does NOT mutate the D3 headline — that rides untouched as the fallback.
  assert.ok(result.nowcast.headline.startsWith('At this pace, revenue reaches ~'), result.nowcast.headline)
  assert.strictEqual(voice.raw, result.nowcast.headline)

  // leak-safe: a metric label + bare numbers + confidence phrasing — no tenant identity.
  const serialized = JSON.stringify(voice)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `voice leaked tenant identity: ${needle}`)
  }
})

test('intel-v14 D6: caller thresholds thread through ⇒ a tightened firmMax voices the band as FIRM', async () => {
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  // firmMax 100 ⇒ the 12.12% lead band now clears the firm bar: state the number plainly.
  const result = await runScopeInsight(
    { ...INPUT, history, firmMax: 100 },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const voice = result.nowcast.voice
  assert.ok(voice && voice.status === 'voiced')
  assert.strictEqual(voice.confidence, 'firm')
  assert.strictEqual(voice.speaksNumber, true)
  assert.strictEqual(voice.hedge, '')                        // firm speaks plainly, no qualifier
  // firm drops the soft "~" and leads with the figure + the signed magnitude.
  assert.match(voice.headline, /^Revenue is on track to reach \$[\d,]+(?:\.\d+)? next update \(\+\$[\d,]+(?:\.\d+)?\)\.$/)
  assert.ok(!voice.headline.includes('~'), 'firm states the number without a soft ~')
  // the override threaded all the way through runScopeInsight → calibrateNowcastVoice.
  assert.strictEqual(voice.meta.thresholds.firmMax, 100)
})

test('intel-v14 D6: a loosened ceiling ⇒ a too-volatile band WITHHOLDS the number, naming only direction', async () => {
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  // pull both ceilings below the 12.12% band ⇒ it falls past 'tentative' to 'withheld'.
  const result = await runScopeInsight(
    { ...INPUT, history, measuredMax: 5, tentativeMax: 10 },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const voice = result.nowcast.voice
  assert.ok(voice && voice.status === 'voiced')
  assert.strictEqual(voice.confidence, 'withheld')
  assert.strictEqual(voice.speaksNumber, false)
  // names only the direction + why the figure is withheld — and speaks NO projected figure.
  assert.match(voice.headline, /^Revenue is trending up, though recent estimates have been too volatile \(±\d+%\) to call a number yet\.$/)
  assert.ok(!voice.headline.includes('$'), 'withheld speaks no dollar figure')
  // the D3 headline (which DOES name a number) still rides untouched beneath it.
  assert.ok(result.nowcast.headline.includes('$'), 'the raw D3 line still names its number')
})

test('intel-v14 D6: a streak on a SHORT buffer ⇒ nowcast but NO voice key (byte-identical to D5)', async () => {
  // Two prior reads + the fresh read = a 3-read buffer, below the grading floor.
  // No accuracy ⇒ no band ⇒ no voice — the nowcast is unchanged from pre-D6.
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
  assert.strictEqual('voice' in result.nowcast, false)
})

test('intel-v14 D6: omitting `history` ⇒ no nowcast ⇒ no voice (additive, byte-identical envelope)', async () => {
  const result = await runScopeInsight(INPUT, fakeQuery(CURRENT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('nowcast' in result, false)
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2g — intel-v14 D7: the optional `nowcast.corroboration` — an INDEPENDENT
// cross-lens second opinion the self-backtest (D4–D6) structurally cannot give.
// Proves the WIRING (runScopeInsight cross-checks the lead projection's trajectory
// against the genuinely independent `delta` lens — the metric's move since the
// caller's own `since` snapshot — and attaches `corroboration` only when status
// 'corroborated'); the aligned/mixed arithmetic itself is owned by
// scopeNowcastCorroboration.test.js. The defining property, exercised below: it is
// wired BEFORE the accuracy grade, so it attaches on a projected nowcast + an
// independent delta EVEN ON A SHORT BUFFER too short to grade — independent of the
// confidence ladder. Additive — absent `since` (⇒ no delta), the nowcast carries
// no `corroboration` key, byte-identical to a pre-D7 caller. It NEVER mutates the
// headline, voice, band, or accuracy — it only rides a sibling cue alongside them.
// ──────────────────────────────────────────────────────────────────────────

test('intel-v14 D7: a graded streak + an independent delta that AGREES ⇒ nowcast.corroboration "aligned"', async () => {
  // The D6 graded fixture (prior reads 8000/10000/12000 + fresh NEXT_RAW total 12400)
  // ⇒ nowcast revenue UP with accuracy/band/voice. The caller also sends a `since`
  // snapshot of the on-screen revenue (10000) — so the independent delta moves
  // 10000 → 12400 (+2400 = up), the SAME way the projection points. Corroborated, aligned.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const since = [{ metric: 'revenue', current: 10000 }]
  const result = await runScopeInsight(
    { ...INPUT, history, since },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // the independent delta is present and points up — the witness the cue reads from.
  assert.ok(result.delta && result.delta.status === 'changed')
  assert.strictEqual(result.delta.changes.find(c => c.metric === 'revenue').direction, 'up')

  // the cross-lens cue rides on the nowcast.
  const c = result.nowcast.corroboration
  assert.ok(c, 'corroboration attached once a projected nowcast has an independent delta')
  assert.strictEqual(c.status, 'corroborated')
  assert.strictEqual(c.level, 'aligned')
  assert.strictEqual(c.leadMetric, 'revenue')
  assert.strictEqual(c.leadLabel, 'Revenue')
  assert.strictEqual(c.trajectory, 'up')   // what the nowcast claims
  assert.strictEqual(c.recent, 'up')       // the independent delta move
  assert.strictEqual(c.agree, true)
  assert.strictEqual(c.witnessCount, 1)
  assert.strictEqual(c.confirmCount, 1)
  assert.strictEqual(c.conflictCount, 0)
  assert.deepStrictEqual(c.witnesses, [{ lens: 'delta', direction: 'up', agrees: true }])
  assert.match(c.note, /also points up/)
  assert.match(c.note, /corroborated/)
  assert.deepStrictEqual(c.meta, { independentLenses: ['delta'], basis: 'cross-lens' })

  // it rides ALONGSIDE the D4 accuracy → D5 band → D6 voice — none replaced.
  assert.ok(result.nowcast.accuracy, 'D4 accuracy still present')
  assert.ok(result.nowcast.projections[0].band, 'D5 band still pinned on the lead projection')
  assert.ok(result.nowcast.voice && result.nowcast.voice.status === 'voiced', 'D6 voice still present')
})

test('intel-v14 D7: a graded streak + an independent delta that DISAGREES ⇒ nowcast.corroboration "mixed"', async () => {
  // Same UP projection, but the caller last looked when revenue read 99999 — so the
  // independent move since then is DOWN (12400 < 99999), AGAINST the projected up.
  // This is the regime-change catch the self-backtest cannot make: the run is up
  // (trend up → nowcast up) yet the metric has ticked down vs the caller's snapshot.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const since = [{ metric: 'revenue', current: 99999 }]
  const result = await runScopeInsight(
    { ...INPUT, history, since },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  assert.strictEqual(result.delta.changes.find(c => c.metric === 'revenue').direction, 'down')

  const c = result.nowcast.corroboration
  assert.ok(c)
  assert.strictEqual(c.status, 'corroborated')
  assert.strictEqual(c.level, 'mixed')
  assert.strictEqual(c.trajectory, 'up')
  assert.strictEqual(c.recent, 'down')
  assert.strictEqual(c.agree, false)
  assert.strictEqual(c.confirmCount, 0)
  assert.strictEqual(c.conflictCount, 1)
  assert.deepStrictEqual(c.witnesses, [{ lens: 'delta', direction: 'down', agrees: false }])
  assert.match(c.note, /points down/)
  assert.match(c.note, /against the projected up/)
  assert.match(c.note, /caution/)

  // the voice/headline still speak the projection in full — corroboration only tempers, never edits.
  assert.ok(result.nowcast.voice && result.nowcast.voice.status === 'voiced')
  assert.ok(result.nowcast.headline.startsWith('At this pace, revenue reaches ~'), result.nowcast.headline)
})

test('intel-v14 D7: a SHORT buffer too short to grade STILL corroborates (independent of the accuracy ladder)', async () => {
  // Two prior reads + the fresh read = a 3-read buffer ⇒ nowcast projects but earns
  // NO accuracy/band/voice (below the grading floor). Corroboration is wired BEFORE
  // the grade, so with an independent `since` it attaches anyway — the key property
  // that separates it from the self-backtest layers: it does not need a gradeable run.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
  ]
  const since = [{ metric: 'revenue', current: 10000 }]
  const result = await runScopeInsight(
    { ...INPUT, history, since },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // the nowcast projects but is ungraded — no accuracy/band/voice on this buffer.
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('accuracy' in result.nowcast, false)
  assert.ok(result.nowcast.projections.every(p => !('band' in p)))
  assert.strictEqual('voice' in result.nowcast, false)

  // …yet corroboration IS present — it rides on the projection + the independent delta alone.
  const c = result.nowcast.corroboration
  assert.ok(c, 'corroboration attaches on a projected-but-ungraded nowcast')
  assert.strictEqual(c.status, 'corroborated')
  assert.strictEqual(c.level, 'aligned')
  assert.strictEqual(c.trajectory, 'up')
  assert.strictEqual(c.recent, 'up')
})

test('intel-v14 D7: a graded streak with NO `since` ⇒ no delta ⇒ NO corroboration key (byte-identical to D6)', async () => {
  // Without a `since` snapshot there is no independent lens to cross-check against, so
  // corroboration gates to status 'none' and attaches nothing — the nowcast is exactly
  // what a pre-D7 caller saw (accuracy/band/voice intact, no corroboration key).
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  assert.strictEqual('delta' in result, false)
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.ok(result.nowcast.voice, 'the D6 voice is untouched')
  assert.strictEqual('corroboration' in result.nowcast, false)
})

test('intel-v14 D7: omitting `history` ⇒ no nowcast ⇒ no corroboration (additive, byte-identical envelope)', async () => {
  // Even with a `since` in hand, no nowcast means nothing to corroborate — the
  // corroboration cue lives strictly inside the nowcast block.
  const since = [{ metric: 'revenue', current: 10000 }]
  const result = await runScopeInsight({ ...INPUT, since }, fakeQuery(NEXT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('nowcast' in result, false)
})

test('intel-v14 D7: the corroboration payload embeds no tenant identity (renders identically on both surfaces)', async () => {
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const since = [{ metric: 'revenue', current: 10000 }]
  const result = await runScopeInsight(
    { ...INPUT, history, since },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  const serialized = JSON.stringify(result.nowcast.corroboration)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `corroboration leaked tenant identity: ${needle}`)
  }
})

// ── intel-v14 D8: cross-metric story-check (nowcast.coherence) ───────────────────────────────────
// D1–D7 are every one LEAD-CENTRIC — they reason about the single most-salient projection in
// isolation, so none can see the vanity-metric trap: a headline metric projected UP while, in the
// SAME basket, unit economics (cost per lead) are projected UP too — and a rising cost per lead is a
// WORSENING move. D8 is the first lens that reads the FULL projections[] vector and classifies it by
// POLARITY (the `improving` flag the pace oracle attaches), so it catches exactly that tension.

test('intel-v14 D8: a divergent basket (revenue improving, cost per lead worsening) ⇒ nowcast.coherence "divergent"', async () => {
  // revenue [8000,10000,→12400] trends UP (improving) while cpl [12,16,→20] trends UP too — but a
  // RISING cost per lead is a WORSENING move (improving:false). No lead-centric lens (D1–D7) can see
  // this tension; D8 reads the whole vector and names it. The 3-read buffer (2 history + the live
  // read) is too short to GRADE, so coherence rides on the projection vector ALONE — the same
  // independence-from-grading property that separates it from the D4–D6 self-backtest ladder.
  const history = [
    [{ metric: 'revenue', current: 8000 }, { metric: 'cpl', current: 12 }],
    [{ metric: 'revenue', current: 10000 }, { metric: 'cpl', current: 16 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // the nowcast projects but is UNGRADED on this short buffer — no accuracy / band / voice…
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('accuracy' in result.nowcast, false)
  assert.ok(result.nowcast.projections.every(p => !('band' in p)))
  assert.strictEqual('voice' in result.nowcast, false)

  // …yet the cross-metric coherence check IS present — it needs only ≥2 polarity-bearing projections.
  const c = result.nowcast.coherence
  assert.ok(c, 'coherence attaches on a projected-but-ungraded multi-metric nowcast')
  assert.strictEqual(c.status, 'assessed')
  assert.strictEqual(c.level, 'divergent')
  assert.strictEqual(c.favorableCount, 1)
  assert.strictEqual(c.unfavorableCount, 1)
  assert.strictEqual(c.assessedCount, 2)
  assert.strictEqual(c.leadFavorable.metric, 'revenue')
  assert.strictEqual(c.leadUnfavorable.metric, 'cpl')
  // the live cpl label flows from ask.js METRICS ('Cost per lead') → lowercased in the note.
  assert.strictEqual(
    c.note,
    "Revenue is projected to improve, but cost per lead is projected to worsen — the gain isn't clean.")
})

test('intel-v14 D8: a unified basket (revenue and leads both improving) ⇒ nowcast.coherence "unified"', async () => {
  // revenue [8000,10000,→12400] and leads [100,130,→150] both trend UP, and UP is the GOOD direction
  // for each → every assessed metric is improving → the basket moves as one, the headline is backed.
  const history = [
    [{ metric: 'revenue', current: 8000 }, { metric: 'leads', current: 100 }],
    [{ metric: 'revenue', current: 10000 }, { metric: 'leads', current: 130 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const c = result.nowcast.coherence
  assert.ok(c)
  assert.strictEqual(c.status, 'assessed')
  assert.strictEqual(c.level, 'unified')
  assert.strictEqual(c.favorableCount, 2)
  assert.strictEqual(c.unfavorableCount, 0)
  assert.strictEqual(c.leadUnfavorable, null)
  // salience orders the two improving metrics; the 2-metric phrasing tolerates either order.
  assert.match(
    c.note,
    /^Both (revenue and leads|leads and revenue) are projected to improve — the basket is moving as one\.$/)
})

test('intel-v14 D8: a single-metric GRADED nowcast ⇒ NO coherence key (additive, byte-identical envelope)', async () => {
  // A revenue-only history long enough to GRADE (3 history + the live read = a 4-read buffer) → the
  // nowcast carries accuracy / band / voice, but there is only ONE polarity-bearing projection, so
  // coherence has nothing to cohere WITH → status 'none' → no key. Crucially this holds even on a
  // FULLY GRADED nowcast: a pre-D8 caller's envelope is byte-identical whether or not D8 ran.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // the nowcast IS graded (so the absence below is meaningful, not merely "too short to do anything")…
  assert.strictEqual(result.nowcast.projections.length, 1)
  assert.ok(result.nowcast.accuracy, 'a 4-read revenue buffer grades')
  assert.ok(result.nowcast.voice, 'the D6 voice is present on the graded single-metric nowcast')
  // …yet there is no second polarity-bearing metric, so D8 adds nothing.
  assert.strictEqual('coherence' in result.nowcast, false)
})

test('intel-v14 D8: the coherence payload embeds no tenant identity (renders identically on both surfaces)', async () => {
  const history = [
    [{ metric: 'revenue', current: 8000 }, { metric: 'cpl', current: 12 }],
    [{ metric: 'revenue', current: 10000 }, { metric: 'cpl', current: 16 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  const serialized = JSON.stringify(result.nowcast.coherence)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `coherence leaked tenant identity: ${needle}`)
  }
})

// ── intel-v14 D9: magnitude temper (nowcast.materiality) ──────────────────────────────────────────
// D8 classifies the projection basket by POLARITY (unified / divergent / deteriorating). D9 supplies
// the missing half — MAGNITUDE: is the move that matters big enough to act on, or a hairline? The two
// guard opposite failures (D8: a vanity metric hides trouble; D9: a trivial wobble masquerades as
// trouble), so they COEXIST on the same basket. Like coherence, materiality needs no grade — it rides
// on the projection vector alone (it even speaks on the single-metric nowcast D8 stays silent on).

test('intel-v14 D9: a material divergence (revenue +~18%, cost per lead worsening +~20%) ⇒ nowcast.materiality "material"', async () => {
  // Same basket as the D8 divergent case: revenue [8000,10000,→12400] improving while cpl [12,16,→20]
  // is worsening. D8 already named the POLARITY tension; D9 sizes it — the worsening side (the
  // decisive one) clears the 5% threshold, so this divergence is real, not noise. The 3-read buffer is
  // too short to GRADE, so — exactly like coherence — materiality attaches on the projection vector
  // ALONE, with no accuracy / band / voice.
  const history = [
    [{ metric: 'revenue', current: 8000 }, { metric: 'cpl', current: 12 }],
    [{ metric: 'revenue', current: 10000 }, { metric: 'cpl', current: 16 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // ungraded on the short buffer — no accuracy / band / voice (materiality rides ahead of the grade)…
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('accuracy' in result.nowcast, false)
  assert.ok(result.nowcast.projections.every(p => !('band' in p)))
  assert.strictEqual('voice' in result.nowcast, false)

  // …and D8 + D9 BOTH speak on the same basket: divergent (polarity) AND material (magnitude).
  assert.strictEqual(result.nowcast.coherence.level, 'divergent')

  const m = result.nowcast.materiality
  assert.ok(m, 'materiality attaches on a projected-but-ungraded multi-metric nowcast')
  assert.strictEqual(m.status, 'assessed')
  assert.strictEqual(m.level, 'material')
  assert.strictEqual(m.assessedCount, 2)
  assert.strictEqual(m.materialCount, 2)         // both sides clear 5%
  assert.strictEqual(m.marginalCount, 0)
  assert.strictEqual(m.biggestFavorable.metric, 'revenue')
  assert.strictEqual(m.biggestAdverse.metric, 'cpl')
  assert.strictEqual(m.decisive.metric, 'cpl')   // the worsening side is decisive
  // the note names the decisive (worsening) side at its real size; cpl's live label is 'Cost per lead'.
  const cplPct = Math.round(Math.abs(result.nowcast.projections.find(p => p.metric === 'cpl').pct))
  assert.strictEqual(m.note, `Cost per lead is projected to worsen ~${cplPct}% — a material divergence, not noise.`)
})

test('intel-v14 D9: a big headline over a hairline slip (revenue +~18%, cpl +~1%) ⇒ nowcast.materiality "marginal"', async () => {
  // THE signature D9 case. cpl [19.6,19.8,→20] is technically worsening, so D8 still calls the basket
  // 'divergent' — but the worsening side projects barely ~1%, well under the 5% threshold. Sounding the
  // same caution as a real divergence would be crying wolf; D9 tempers it to 'marginal' even though the
  // headline (revenue) itself moved materially. materialCount/marginalCount keep the raw tally (the
  // material gain is still counted) while `level` keys only on the decisive (worsening) side.
  const history = [
    [{ metric: 'revenue', current: 8000 }, { metric: 'cpl', current: 19.6 }],
    [{ metric: 'revenue', current: 10000 }, { metric: 'cpl', current: 19.8 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // D8 still sees the polarity split (a rising cpl is worsening, however small)…
  assert.strictEqual(result.nowcast.coherence.level, 'divergent')

  // …but D9 reads the size and refuses to cry wolf.
  const m = result.nowcast.materiality
  assert.ok(m)
  assert.strictEqual(m.status, 'assessed')
  assert.strictEqual(m.level, 'marginal')
  assert.strictEqual(m.assessedCount, 2)
  assert.strictEqual(m.materialCount, 1)         // revenue is a material gain…
  assert.strictEqual(m.marginalCount, 1)         // …but the worsening side is a hairline
  assert.strictEqual(m.biggestFavorable.metric, 'revenue')
  assert.strictEqual(m.biggestAdverse.metric, 'cpl')
  assert.strictEqual(m.decisive.metric, 'cpl')   // marginal worsening sets the (marginal) level
  // the note names the material headline AND the under-threshold worsening side, so 'marginal' reads
  // honestly — not as a denial that anything is moving.
  const revPct = Math.round(Math.abs(result.nowcast.projections.find(p => p.metric === 'revenue').pct))
  assert.strictEqual(
    m.note,
    `Revenue is projected up ~${revPct}%, while the worsening side stays under ~5% — the divergence is marginal.`)
})

test('intel-v14 D9: a single-metric GRADED nowcast ⇒ materiality present (the case D8 omits coherence on)', async () => {
  // A revenue-only buffer long enough to GRADE (3 history + the live read = 4 reads). D8 stays SILENT
  // here — one polarity-bearing metric has nothing to cohere WITH. D9 does NOT: "revenue projected up
  // ~12%" is a material move on its own. So on the exact fixture where coherence is absent, materiality
  // speaks — the two lenses are complementary, never redundant.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 12000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // graded single-metric nowcast: accuracy + voice present, coherence ABSENT (nothing to cohere with)…
  assert.strictEqual(result.nowcast.projections.length, 1)
  assert.ok(result.nowcast.accuracy, 'a 4-read revenue buffer grades')
  assert.ok(result.nowcast.voice)
  assert.strictEqual('coherence' in result.nowcast, false)

  // …yet materiality DOES speak on the single projection.
  const m = result.nowcast.materiality
  assert.ok(m, 'materiality speaks on a single polarity-bearing projection')
  assert.strictEqual(m.status, 'assessed')
  assert.strictEqual(m.level, 'material')
  assert.strictEqual(m.assessedCount, 1)
  assert.strictEqual(m.materialCount, 1)
  assert.strictEqual(m.biggestFavorable.metric, 'revenue')
  assert.strictEqual(m.biggestAdverse, null)     // no worsening side
  assert.strictEqual(m.decisive.metric, 'revenue')
  const revPct = Math.round(Math.abs(result.nowcast.projections[0].pct))
  assert.strictEqual(m.note, `Revenue is projected up ~${revPct}% — a material gain.`)
})

test('intel-v14 D9: no projected nowcast ⇒ NO materiality (additive, byte-identical envelope)', async () => {
  // Omitting `history` ⇒ no trend ⇒ no nowcast at all, so there is nothing for D9 to size and the
  // envelope is byte-identical to every pre-D9 caller.
  const result = await runScopeInsight(INPUT, fakeQuery(NEXT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('nowcast' in result, false)
})

test('intel-v14 D9: the materiality payload embeds no tenant identity (renders identically on both surfaces)', async () => {
  const history = [
    [{ metric: 'revenue', current: 8000 }, { metric: 'cpl', current: 12 }],
    [{ metric: 'revenue', current: 10000 }, { metric: 'cpl', current: 16 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  const serialized = JSON.stringify(result.nowcast.materiality)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `materiality leaked tenant identity: ${needle}`)
  }
})

// ── intel-v14 D10: run-curvature temper (nowcast.momentum) ──────────────────────────────────────────
// D3 projects each trending metric forward at its run's AVERAGE step pace — an honest straight line, but
// blind to CURVATURE. D8 read the projection basket's POLARITY and D9 its MAGNITUDE; D10 reads whether the
// pace that JUSTIFIED the straight line is still being delivered. It re-reads each projection's own run
// (`values` — the finite, gap-free, same-signed read sequence scopeTrend already validated), measures the
// step magnitudes in drift-free integer cents, and compares an early-half pace to a late-half pace: steps
// that keep GROWING ⇒ accelerating (the line is a FLOOR — it understates); steps that keep SHRINKING ⇒
// decelerating (the line is a CEILING — it overstates); inside the ±20% band ⇒ steady (the line is
// well-founded). Curvature needs only a single projection carrying a ≥3-read run (two steps to compare),
// so — exactly like coherence and materiality — momentum rides on the projection vector ALONE, ahead of
// the grade. The live read totals revenue to 12400, so each single-metric run below is [h0, h1, 12400];
// these use OWN fixtures with clear margin from D9's +20% knife-edge so the shape is unambiguous.

test('intel-v14 D10: a run whose steps keep GROWING ⇒ nowcast.momentum "accelerating" (the line is a floor)', async () => {
  // revenue [10000,11000,→12400]: step magnitudes (cents) [100000,140000] ⇒ paceRatio 1.4, well past the
  // 1.20 accelerating boundary. Revenue is favorable (up is good), so the honest framing is a compounding
  // gain — NOT a warning. The 3-read buffer is too short to GRADE, so momentum attaches on the projection
  // vector alone (no accuracy / band / voice), and a single metric has nothing to cohere with so D8 is silent.
  const history = [
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 11000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  // ungraded on the short buffer, single-metric ⇒ no accuracy / band / voice / coherence (momentum rides ahead)…
  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('accuracy' in result.nowcast, false)
  assert.ok(result.nowcast.projections.every(p => !('band' in p)))
  assert.strictEqual('voice' in result.nowcast, false)
  assert.strictEqual('coherence' in result.nowcast, false)

  // …yet D10 reads the curvature on the lone projection.
  const m = result.nowcast.momentum
  assert.ok(m, 'momentum attaches on a projected-but-ungraded single-metric nowcast')
  assert.strictEqual(m.status, 'assessed')
  assert.strictEqual(m.shape, 'accelerating')
  assert.strictEqual(m.assessedCount, 1)
  assert.strictEqual(m.acceleratingCount, 1)
  assert.strictEqual(m.deceleratingCount, 0)
  assert.strictEqual(m.steadyCount, 0)
  assert.strictEqual(m.decisive.metric, 'revenue')
  assert.strictEqual(m.biggestMove.metric, 'revenue')
  assert.strictEqual(m.meta.basis, 'run-curvature')
  // revenue is favorable, so an accelerating gain reads as compounding momentum, not a risk.
  assert.strictEqual(
    m.note,
    "Revenue's gain is accelerating — each update is larger than the last; the momentum is compounding.")
})

test('intel-v14 D10: a run whose steps keep SHRINKING ⇒ nowcast.momentum "decelerating" (the line is a ceiling)', async () => {
  // revenue [8000,11400,→12400]: step magnitudes (cents) [340000,100000] ⇒ paceRatio ≈0.29, far under the
  // 0.80 decelerating boundary. The climb is real but running out of steam, so the straight line OVERSTATES
  // where the next read lands — the accuracy-protecting half of the lens. Revenue is favorable, so the note
  // frames it as a flattening GAIN that the projection may overstate.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 11400 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const m = result.nowcast.momentum
  assert.ok(m)
  assert.strictEqual(m.status, 'assessed')
  assert.strictEqual(m.shape, 'decelerating')
  assert.strictEqual(m.assessedCount, 1)
  assert.strictEqual(m.acceleratingCount, 0)
  assert.strictEqual(m.deceleratingCount, 1)
  assert.strictEqual(m.steadyCount, 0)
  assert.strictEqual(m.decisive.metric, 'revenue')
  assert.strictEqual(m.meta.basis, 'run-curvature')
  assert.strictEqual(
    m.note,
    "Revenue's gain is flattening — each update is smaller than the last, so the projection may overstate it.")
})

test('intel-v14 D10: a run holding its slope ⇒ nowcast.momentum "steady" (the straight line is well-founded)', async () => {
  // revenue [8200,10300,→12400]: step magnitudes (cents) [210000,210000] ⇒ paceRatio exactly 1.0, dead
  // center of the ±20% band. The pace that produced the projection is still in force, so D10 affirms the
  // straight line rather than tempering it — the "do not cry wolf" case for curvature.
  const history = [
    [{ metric: 'revenue', current: 8200 }],
    [{ metric: 'revenue', current: 10300 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const m = result.nowcast.momentum
  assert.ok(m)
  assert.strictEqual(m.status, 'assessed')
  assert.strictEqual(m.shape, 'steady')
  assert.strictEqual(m.assessedCount, 1)
  assert.strictEqual(m.acceleratingCount, 0)
  assert.strictEqual(m.deceleratingCount, 0)
  assert.strictEqual(m.steadyCount, 1)
  assert.strictEqual(m.decisive.metric, 'revenue')
  assert.strictEqual(m.meta.basis, 'run-curvature')
  assert.strictEqual(m.note, "Revenue's pace is holding steady — the linear projection is well-founded.")
})

test('intel-v14 D10: no projected nowcast ⇒ NO momentum (additive, byte-identical envelope)', async () => {
  // Omitting `history` ⇒ no trend ⇒ no nowcast at all, so there is nothing for D10 to read and the
  // envelope is byte-identical to every pre-D10 caller.
  const result = await runScopeInsight(INPUT, fakeQuery(NEXT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('nowcast' in result, false)
})

test('intel-v14 D10: the momentum payload embeds no tenant identity (renders identically on both surfaces)', async () => {
  const history = [
    [{ metric: 'revenue', current: 10000 }],
    [{ metric: 'revenue', current: 11000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  const serialized = JSON.stringify(result.nowcast.momentum)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `momentum leaked tenant identity: ${needle}`)
  }
})

// ── intel-v14 D11: run-jitter temper (nowcast.stability) ──────────────────────────────────────────
// D10 read the SYSTEMATIC bend in a run's pace (accelerating / decelerating / steady); D11 reads the
// NON-systematic SCATTER that survives after pace (D3) and curvature (D10) are accounted for. A run can
// hold a flat average pace AND a flat early-vs-late curvature while still lurching read-to-read, so D11
// re-reads each projection's own run (`values`), measures the step magnitudes in drift-free integer
// cents, and takes their coefficient of variation (CV = stdev/mean): evenly-sized steps (CV ≤ 0.25) ⇒
// smooth (the straight-line single number rests on firm footing); steps that lurch around (CV ≥ 0.6) ⇒
// choppy (read the projection as a rough center, not a target); between ⇒ variable. To stay genuinely
// ORTHOGONAL to D10 it requires ≥3 steps (≥4 reads) — on a 2-step run CV is a monotone function of D10's
// pace ratio, so the ≥3-step floor makes D11 silent exactly where it would merely re-state D10. Jitter
// is direction-NEUTRAL, so unlike D10 the note never branches on polarity. The live read totals revenue
// to 12400, so each single-metric run below is [h0, h1, h2, →12400] (4 reads / 3 steps), climbing every
// step so scopeTrend sees one unbroken up-run. These use OWN fixtures with clear margin from the 0.25 /
// 0.60 CV boundaries so the level is unambiguous.

test('intel-v14 D11: a run with evenly-sized steps ⇒ nowcast.stability "smooth" (the single number is well-grounded)', async () => {
  // revenue [6400,8400,10400,→12400]: step magnitudes (cents) [200000,200000,200000] ⇒ CV 0, dead
  // center of the smooth band. The pace is not just steady (D10) but DELIVERED evenly read-to-read, so
  // the straight-line projection rests on firm footing — the "trust the number" case for jitter.
  const history = [
    [{ metric: 'revenue', current: 6400 }],
    [{ metric: 'revenue', current: 8400 }],
    [{ metric: 'revenue', current: 10400 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  assert.strictEqual(result.nowcast.status, 'projected')
  const s = result.nowcast.stability
  assert.ok(s, 'stability attaches on a projected nowcast carrying a ≥4-read run')
  assert.strictEqual(s.status, 'assessed')
  assert.strictEqual(s.level, 'smooth')
  assert.strictEqual(s.assessedCount, 1)
  assert.strictEqual(s.smoothCount, 1)
  assert.strictEqual(s.variableCount, 0)
  assert.strictEqual(s.choppyCount, 0)
  assert.strictEqual(s.decisive.metric, 'revenue')
  assert.strictEqual(s.jumpiest.metric, 'revenue')
  assert.strictEqual(s.decisive.steps, 3)
  assert.strictEqual(s.meta.basis, 'step-dispersion')
  assert.strictEqual(
    s.note,
    "Revenue's updates have been evenly sized — the run is steady underfoot, so the projected figure rests on firm footing.")
})

test('intel-v14 D11: a run whose steps lurch ⇒ nowcast.stability "choppy" (read the projection as a rough center)', async () => {
  // revenue [1400,2400,11400,→12400]: step magnitudes (cents) [100000,900000,100000] ⇒ mean 366666.67,
  // stdev ≈ 377124, CV ≈ 1.03 — far past the 0.60 choppy boundary. The run still climbs to the SAME
  // 12400 endpoint, so D3 projects and D10 may read it steady, yet no single next read is predictable
  // from it: D11 honestly flags the straight-line number as a rough center, not a target.
  const history = [
    [{ metric: 'revenue', current: 1400 }],
    [{ metric: 'revenue', current: 2400 }],
    [{ metric: 'revenue', current: 11400 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const s = result.nowcast.stability
  assert.ok(s)
  assert.strictEqual(s.status, 'assessed')
  assert.strictEqual(s.level, 'choppy')
  assert.strictEqual(s.assessedCount, 1)
  assert.strictEqual(s.smoothCount, 0)
  assert.strictEqual(s.variableCount, 0)
  assert.strictEqual(s.choppyCount, 1)
  assert.strictEqual(s.decisive.metric, 'revenue')
  assert.strictEqual(s.meta.basis, 'step-dispersion')
  // direction-neutral: revenue is favorable, yet the note speaks only to reliability, never good/bad.
  assert.strictEqual(
    s.note,
    "Revenue's updates have been uneven — the run is jumpy, so read the projected figure as a rough center, not a precise target.")
})

test('intel-v14 D11: a run between the bands ⇒ nowcast.stability "variable" (reasonable but not pinpoint)', async () => {
  // revenue [7900,8900,10900,→12400]: step magnitudes (cents) [100000,200000,150000] ⇒ mean 150000,
  // stdev ≈ 40825, CV ≈ 0.272 — inside the 0.25–0.60 variable band. The projection is defensible but
  // the run is not even enough to call the single number pinpoint.
  const history = [
    [{ metric: 'revenue', current: 7900 }],
    [{ metric: 'revenue', current: 8900 }],
    [{ metric: 'revenue', current: 10900 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  const s = result.nowcast.stability
  assert.ok(s)
  assert.strictEqual(s.status, 'assessed')
  assert.strictEqual(s.level, 'variable')
  assert.strictEqual(s.assessedCount, 1)
  assert.strictEqual(s.smoothCount, 0)
  assert.strictEqual(s.variableCount, 1)
  assert.strictEqual(s.choppyCount, 0)
  assert.strictEqual(s.decisive.metric, 'revenue')
  assert.strictEqual(s.meta.basis, 'step-dispersion')
  assert.strictEqual(s.note, "Revenue's updates vary in size — the projection is reasonable but not pinpoint.")
})

test('intel-v14 D11: a 2-step run ⇒ momentum speaks but NO stability key (the ≥3-step orthogonality floor)', async () => {
  // revenue [8000,10000,→12400]: only 2 steps. D10 has its early-vs-late pace to compare, so momentum
  // attaches — but D11 stays SILENT, because on 2 steps CV is a monotone function of D10's pace ratio and
  // would merely re-state it. This is the integration-level proof that D11 is not a second momentum lens.
  const history = [
    [{ metric: 'revenue', current: 8000 }],
    [{ metric: 'revenue', current: 10000 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })

  assert.strictEqual(result.nowcast.status, 'projected')
  assert.strictEqual('momentum' in result.nowcast, true)  // D10 speaks on the 2-step run…
  assert.strictEqual('stability' in result.nowcast, false) // …but D11 does not (would just echo D10).
})

test('intel-v14 D11: no projected nowcast ⇒ NO stability (additive, byte-identical envelope)', async () => {
  // Omitting `history` ⇒ no trend ⇒ no nowcast at all, so there is nothing for D11 to read and the
  // envelope is byte-identical to every pre-D11 caller.
  const result = await runScopeInsight(INPUT, fakeQuery(NEXT_RAW, PREVIOUS_RAW), { scopeClientId: '7', role: 'client' })
  assert.strictEqual('nowcast' in result, false)
})

test('intel-v14 D11: the stability payload embeds no tenant identity (renders identically on both surfaces)', async () => {
  const history = [
    [{ metric: 'revenue', current: 6400 }],
    [{ metric: 'revenue', current: 8400 }],
    [{ metric: 'revenue', current: 10400 }],
  ]
  const result = await runScopeInsight(
    { ...INPUT, history },
    fakeQuery(NEXT_RAW, PREVIOUS_RAW),
    { scopeClientId: '7', role: 'client' })
  const serialized = JSON.stringify(result.nowcast.stability)
  for (const needle of ['"7"', 'client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId']) {
    assert.ok(!serialized.includes(needle), `stability leaked tenant identity: ${needle}`)
  }
})
