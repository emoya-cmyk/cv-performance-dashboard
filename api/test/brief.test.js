// ============================================================
// test/brief.test.js — orchestration + grounding tests for the AI Morning Brief
// (lib/brief.js over lib/pulseBrief.js + lib/ai.js generateBriefText).
//
// The daily analog of test/recap.test.js. Two halves, both proven offline:
//
//   A. ORCHESTRATION + PERSISTENCE (no API key → deterministic template branch).
//      getClientPulse / getPortfolioPulse → buildClientBriefPack /
//      buildPortfolioBriefPack → generateBriefText (template, grounded by
//      construction) → idempotent upsert into ai_briefs (scope_key, as_of) →
//      normalized read-back. Both audiences: a client keyed on its id, the
//      portfolio keyed on the reserved '__portfolio__' scope with a NULL client_id.
//
//   B. GROUNDED-AI SAFETY (stubbed Anthropic). generateBriefText narrates a
//      synthetic pack: a grounded draft passes straight through; an ungrounded
//      draft (twice) degrades to the deterministic template — for the CLIENT and
//      the AGENCY prompt alike. Never throws, never emits an unverified number.
//
// axios.post is monkey-patched on the shared module object BEFORE requiring
// ../lib/brief (which transitively requires ../lib/ai), so callAnthropic() is
// fully offline. ANTHROPIC_API_KEY is deleted up front (orchestration takes the
// template branch); the safety tests set it only for their own scope and clear
// it again. AI_MODEL is cleared so the default model string is stable to assert.
//
// Isolated temp SQLite DB — no Postgres, no network. Run with:  node --test
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// No key → orchestration tests take the deterministic template branch and never
// hit the network. Stable default model string for the passthrough assertion.
delete process.env.ANTHROPIC_API_KEY
delete process.env.AI_MODEL

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `brief_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// Stub axios.post before requiring ../lib/brief → ../lib/ai. ai.js holds
// `const axios = require('axios')` and calls `axios.post(...)` at call-time, so
// overriding the method on the shared cached module object intercepts every
// Anthropic call (identical idiom to test/ai.test.js).
const axios = require('axios')
let axiosCalls = 0
let axiosResponder = () => { throw new Error('no axios responder set') }
axios.post = async (...args) => { axiosCalls++; return axiosResponder(...args) }
const reply = (text) => ({ data: { content: [{ type: 'text', text }] } })

const db = require('../db')
const {
  generateClientBrief, generatePortfolioBrief,
  getClientBrief, getPortfolioBrief,
  getOrGenerateClientBrief, getOrGeneratePortfolioBrief,
  PORTFOLIO_KEY,
} = require('../lib/brief')
const { generateBriefText } = require('../lib/ai')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── helpers (same shape as test/recap.test.js) ───────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

let seq = 0
async function freshClient(name) {
  const id = `brief-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

async function briefCount(scopeKey, asOf) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM ai_briefs WHERE scope_key = $1 AND as_of = $2`,
    [scopeKey, asOf]
  )
  return Number(rows[0].n)
}

// A single calendar morning to key briefs on (no Monday snap — a brief is one
// DAY's pulse). With no fact_metric data seeded, the pulse is calm by
// construction, which is all the orchestration half needs to prove.
const AS_OF = '2026-05-18'

// ── A. ORCHESTRATION + PERSISTENCE (no key → template) ───────────────────────
test('generateClientBrief with no API key persists a grounded template brief', async () => {
  await ready()
  const c = await freshClient('Template Brief Roofing Co')

  axiosCalls = 0
  const res = await generateClientBrief(c, AS_OF)

  // Deterministic fallback, grounded by construction, no network touched.
  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.equal(res.audience, 'client')
  assert.equal(res.scope_key, c)
  assert.equal(res.client_id, c)
  assert.equal(res.as_of, AS_OF)
  assert.equal(axiosCalls, 0)

  // The brief opens in the morning voice and is client-safe by construction.
  assert.match(res.brief_text, /^Good morning\./)

  // The numbers-only pack rode back attached, audience-stamped.
  assert.equal(res.pack.audience, 'client')
  assert.equal(res.pack.as_of, AS_OF)

  // Exactly one row written, keyed on (scope_key, as_of).
  assert.equal(await briefCount(c, AS_OF), 1)
})

test('generateClientBrief is idempotent on (scope_key, as_of) — upsert in place', async () => {
  await ready()
  const c = await freshClient('Idempotent Brief Roofing Co')

  await generateClientBrief(c, AS_OF)
  assert.equal(await briefCount(c, AS_OF), 1)

  // Re-running the same morning overwrites the same row rather than inserting.
  const again = await generateClientBrief(c, AS_OF)
  assert.equal(again.grounded, true)
  assert.equal(await briefCount(c, AS_OF), 1)
})

test('getClientBrief returns null before generation, normalized row after', async () => {
  await ready()
  const c = await freshClient('Readback Brief Roofing Co')

  assert.equal(await getClientBrief(c, AS_OF), null)

  await generateClientBrief(c, AS_OF)
  const row = await getClientBrief(c, AS_OF)

  assert.ok(row)
  assert.equal(row.scope_key, c)
  assert.equal(row.audience, 'client')
  // grounded normalized to a real boolean (SQLite stores 0/1).
  assert.equal(row.grounded, true)
  assert.equal(typeof row.grounded, 'boolean')
  // pack normalized from the TEXT column back to an object.
  assert.equal(typeof row.pack, 'object')
  assert.equal(row.pack.audience, 'client')
  assert.equal(row.pack.as_of, AS_OF)
  assert.match(row.brief_text, /^Good morning\./)
})

test('getOrGenerateClientBrief generates once, then returns the stored row', async () => {
  await ready()
  const c = await freshClient('Cache Brief Roofing Co')

  // First call: nothing stored → generate + persist.
  const first = await getOrGenerateClientBrief(c, AS_OF)
  assert.equal(first.model, 'template')
  assert.equal(await briefCount(c, AS_OF), 1)

  // Second call: served from storage, no new row, byte-identical text.
  const second = await getOrGenerateClientBrief(c, AS_OF)
  assert.equal(second.brief_text, first.brief_text)
  assert.equal(await briefCount(c, AS_OF), 1)
})

test('generatePortfolioBrief persists a grounded template brief under the portfolio scope', async () => {
  await ready()
  // A book of calm clients → a quiet portfolio briefing (no peer named).
  await freshClient('Portfolio Member A')
  await freshClient('Portfolio Member B')

  axiosCalls = 0
  const res = await generatePortfolioBrief(AS_OF)

  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.equal(res.audience, 'agency')
  assert.equal(res.scope_key, PORTFOLIO_KEY)
  assert.equal(res.client_id, null)          // the portfolio brief has no single client
  assert.equal(res.as_of, AS_OF)
  assert.equal(axiosCalls, 0)
  assert.match(res.brief_text, /^Good morning\./)
  assert.equal(res.pack.audience, 'agency')

  assert.equal(await briefCount(PORTFOLIO_KEY, AS_OF), 1)
})

test('getOrGeneratePortfolioBrief generates once, then returns the stored row', async () => {
  await ready()

  const first = await getOrGeneratePortfolioBrief(AS_OF)
  assert.equal(first.scope_key, PORTFOLIO_KEY)
  assert.equal(await briefCount(PORTFOLIO_KEY, AS_OF), 1)

  // Second call served from storage — no new row, no second generation.
  const second = await getOrGeneratePortfolioBrief(AS_OF)
  assert.equal(second.brief_text, first.brief_text)
  assert.equal(await briefCount(PORTFOLIO_KEY, AS_OF), 1)
})

// ── B. GROUNDED-AI SAFETY (stubbed Anthropic, synthetic packs) ───────────────
// Synthetic packs with a KNOWN focus/headline, so generateBriefText takes the
// narrate-only API path (briefWorthNarrating is true) and the asserted numbers
// don't depend on what an (empty) pulse produced. Mirrors test/ai.test.js's
// synthetic-pack approach for generateRecapText.
const CLIENT_FOCUS_PACK = {
  audience: 'client',
  as_of: AS_OF,
  period: { label: AS_OF, week_start: AS_OF, week_end: AS_OF },
  posture: 'attention',
  status: 'briefing',
  meta: { quiet: false, has_focus: true, has_resolved: false },
  focus: { metric: 'leads', label: 'Leads', direction: 'down', delta_pct: 18, lane: 'act_now' },
  also_count: 0,
  memory: {
    new_count: 1, persisting_count: 0, escalating_count: 0, resolved_count: 0,
    focus_status: 'new', streak: 1, since_back: null, streak_capped: false, trend: null,
  },
  resolved: [],
  engine_notes: { headline: 'Leads need a look this morning.', focus_streak: null, resolved: null },
}

const AGENCY_HEADLINE_PACK = {
  audience: 'agency',
  as_of: AS_OF,
  period: { label: AS_OF, week_start: AS_OF, week_end: AS_OF },
  posture: 'attention',
  status: 'briefing',
  meta: { quiet: false, has_action: true, has_resolved: false },
  counts: { adverse: 2, clients: 2, act_now: 1, tailwinds: 0, proven: 0, learning: 0 },
  headline: { client_name: 'North Co', metric: 'leads', label: 'Leads', lane: 'act_now', direction: 'down', delta_pct: 22 },
  also: [],
  memory: {
    new_count: 2, persisting_count: 0, escalating_count: 0, resolved_count: 0,
    clients_new: 2, clients_escalating: 0, clients_resolved: 0,
  },
  confidence: { label: 'n/a', note: null },
  engine_notes: { headline: null, also: null, continuity: null, confidence: null },
}

test('generateBriefText passes a grounded client draft straight through', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  const draft = 'Good morning. Leads is running about 18% below your usual pace.'
  axiosResponder = () => reply(draft)

  const res = await generateBriefText(CLIENT_FOCUS_PACK)
  assert.equal(res.text, draft)
  assert.equal(res.grounded, true)
  assert.equal(res.model, 'claude-haiku-4-5')   // not the template fallback
  assert.equal(axiosCalls, 1)                    // accepted on the first try, no retry

  delete process.env.ANTHROPIC_API_KEY
})

test('generateBriefText rejects an ungrounded client draft and falls back to the template', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  // A hallucinated figure on every attempt → never verifies.
  axiosResponder = () => reply('Good morning. Leads cratered to 999 overnight!')

  const res = await generateBriefText(CLIENT_FOCUS_PACK)
  assert.equal(res.model, 'template')            // degraded to deterministic text
  assert.equal(res.grounded, true)               // template is grounded by construction
  assert.ok(!res.text.includes('999'))           // the hallucination never survives
  assert.match(res.text, /18%/)                  // template narrates the real number
  assert.match(res.text, /^Good morning\./)
  assert.equal(axiosCalls, 2)                     // tried once, retried strict once, then gave up

  delete process.env.ANTHROPIC_API_KEY
})

test('generateBriefText rejects an ungrounded agency draft and falls back to the portfolio template', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  axiosResponder = () => reply('Good morning. A staggering 4242 alerts fired across the book!')

  const res = await generateBriefText(AGENCY_HEADLINE_PACK)
  assert.equal(res.model, 'template')
  assert.equal(res.grounded, true)
  assert.ok(!res.text.includes('4242'))          // the hallucination never survives
  assert.match(res.text, /22%/)                  // the real headline delta
  assert.match(res.text, /North Co/)             // the agency template names the lead client
  assert.match(res.text, /^Good morning\./)
  assert.equal(axiosCalls, 2)

  delete process.env.ANTHROPIC_API_KEY
})
