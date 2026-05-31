// ============================================================
// test/query.golden.test.js — golden parity + safety tests for the Phase 1
// semantic query layer (semantic/registry.js + semantic/compile.js +
// routes/query.js → POST /api/query).
//
// The load-bearing guarantee: POST /api/query, grouped by channel over a week,
// reproduces EXACTLY the numbers rebuildWeeklyRollup writes into weekly_reports.
// Both sides aggregate the same fact_metric grain (sum / unweighted-avg /
// SUM(num)/SUM(den) ratio); this test seeds one week of facts, runs BOTH paths,
// and asserts every mapped (channel, metric) cell agrees. If the query engine
// and the rollup ever drift, this fails.
//
// It then proves the things the wide weekly_reports table physically cannot do
// — daily grain, period-over-period compare, per-client breakdown — and that
// the registry allow-list rejects every off-vocabulary / injection input before
// it can reach SQL.
//
// Runs entirely on an isolated temp SQLite DB — no Postgres, no network, no live
// connectors. Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db, exactly
// as rollup.golden.test.js does. db.js delegates to db-sqlite when DATABASE_URL
// is unset; Node caches that module so compile.js / rollup.js (which both
// require('../db')) share this same temp file.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `query_golden_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db    = require('../db')
const facts = require('../lib/facts')
const { rebuildWeeklyRollup, weekStartOf, weekEndOf } = require('../lib/rollup')
const { runQuerySpec, validateQuerySpec, QuerySpecError } = require('../semantic/compile')

after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── helpers (mirrors rollup.golden.test.js) ─────────────────────────────────
const FACT_UPSERT = `
  INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
  VALUES ($1,$2,$3,$4,$5,$6)
  ON CONFLICT (client_id, date, channel_id, COALESCE(entity_id,0), metric_key)
  DO UPDATE SET metric_value = EXCLUDED.metric_value`

let migrated = false
async function ready() {
  if (!migrated) { await db.migrate(); migrated = true }
}

// Insert account-grain (entity_id NULL) facts: {date, channel, metric_key, value}.
async function insertAccountFacts(clientId, list) {
  for (const f of list) {
    await db.query(FACT_UPSERT, [clientId, f.date, facts.channelId(f.channel), null, f.metric_key, f.value])
  }
}

let seq = 0
async function freshClient(name) {
  const id = `q-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

async function weeklyRow(clientId, weekStart) {
  const { rows } = await db.query(
    `SELECT * FROM weekly_reports WHERE client_id = $1 AND week_start = $2`,
    [clientId, weekStart]
  )
  return rows[0]
}

const ALL_CHANNELS = ['google_ads', 'meta', 'lsa', 'gbp', 'ga4', 'ghl']

// A full week of account-grain facts spread across two days (Mon + Wed) of the
// week starting Monday 2026-06-01. Chosen so every channel and every aggregation
// kind is exercised: additive sums, two ratios (roas via revenue/spend) and two
// avg rates (engagement_rate, avg_ticket). Integer sums → exact float parity.
const WEEK = '2026-06-01'                 // Monday
const MON  = '2026-06-01'
const WED  = '2026-06-03'
function seedWeek(c) {
  return insertAccountFacts(c, [
    // ——— google_ads ———  spend 500, imp 15000, clk 300, leads 30, rev 1500 → roas 3
    { date: MON, channel: 'google_ads', metric_key: 'spend',       value: 300 },
    { date: WED, channel: 'google_ads', metric_key: 'spend',       value: 200 },
    { date: MON, channel: 'google_ads', metric_key: 'impressions', value: 10000 },
    { date: WED, channel: 'google_ads', metric_key: 'impressions', value: 5000 },
    { date: MON, channel: 'google_ads', metric_key: 'clicks',      value: 200 },
    { date: WED, channel: 'google_ads', metric_key: 'clicks',      value: 100 },
    { date: MON, channel: 'google_ads', metric_key: 'leads',       value: 20 },
    { date: WED, channel: 'google_ads', metric_key: 'leads',       value: 10 },
    { date: MON, channel: 'google_ads', metric_key: 'revenue',     value: 900 },
    { date: WED, channel: 'google_ads', metric_key: 'revenue',     value: 600 },
    // ——— meta ———  spend 150, imp 6000, clk 120, leads 12, rev 450 → roas 3
    { date: MON, channel: 'meta', metric_key: 'spend',       value: 100 },
    { date: WED, channel: 'meta', metric_key: 'spend',       value: 50 },
    { date: MON, channel: 'meta', metric_key: 'impressions', value: 4000 },
    { date: WED, channel: 'meta', metric_key: 'impressions', value: 2000 },
    { date: MON, channel: 'meta', metric_key: 'clicks',      value: 80 },
    { date: WED, channel: 'meta', metric_key: 'clicks',      value: 40 },
    { date: MON, channel: 'meta', metric_key: 'leads',       value: 8 },
    { date: WED, channel: 'meta', metric_key: 'leads',       value: 4 },
    { date: MON, channel: 'meta', metric_key: 'revenue',     value: 300 },
    { date: WED, channel: 'meta', metric_key: 'revenue',     value: 150 },
    // ——— lsa ———  spend 120, calls 8
    { date: MON, channel: 'lsa', metric_key: 'spend', value: 80 },
    { date: WED, channel: 'lsa', metric_key: 'spend', value: 40 },
    { date: MON, channel: 'lsa', metric_key: 'calls', value: 5 },
    { date: WED, channel: 'lsa', metric_key: 'calls', value: 3 },
    // ——— gbp ———  views 150, searches 50, calls 10, directions 20, web clicks 12
    { date: MON, channel: 'gbp', metric_key: 'views',          value: 100 },
    { date: WED, channel: 'gbp', metric_key: 'views',          value: 50 },
    { date: MON, channel: 'gbp', metric_key: 'searches',       value: 30 },
    { date: WED, channel: 'gbp', metric_key: 'searches',       value: 20 },
    { date: MON, channel: 'gbp', metric_key: 'calls',          value: 6 },
    { date: WED, channel: 'gbp', metric_key: 'calls',          value: 4 },
    { date: MON, channel: 'gbp', metric_key: 'directions',     value: 12 },
    { date: WED, channel: 'gbp', metric_key: 'directions',     value: 8 },
    { date: MON, channel: 'gbp', metric_key: 'website_clicks', value: 8 },
    { date: WED, channel: 'gbp', metric_key: 'website_clicks', value: 4 },
    // ——— ga4 ———  sessions 1500, new 600, org 900, paid 300, direct 150,
    //               conversions 20, engagement_rate AVG(0.50,0.60)=0.55
    { date: MON, channel: 'ga4', metric_key: 'sessions',         value: 1000 },
    { date: WED, channel: 'ga4', metric_key: 'sessions',         value: 500 },
    { date: MON, channel: 'ga4', metric_key: 'new_users',        value: 400 },
    { date: WED, channel: 'ga4', metric_key: 'new_users',        value: 200 },
    { date: MON, channel: 'ga4', metric_key: 'organic_sessions', value: 600 },
    { date: WED, channel: 'ga4', metric_key: 'organic_sessions', value: 300 },
    { date: MON, channel: 'ga4', metric_key: 'paid_sessions',    value: 200 },
    { date: WED, channel: 'ga4', metric_key: 'paid_sessions',    value: 100 },
    { date: MON, channel: 'ga4', metric_key: 'direct_sessions',  value: 100 },
    { date: WED, channel: 'ga4', metric_key: 'direct_sessions',  value: 50 },
    { date: MON, channel: 'ga4', metric_key: 'conversions',      value: 14 },
    { date: WED, channel: 'ga4', metric_key: 'conversions',      value: 6 },
    { date: MON, channel: 'ga4', metric_key: 'engagement_rate',  value: 0.50 },
    { date: WED, channel: 'ga4', metric_key: 'engagement_rate',  value: 0.60 },
    // ——— ghl ———  raw 60, mql 40, sql 20, won 8, proj 100000,
    //               avg_ticket AVG(15000,13000)=14000
    { date: MON, channel: 'ghl', metric_key: 'raw_leads',         value: 40 },
    { date: WED, channel: 'ghl', metric_key: 'raw_leads',         value: 20 },
    { date: MON, channel: 'ghl', metric_key: 'mql',               value: 25 },
    { date: WED, channel: 'ghl', metric_key: 'mql',               value: 15 },
    { date: MON, channel: 'ghl', metric_key: 'sql_count',         value: 12 },
    { date: WED, channel: 'ghl', metric_key: 'sql_count',         value: 8 },
    { date: MON, channel: 'ghl', metric_key: 'closed_won',        value: 5 },
    { date: WED, channel: 'ghl', metric_key: 'closed_won',        value: 3 },
    { date: MON, channel: 'ghl', metric_key: 'projected_revenue', value: 60000 },
    { date: WED, channel: 'ghl', metric_key: 'projected_revenue', value: 40000 },
    { date: MON, channel: 'ghl', metric_key: 'avg_ticket',        value: 15000 },
    { date: WED, channel: 'ghl', metric_key: 'avg_ticket',        value: 13000 },
  ])
}

// Which (channel → metric ids) cross-check against the rollup's weekly columns.
// Only metrics that map to a real weekly_reports column are listed; the query
// engine computes more (e.g. cpl) but the wide table has no column to compare.
const CHECK = {
  google_ads: ['spend', 'impressions', 'clicks', 'leads', 'roas'],
  meta:       ['spend', 'impressions', 'clicks', 'leads', 'roas'],
  lsa:        ['spend', 'calls'],
  gbp:        ['views', 'searches', 'calls', 'directions', 'website_clicks'],
  ga4:        ['sessions', 'new_users', 'organic_sessions', 'paid_sessions', 'direct_sessions', 'conversions', 'engagement_rate'],
  ghl:        ['raw_leads', 'mql', 'sql_count', 'closed_won', 'projected_revenue', 'avg_ticket'],
}
// metric id → the fact-side metric_key used by COLUMN_FACT_MAP (identical except
// the roas ratio, whose weekly column ads_roas/meta_roas carries metric_key 'roas').
const weeklyColFor = (channel, mid) => facts.columnFor(channel, mid === 'roas' ? 'roas' : mid)

// The flat union of every metric id we cross-check (deduped, order-stable).
const ALL_METRICS = [...new Set(Object.values(CHECK).flat())]

// ── tests ───────────────────────────────────────────────────────────────────

test('GOLDEN: /api/query groupBy channel reproduces every weekly_reports column', async () => {
  await ready()
  const c = await freshClient('Parity Co')
  await seedWeek(c)

  // Path A — the legacy wide table, derived by the rollup.
  const res = await rebuildWeeklyRollup(c, [WEEK], ALL_CHANNELS)
  assert.equal(res.weeks, 1)
  const row = await weeklyRow(c, WEEK)

  // Path B — the semantic query engine over the same facts.
  const out = await runQuerySpec({
    clients:  [c],
    metrics:  ALL_METRICS,
    dateRange: { start: WEEK, end: weekEndOf(WEEK) },
    groupBy:  ['channel'],
  }, db.query)

  // Every mapped (channel, metric) cell must agree exactly.
  for (const [channel, metricIds] of Object.entries(CHECK)) {
    const qRow = out.rows.find(r => r.channel === channel)
    assert.ok(qRow, `query returned a row for ${channel}`)
    for (const mid of metricIds) {
      const col = weeklyColFor(channel, mid)
      assert.ok(col, `expected a weekly column for ${channel}.${mid}`)
      assert.equal(
        qRow[mid], Number(row[col]),
        `${channel}.${mid} (query=${qRow[mid]}) must equal weekly ${col} (=${row[col]})`
      )
    }
  }

  // Spot-check the two ratios and two averages explicitly (the interesting math).
  const ga = out.rows.find(r => r.channel === 'google_ads')
  const g4 = out.rows.find(r => r.channel === 'ga4')
  const gh = out.rows.find(r => r.channel === 'ghl')
  assert.equal(ga.roas, 3)              // 1500 / 500, SUM(num)/SUM(den)
  assert.equal(g4.engagement_rate, 0.55) // unweighted AVG(0.50, 0.60)
  assert.equal(gh.avg_ticket, 14000)     // unweighted AVG(15000, 13000)

  // Framing: one row per channel that has facts, metric columns described.
  assert.equal(out.rows.length, 6)
  assert.equal(out.meta.grain, 'period')
  assert.deepEqual([...out.meta.channels].sort(), [...ALL_CHANNELS].sort())
})

test('daily grain exposes per-day totals the weekly table cannot (spend by day)', async () => {
  await ready()
  const c = await freshClient('Daily Co')
  await seedWeek(c)

  const out = await runQuerySpec({
    clients:  [c],
    metrics:  ['spend'],
    dateRange: { start: WEEK, end: weekEndOf(WEEK) },
    groupBy:  ['date:day'],
  }, db.query)

  // spend exists on Mon + Wed only, summed across google_ads + meta + lsa.
  assert.equal(out.rows.length, 2)
  assert.equal(out.meta.grain, 'day')
  assert.equal(out.rows[0].date, MON)            // default order: date ascending
  assert.equal(out.rows[0].spend, 480)           // 300 + 100 + 80
  assert.equal(out.rows[1].date, WED)
  assert.equal(out.rows[1].spend, 290)           // 200 + 50 + 40
  // …and the two days sum back to the week's total spend (500 + 150 + 120).
  assert.equal(out.rows[0].spend + out.rows[1].spend, 770)
})

test('weekly grain buckets every day into the Monday week-start', async () => {
  await ready()
  const c = await freshClient('Weekly Co')
  await seedWeek(c)

  const out = await runQuerySpec({
    clients:  [c],
    metrics:  ['spend', 'roas'],
    dateRange: { start: WEEK, end: weekEndOf(WEEK) },
    groupBy:  ['date:week'],
  }, db.query)

  assert.equal(out.rows.length, 1)
  assert.equal(out.meta.grain, 'week')
  assert.equal(out.rows[0].date, weekStartOf(WED)) // Wed buckets to Monday 06-01
  assert.equal(out.rows[0].date, WEEK)
  assert.equal(out.rows[0].spend, 770)             // all channels, whole week
  assert.equal(out.rows[0].roas, 2.53)             // round2(rev 1950 / spend 770)
})

test('compareTo previous_period attaches _compare and _delta', async () => {
  await ready()
  const c = await freshClient('Compare Co')
  await seedWeek(c)
  // Previous period for [06-01..06-07] is [05-25..05-31]; seed google_ads spend 400.
  await insertAccountFacts(c, [
    { date: '2026-05-25', channel: 'google_ads', metric_key: 'spend', value: 400 },
  ])

  const out = await runQuerySpec({
    clients:  [c],
    metrics:  ['spend'],
    dateRange: { start: WEEK, end: weekEndOf(WEEK) },
    groupBy:  ['channel'],
    filters:  [{ dim: 'channel', op: 'in', values: ['google_ads'] }],
    compareTo: 'previous_period',
  }, db.query)

  assert.equal(out.rows.length, 1)
  const r = out.rows[0]
  assert.equal(r.channel, 'google_ads')
  assert.equal(r.spend, 500)            // current week
  assert.equal(r._compare.spend, 400)   // previous period
  assert.equal(r._delta.spend, 100)     // 500 - 400
  // meta echoes the resolved comparison window.
  assert.deepEqual(out.meta.compareTo, { start: '2026-05-25', end: '2026-05-31' })
})

test('compareTo is ignored (with a note) when grouping by date', async () => {
  await ready()
  const c = await freshClient('Compare Date Co')
  await seedWeek(c)

  const out = await runQuerySpec({
    clients:  [c],
    metrics:  ['spend'],
    dateRange: { start: WEEK, end: weekEndOf(WEEK) },
    groupBy:  ['date:day'],
    compareTo: 'previous_period',
  }, db.query)

  assert.equal(out.meta.compareTo, null)
  assert.match(out.meta.note || '', /ignored when grouping by date/)
  assert.ok(out.rows.every(r => r._delta === undefined))
})

test('groupBy client breaks down by client and decorates client_name', async () => {
  await ready()
  const a = await freshClient('Alpha Co')
  const b = await freshClient('Beta Co')
  await insertAccountFacts(a, [{ date: MON, channel: 'google_ads', metric_key: 'spend', value: 100 }])
  await insertAccountFacts(b, [{ date: MON, channel: 'google_ads', metric_key: 'spend', value: 250 }])

  const out = await runQuerySpec({
    clients:  [a, b],
    metrics:  ['spend'],
    dateRange: { start: WEEK, end: weekEndOf(WEEK) },
    groupBy:  ['client'],
  }, db.query)

  const byId = Object.fromEntries(out.rows.map(r => [r.client, r]))
  assert.equal(byId[a].spend, 100)
  assert.equal(byId[a].client_name, 'Alpha Co')
  assert.equal(byId[b].spend, 250)
  assert.equal(byId[b].client_name, 'Beta Co')
  // default order = first metric descending → Beta (250) before Alpha (100)
  assert.equal(out.rows[0].client, b)
  assert.equal(out.meta.clients, 2)
})

test('validateQuerySpec normalizes a valid spec and folds channel filter → ids', () => {
  const norm = validateQuerySpec({
    metrics:  ['spend', 'roas'],
    dateRange: { start: '2026-06-01', end: '2026-06-07' },
    groupBy:  ['channel'],
    filters:  [{ dim: 'channel', op: 'in', values: ['google_ads', 'meta'] }],
  })
  assert.deepEqual(norm.metrics, ['spend', 'roas'])
  assert.deepEqual(norm.channelIds, [1, 2]) // google_ads, meta per migration 011
  assert.equal(norm.clients, 'all')
  assert.equal(norm.limit, 1000)
})

test('allow-list rejects every off-registry / injection input', () => {
  const RANGE = { dateRange: { start: '2026-06-01', end: '2026-06-07' } }
  const bad = [
    // unknown / injection-laden metric ids
    { metrics: ['spend; DROP TABLE clients'], ...RANGE },
    { metrics: ["spend') OR 1=1--"], ...RANGE },
    { metrics: ['revenue', 'totally_made_up'], ...RANGE },
    { metrics: [], ...RANGE },                                  // empty
    // unknown groupBy token
    { metrics: ['spend'], groupBy: ['channel; DROP'], ...RANGE },
    { metrics: ['spend'], groupBy: ['date:century'], ...RANGE }, // bad grain
    // two date groupings
    { metrics: ['spend'], groupBy: ['date:day', 'date:week'], ...RANGE },
    // bad filters
    { metrics: ['spend'], filters: [{ dim: 'evil', op: 'in', values: ['x'] }], ...RANGE },
    { metrics: ['spend'], filters: [{ dim: 'channel', op: 'in', values: ['hackernews'] }], ...RANGE },
    { metrics: ['spend'], filters: [{ dim: 'channel', op: 'like', values: ['google_ads'] }], ...RANGE },
    { metrics: ['spend'], filters: [{ dim: 'channel', op: 'in', values: [] }], ...RANGE },
    // bad dateRange
    { metrics: ['spend'], dateRange: { start: 'nope', end: '2026-06-07' } },
    { metrics: ['spend'], dateRange: { start: '2026-06-08', end: '2026-06-01' } },
    // bad orderBy / compareTo / limit
    { metrics: ['spend'], orderBy: [{ key: 'revenue', dir: 'asc' }], ...RANGE }, // not a requested metric
    { metrics: ['spend'], compareTo: 'next_lifetime', ...RANGE },
    { metrics: ['spend'], limit: 0, ...RANGE },
    { metrics: ['spend'], clients: [], ...RANGE },              // empty client list
  ]
  for (const spec of bad) {
    assert.throws(() => validateQuerySpec(spec), QuerySpecError,
      `expected rejection for ${JSON.stringify(spec)}`)
  }
})

test('runQuerySpec rejects an off-registry metric end-to-end (the 400 path)', async () => {
  await ready()
  await assert.rejects(
    runQuerySpec({ metrics: ['nonexistent'], dateRange: { start: WEEK, end: weekEndOf(WEEK) } }, db.query),
    QuerySpecError
  )
})
