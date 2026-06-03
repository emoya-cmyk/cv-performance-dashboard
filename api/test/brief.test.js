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

// ── Section E — layer 14: watch the watcher (the stability monitor, wired) ─────────
// 14a proved the monitor's grading in isolation; here we prove the WIRING: across a real
// brief generation, generatePortfolioBrief consults the loop's TRAJECTORY (six day-anchors,
// one deriveLeadPolicy per anchor inside leadPolicyDecisionFor) and (1) on a STABLE history
// keeps the tuned policy AND attaches the stable verdict for the agency, (2) on an
// OSCILLATING history SELF-HEALS — it drops the tuned policy back to neutral and attaches an
// 'unstable'/'revert_to_neutral' verdict that tells the agency why the lead order went
// neutral, and (3) the client pack carries NONE of it under either regime.
//
// Both regimes are driven by the SAME module-object stubs Section D uses (impactEngine /
// leadPolicyEngine, restored by the file-level test.after hooks). The oscillation stub flips a
// NON-floored lane (worth_a_look) promote↔demote across the six anchors via a fresh per-call
// closure counter — never touching the safety-floored act_now — so countFlips sees ≥2
// reversals and the monitor's oscillation branch fires. Every snapshot stays status:'tuned',
// so the ONLY reason the policy is suppressed is the revert gate, not a non-tuned status.
function oscSnapshot(k) {
  const promote = (k % 2 === 0) // even anchor → promote, odd → demote: a clean alternation
  return {
    status: 'tuned', neutral_rate: 0.5, min_sample: 4,
    bounds: { min: 0.8, max: 1.2 }, safety_floor_lanes: ['act_now'],
    lanes: {
      // the safety lane is held perfectly still and neutral — it must NEVER be the oscillator.
      act_now:      { weight: 1.0, direction: 'neutral', adjusted: false, judged: 0, hit_rate: null, label: null, reason: 'insufficient_sample', safetyFloored: false },
      // the oscillator: mid-band weights (never at a bound → no saturation masks the flip) with
      // a flipping direction. Not floored → floor-masking can't pre-empt the oscillation branch.
      worth_a_look: promote
        ? { weight: 1.1, direction: 'promote', adjusted: true, judged: 4, hit_rate: 0.70, label: 'earned',     reason: 'promoted', safetyFloored: false }
        : { weight: 0.9, direction: 'demote',  adjusted: true, judged: 4, hit_rate: 0.30, label: 'overcalled', reason: 'demoted',  safetyFloored: false },
      verify:       { weight: 1.0, direction: 'neutral', adjusted: false, judged: 0, hit_rate: null, label: null, reason: 'insufficient_sample', safetyFloored: false },
    },
    promoted: promote ? 1 : 0, demoted: promote ? 0 : 1, floored: 0, adjusted_count: 1,
  }
}
function stubOscillating() {
  impactEngine.getBriefImpact = async () => ({ status: 'insufficient', label: null, hit_rate: null, hits: 0, judged: 0 })
  let k = 0
  leadPolicyEngine.deriveLeadPolicy = () => oscSnapshot(k++)
}

// The layer-15 WIN fixture: the SAME proven oscillation (worth_a_look thrashing → an
// 'unstable'/'revert_to_neutral' verdict) PLUS a separately-earned, rock-steady promote lane
// (tailwind) that NEVER flips and sits mid-band (1.15, clear of the 1.2 ceiling → not saturated).
// The old blunt revert would have thrown tailwind out with everything else the instant
// worth_a_look thrashed; the governor must neutralise ONLY worth_a_look and keep tailwind live.
function oscEarnedSnapshot(k) {
  const snap = oscSnapshot(k) // identical oscillation → identical verdict; we only ADD a healthy lane
  snap.lanes.tailwind = { weight: 1.15, direction: 'promote', adjusted: true, judged: 6, hit_rate: 0.75, label: 'earned', reason: 'promoted', safetyFloored: false }
  snap.promoted += 1
  snap.adjusted_count += 1
  return snap
}
function stubOscillatingWithEarned() {
  impactEngine.getBriefImpact = async () => ({ status: 'insufficient', label: null, hit_rate: null, hits: 0, judged: 0 })
  let k = 0
  leadPolicyEngine.deriveLeadPolicy = () => oscEarnedSnapshot(k++)
}

// The stability-monitor vocabulary — compound, snake_case machine identifiers that could never
// occur in a human morning-brief sentence — that must NEVER cross to the client at any depth.
// (Disjoint from Section D's lead-policy set; 14d folds both into the dedicated leak-proof pass.)
const FORBIDDEN_HEALTH_KEYS = [
  'lead_policy_health', 'recommended_action', 'verdict_reason', 'revert_to_neutral',
  'floor_masked', 'high_run', 'low_run', 'mask_runs', 'window_used', 'history_len',
  'series', // the per-lane weight trajectory — pure machinery, never a client field
]
const FORBIDDEN_HEALTH_TOKENS = /lead_policy_health|recommended_action|verdict_reason|revert_to_neutral|floor_masked|high_run|low_run|mask_runs|window_used|history_len/
function assertNoStabilityMachinery(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_HEALTH_KEYS.includes(k), `${where}: client pack must not carry stability-monitor field "${k}" (at ${path})`)
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(!FORBIDDEN_HEALTH_TOKENS.test(JSON.stringify(pack)), `${where}: stability-monitor vocabulary leaked into the serialized client pack`)
}

test('generatePortfolioBrief on a STABLE loop keeps the tuned policy AND attaches the stable verdict (14b)', async () => {
  await ready()
  stubTuned() // six identical TUNED_POLICY snapshots → zero spread → a converged, stable verdict
  await freshClient('Portfolio Stability A')

  const res = await generatePortfolioBrief(AS_OF)

  // The tuned order still applies (the monitor saw nothing to heal)…
  assert.ok('lead_policy' in res.pack, 'a stable loop keeps the learned policy')
  assert.deepEqual(res.pack.lead_policy, TUNED_POLICY, 'and it is the unmodified learned policy')
  // …and the agency also gets the stability verdict that VOUCHES the loop is holding steady.
  assert.ok('lead_policy_health' in res.pack, 'the stability verdict rides along for the agency')
  assert.equal(res.pack.lead_policy_health.status, 'stable')
  assert.equal(res.pack.lead_policy_health.recommended_action, 'trust')
})

test('generatePortfolioBrief surgically neutralises the lone oscillating lane → it was the only weighted one, so the order collapses to idle (15b)', async () => {
  await ready()
  stubOscillating() // worth_a_look flips promote↔demote across the six anchors → oscillation
  await freshClient('Portfolio Stability B')

  const res = await generatePortfolioBrief(AS_OF)

  // LAYER 15 — the governor no longer throws out the WHOLE policy on a thrash (the old blunt
  // revert). It resets ONLY the lane that is shaking (worth_a_look). Here that lane is the
  // policy's sole weighted lane, so neutralising it leaves nothing adjusted → the governed order
  // collapses to idle and no lead_policy is applied. Same neutral OUTCOME the blunt revert gave,
  // reached surgically — had another lane earned its lift it would have survived (next test).
  assert.ok(!('lead_policy' in res.pack), 'neutralising the sole weighted lane collapses the order to idle (no policy applied)')
  // the governor's OWN verdict rides along for the agency: it DID act — a weight was reset.
  assert.ok('lead_policy_governance' in res.pack, 'the governance verdict explains what the surgeon did')
  assert.equal(res.pack.lead_policy_governance.status, 'corrected')
  assert.ok(res.pack.lead_policy_governance.counts.neutralized >= 1, 'at least one lane was neutralised')
  const neutralised = res.pack.lead_policy_governance.interventions.find(i => i.lane === 'worth_a_look')
  assert.ok(neutralised && neutralised.action === 'neutralize', 'the oscillating lane is the one that was neutralised')
  // …and the stability verdict that DIAGNOSED the thrash still attaches independently.
  assert.ok('lead_policy_health' in res.pack, 'the unstable verdict explains why the lead order went neutral')
  assert.equal(res.pack.lead_policy_health.status, 'unstable')
  assert.equal(res.pack.lead_policy_health.recommended_action, 'revert_to_neutral')
  // the verdict fingers the oscillating lane (the safety lane stayed put and is never blamed)
  assert.equal(res.pack.lead_policy_health.lanes.worth_a_look.state, 'oscillating')
  assert.ok(res.pack.lead_policy_health.counts.oscillating >= 1, 'at least one lane is flagged oscillating')
  assert.notEqual(res.pack.lead_policy_health.lanes.act_now && res.pack.lead_policy_health.lanes.act_now.state, 'oscillating')
})

test('generatePortfolioBrief SURGICALLY governs an oscillation — neutralises the thrashing lane but KEEPS the earned one (the layer-15 win) (15b)', async () => {
  await ready()
  stubOscillatingWithEarned() // worth_a_look thrashes; tailwind holds a steady, honestly-earned promotion
  await freshClient('Portfolio Stability C')

  const res = await generatePortfolioBrief(AS_OF)

  // THE WIN over blunt revert: a learned order STILL applies. The old all-or-nothing self-heal
  // would have dropped the WHOLE policy the moment worth_a_look thrashed — taking tailwind's
  // honest lift down with it. The governor resets ONLY the shaking lane and keeps the rest live.
  assert.ok('lead_policy' in res.pack, 'an earned lane survives the oscillation (surgical, not blunt)')
  assert.equal(res.pack.lead_policy.status, 'tuned')
  // the thrashing lane is reset to neutral…
  assert.equal(res.pack.lead_policy.lanes.worth_a_look.weight, 1)
  assert.equal(res.pack.lead_policy.lanes.worth_a_look.direction, 'neutral')
  // …while the earned lane rides untouched (the blunt revert would have lost this lift).
  assert.equal(res.pack.lead_policy.lanes.tailwind.weight, 1.15)
  assert.equal(res.pack.lead_policy.lanes.tailwind.direction, 'promote')
  // the governance verdict tells the agency it corrected exactly the one lane…
  assert.ok('lead_policy_governance' in res.pack, 'the governance verdict rides along for the agency')
  assert.equal(res.pack.lead_policy_governance.status, 'corrected')
  assert.ok(res.pack.lead_policy_governance.counts.neutralized >= 1)
  const neutralised = res.pack.lead_policy_governance.interventions.find(i => i.lane === 'worth_a_look')
  assert.ok(neutralised && neutralised.action === 'neutralize', 'worth_a_look is the neutralised lane')
  // …and the pre-governance weight is preserved for reversibility (snapshot carries the raw order).
  assert.notEqual(res.pack.lead_policy_governance.snapshot.lanes.worth_a_look.weight, 1)
  // the diagnosis (unstable / revert) still attaches independently of the corrective action.
  assert.equal(res.pack.lead_policy_health.status, 'unstable')
  assert.equal(res.pack.lead_policy_health.recommended_action, 'revert_to_neutral')
})

test('generateClientBrief exposes NONE of the stability monitor — under a healthy OR an oscillating loop (14b)', async () => {
  await ready()
  const c = await freshClient('Stability Confinement Roofing Co')
  stubOscillating() // the most machinery-laden regime: a suppression decision + an unstable verdict

  const res = await generateClientBrief(c, AS_OF)

  // The brief still ships in the morning voice…
  assert.equal(res.grounded, true)
  assert.match(res.brief_text, /^Good morning\./)
  // …carrying neither the policy nor its stability verdict, at any depth.
  assert.ok(!('lead_policy' in res.pack), 'client pack must not carry lead_policy')
  assert.ok(!('lead_policy_health' in res.pack), 'client pack must not carry the stability verdict')
  assertCleanClientPack(res.pack, 'generateClientBrief under oscillation')      // Section D lead-policy guard
  assertNoStabilityMachinery(res.pack, 'generateClientBrief under oscillation') // layer-14 monitor guard

  // and the persisted read-back — the row a client actually fetches — is just as clean.
  const row = await getClientBrief(c, AS_OF)
  assertCleanClientPack(row.pack, 'getClientBrief read-back under oscillation')
  assertNoStabilityMachinery(row.pack, 'getClientBrief read-back under oscillation')
})

// ── Section F — layer 14d: the stability monitor is AGENCY-ONLY at the SOURCE ───────
// 14b proved the WIRING keeps the monitor off the client pack across a live brief; this closes
// the loop at the NARRATOR — the last egress gate every surface ultimately calls. We drive
// assessLeadPolicyHealth with hand-built trajectories that each land on exactly ONE of its seven
// verdict statuses, then assert the narrator's contract at the source: the CLIENT audience gets
// '' for ALL seven (loop health is internal calibration, never client-facing), while the AGENCY
// hears the four states worth knowing about (unstable / constrained / flagged / stable) and
// stays silent on the three that are "no news is good news" (settling / idle / abstained). Each
// agency string is also scanned for FORBIDDEN_HEALTH_TOKENS, so even the candid agency sentence
// carries no machine identifier. Finally we prove the 14d guard ADDITION is load-bearing: a pack
// clean but for a lone `series` weight-trajectory now trips assertNoStabilityMachinery by name.
const { assessLeadPolicyHealth, narrateLeadPolicyHealth } = require('../lib/briefLeadPolicyHealth')

// 14a house style: a lane cell, and a status:'tuned' snapshot the monitor will normalise.
const hLane = (weight, direction, floored = false) => ({
  weight,
  direction: direction || (weight > 1 ? 'promote' : weight < 1 ? 'demote' : 'neutral'),
  adjusted: weight !== 1,
  safetyFloored: !!floored,
})
const hSnap = (lanes, as_of) => ({
  status: 'tuned', neutral_rate: 0.5, min_sample: 4,
  bounds: { min: 0.8, max: 1.2 }, safety_floor_lanes: ['act_now'],
  lanes, ...(as_of ? { as_of } : {}),
})

// One trajectory per verdict status — each lands on a single dominant lane-state so the status is
// unambiguous (asserted below, so a drifting threshold trips the fixture, not a silent false pass).
// `loud` marks the four statuses the agency is meant to hear; the rest the agency stays mute on.
const HEALTH_CASES = [
  // oscillating non-floored lane (promote↔demote, 3 flips ≥ 2) → unstable
  { status: 'unstable', loud: true, history: [
    hSnap({ verify: hLane(1.1, 'promote') }), hSnap({ verify: hLane(0.9, 'demote') }),
    hSnap({ verify: hLane(1.1, 'promote') }), hSnap({ verify: hLane(0.9, 'demote') }),
  ] },
  // a lane pinned at the 1.2 ceiling for 3 trailing mornings (high_run ≥ 3) → constrained
  { status: 'constrained', loud: true, history: [
    hSnap({ tailwind: hLane(1.1, 'promote') }), hSnap({ tailwind: hLane(1.2, 'promote') }),
    hSnap({ tailwind: hLane(1.2, 'promote') }), hSnap({ tailwind: hLane(1.2, 'promote') }),
  ] },
  // the safety floor catching act_now for 3 trailing mornings (mask_runs ≥ 3) → flagged
  { status: 'flagged', loud: true, history: [
    hSnap({ act_now: hLane(1, 'neutral', true) }), hSnap({ act_now: hLane(1, 'neutral', true) }),
    hSnap({ act_now: hLane(1, 'neutral', true) }),
  ] },
  // an active lane still drifting upward (spread 0.08 > ε, no bound-run, no flip) → settling (mute)
  { status: 'settling', loud: false, history: [
    hSnap({ verify: hLane(1.04, 'promote') }), hSnap({ verify: hLane(1.08, 'promote') }),
    hSnap({ verify: hLane(1.12, 'promote') }),
  ] },
  // an active lane converged (spread 0 ≤ ε) → stable
  { status: 'stable', loud: true, history: [
    hSnap({ tailwind: hLane(1.10, 'promote') }), hSnap({ tailwind: hLane(1.10, 'promote') }),
  ] },
  // every lane parked at neutral weight 1, never floored → idle (agency mute)
  { status: 'idle', loud: false, history: [
    hSnap({ verify: hLane(1, 'neutral') }), hSnap({ verify: hLane(1, 'neutral') }),
  ] },
  // a single morning — below min-history → abstained, lanes {} (agency mute)
  { status: 'abstained', loud: false, history: [ hSnap({ verify: hLane(1.1, 'promote') }) ] },
]

test('narrateLeadPolicyHealth is silent for the client across ALL seven verdict statuses (14d)', () => {
  for (const c of HEALTH_CASES) {
    const verdict = assessLeadPolicyHealth(c.history)
    // the fixture really does build the status it claims — honest coverage, not a lucky '':
    assert.equal(verdict.status, c.status, `fixture for "${c.status}" must assess to that status`)
    // the client egress is '' for EVERY status — loop health is internal calibration, full stop.
    assert.equal(
      narrateLeadPolicyHealth(verdict, { audience: 'client' }), '',
      `client narration must be '' for status "${c.status}"`,
    )
  }
})

test('narrateLeadPolicyHealth speaks to the AGENCY only for the four loud statuses — token-clean (14d)', () => {
  for (const c of HEALTH_CASES) {
    const verdict = assessLeadPolicyHealth(c.history)
    const agency = narrateLeadPolicyHealth(verdict, { audience: 'agency' })
    assert.equal(typeof agency, 'string')
    if (c.loud) {
      assert.ok(agency.length > 0, `agency SHOULD hear status "${c.status}" (proving the client '' is a deliberate choice)`)
      assert.ok(
        !FORBIDDEN_HEALTH_TOKENS.test(agency),
        `agency narration for "${c.status}" must carry no machine identifier`,
      )
    } else {
      assert.equal(agency, '', `agency stays silent on "${c.status}" — no news is good news`)
    }
  }
})

test('the 14d series guard is load-bearing — a lone weight-trajectory trips assertNoStabilityMachinery (14d)', () => {
  // A pack clean of every other machinery key but carrying a single `series` weight-trajectory:
  // before 14d added 'series' to FORBIDDEN_HEALTH_KEYS this slipped through; now it is caught by name.
  assert.throws(
    () => assertNoStabilityMachinery({ focus: { metric: 'leads', series: [1.1, 0.9, 1.1] } }, 'series-probe'),
    /series/,
    'a `series` array anywhere in a client pack must be rejected by name',
  )
  // …and the guard is not vacuously throwing — a structurally similar pack with no machinery passes.
  assert.doesNotThrow(
    () => assertNoStabilityMachinery({ focus: { metric: 'leads', trend: 'down' } }, 'clean-probe'),
    'a clean pack with no stability machinery must pass',
  )
  // belt-and-suspenders: a REAL assessed verdict (every lane carries a `series`) can never ride a pack.
  const real = assessLeadPolicyHealth(HEALTH_CASES[0].history) // the unstable verdict
  assert.ok(Array.isArray(real.lanes.verify.series), 'sanity: the real verdict carries a per-lane series')
  assert.throws(
    () => assertNoStabilityMachinery({ insight: { lead_policy_health: real } }, 'real-verdict-probe'),
    /stability-monitor field/,
    'a real stability verdict spliced into a client pack must be rejected',
  )
})

// ── Section G — layer 15d: the GOVERNOR is agency-only at the SOURCE and the EGRESS ──
// 15b proved the WIRING: the portfolio pack carries lead_policy_governance while a surgically
// governed policy (or none) reaches the client. This closes the loop the way 13d/14d did for
// their layers — at the NARRATOR (the last egress gate every surface ultimately calls) and with
// a dedicated leak-proof pass over a LIVE client brief — but now for the governor's vocabulary.
// The governor consumes the stability verdict and AUTONOMOUSLY applies the safe per-lane
// corrective; that control-plane telemetry (which lane it reset, the pre-governance weights it
// kept for rollback, the held / floor-respected advisories) is the agency's to see and the
// client's never. We drive governLeadPolicy onto each of its four statuses with REAL assessed
// verdicts (honest coverage, not a lucky ''), assert the narrator is '' for the client across
// ALL four while the agency hears only 'corrected', then prove a live client brief — under the
// most machinery-laden regime — carries none of it, and that the new guard is load-bearing.
const { governLeadPolicy, narrateLeadPolicyGovernance } = require('../lib/briefLeadPolicyGovernor')

// The governor's vocabulary — compound, snake_case control-plane identifiers that could never
// surface in a human morning-brief sentence — that must NEVER cross to the client at any depth.
// Disjoint from Section D's lead-policy set and Section F's stability set; 15d adds the third
// confinement pass so a governance leak is caught by NAME, not merely by a generic token sweep.
const FORBIDDEN_GOV_KEYS = [
  'lead_policy_governance',   // the agency-only pack attach key
  'governed',                 // the governed-status sub-object {status}
  'interventions',            // the per-lane corrective log
  'from_weight', 'to_weight', // an intervention's weight transition — raw tuning, never a client field
  'floored_respected',        // a counts field unique to the governor
]
// The action verbs + reason/counts tokens that must never cross as a VALUE either — a serialized
// scan catches a leak smuggled in as a string (e.g. an intervention's action:'neutralize').
const FORBIDDEN_GOV_TOKENS = /lead_policy_governance|governed_oscillation|hold_at_bound|respect_floor|floored_respected|from_weight|to_weight|neutralize/
function assertNoGovernanceMachinery(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_GOV_KEYS.includes(k), `${where}: client pack must not carry governor field "${k}" (at ${path})`)
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(!FORBIDDEN_GOV_TOKENS.test(JSON.stringify(pack)), `${where}: governor vocabulary leaked into the serialized client pack`)
}

// A current tuned-policy snapshot for the governor to act ON (reuses Section F's lane cells).
const govPolicy = (lanes) => ({
  status: 'tuned', neutral_rate: 0.5, min_sample: 4,
  bounds: { min: 0.8, max: 1.2 }, safety_floor_lanes: ['act_now'], lanes,
})

// One (trajectory → REAL verdict, current policy) pair per governance status, each landing
// UNAMBIGUOUSLY on a single status (asserted below, so a drifting threshold trips the fixture,
// not a silent false pass). The verdict is assessed by assessLeadPolicyHealth over the same
// trajectory shapes Section F proves — so the status is EARNED, never hand-stamped. `loud` marks
// the one status the agency is meant to hear (a correction); the rest the narrator stays mute on.
const GOVERNANCE_CASES = [
  // a non-floored lane thrashing (oscillating) that still carries weight → the governor RESETS it.
  { status: 'corrected', loud: true,
    history: [
      hSnap({ verify: hLane(1.1, 'promote') }), hSnap({ verify: hLane(0.9, 'demote') }),
      hSnap({ verify: hLane(1.1, 'promote') }), hSnap({ verify: hLane(0.9, 'demote') }),
    ],
    policy: govPolicy({ act_now: hLane(1, 'neutral', true), verify: hLane(1.1, 'promote'), worth_a_look: hLane(1, 'neutral') }) },
  // a lane pinned at the ceiling (saturated_high), nothing thrashing → the governor only ADVISES:
  // it holds the lane at the bound (no weight change) and reports it → advised.
  { status: 'advised', loud: false,
    history: [
      hSnap({ tailwind: hLane(1.1, 'promote') }), hSnap({ tailwind: hLane(1.2, 'promote') }),
      hSnap({ tailwind: hLane(1.2, 'promote') }), hSnap({ tailwind: hLane(1.2, 'promote') }),
    ],
    policy: govPolicy({ act_now: hLane(1, 'neutral', true), tailwind: hLane(1.2, 'promote') }) },
  // a converged, healthy lane (stable) → nothing to correct or advise → clean.
  { status: 'clean', loud: false,
    history: [ hSnap({ tailwind: hLane(1.10, 'promote') }), hSnap({ tailwind: hLane(1.10, 'promote') }) ],
    policy: govPolicy({ act_now: hLane(1, 'neutral', true), tailwind: hLane(1.10, 'promote') }) },
  // a single morning → the verdict abstains → the governor refuses to act on a loop it cannot
  // currently assess → abstained (fail-safe).
  { status: 'abstained', loud: false,
    history: [ hSnap({ verify: hLane(1.1, 'promote') }) ],
    policy: govPolicy({ verify: hLane(1.1, 'promote') }) },
]

test('governLeadPolicy lands on each of its four statuses from a REAL assessed verdict (15d)', () => {
  for (const c of GOVERNANCE_CASES) {
    const verdict = assessLeadPolicyHealth(c.history)
    const result = governLeadPolicy(c.policy, verdict)
    // the fixture really does build the status it claims — honest coverage, not a lucky pass.
    assert.equal(result.status, c.status, `fixture for "${c.status}" must govern to that status (got "${result.status}")`)
  }
})

test('narrateLeadPolicyGovernance is silent for the client across ALL four governance statuses (15d)', () => {
  for (const c of GOVERNANCE_CASES) {
    const verdict = assessLeadPolicyHealth(c.history)
    const result = governLeadPolicy(c.policy, verdict)
    // the client egress is '' for EVERY status — what the governor did is internal control, full stop.
    assert.equal(
      narrateLeadPolicyGovernance(result, { audience: 'client' }), '',
      `client narration must be '' for governance status "${c.status}"`,
    )
  }
})

test('narrateLeadPolicyGovernance speaks to the AGENCY only when it CORRECTED — token-clean (15d)', () => {
  for (const c of GOVERNANCE_CASES) {
    const verdict = assessLeadPolicyHealth(c.history)
    const result = governLeadPolicy(c.policy, verdict)
    const agency = narrateLeadPolicyGovernance(result, { audience: 'agency' })
    assert.equal(typeof agency, 'string')
    if (c.loud) {
      // a correction is the one event worth telling the agency about (a learned weight was reset)…
      assert.ok(agency.length > 0, `agency SHOULD hear a "${c.status}" governance (proving the client '' is a deliberate choice)`)
      // …and even that candid sentence carries no machine identifier — from ANY of the three layers.
      assert.ok(!FORBIDDEN_GOV_TOKENS.test(agency),    'agency governance narration must carry no governor identifier')
      assert.ok(!FORBIDDEN_HEALTH_TOKENS.test(agency), 'agency governance narration must carry no stability identifier')
      assert.ok(!FORBIDDEN_TOKENS.test(agency),        'agency governance narration must carry no lead-policy identifier')
    } else {
      // advised / clean / abstained are "nothing the agency must act on" — the narrator stays mute.
      assert.equal(agency, '', `agency stays silent on governance status "${c.status}" — no correction to report`)
    }
  }
})

test('generateClientBrief exposes NONE of the governor — even when it surgically corrected a live policy (15d)', async () => {
  await ready()
  const c = await freshClient('Governance Confinement Roofing Co')
  // the richest control-plane regime: a thrashing lane is reset (CORRECTED governance, carrying
  // interventions + a pre-governance snapshot) WHILE an earned lane survives (a live tuned policy).
  stubOscillatingWithEarned()

  const res = await generateClientBrief(c, AS_OF)

  // The brief still ships, grounded, in the morning voice…
  assert.equal(res.grounded, true)
  assert.match(res.brief_text, /^Good morning\./)
  // …carrying none of the governor's control plane, at any depth.
  assert.ok(!('lead_policy_governance' in res.pack), 'client pack must not carry the governance verdict')
  assertNoGovernanceMachinery(res.pack, 'generateClientBrief under a corrected governance')
  // belt-and-suspenders: the lead-policy and stability layers stay confined too — this regime
  // attaches all three on the agency side, so the client getting none of any proves the split.
  assertCleanClientPack(res.pack, 'generateClientBrief under a corrected governance')
  assertNoStabilityMachinery(res.pack, 'generateClientBrief under a corrected governance')

  // and the persisted read-back — the row a client actually fetches — is just as clean.
  const row = await getClientBrief(c, AS_OF)
  assertNoGovernanceMachinery(row.pack, 'getClientBrief read-back under a corrected governance')
})

test('the agency portfolio pack DOES carry the governor — confinement is a split, and the 15d guard detects it (15d)', async () => {
  await ready()
  stubOscillatingWithEarned() // corrected governance: a reset lane + a surviving earned lane
  await freshClient('Portfolio Governance Split A')

  const res = await generatePortfolioBrief(AS_OF)

  // The agency surface gets the very control plane the client is denied — a deliberate audience
  // split, not a blanket suppression that would also blind the agency. And running the CLIENT
  // guard over the AGENCY pack must THROW: proof the guard genuinely detects governance, so its
  // silence on the client pack above is a real all-clear, not a vacuous pass.
  assert.ok('lead_policy_governance' in res.pack, 'portfolio pack must carry the governance verdict')
  assert.equal(res.pack.lead_policy_governance.status, 'corrected')
  assert.throws(
    () => assertNoGovernanceMachinery(res.pack, 'portfolio-pack-probe'),
    /governor field|governor vocabulary/,
    'the agency pack carries governance machinery — the client guard MUST trip on it',
  )
})

test('the 15d governance guard is load-bearing — a lone intervention log, a string verb, or a real verdict trips it (15d)', () => {
  // A pack clean of every other machinery key but carrying a single governor `interventions` log
  // is caught BY NAME (before 15d no governance key sat on any forbidden list).
  assert.throws(
    () => assertNoGovernanceMachinery({ focus: { metric: 'leads', interventions: [{ lane: 'verify', action: 'neutralize' }] } }, 'interventions-probe'),
    /interventions/,
    'an `interventions` log anywhere in a client pack must be rejected by name',
  )
  // a governor action verb smuggled in as a plain string VALUE is caught by the token sweep.
  assert.throws(
    () => assertNoGovernanceMachinery({ note: 'we would hold_at_bound the lane' }, 'token-probe'),
    /governor vocabulary/,
    'a governor action verb leaked as a string must be rejected by the token sweep',
  )
  // …and the guard is not vacuously throwing — a structurally similar clean pack passes.
  assert.doesNotThrow(
    () => assertNoGovernanceMachinery({ focus: { metric: 'leads', trend: 'down' } }, 'clean-probe'),
    'a clean pack with no governor machinery must pass',
  )
  // belt-and-suspenders: a REAL governance result spliced into a client pack can never ride along.
  const verdict = assessLeadPolicyHealth(GOVERNANCE_CASES[0].history)
  const real = governLeadPolicy(GOVERNANCE_CASES[0].policy, verdict)
  assert.equal(real.status, 'corrected', 'sanity: the real result is a corrected governance')
  assert.ok(Array.isArray(real.interventions) && real.interventions.length > 0, 'sanity: it carries an interventions log')
  assert.throws(
    () => assertNoGovernanceMachinery({ insight: { lead_policy_governance: real } }, 'real-governance-probe'),
    /governor field|governor vocabulary/,
    'a real governance verdict spliced into a client pack must be rejected',
  )
})
