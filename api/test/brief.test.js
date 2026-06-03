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

// ── C. EDITORIAL-PRECISION REINFORCEMENT (12d) — honest, earned-only, server-folded ──
// The morning brief carries ONE client-safe trust line, and ONLY when our recent morning
// leads have actually EARNED it. generateClientBrief computes it AFTER narration (the LLM
// narrator and the grounding verifier never see it) and folds ONLY the pre-narrated string
// into the persisted pack — never the grade, percentage, lane split, or audience bucket.
// Every other grade ('fair'/'overcalled'/un-graded) collapses to '' (absent), and the
// portfolio brief never carries it at all. brief.js lazy-requires briefImpactEngine inside
// clientImpactReinforcement (to break the brief↔engine module cycle), so mutating the cached
// module object here drives the grade deterministically with no DB replay.
const impactEngine = require('../lib/briefImpactEngine')
const realGetBriefImpact = impactEngine.getBriefImpact
const stubImpact = (impact) => { impactEngine.getBriefImpact = async () => impact }
test.after(() => { impactEngine.getBriefImpact = realGetBriefImpact })

// Only the fields narrateBriefImpact actually reads: status === 'graded', hit_rate != null,
// and the label. The exact summarizeBriefImpact shape; extra fields are irrelevant here.
const earnedImpact     = { status: 'graded',       label: 'earned',     hit_rate: 0.82, hits: 9, judged: 11 }
const fairImpact       = { status: 'graded',       label: 'fair',       hit_rate: 0.55, hits: 6, judged: 11 }
const overcalledImpact = { status: 'graded',       label: 'overcalled', hit_rate: 0.30, hits: 3, judged: 11 }
const ungradedImpact   = { status: 'insufficient', label: null,         hit_rate: null, hits: 0, judged: 0  }

const EARNED_LINE = 'When we lead your morning brief with something, it has usually held up.'

test('generateClientBrief folds the EARNED trust line into the client pack — and nothing else', async () => {
  await ready()
  const c = await freshClient('Earned Reinforcement Roofing Co')
  stubImpact(earnedImpact)

  const res = await generateClientBrief(c, AS_OF)

  // The exact pre-narrated 'client' sentence rode into the pack, verbatim.
  assert.equal(res.pack.impact_reinforcement, EARNED_LINE)
  // NONE of the grading machinery leaked into the client-visible pack.
  for (const k of ['label', 'hit_rate', 'hits', 'judged', 'by_lane', 'by_audience', 'impact']) {
    assert.ok(!(k in res.pack), `client pack must not carry editorial-grade field "${k}"`)
  }
  // The string is the ONLY artifact that survives — no percentage, no count, no digit.
  assert.ok(!/\d/.test(res.pack.impact_reinforcement))

  // It persisted — a read-back carries the same line (re-reads cost nothing).
  const row = await getClientBrief(c, AS_OF)
  assert.equal(row.pack.impact_reinforcement, EARNED_LINE)
})

test('generateClientBrief shows NO reinforcement when the record is only fair', async () => {
  await ready()
  const c = await freshClient('Fair Reinforcement Roofing Co')
  stubImpact(fairImpact)

  const res = await generateClientBrief(c, AS_OF)
  assert.equal(res.pack.impact_reinforcement, '')   // fair → the client sees nothing
})

test('generateClientBrief shows NO reinforcement when we are overcalling', async () => {
  await ready()
  const c = await freshClient('Overcalled Reinforcement Roofing Co')
  stubImpact(overcalledImpact)

  const res = await generateClientBrief(c, AS_OF)
  assert.equal(res.pack.impact_reinforcement, '')   // overcalled → never bragged to the client
})

test('generateClientBrief shows NO reinforcement before there is enough to grade', async () => {
  await ready()
  const c = await freshClient('Ungraded Reinforcement Roofing Co')
  stubImpact(ungradedImpact)

  const res = await generateClientBrief(c, AS_OF)
  assert.equal(res.pack.impact_reinforcement, '')   // un-graded → silent
})

test('generateClientBrief is fail-safe — a grading error still ships the brief, reinforcement ""', async () => {
  await ready()
  const c = await freshClient('Failsafe Reinforcement Roofing Co')
  impactEngine.getBriefImpact = async () => { throw new Error('grading replay blew up') }

  const res = await generateClientBrief(c, AS_OF)
  assert.equal(res.grounded, true)                  // the brief still ships
  assert.match(res.brief_text, /^Good morning\./)
  assert.equal(res.pack.impact_reinforcement, '')   // failure degrades to silence, never throws
})

test('generatePortfolioBrief NEVER carries an impact_reinforcement line', async () => {
  await ready()
  stubImpact(earnedImpact)   // even when the grade is glowing
  await freshClient('Portfolio NoReinforce A')

  const res = await generatePortfolioBrief(AS_OF)
  assert.ok(!('impact_reinforcement' in res.pack))  // the agency brief shows the full panel instead
})

// ── D. LEAD-POLICY CONFINEMENT (13d) — the learned lead nudge re-aims, never leaks ──
// intel-v7 layer 13 tunes WHICH triage lane leads the morning brief from our OWN recent
// front-page hit rate (deriveLeadPolicy → bounded per-lane weights in [0.8,1.2], act_now
// safety-floored at ≥1). That tuning is AGENCY-ONLY telemetry: the portfolio pack carries
// the full lead_policy object (D2); the CLIENT pack must carry NONE of it. A tuned policy may
// only re-AIM which adverse signal becomes the client's focus — never ride a weight, hit_rate,
// lane bound, or the promote/demote vocabulary across the egress. We stub BOTH boundary calls
// leadPolicyFor() reaches (getBriefImpact must not throw → deriveLeadPolicy returns the policy)
// on their cached module objects, same idiom as Section C, so a deterministic TUNED policy
// drives the egress with no DB replay; briefLeadPolicy.test.js (13a) proves the derivation.
const { summarizeClientPulse } = require('../lib/pulseBriefing')
const { buildClientBriefPack }  = require('../lib/pulseBrief')
const leadPolicyEngine = require('../lib/briefLeadPolicy')
const { narrateLeadPolicy } = leadPolicyEngine
const realDeriveLeadPolicy  = leadPolicyEngine.deriveLeadPolicy
test.after(() => { leadPolicyEngine.deriveLeadPolicy = realDeriveLeadPolicy })

// A fully-formed TUNED policy (the exact deriveLeadPolicy shape): act_now promoted, worth_a_look
// demoted, verify neutral — so the egress sees a real object full of machinery to (not) leak.
const TUNED_POLICY = {
  status: 'tuned', neutral_rate: 0.5, min_sample: 4,
  bounds: { min: 0.8, max: 1.2 }, safety_floor_lanes: ['act_now'],
  lanes: {
    act_now:      { weight: 1.10, direction: 'promote', adjusted: true,  judged: 4, hit_rate: 0.75, label: 'earned',     reason: 'promoted',            safetyFloored: false },
    worth_a_look: { weight: 0.90, direction: 'demote',  adjusted: true,  judged: 4, hit_rate: 0.25, label: 'overcalled', reason: 'demoted',             safetyFloored: false },
    verify:       { weight: 1.0,  direction: 'neutral', adjusted: false, judged: 0, hit_rate: null, label: null,         reason: 'insufficient_sample', safetyFloored: false },
  },
  promoted: 1, demoted: 1, floored: 0, adjusted_count: 2,
}

// Drive leadPolicyFor() → TUNED_POLICY: getBriefImpact must merely NOT throw (its value is
// ignored by the deriveLeadPolicy stub); an ungraded impact also zeroes impact_reinforcement,
// isolating these tests to the lead-policy concern. impactEngine is Section C's binding.
function stubTuned() {
  impactEngine.getBriefImpact   = async () => ({ status: 'insufficient', label: null, hit_rate: null, hits: 0, judged: 0 })
  leadPolicyEngine.deriveLeadPolicy = () => TUNED_POLICY
}

// Compound, unambiguous machinery key names that must NEVER appear at ANY depth of a client
// pack (each cross-checked against buildClientBriefPack's whitelist — none collide with a real
// client field). focus.direction (the metric trend up/down) is legitimate, asserted separately.
const FORBIDDEN_KEYS = [
  'lead_policy', 'leadPolicy', 'lead_weight', 'base_score', '__lead',
  'safetyFloored', 'safety_floor_lanes', 'neutral_rate', 'min_sample',
  'bounds', 'lanes', 'hit_rate', 'weight', 'adjusted_count',
]
// The promote/demote policy-direction vocabulary + bookkeeping tokens that must never cross as a
// VALUE either — a serialized-pack scan catches a leak that smuggled them in as a string.
const FORBIDDEN_TOKENS = /promote|demote|lead_weight|base_score|__lead|safety_floor|hit_rate|neutral_rate/

function assertCleanClientPack(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_KEYS.includes(k), `${where}: client pack must not carry lead-policy field "${k}" (at ${path})`)
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(!FORBIDDEN_TOKENS.test(JSON.stringify(pack)), `${where}: lead-policy vocabulary leaked into the serialized client pack`)
}

// Minimal synthetic-signal factory (the insights.pulseBriefing.test.js shape) for the re-aim path.
let sigSeq = 0
function sig(o = {}) {
  return {
    client_id: o.client_id ?? `d-${++sigSeq}`,
    metric:    o.metric ?? 'leads',
    label:     o.label ?? 'Leads',
    severity:  o.severity ?? 'critical',
    adverse:   o.adverse ?? true,
    direction: o.direction ?? 'down',
    delta_pct: o.delta_pct ?? -40,
    z:         o.z ?? -3,
    ...(o.reliability != null ? { reliability: o.reliability } : {}),
    ...(o.reliability_label != null ? { reliability_label: o.reliability_label } : {}),
    ...(o.accuracy_label != null ? { accuracy_label: o.accuracy_label } : {}),
  }
}

test('generateClientBrief carries NO lead-policy machinery, even when the policy is tuned (13d)', async () => {
  await ready()
  const c = await freshClient('Lead Policy Confinement Roofing Co')
  stubTuned()

  const res = await generateClientBrief(c, AS_OF)

  // The brief still ships, grounded, in the morning voice.
  assert.equal(res.grounded, true)
  assert.match(res.brief_text, /^Good morning\./)
  // The policy object is NOT attached to the client pack…
  assert.ok(!('lead_policy' in res.pack), 'client pack must not carry lead_policy')
  // …and none of its machinery rode along at any depth, top-level or nested.
  assertCleanClientPack(res.pack, 'generateClientBrief')

  // The persisted read-back — the row a client actually fetches — is just as clean.
  const row = await getClientBrief(c, AS_OF)
  assertCleanClientPack(row.pack, 'getClientBrief read-back')
})

test('generatePortfolioBrief DOES carry the full lead_policy — confinement is a split, not suppression (13d)', async () => {
  await ready()
  stubTuned()
  await freshClient('Portfolio LeadPolicy A')

  const res = await generatePortfolioBrief(AS_OF)
  // The agency surface gets the very machinery the client is denied — proving the egress is a
  // deliberate audience split, not a blanket suppression that would also blind the agency.
  assert.ok('lead_policy' in res.pack, 'portfolio pack must carry lead_policy')
  assert.deepEqual(res.pack.lead_policy, TUNED_POLICY)
})

test('summarizeClientPulse re-aims the focus under a tuned policy yet exposes only client fields (13d)', () => {
  // The re-aim path with a REAL focus: ≥2 adverse signals across lanes so applyLeadPolicyToFeed
  // actually runs (it no-ops below 2). Whatever lands in the lead slot, the client focus carries
  // EXACTLY the five client-visible fields — never a weight, hit_rate, z, severity or tuning label.
  const signals = [
    sig({ metric: 'leads',   label: 'Leads',   severity: 'critical', reliability: 0.9, reliability_label: 'reliable', accuracy_label: 'proven',     delta_pct: -42, z: -3.1 }),
    sig({ metric: 'revenue', label: 'Revenue', severity: 'warning',  reliability: 0.5, reliability_label: 'mixed',    accuracy_label: 'developing', delta_pct: -19, z: -1.5 }),
    sig({ metric: 'jobs',    label: 'Jobs',    severity: 'warning',  delta_pct: -11, z: -1.0 }),
  ]
  const out = summarizeClientPulse(signals, { leadPolicy: TUNED_POLICY })

  assert.equal(out.status, 'briefing')
  assert.ok(out.focus, 'a real focus was chosen')
  // EXACTLY the five client fields — nothing else smuggled onto the focus.
  assert.deepEqual(Object.keys(out.focus).sort(), ['delta_pct', 'direction', 'label', 'lane', 'metric'])
  // focus.direction is the METRIC trend (up/down/flat), never the policy promote/demote vocabulary.
  assert.match(out.focus.direction, /^(up|down|flat)$/)
  // The headline narration carries no tuning vocabulary either.
  assert.ok(!FORBIDDEN_TOKENS.test(out.headline_text), 'headline must not leak lead-policy vocabulary')

  // The full client pack built from this re-aimed briefing stays clean end-to-end.
  const pack = buildClientBriefPack({ as_of: AS_OF, signals, briefing: out })
  assertCleanClientPack(pack, 'summarizeClientPulse→buildClientBriefPack')
  assert.ok(pack.focus, 'the pack carried the re-aimed focus through')
})

test('narrateLeadPolicy is silent for the client even when the agency narration is not (13d)', () => {
  // The narrator is the last egress gate: the client audience ALWAYS gets '' — a tuned policy that
  // speaks to the agency must stay mute to the client, with zero tuning vocabulary either way.
  assert.equal(narrateLeadPolicy(TUNED_POLICY, { audience: 'client' }), '')
  const agency = narrateLeadPolicy(TUNED_POLICY, { audience: 'agency' })
  assert.equal(typeof agency, 'string')
  assert.ok(agency.length > 0, 'the agency DOES hear the tuned policy (proving the client silence is a deliberate choice)')
})
