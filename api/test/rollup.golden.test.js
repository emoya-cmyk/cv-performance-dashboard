// ============================================================
// test/rollup.golden.test.js — golden parity tests for the Phase 0
// fact-grain rollup (lib/facts.js + lib/rollup.js + migrations 010/011).
//
// These lock in the guarantee that deriving weekly_reports from fact_metric
// produces the SAME numbers the legacy fetchStats path wrote directly, so the
// wide table (and the entire current frontend) keeps working unchanged while
// connectors migrate to the atomic grain one at a time.
//
// Runs entirely on an isolated temp SQLite DB — no Postgres, no network, no
// live connectors. Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
// db.js delegates to db-sqlite whenever DATABASE_URL is unset, and Node caches
// that module so rollup.js (which does require('../db')) shares this same
// connection / temp file.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `rollup_golden_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db    = require('../db')
const facts = require('../lib/facts')
const { rebuildWeeklyRollup, weekStartOf } = require('../lib/rollup')

after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── helpers ─────────────────────────────────────────────────────────────────
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
  const id = `gold-${process.pid}-${++seq}`
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

// ── tests ─────────────────────────────────────────────────────────────────
test('migration seeds the 11 channels and the fact grain dedupes account rows', async () => {
  await ready()

  const ch = await db.query('SELECT id, key FROM dim_channel ORDER BY id')
  assert.equal(ch.rows.length, 11)
  assert.deepEqual(
    ch.rows.map(r => r.key),
    ['google_ads', 'meta', 'lsa', 'gbp', 'ga4', 'ghl', 'organic',
     'callrail', 'housecallpro', 'bing_ads', 'youtube']
  )

  const c = await freshClient('Grain Co')
  // Same (client, date, channel, NULL entity, metric) twice → one row, replaced.
  await insertAccountFacts(c, [
    { date: '2026-05-25', channel: 'google_ads', metric_key: 'spend', value: 100 },
    { date: '2026-05-25', channel: 'google_ads', metric_key: 'spend', value: 250 },
  ])
  const r = await db.query(
    `SELECT metric_value FROM fact_metric
      WHERE client_id = $1 AND metric_key = 'spend' AND entity_id IS NULL`,
    [c]
  )
  assert.equal(r.rows.length, 1)
  assert.equal(Number(r.rows[0].metric_value), 250)
})

test('weekly row → facts → rollup round-trips every mapped column (golden parity)', async () => {
  await ready()
  const c    = await freshClient('Parity Co')
  const week = weekStartOf('2026-05-27') // Wed → Monday 2026-05-25

  // A representative wide row touching every channel, including both ratio
  // columns (ads_roas, meta_roas) and both avg columns (ga4_engagement_rate,
  // avg_ticket).
  const original = {
    week_start: week,
    ads_spend: 1000, ads_impressions: 50000, ads_clicks: 1200, ads_leads: 45, ads_roas: 3.5,
    lsa_spend: 800, lsa_impressions: 20000, lsa_calls: 60, lsa_booked_jobs: 15,
    meta_spend: 500, meta_impressions: 30000, meta_clicks: 900, meta_leads: 25, meta_roas: 2,
    gbp_views: 4000, gbp_searches: 2500, gbp_calls: 80, gbp_directions: 120, gbp_website_clicks: 300,
    ga4_sessions: 6000, ga4_new_users: 3500, ga4_organic_sessions: 2000, ga4_paid_sessions: 1500,
    ga4_direct_sessions: 900, ga4_conversions: 140, ga4_engagement_rate: 0.62,
    raw_leads: 70, mql: 40, sql_count: 22, closed_won: 8, projected_revenue: 120000, avg_ticket: 15000,
  }

  // Legacy bridge: a wide row → account-grain facts dated on week_start.
  const factList = facts.factsFromWeeklyRow(original)
  await insertAccountFacts(c, factList)

  const res = await rebuildWeeklyRollup(c, [week], ALL_CHANNELS)
  assert.equal(res.weeks, 1)

  const row = await weeklyRow(c, week)
  for (const col of Object.keys(facts.COLUMN_FACT_MAP)) {
    assert.equal(Number(row[col]), original[col], `column ${col} should round-trip`)
  }
})

test('rollup aggregates across days: SUM, ratio = SUM(num)/SUM(den), AVG', async () => {
  await ready()
  const c    = await freshClient('Aggregate Co')
  const week = weekStartOf('2026-06-01') // Monday

  await insertAccountFacts(c, [
    // google_ads spend across Mon/Wed/Fri → SUM = 1000
    { date: '2026-06-01', channel: 'google_ads', metric_key: 'spend',   value: 300 },
    { date: '2026-06-03', channel: 'google_ads', metric_key: 'spend',   value: 200 },
    { date: '2026-06-05', channel: 'google_ads', metric_key: 'spend',   value: 500 },
    // revenue → SUM = 3000, so ads_roas = 3000 / 1000 = 3
    { date: '2026-06-01', channel: 'google_ads', metric_key: 'revenue', value: 900 },
    { date: '2026-06-03', channel: 'google_ads', metric_key: 'revenue', value: 800 },
    { date: '2026-06-05', channel: 'google_ads', metric_key: 'revenue', value: 1300 },
    // ga4 engagement rate → AVG(0.4, 0.5, 0.6) = 0.5 (not additive)
    { date: '2026-06-01', channel: 'ga4', metric_key: 'engagement_rate', value: 0.40 },
    { date: '2026-06-03', channel: 'ga4', metric_key: 'engagement_rate', value: 0.50 },
    { date: '2026-06-05', channel: 'ga4', metric_key: 'engagement_rate', value: 0.60 },
  ])

  await rebuildWeeklyRollup(c, [week], ['google_ads', 'ga4'])
  const row = await weeklyRow(c, week)
  assert.equal(Number(row.ads_spend), 1000)          // SUM
  assert.equal(Number(row.ads_roas), 3)              // ratio
  assert.equal(Number(row.ga4_engagement_rate), 0.5) // AVG
})

test('rollup is column-scoped: only the rebuilt channels are written; others coexist', async () => {
  await ready()
  const c    = await freshClient('Scope Co')
  const week = weekStartOf('2026-06-01')

  await insertAccountFacts(c, [
    { date: '2026-06-01', channel: 'google_ads', metric_key: 'spend',     value: 1000 },
    { date: '2026-06-01', channel: 'ghl',        metric_key: 'raw_leads', value: 50 },
  ])

  // Rebuild ONLY google_ads — ghl columns must stay untouched (NULL).
  await rebuildWeeklyRollup(c, [week], ['google_ads'])
  let row = await weeklyRow(c, week)
  assert.equal(Number(row.ads_spend), 1000)
  assert.equal(row.raw_leads, null)

  // Now rebuild ghl — its column fills in, google_ads stays intact.
  await rebuildWeeklyRollup(c, [week], ['ghl'])
  row = await weeklyRow(c, week)
  assert.equal(Number(row.ads_spend), 1000)
  assert.equal(Number(row.raw_leads), 50)
})

test('rollup never overwrites a non-zero weekly value with zero (smart-upsert parity)', async () => {
  await ready()
  const c    = await freshClient('Guard Co')
  const week = weekStartOf('2026-06-01')

  await insertAccountFacts(c, [
    { date: '2026-06-01', channel: 'google_ads', metric_key: 'spend', value: 1000 },
  ])
  await rebuildWeeklyRollup(c, [week], ['google_ads'])
  assert.equal(Number((await weeklyRow(c, week)).ads_spend), 1000)

  // A later re-sync that finds zero spend that week must NOT clobber the 1000.
  await db.query(`DELETE FROM fact_metric WHERE client_id = $1 AND metric_key = 'spend'`, [c])
  await rebuildWeeklyRollup(c, [week], ['google_ads'])
  assert.equal(Number((await weeklyRow(c, week)).ads_spend), 1000)
})
