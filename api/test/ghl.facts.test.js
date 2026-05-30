// ============================================================
// test/ghl.facts.test.js — unit + end-to-end test for connectors/ghl.js#fetchFacts.
//
// axios.get is stubbed (no network). Two layers:
//   1. transform — GHL contacts/opportunities → daily account-grain ghl facts
//      (raw_leads / mql / sql_count / closed_won / projected_revenue), zeros
//      skipped, entity = null, NO cross-channel lead facts (Phase 0 scope).
//   2. end-to-end — feed those facts through ingestFacts and confirm the rollup
//      derives the same weekly_reports CRM columns fetchStats used to write.
//
// DB-isolated temp SQLite (header runs before require('../db')).
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Isolated SQLite backend BEFORE requiring ../db (ingestFacts pulls it in).
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `ghl_facts_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db    = require('../db')
const axios = require('axios')
const ghl   = require('../connectors/ghl')
const { ingestFacts } = require('../routes/sync')

// ── stub axios.get: contacts list + opportunities search ─────────────────────
const realGet = axios.get
const CONTACTS = [
  { dateAdded: '2026-06-01T10:00:00Z', tags: ['MQL'] },
  { dateAdded: '2026-06-01T12:00:00Z', tags: ['SQL'] },
  { dateAdded: '2026-06-02T09:00:00Z', tags: [] },
]
const OPPS = [
  { createdAt: '2026-06-01T15:00:00Z', status: 'won',  monetaryValue: '1000' },
  { createdAt: '2026-06-02T15:00:00Z', status: 'open', monetaryValue: '500'  }, // not won → ignored
]
axios.get = async (url) => {
  if (url.includes('/contacts/'))            return { data: { contacts: CONTACTS } }
  if (url.includes('/opportunities/search')) return { data: { opportunities: OPPS } }
  throw new Error(`unexpected axios.get to ${url}`)
}

test.after(() => {
  axios.get = realGet
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

const CREDS  = { location_id: 'loc1', api_key: 'pit' }
const WINDOW = { since: '2026-06-01', until: '2026-06-07' }

// ── helpers ─────────────────────────────────────────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }
let seq = 0
async function freshClient(name) {
  const id = `ghl-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

// ── tests ─────────────────────────────────────────────────────────────────
test('fetchFacts: contacts/opps → daily account-grain ghl facts, zeros skipped', async () => {
  const { entities, facts } = await ghl.fetchFacts(CREDS, WINDOW)

  // CRM metrics are account-level → no entities
  assert.equal(entities.length, 0)

  // 06-01: raw_leads,mql,sql_count,closed_won,projected_revenue = 5 facts
  // 06-02: raw_leads only (mql/sql/won/rev all 0 → skipped)             = 1 fact
  assert.equal(facts.length, 6)
  assert.ok(facts.every(f => f.channel === 'ghl'))
  assert.ok(facts.every(f => f.entity === null))

  const cell = (date, key) =>
    facts.find(f => f.date === date && f.metric_key === key)?.value

  assert.equal(cell('2026-06-01', 'raw_leads'),         2)
  assert.equal(cell('2026-06-01', 'mql'),               1)
  assert.equal(cell('2026-06-01', 'sql_count'),         1)
  assert.equal(cell('2026-06-01', 'closed_won'),        1)
  assert.equal(cell('2026-06-01', 'projected_revenue'), 1000)
  assert.equal(cell('2026-06-02', 'raw_leads'),         1)
  // zero-valued metrics on 06-02 were skipped
  assert.equal(cell('2026-06-02', 'mql'),               undefined)
  assert.equal(cell('2026-06-02', 'closed_won'),        undefined)

  // Phase-0 scope: NO cross-channel lead facts (only the ghl channel)
  assert.ok(!facts.some(f => f.channel === 'google_ads' || f.channel === 'meta' || f.channel === 'lsa'))
})

test('fetchFacts → ingestFacts → weekly_reports derives the CRM columns', async () => {
  await ready()
  const c = await freshClient('GHL E2E Co')

  const payload = await ghl.fetchFacts(CREDS, WINDOW)
  const res = await ingestFacts(c, 'ghl', payload)
  assert.equal(res.facts, 6)
  assert.equal(res.entities, 0)

  // week of Monday 2026-06-01 (06-01 + 06-02 fall in the same week)
  const { rows } = await db.query(
    `SELECT * FROM weekly_reports WHERE client_id = $1 AND week_start = '2026-06-01'`, [c])
  const row = rows[0]
  assert.equal(Number(row.raw_leads),         3)    // 2 (06-01) + 1 (06-02)
  assert.equal(Number(row.mql),               1)
  assert.equal(Number(row.sql_count),         1)
  assert.equal(Number(row.closed_won),        1)
  assert.equal(Number(row.projected_revenue), 1000)
})
