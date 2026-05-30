// ============================================================
// test/ingest.facts.test.js — direct tests for routes/sync.js#ingestFacts,
// the entity-aware atomic ingest that backs every connector's new fetchFacts()
// path.
//
// Where rollup.golden.test.js proves the account-grain pivot, this proves the
// full connector contract:
//   • { entities, facts } lands dim_entity rows at campaign grain
//   • parent_external_id resolves to a real parent_id (account ← campaign)
//   • re-ingesting the same payload is idempotent (no duplicate entities/facts)
//   • facts carry a non-null entity_id (campaign grain, not account grain)
//   • the column-scoped rollup still derives weekly_reports (ads_spend, ads_roas)
//
// Isolated temp SQLite DB — no Postgres, no network, no live connectors.
// Requiring ../routes/sync pulls in realtime (side-effect-free; broadcast is a
// no-op with no SSE clients) and the 6 connectors (each only require('axios')).
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `ingest_facts_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const facts = require('../lib/facts')
const { ingestFacts } = require('../routes/sync')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── helpers ─────────────────────────────────────────────────────────────────
let migrated = false
async function ready() {
  if (!migrated) { await db.migrate(); migrated = true }
}

let seq = 0
async function freshClient(name) {
  const id = `ingest-${process.pid}-${++seq}`
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

// A two-campaign Google Ads payload over the week of Monday 2026-06-01.
// Account "acct1" is the parent of campaigns "c1" (Brand) and "c2" (Generic).
// Note the embedded fact entities omit name — they must merge with the named
// catalog entries supplied in `entities`.
function googleAdsPayload() {
  return {
    entities: [
      { type: 'account',  external_id: 'acct1', name: 'Acme Roofing' },
      { type: 'campaign', external_id: 'c1', name: 'Brand',   parent_external_id: 'acct1' },
      { type: 'campaign', external_id: 'c2', name: 'Generic', parent_external_id: 'acct1' },
    ],
    facts: [
      // campaign c1 — spend 100+50=150, revenue 300+150=450
      { date: '2026-06-01', channel: 'google_ads', entity: { type: 'campaign', external_id: 'c1' }, metric_key: 'spend',   value: 100 },
      { date: '2026-06-01', channel: 'google_ads', entity: { type: 'campaign', external_id: 'c1' }, metric_key: 'revenue', value: 300 },
      { date: '2026-06-02', channel: 'google_ads', entity: { type: 'campaign', external_id: 'c1' }, metric_key: 'spend',   value: 50 },
      { date: '2026-06-02', channel: 'google_ads', entity: { type: 'campaign', external_id: 'c1' }, metric_key: 'revenue', value: 150 },
      // campaign c2 — spend 200, revenue 400
      { date: '2026-06-01', channel: 'google_ads', entity: { type: 'campaign', external_id: 'c2' }, metric_key: 'spend',   value: 200 },
      { date: '2026-06-01', channel: 'google_ads', entity: { type: 'campaign', external_id: 'c2' }, metric_key: 'revenue', value: 400 },
    ],
  }
}

const GADS = facts.channelId('google_ads')

// ── tests ─────────────────────────────────────────────────────────────────
test('ingestFacts lands entities at campaign grain and resolves parent links', async () => {
  await ready()
  const c = await freshClient('Entity Co')

  const res = await ingestFacts(c, 'google_ads', googleAdsPayload())
  assert.equal(res.entities, 3)          // account + 2 campaigns
  assert.equal(res.facts, 6)             // 6 metric rows landed

  // 3 dim_entity rows, all on the google_ads channel.
  const ents = await db.query(
    `SELECT entity_type, external_id, name, parent_id, id
       FROM dim_entity WHERE client_id = $1 AND channel_id = $2
      ORDER BY external_id`,
    [c, GADS]
  )
  assert.equal(ents.rows.length, 3)

  const acct = ents.rows.find(r => r.external_id === 'acct1')
  const c1   = ents.rows.find(r => r.external_id === 'c1')
  const c2   = ents.rows.find(r => r.external_id === 'c2')

  // names merged from the catalog even though the embedded fact entities had none
  assert.equal(acct.name, 'Acme Roofing')
  assert.equal(c1.name, 'Brand')
  assert.equal(c2.name, 'Generic')

  // account has no parent; both campaigns point at the account
  assert.equal(acct.parent_id, null)
  assert.equal(c1.parent_id, acct.id)
  assert.equal(c2.parent_id, acct.id)
})

test('ingestFacts writes facts at campaign grain (entity_id NOT NULL)', async () => {
  await ready()
  const c = await freshClient('Grain Co')
  await ingestFacts(c, 'google_ads', googleAdsPayload())

  // every google_ads fact carries a campaign entity_id — none at account grain
  const nullGrain = await db.query(
    `SELECT COUNT(*) AS n FROM fact_metric
      WHERE client_id = $1 AND channel_id = $2 AND entity_id IS NULL`,
    [c, GADS]
  )
  assert.equal(Number(nullGrain.rows[0].n), 0)

  // spot-check one atomic cell: c1 spend on 2026-06-01 = 100
  const cell = await db.query(
    `SELECT metric_value FROM fact_metric fm
       JOIN dim_entity e ON e.id = fm.entity_id
      WHERE fm.client_id = $1 AND fm.date = '2026-06-01'
        AND fm.metric_key = 'spend' AND e.external_id = 'c1'`,
    [c]
  )
  assert.equal(Number(cell.rows[0].metric_value), 100)
})

test('ingestFacts derives weekly_reports via the column-scoped rollup', async () => {
  await ready()
  const c = await freshClient('Rollup Co')
  await ingestFacts(c, 'google_ads', googleAdsPayload())

  // week of Monday 2026-06-01
  const row = await weeklyRow(c, '2026-06-01')
  // ads_spend = 150 (c1) + 200 (c2) = 350
  assert.equal(Number(row.ads_spend), 350)
  // ads_roas = SUM(revenue) / SUM(spend) = (450 + 400) / 350 = 850/350 = 2.43
  assert.equal(Number(row.ads_roas), 2.43)
})

test('ingestFacts is idempotent: re-ingest reuses entities and replaces facts', async () => {
  await ready()
  const c = await freshClient('Idem Co')
  await ingestFacts(c, 'google_ads', googleAdsPayload())
  const second = await ingestFacts(c, 'google_ads', googleAdsPayload())

  // same catalog size reported back
  assert.equal(second.entities, 3)

  // still exactly 3 entities and 6 facts — no duplicates from the second pass
  const ents = await db.query(
    `SELECT COUNT(*) AS n FROM dim_entity WHERE client_id = $1`, [c])
  assert.equal(Number(ents.rows[0].n), 3)

  const fm = await db.query(
    `SELECT COUNT(*) AS n FROM fact_metric WHERE client_id = $1`, [c])
  assert.equal(Number(fm.rows[0].n), 6)

  // weekly totals unchanged after the idempotent re-ingest
  const row = await weeklyRow(c, '2026-06-01')
  assert.equal(Number(row.ads_spend), 350)
  assert.equal(Number(row.ads_roas), 2.43)
})
