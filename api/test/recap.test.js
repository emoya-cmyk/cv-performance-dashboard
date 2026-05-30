// ============================================================
// test/recap.test.js — orchestration + persistence tests for lib/recap.js.
//
// Proves the no-network half of the Grounded-AI recap pipeline end to end:
//   buildEvidencePack → generateRecapText (no key → deterministic template)
//        → idempotent upsert into ai_recaps → normalized read-back.
//
// ANTHROPIC_API_KEY is deleted up front so generateRecapText takes the
// deterministic templateRecap() branch — the recap is grounded by construction
// and the test needs no network. (The live-API + grounding-verifier behaviour is
// covered separately in test/ai.test.js.)
//
// Isolated temp SQLite DB — no Postgres, no network. Run with:  npm test
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// No key → force the deterministic template branch (and never hit the network).
delete process.env.ANTHROPIC_API_KEY

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `recap_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { generateRecap, getRecap, getOrGenerateRecap } = require('../lib/recap')

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
  const id = `recap-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

// Seed one weekly_reports row. Only the columns the evidence pack reads matter;
// the rest stay NULL and COALESCE to 0 in the AGG.
async function seedWeek(clientId, weekStart, w) {
  await db.query(
    `INSERT INTO weekly_reports
       (client_id, week_start, ads_spend, lsa_spend, meta_spend, ads_roas,
        ads_leads, meta_leads, gbp_calls, ga4_sessions,
        raw_leads, closed_won, projected_revenue)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [clientId, weekStart,
     w.ads_spend, w.lsa_spend, w.meta_spend, w.ads_roas,
     w.ads_leads, w.meta_leads, w.gbp_calls, w.ga4_sessions,
     w.raw_leads, w.closed_won, w.projected_revenue]
  )
}

async function recapCount(clientId, weekStart) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM ai_recaps WHERE client_id = $1 AND week_start = $2`,
    [clientId, weekStart]
  )
  return Number(rows[0].n)
}

// The week under test: Monday 2026-05-18 (current) vs 2026-05-11 (prior).
const WEEK  = '2026-05-18'
const PRIOR = '2026-05-11'

// Builds a client whose current week is revenue 800 (+25% WoW), 20 leads,
// 5 jobs, spend 200 (roas 4), against a $3,000 monthly goal at 48% MTD.
async function seedScenario(name) {
  const c = await freshClient(name)
  await seedWeek(c, WEEK, {
    ads_spend: 150, lsa_spend: 50, meta_spend: 0, ads_roas: 4,
    ads_leads: 12, meta_leads: 8, gbp_calls: 30, ga4_sessions: 1200,
    raw_leads: 20, closed_won: 5, projected_revenue: 800,
  })
  await seedWeek(c, PRIOR, {
    ads_spend: 120, lsa_spend: 40, meta_spend: 0, ads_roas: 4,
    ads_leads: 10, meta_leads: 6, gbp_calls: 25, ga4_sessions: 1000,
    raw_leads: 16, closed_won: 4, projected_revenue: 640,
  })
  // Monthly revenue goal: MTD = 640 (05-11) + 800 (05-18) = 1440 → 48% of 3000.
  await db.query(
    `INSERT INTO client_goals (client_id, month, revenue_target) VALUES ($1,$2,$3)`,
    [c, '2026-05-01', 3000]
  )
  return c
}

// ── tests ─────────────────────────────────────────────────────────────────
test('generateRecap with no API key persists a grounded template recap', async () => {
  await ready()
  const c = await seedScenario('Template Roofing Co')

  const res = await generateRecap(c, WEEK)

  // Deterministic fallback, grounded by construction.
  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.equal(res.client_id, c)
  assert.equal(res.week_start, WEEK)

  // The template narrates the seeded numbers verbatim.
  assert.match(res.recap_text, /\$800/)
  assert.match(res.recap_text, /25% week over week/)
  assert.match(res.recap_text, /20 leads and 5 jobs won/)
  assert.match(res.recap_text, /48% of the \$3,000 monthly revenue goal/)

  // Evidence pack came back attached and carries the canonical numbers.
  assert.equal(res.evidence_pack.metrics.revenue.current, 800)
  assert.equal(res.evidence_pack.metrics.revenue.pct_change, 25)
  assert.equal(res.evidence_pack.goal.pct, 48)
  assert.equal(res.evidence_pack.meta.has_data, true)

  // Exactly one row written.
  assert.equal(await recapCount(c, WEEK), 1)
})

test('generateRecap is idempotent on (client_id, week_start) — upsert in place', async () => {
  await ready()
  const c = await seedScenario('Idempotent Roofing Co')

  await generateRecap(c, WEEK)
  assert.equal(await recapCount(c, WEEK), 1)

  // Re-running the same week overwrites the same row rather than inserting.
  const again = await generateRecap(c, WEEK)
  assert.equal(again.grounded, true)
  assert.equal(await recapCount(c, WEEK), 1)
})

test('getRecap returns null before generation, normalized row after', async () => {
  await ready()
  const c = await seedScenario('Readback Roofing Co')

  assert.equal(await getRecap(c, WEEK), null)

  await generateRecap(c, WEEK)
  const row = await getRecap(c, WEEK)

  assert.ok(row)
  // grounded normalized to a real boolean (SQLite stores 0/1).
  assert.equal(row.grounded, true)
  assert.equal(typeof row.grounded, 'boolean')
  // evidence_pack normalized from the TEXT column back to an object.
  assert.equal(typeof row.evidence_pack, 'object')
  assert.equal(row.evidence_pack.client.name, 'Readback Roofing Co')
  assert.equal(row.evidence_pack.metrics.revenue.current, 800)
  assert.match(row.recap_text, /\$800/)
})

test('getOrGenerateRecap generates once, then returns the stored row', async () => {
  await ready()
  const c = await seedScenario('Cache Roofing Co')

  // First call: nothing stored → generate + persist.
  const first = await getOrGenerateRecap(c, WEEK)
  assert.equal(first.model, 'template')
  assert.equal(await recapCount(c, WEEK), 1)

  // Second call: served from storage, no new row.
  const second = await getOrGenerateRecap(c, WEEK)
  assert.equal(second.recap_text, first.recap_text)
  assert.equal(await recapCount(c, WEEK), 1)
})

test('no-data client yields a grounded "no data" template, still persisted', async () => {
  await ready()
  const c = await freshClient('Empty Roofing Co')  // no weekly_reports at all

  const res = await generateRecap(c, WEEK)
  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.equal(res.evidence_pack.meta.has_data, false)
  assert.match(res.recap_text, /No campaign data was recorded/)
  assert.equal(await recapCount(c, WEEK), 1)
})
