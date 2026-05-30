// ============================================================
// test/ai.test.js — the grounding half of the Grounded-AI pipeline.
//
// Three guarantees, proven without a network call:
//   1. EVIDENCE-PACK EXACTNESS — every number buildEvidencePack emits is the
//      SAME number metricsCore.derive() computes over the seeded rows (same
//      rounding), so the pack the LLM narrates can never drift from the live
//      dashboard math.
//   2. GROUNDING VERIFIER — accepts text whose numbers trace to the pack,
//      rejects an invented one, and is scale-aware ("$1.4K" covers 1,440 but
//      "$801" does NOT cover 800).
//   3. generateRecapText is SAFE — a grounded draft passes through; an
//      ungrounded draft (twice) or a transport error or a missing key all
//      degrade to the deterministic template, grounded=true, never throwing.
//
// axios.post is monkey-patched on the shared module object so callAnthropic()
// is fully offline and deterministic. AI_MODEL is cleared up front so the
// default model string ('claude-haiku-4-5') is stable to assert against.
//
// Isolated temp SQLite DB — no Postgres, no network. Run with:  npm test
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Deterministic model string + force the SQLite backend at an isolated path
// BEFORE requiring ../db (mirrors test/recap.test.js).
delete process.env.AI_MODEL
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `aitest_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// Stub axios.post before requiring ../lib/ai. ai.js holds `const axios =
// require('axios')` and calls `axios.post(...)` at call-time, so overriding the
// method on the shared cached module object intercepts every Anthropic call.
const axios = require('axios')
let axiosCalls = 0
let axiosResponder = () => { throw new Error('no axios responder set') }
axios.post = async (...args) => { axiosCalls++; return axiosResponder(...args) }
// Build the Anthropic-shaped success envelope callAnthropic() expects.
const reply = (text) => ({ data: { content: [{ type: 'text', text }] } })

const db = require('../db')
const { AGG, derive, pctChange } = require('../lib/metricsCore')
const { buildEvidencePack } = require('../lib/evidence')
const { generateRecapText, verifyGrounding } = require('../lib/ai')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── rounding mirrors lib/evidence.js so "expected" lines up exactly ───────────
const r0 = n => Math.round(Number(n) || 0)
const r1 = n => Math.round((Number(n) || 0) * 10) / 10
const r2 = n => Math.round((Number(n) || 0) * 100) / 100
// Re-derive one delta block the SAME way evidence.delta() does.
function expDelta(curr, past, key, dp) {
  const round = dp === 2 ? r2 : dp === 1 ? r1 : r0
  const pc = pctChange(curr[key] || 0, past[key] || 0)
  return { current: round(curr[key] || 0), previous: round(past[key] || 0), pct_change: pc == null ? null : r1(pc) }
}

// ── helpers (same shape as test/recap.test.js) ───────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

let seq = 0
async function freshClient(name) {
  const id = `ai-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

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

const WEEK  = '2026-05-18'
const PRIOR = '2026-05-11'

// Same scenario as recap.test.js: revenue 800 (+25% WoW), 20 leads, 5 jobs,
// spend 200 (roas 4), MTD 1,440 → 48% of a $3,000 monthly goal.
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
  await db.query(
    `INSERT INTO client_goals (client_id, month, revenue_target) VALUES ($1,$2,$3)`,
    [c, '2026-05-01', 3000]
  )
  return c
}

// Independently aggregate + derive() one week, exactly as evidence.loadWeek does.
async function deriveWeek(clientId, weekStart) {
  const { rows } = await db.query(
    `SELECT ${AGG} FROM weekly_reports WHERE client_id = $1 AND week_start = $2`,
    [clientId, weekStart]
  )
  return derive(rows[0] || {})
}

// ── 1. EVIDENCE-PACK EXACTNESS vs derive() ───────────────────────────────────
test('evidence pack numbers equal derive() over the seeded rows, exactly', async () => {
  await ready()
  const c = await seedScenario('Exactness Roofing Co')

  const pack = await buildEvidencePack(c, WEEK)
  const curr = await deriveWeek(c, WEEK)
  const past = await deriveWeek(c, PRIOR)

  // Every metric block matches a from-scratch derive()+round of the same rows.
  assert.deepEqual(pack.metrics.revenue,    expDelta(curr, past, 'total_revenue', 0))
  assert.deepEqual(pack.metrics.leads,      expDelta(curr, past, 'total_leads',   0))
  assert.deepEqual(pack.metrics.jobs,       expDelta(curr, past, 'total_closed',  0))
  assert.deepEqual(pack.metrics.spend,      expDelta(curr, past, 'total_spend',   0))
  assert.deepEqual(pack.metrics.roas,       expDelta(curr, past, 'roas',          2))
  assert.deepEqual(pack.metrics.cpl,        expDelta(curr, past, 'cpl',           2))
  assert.deepEqual(pack.metrics.close_rate, expDelta(curr, past, 'close_rate',    1))

  // Spot-check the concrete canonical values too (guards the scenario itself).
  assert.equal(pack.metrics.revenue.current, 800)
  assert.equal(pack.metrics.revenue.pct_change, 25)
  assert.equal(pack.metrics.spend.current, 200)
  assert.equal(pack.metrics.roas.current, 4)
  assert.equal(pack.metrics.cpl.current, 10)
  assert.equal(pack.metrics.close_rate.current, 25)

  // Channels mirror the current-week row verbatim.
  assert.equal(pack.channels.google_ads.spend, 150)
  assert.equal(pack.channels.google_ads.leads, 12)
  assert.equal(pack.channels.gbp.calls, 30)
  assert.equal(pack.channels.ga4.sessions, 1200)

  // Goal pace is code-computed MTD/target.
  assert.equal(pack.goal.revenue_target, 3000)
  assert.equal(pack.goal.month_revenue, 1440)
  assert.equal(pack.goal.pct, 48)

  assert.equal(pack.meta.has_data, true)
})

// ── 2. GROUNDING VERIFIER ─────────────────────────────────────────────────────
test('verifier accepts pack-traceable numbers and rejects an invented one', async () => {
  await ready()
  const c = await seedScenario('Verifier Roofing Co')
  const pack = await buildEvidencePack(c, WEEK)

  // All numbers trace to the pack → grounded.
  const ok = verifyGrounding('Revenue was $800, up 25% week over week, from 20 leads and 5 jobs.', pack)
  assert.equal(ok.grounded, true)
  assert.equal(ok.offending.length, 0)

  // $801 is one dollar off 800 — outside its ±0.5 half-step → rejected.
  const bad = verifyGrounding('Revenue was $801 this week.', pack)
  assert.equal(bad.grounded, false)
  assert.ok(bad.offending.some(t => t.includes('801')))
})

test('verifier is scale-aware: $1.4K covers 1,440; a bare invented number does not', async () => {
  await ready()
  const c = await seedScenario('Scale Roofing Co')
  const pack = await buildEvidencePack(c, WEEK)  // goal.month_revenue === 1440

  // "$1.4K" → magnitude 1400 with a ±50 half-step, which reaches 1,440.
  assert.equal(verifyGrounding('About $1.4K booked month-to-date.', pack).grounded, true)

  // A number absent from the pack at full precision stays ungrounded.
  assert.equal(verifyGrounding('We saw $777 in stray spend.', pack).grounded, false)
})

// ── 3. generateRecapText SAFETY (stubbed Anthropic) ───────────────────────────
test('generateRecapText passes a grounded draft straight through', async () => {
  await ready()
  const c = await seedScenario('Passthrough Roofing Co')
  const pack = await buildEvidencePack(c, WEEK)

  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  const draft = 'Revenue was $800 for the week, up 25% week over week, on 20 leads and 5 jobs won.'
  axiosResponder = () => reply(draft)

  const res = await generateRecapText(pack)
  assert.equal(res.text, draft)
  assert.equal(res.grounded, true)
  assert.equal(res.model, 'claude-haiku-4-5')  // not the template fallback
  assert.equal(axiosCalls, 1)                   // accepted on first try, no retry

  delete process.env.ANTHROPIC_API_KEY
})

test('generateRecapText rejects an ungrounded draft and falls back to the template', async () => {
  await ready()
  const c = await seedScenario('Fallback Roofing Co')
  const pack = await buildEvidencePack(c, WEEK)

  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  // A hallucinated figure on every attempt → never verifies.
  axiosResponder = () => reply('Revenue exploded to $999,999 this week!')

  const res = await generateRecapText(pack)
  assert.equal(res.model, 'template')           // degraded to deterministic text
  assert.equal(res.grounded, true)              // template is grounded by construction
  assert.ok(!res.text.includes('999'))          // the hallucination never survives
  assert.match(res.text, /\$800/)               // template narrates the real number
  assert.equal(axiosCalls, 2)                   // tried once, retried strict once, then gave up

  delete process.env.ANTHROPIC_API_KEY
})

test('generateRecapText swallows a transport error and falls back to the template', async () => {
  await ready()
  const c = await seedScenario('Transport Roofing Co')
  const pack = await buildEvidencePack(c, WEEK)

  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  axiosResponder = () => { throw new Error('ECONNRESET') }

  const res = await generateRecapText(pack)   // must not throw
  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.match(res.text, /\$800/)
  assert.equal(axiosCalls, 1)                 // a transport failure short-circuits the retry loop

  delete process.env.ANTHROPIC_API_KEY
})

test('generateRecapText with no API key never calls the network', async () => {
  await ready()
  const c = await seedScenario('NoKey Roofing Co')
  const pack = await buildEvidencePack(c, WEEK)

  delete process.env.ANTHROPIC_API_KEY
  axiosCalls = 0
  axiosResponder = () => { throw new Error('should not be called') }

  const res = await generateRecapText(pack)
  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.match(res.text, /\$800/)
  assert.equal(axiosCalls, 0)                 // guarded before any HTTP
})
