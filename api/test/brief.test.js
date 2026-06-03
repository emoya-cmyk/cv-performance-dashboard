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
  buildEmphasisObservations, briefEmphasisEfficacyFor,
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

// ── Section H — layer 16d: the AUDITOR is agency-only, and it rides NEITHER pack ──
// 13d/14d/15d each closed a layer at the NARRATOR and proved a live client brief carries none of
// its vocabulary. The auditor closes the loop one rung higher AND with a different wiring shape:
// where the governor ATTACHES to the agency portfolio pack (a per-morning verdict), the auditor is
// a CROSS-MORNING rollup served ONLY by its agency-gated route — it is never a pack field at all.
// So this pass proves three things: (1) the narrator is '' for the client across ALL four audit
// statuses while the agency hears only 'churning'; (2) a live client brief — under the richest
// control-plane regime — carries none of the auditor; and (3) the agency portfolio pack does NOT
// carry it either (the governor rides the pack, the auditor rides the route), with the new guard
// load-bearing and provably disjoint from the legitimate client vocabulary (`monitor`, "churn").
const { auditLeadPolicyGovernance, shouldEscalateGovernance, narrateLeadPolicyGovernanceAudit } = require('../lib/briefLeadPolicyAudit')

// The auditor's vocabulary — compound, snake_case control-plane identifiers that could never
// surface in a human morning-brief sentence — that must NEVER cross to the client at any depth.
// Disjoint from the lead-policy (D), stability (F) and governor (G) sets; 16d adds the FOURTH
// confinement pass. DELIBERATELY excludes the roll-up/outcome WORDS (churning, recurring,
// intermittent, resolved, one_off, escalate) and the legit client lane `monitor`: each is a real
// English or marketing term ("churn rate", "recurring revenue") that could ride a real client pack,
// so forbidding it would false-positive. The audit's identity lives in its snake_case structure.
const FORBIDDEN_AUDIT_KEYS = [
  'lead_policy_governance_audit',  // the route-only audit object — must never become a pack attach
  'audit_reason',                  // the roll-up reason code (e.g. churning:verify)
  'corrections',                   // a per-lane count of mornings the governor reset it
  'current_run', 'max_run',        // the per-lane recurrence-run figures
  'corrected_mornings', 'advisory_mornings', 'quiet_mornings', // the morning-type tallies
]
const FORBIDDEN_AUDIT_TOKENS = /lead_policy_governance_audit|audit_reason|corrected_mornings|advisory_mornings|quiet_mornings|current_run|max_run/
function assertNoAuditMachinery(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_AUDIT_KEYS.includes(k), `${where}: client pack must not carry auditor field "${k}" (at ${path})`)
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(!FORBIDDEN_AUDIT_TOKENS.test(JSON.stringify(pack)), `${where}: auditor vocabulary leaked into the serialized client pack`)
}

// Mint REAL governor decisions to assemble a history the auditor reads — the status is EARNED from
// the same Section-G fixtures (a real assessed verdict → a real governLeadPolicy result), never
// hand-stamped. The 'corrected' case neutralises the thrashing `verify` lane; 'advised' only holds a
// lane at its bound (an advisory non-action, NOT a correction); 'clean' touches nothing.
const auditGov = (caseObj) => governLeadPolicy(caseObj.policy, assessLeadPolicyHealth(caseObj.history))
const audCorrected = auditGov(GOVERNANCE_CASES[0]) // interventions: [{ lane:'verify', action:'neutralize' }]
const audAdvised   = auditGov(GOVERNANCE_CASES[1]) // interventions: [{ lane:'tailwind', action:'hold_at_bound' }]
const audClean     = auditGov(GOVERNANCE_CASES[2]) // interventions: []
const auditMorning = (asOf, gov) => ({ as_of: asOf, governance: gov }) // the { as_of, governance } shape brief.js persists

// One history per audit status, each landing UNAMBIGUOUSLY on a single status (asserted below, so a
// drifting threshold trips the fixture, not a silent pass). `escalates` is the escalation hook's
// expected verdict — true ONLY for churning.
const AUDIT_CASES = [
  // the SAME lane reset on FOUR consecutive mornings — the corrective is being fought, not healing.
  { status: 'churning', escalates: true, history: [
    auditMorning('2026-05-30', audCorrected), auditMorning('2026-05-31', audCorrected),
    auditMorning('2026-06-01', audCorrected), auditMorning('2026-06-02', audCorrected) ] },
  // reset on the first two mornings, then it TOOK — the lane graduated back to riding on its own.
  { status: 'effective', escalates: false, history: [
    auditMorning('2026-05-30', audCorrected), auditMorning('2026-05-31', audCorrected),
    auditMorning('2026-06-01', audClean), auditMorning('2026-06-02', audClean) ] },
  // two mornings that only ever HELD a lane at its bound — advisory, never a correction → quiet.
  { status: 'quiet', escalates: false, history: [
    auditMorning('2026-06-01', audAdvised), auditMorning('2026-06-02', audAdvised) ] },
  // a single governed morning — one morning is not a track record → abstained (fail-safe).
  { status: 'abstained', escalates: false, history: [ auditMorning('2026-06-02', audCorrected) ] },
]

test('auditLeadPolicyGovernance lands on each of its four statuses from REAL governor decisions (16d)', () => {
  for (const c of AUDIT_CASES) {
    const audit = auditLeadPolicyGovernance(c.history)
    // the fixture really does build the status it claims — honest coverage, not a lucky pass.
    assert.equal(audit.status, c.status, `fixture for "${c.status}" must audit to that status (got "${audit.status}")`)
    // and the one self-improving hook agrees with the posture: escalate ONLY when churning.
    assert.equal(shouldEscalateGovernance(audit), c.escalates, `escalation hook must ${c.escalates ? 'fire' : 'stay quiet'} for "${c.status}"`)
    if (c.status === 'churning') {
      assert.deepEqual(audit.recommendation, { action: 'escalate', lanes: ['verify'] }, 'churning escalates EXACTLY the recurring lane')
    } else {
      assert.equal(audit.recommendation.action, 'none', `a non-churning audit recommends nothing ("${c.status}")`)
    }
  }
})

test('narrateLeadPolicyGovernanceAudit is silent for the client across ALL four audit statuses (16d)', () => {
  for (const c of AUDIT_CASES) {
    const audit = auditLeadPolicyGovernance(c.history)
    // how well our OWN auto-corrector is converging is the most internal telemetry in the stack —
    // the client egress is '' for every status, full stop.
    assert.equal(
      narrateLeadPolicyGovernanceAudit(audit, { audience: 'client' }), '',
      `client narration must be '' for audit status "${c.status}"`,
    )
  }
})

test('narrateLeadPolicyGovernanceAudit speaks to the AGENCY only when CHURNING — clean across all four layers (16d)', () => {
  for (const c of AUDIT_CASES) {
    const audit = auditLeadPolicyGovernance(c.history)
    const agency = narrateLeadPolicyGovernanceAudit(audit, { audience: 'agency' })
    assert.equal(typeof agency, 'string')
    if (c.status === 'churning') {
      // a corrective that keeps coming back is the one audit finding worth raising to the agency…
      assert.ok(agency.length > 0, `agency SHOULD hear a churning audit (proving the client '' is a deliberate choice)`)
      // …and even that candid sentence carries no machine identifier — from ANY of the FOUR layers.
      assert.ok(!FORBIDDEN_AUDIT_TOKENS.test(agency), 'agency audit narration must carry no auditor identifier')
      assert.ok(!FORBIDDEN_GOV_TOKENS.test(agency),   'agency audit narration must carry no governor identifier')
      assert.ok(!FORBIDDEN_HEALTH_TOKENS.test(agency),'agency audit narration must carry no stability identifier')
      assert.ok(!FORBIDDEN_TOKENS.test(agency),       'agency audit narration must carry no lead-policy identifier')
    } else {
      // effective / quiet / abstained are "nothing the agency must act on" — the narrator stays mute.
      assert.equal(agency, '', `agency stays silent on audit status "${c.status}" — a corrective that takes is not news`)
    }
  }
})

test('neither a live client brief nor the agency portfolio pack carries the auditor — it rides the route alone (16d)', async () => {
  await ready()
  const c = await freshClient('Governance Audit Confinement Roofing Co')
  // the richest control-plane regime: a thrashing lane is reset live this morning (a CORRECTED
  // governance rides the agency pack) — the audit is the layer ABOVE that, and rides neither pack.
  stubOscillatingWithEarned()

  const res = await generateClientBrief(c, AS_OF)
  // the brief still ships, grounded, in the morning voice…
  assert.equal(res.grounded, true)
  assert.match(res.brief_text, /^Good morning\./)
  // …carrying none of the auditor, at any depth, and clean of the three layers beneath it too.
  assert.ok(!('lead_policy_governance_audit' in res.pack), 'client pack must not carry the governance audit')
  assertNoAuditMachinery(res.pack, 'generateClientBrief under a live governance')
  assertCleanClientPack(res.pack, 'generateClientBrief under a live governance')
  assertNoStabilityMachinery(res.pack, 'generateClientBrief under a live governance')
  assertNoGovernanceMachinery(res.pack, 'generateClientBrief under a live governance')
  // and the persisted read-back — the row a client actually fetches — is just as clean.
  const row = await getClientBrief(c, AS_OF)
  assertNoAuditMachinery(row.pack, 'getClientBrief read-back')

  // THE WIRING SPLIT: the agency portfolio pack carries the GOVERNOR (a per-morning verdict) but
  // NOT the auditor — the audit is a cross-morning rollup exposed ONLY by its agency-gated route
  // (briefImpact.integration proves the 403). Running the audit guard over that same agency pack
  // PASSES: the auditor's vocabulary is disjoint from the governor's, so its silence on the client
  // pack above is a real all-clear, not telemetry hiding under a governor key.
  const port = await generatePortfolioBrief(AS_OF)
  assert.ok('lead_policy_governance' in port.pack, 'sanity: the portfolio pack DOES carry the governor (the audit is the rung above)')
  assert.ok(!('lead_policy_governance_audit' in port.pack), 'the auditor is route-only — it never rides the portfolio pack')
  assert.doesNotThrow(
    () => assertNoAuditMachinery(port.pack, 'portfolio-pack-audit-probe'),
    'the auditor vocabulary is disjoint from the governor — the agency pack carries the governor but no audit machinery',
  )
})

test('the 16d audit guard is load-bearing — a lone run figure, a string identifier, or a real audit trips it; and it never false-positives (16d)', () => {
  // a pack clean of every other machinery key but carrying a single auditor `current_run` is caught BY NAME
  // (before 16d no audit key sat on any forbidden list).
  assert.throws(
    () => assertNoAuditMachinery({ focus: { metric: 'leads', current_run: 3 } }, 'current-run-probe'),
    /current_run/,
    'a lone auditor run figure in a client pack must be rejected by name',
  )
  // an auditor counts identifier smuggled in as a plain string VALUE is caught by the token sweep.
  assert.throws(
    () => assertNoAuditMachinery({ note: 'corrected_mornings were many' }, 'token-probe'),
    /auditor vocabulary/,
    'an auditor identifier leaked as a string must be rejected by the token sweep',
  )
  // …and the guard is not vacuously throwing — a structurally similar clean pack passes.
  assert.doesNotThrow(
    () => assertNoAuditMachinery({ focus: { metric: 'leads', trend: 'down' } }, 'clean-probe'),
    'a clean pack with no auditor machinery must pass',
  )
  // CRITICAL discipline: the legit client lane `monitor` and marketing words (churn, recurring) are
  // NOT forbidden — proof the token set is disjoint from real client vocabulary and cannot false-
  // positive on a live pack. This is why the regex forbids only snake_case structure, not words.
  assert.doesNotThrow(
    () => assertNoAuditMachinery({ triage: { lane: 'monitor', label: 'recurring revenue', note: 'churn held flat' } }, 'false-positive-probe'),
    'the audit guard must never trip on the legit monitor lane or marketing words like churn / recurring',
  )
  // belt-and-suspenders: a REAL audit result spliced into a client pack can never ride along.
  const realAudit = auditLeadPolicyGovernance(AUDIT_CASES[0].history)
  assert.equal(realAudit.status, 'churning', 'sanity: the real audit is churning')
  assert.equal(realAudit.recommendation.action, 'escalate', 'sanity: it recommends escalation')
  assert.throws(
    () => assertNoAuditMachinery({ insight: { lead_policy_governance_audit: realAudit } }, 'real-audit-probe'),
    /auditor field|auditor vocabulary/,
    'a real audit result spliced into a client pack must be rejected',
  )
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Section I — layer 17d: the REMEDIATOR is leak-proof, and rides the agency portfolio pack alone.
//
// 17 closes the lead-policy control loop: SENSE (14, the stability monitor) → ACT (13/15, the policy
// and its governor) → AUDIT (16, the governance auditor) → ADJUST (17, this remediator). When the
// auditor reports a correction that keeps churning, the remediator proposes the gentlest *structural*
// fix — widen the dead-band, then tighten bounds, then pin to neutral — staged for one agency click,
// always reversible, never touching a safety-floored lane. It is the most internal rung in the whole
// tower, so it must be the most thoroughly confined: this is the FIFTH client-leak guard, joining
// lead-policy (assertCleanClientPack), stability (assertNoStabilityMachinery), governor
// (assertNoGovernanceMachinery) and audit (assertNoAuditMachinery).
//
// WIRING SPLIT — this mirrors the GOVERNOR (15d), not the route-only auditor (16d): when a fix is
// staged, the remediation ATTACHES to the agency PORTFOLIO pack (brief.js: pack.lead_policy_remediation
// = remediation, gated on shouldStageRemediation). So the live test below asserts the agency pack
// CARRIES it while the client brief + its read-back carry none — and the client guard THROWS when
// pointed at the agency pack, proving the client's silence is a real all-clear, not a dead guard.
const { proposeLeadPolicyRemediation, shouldStageRemediation, narrateLeadPolicyRemediation } = require('../lib/briefLeadPolicyRemediation')

// The remediator's identity lives entirely in compound snake_case structure + remedy enum VALUES —
// never in plain English. So we forbid the structural keys and the enum tokens, and DELIBERATELY do
// NOT forbid real words a client pack or prose legitimately uses (reversible, severity, remedy,
// rationale, proposals) — those would false-positive. (widen_neutral_band ⊂ neutral_band, covered.)
const FORBIDDEN_REMEDIATION_KEYS = ['lead_policy_remediation', 'remediation_reason', 'abstained_lanes', 'lanes_considered', 'lane_overrides', 'neutral_band']
const FORBIDDEN_REMEDIATION_TOKENS = /lead_policy_remediation|remediation_reason|abstained_lanes|lanes_considered|lane_overrides|neutral_band|tighten_bounds|pin_neutral|remediation_proposed|safety_floored|at_ceiling/
function assertNoRemediationMachinery(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_REMEDIATION_KEYS.includes(k), `${where}: client pack must not carry remediator field "${k}" (at ${path})`)
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(!FORBIDDEN_REMEDIATION_TOKENS.test(JSON.stringify(pack)), `${where}: remediator vocabulary leaked into the serialized client pack`)
}

// Build the remediator's input the honest way: a REAL audit (reusing Section H's AUDIT_CASES) over a
// real policy literal, so every status below is EARNED end-to-end — history → audit → proposal — and
// never hand-stamped. The fresh policy has no overrides (the ladder starts at rung 1); the floored
// variant makes 'verify' untouchable so we can prove the safety asymmetry.
const remPolicyFresh = govPolicy({})
const remPolicyFloored = { ...govPolicy({}), safety_floor_lanes: ['act_now', 'verify'] }
const auditOf = (n) => auditLeadPolicyGovernance(AUDIT_CASES[n].history)
const REMEDIATION_CASES = [
  // churning 'verify' + a fresh policy → the gentlest bounded fix is staged (rung 1, widen the dead-band).
  { status: 'remediation_proposed', stages: true, lane: 'verify', remedy: 'widen_neutral_band', audit: auditOf(0), policy: remPolicyFresh },
  // the SAME churn, but 'verify' is safety-floored → a floored lane is surfaced, never restructured → steady.
  { status: 'steady', stages: false, abstainedLane: 'verify', abstainedReason: 'safety_floored', audit: auditOf(0), policy: remPolicyFloored },
  // a correction that TOOK (effective) → the auditor isn't escalating → there is nothing to remediate.
  { status: 'steady', stages: false, audit: auditOf(1), policy: remPolicyFresh },
  // a single governed morning → the audit abstained on thin history → we abstain too (fail-safe).
  { status: 'abstained', stages: false, audit: auditOf(3), policy: remPolicyFresh },
]

test('proposeLeadPolicyRemediation lands on each of its three statuses from REAL audits, and floors the floor (17d)', () => {
  for (const c of REMEDIATION_CASES) {
    const rem = proposeLeadPolicyRemediation(c.audit, c.policy)
    assert.equal(rem.status, c.status, `this regime must remediate to "${c.status}" (got "${rem.status}")`)
    assert.equal(shouldStageRemediation(rem), c.stages, `the staging hook must ${c.stages ? 'fire' : 'stay quiet'} for "${c.status}"`)
    if (c.status === 'remediation_proposed') {
      assert.ok(rem.proposals.length > 0, 'a proposed remediation carries at least one concrete fix')
      const top = rem.proposals[0]
      assert.equal(top.lane, c.lane, `the staged fix must name the churning lane "${c.lane}"`)
      assert.equal(top.remedy, c.remedy, `the gentlest applicable remedy must be "${c.remedy}"`)
      assert.equal(top.reversible, true, 'every staged fix is reversible by construction — it is a proposal, not a commit')
      assert.ok(top.from && top.to, 'a staged fix carries both the current knob value and its target')
    } else {
      assert.equal(rem.proposals.length, 0, `a non-proposing remediation ("${c.status}") stages nothing`)
    }
    // the SAFETY ASYMMETRY: a floored churning lane is surfaced as abstained, never given a proposal.
    if (c.abstainedLane) {
      assert.deepEqual(rem.abstained_lanes, [{ lane: c.abstainedLane, reason: c.abstainedReason }],
        `a safety-floored churning lane must abstain with reason "${c.abstainedReason}", never restructure`)
      assert.equal(rem.remediation_reason, 'steady:all_abstained', 'an all-floored escalation is a deliberate steady, tagged as such')
    }
  }
})

test('narrateLeadPolicyRemediation is silent for the CLIENT across all three remediation statuses (17d)', () => {
  for (const c of REMEDIATION_CASES) {
    const rem = proposeLeadPolicyRemediation(c.audit, c.policy)
    assert.equal(
      narrateLeadPolicyRemediation(rem, { audience: 'client' }), '',
      `client narration must be '' for remediation status "${c.status}" — re-tuning the auto-tuner is the deepest internal calibration`,
    )
  }
})

test('narrateLeadPolicyRemediation speaks to the AGENCY only when a fix is PROPOSED — clean across all five layers (17d)', () => {
  for (const c of REMEDIATION_CASES) {
    const rem = proposeLeadPolicyRemediation(c.audit, c.policy)
    const agency = narrateLeadPolicyRemediation(rem, { audience: 'agency' })
    assert.equal(typeof agency, 'string')
    if (c.status === 'remediation_proposed') {
      assert.ok(agency.length > 0, 'the agency SHOULD hear a staged structural fix — proving the client \'\' above is a deliberate split, not an empty feature')
      assert.ok(!FORBIDDEN_REMEDIATION_TOKENS.test(agency), 'agency remediation narration must carry no remediator identifier')
      assert.ok(!FORBIDDEN_AUDIT_TOKENS.test(agency),       'agency remediation narration must carry no auditor identifier')
      assert.ok(!FORBIDDEN_GOV_TOKENS.test(agency),         'agency remediation narration must carry no governor identifier')
      assert.ok(!FORBIDDEN_HEALTH_TOKENS.test(agency),      'agency remediation narration must carry no stability-monitor identifier')
      assert.ok(!FORBIDDEN_TOKENS.test(agency),             'agency remediation narration must carry no lead-policy identifier')
    } else {
      assert.equal(agency, '', `the agency stays silent on remediation status "${c.status}" — a loop that needs no structural fix is not news`)
    }
  }
})

test('neither a live client brief nor its read-back carries the remediator — but the agency portfolio pack does (the 17d split) (17d)', async () => {
  await ready()
  // the deepest control-plane regime: a lane oscillates every morning, the governor corrects it daily,
  // the auditor sees that correction churning and escalates — so THIS morning the remediator stages a
  // real structural fix and rides the agency portfolio pack (one rung up from the governor's wiring).
  stubOscillatingWithEarned()
  const c = await freshClient('Lead Policy Remediation Confinement Roofing Co')

  const res = await generateClientBrief(c, AS_OF)
  assert.equal(res.grounded, true)
  assert.match(res.brief_text, /^Good morning\./)
  // the client pack carries none of the remediator — at any depth — and none of the four layers beneath it.
  assert.ok(!('lead_policy_remediation' in res.pack), 'the client pack must not carry the staged remediation')
  assertNoRemediationMachinery(res.pack, 'generateClientBrief under a live staged remediation')
  assertNoAuditMachinery(res.pack, 'generateClientBrief under a live staged remediation')
  assertNoGovernanceMachinery(res.pack, 'generateClientBrief under a live staged remediation')
  assertNoStabilityMachinery(res.pack, 'generateClientBrief under a live staged remediation')
  assertCleanClientPack(res.pack, 'generateClientBrief under a live staged remediation')
  // and the persisted read-back — the row a client actually fetches — is just as clean.
  const row = await getClientBrief(c, AS_OF)
  assertNoRemediationMachinery(row.pack, 'getClientBrief read-back under a live staged remediation')

  // THE WIRING SPLIT (mirrors the governor 15d, NOT the route-only auditor 16d): the remediation
  // ATTACHES to the agency portfolio pack when a fix is staged. The probe proved one live
  // generatePortfolioBrief under this exact regime deterministically stages widen_neutral_band.
  const port = await generatePortfolioBrief(AS_OF)
  assert.ok('lead_policy_remediation' in port.pack, 'the agency portfolio pack DOES carry the staged remediation')
  assert.equal(port.pack.lead_policy_remediation.status, 'remediation_proposed', 'and what it carries is a real staged proposal')
  // running the CLIENT guard over that same agency pack THROWS — proof the guard is load-bearing and
  // the client pack's silence above is a real all-clear, not a guard that never fires.
  assert.throws(
    () => assertNoRemediationMachinery(port.pack, 'portfolio-pack-remediation-probe'),
    /remediator field|remediator vocabulary/,
    'the agency pack carries remediation machinery — the client guard MUST trip on it',
  )
})

test('the 17d remediation guard is load-bearing — a lone key, a smuggled enum, or a real proposal trips it; and it never false-positives (17d)', () => {
  // a pack clean of every other machinery key but carrying a single remediator override map is caught BY NAME.
  assert.throws(
    () => assertNoRemediationMachinery({ focus: { metric: 'leads', lane_overrides: {} } }, 'override-key-probe'),
    /lane_overrides/,
    'a lone remediator override map in a client pack must be rejected by name',
  )
  // a remedy enum smuggled in as a plain string VALUE is caught by the token sweep (widen_neutral_band ⊂ neutral_band).
  assert.throws(
    () => assertNoRemediationMachinery({ note: 'we should widen_neutral_band on that lane' }, 'enum-token-probe'),
    /remediator vocabulary/,
    'a remediator remedy identifier leaked as a string must be rejected by the token sweep',
  )
  // …and the guard is not vacuously throwing — a structurally similar but clean pack passes.
  assert.doesNotThrow(
    () => assertNoRemediationMachinery({ focus: { metric: 'leads', trend: 'down' } }, 'clean-probe'),
    'a clean client pack with no remediator machinery must pass',
  )
  // CRITICAL discipline: real-English words a live client pack or prose legitimately uses — reversible,
  // severity, remedy, rationale, the monitor lane, marketing copy — are NOT forbidden. The remediator's
  // identity lives in its compound snake_case + remedy enums, so it can never false-positive on English.
  assert.doesNotThrow(
    () => assertNoRemediationMachinery({
      triage: { lane: 'monitor', label: 'recurring revenue' },
      note: 'this change is fully reversible; severity is low and the remedy is simple — see the rationale',
    }, 'false-positive-probe'),
    'the remediation guard must never trip on real words like reversible / severity / remedy / rationale or the monitor lane',
  )
  // belt-and-suspenders: a REAL staged remediation spliced into a client pack can never ride along.
  const realRem = proposeLeadPolicyRemediation(auditOf(0), remPolicyFresh)
  assert.equal(realRem.status, 'remediation_proposed', 'sanity: the spliced remediation is a real proposal')
  assert.throws(
    () => assertNoRemediationMachinery({ insight: { lead_policy_remediation: realRem } }, 'real-remediation-probe'),
    /remediator field|remediator vocabulary/,
    'a real staged remediation spliced into a client pack must be rejected',
  )
})

// ============================================================
// intel-v8 layer 18d — the CONSUMER engagement egress is leak-proof.
// ------------------------------------------------------------
// 18a/b/c built the morning-brief 👍/👎 loop: the consumer votes, the agency
// reads a portfolio-wide reception aggregate (helpful_rate, a per-client board,
// a watch list, trend halves) and the preview twin renders it. THIS is the only
// rung where a human reader grades the system — so it is exactly where a privacy
// regression would hurt: the aggregate is how the AGENCY sees the whole book, and
// no client may ever see another client's reception, the portfolio rate, or even
// the abstention floor that governs grading.
//
// The engagement aggregate never rides inside a brief pack (unlike the lead-policy
// machinery the block above guards) — its egress is narrower and that is the point:
//   1. narrateBriefEngagement(grade, {audience:'client'}) === '' UNCONDITIONALLY —
//      the candid reception sentence is agency-only by construction, for every
//      label and every trend, even when the agency voice is loud.
//   2. recordBriefFeedback / getClientBriefFeedback return ONLY { as_of, signal } —
//      the lone vote reflected back, never a rate, never a neighbour, never a count.
//   3. getPortfolioEngagement is the dense agency instrument — and a structural
//      guard proves it can NEVER be mistaken for a client egress.
//
// The sharp edge here, unique to this layer: 'helpful' | 'not_helpful' is a LEGIT
// client value that crosses the egress every single vote. So the forbidden sweep
// must catch the aggregate RATE `helpful_rate` while leaving the signal VALUE
// untouched — `helpful_rate` is not a substring of `helpful` or `not_helpful`, and
// the disjointness control below proves the 👎 vote passes clean. We forbid only
// the distinctive aggregate identifiers (helpful_rate / recent_rate / older_rate /
// by_client / watch / clients_graded / clients_total / requested_min_votes /
// min_votes) and the two label VALUES that would betray a grade if smuggled as a
// string (well_received / poorly_received) — never the generic count nouns
// (total / n / helpful / ignored) that a lone honest vote legitimately shares.
// ============================================================
const {
  recordBriefFeedback: recordBriefFeedback18d,
  getClientBriefFeedback: getClientBriefFeedback18d,
  getPortfolioEngagement: getPortfolioEngagement18d,
} = require('../lib/briefEngagementEngine')
const {
  summarizeBriefEngagement: summarizeBriefEngagement18d,
  narrateBriefEngagement: narrateBriefEngagement18d,
} = require('../lib/briefEngagement')

const FORBIDDEN_ENGAGEMENT_KEYS = [
  'helpful_rate', 'recent_rate', 'older_rate',
  'by_client', 'watch',
  'clients_graded', 'clients_total',
  'requested_min_votes', 'min_votes',
]
// Distinctive aggregate tokens only. NOT bare `helpful`/`not_helpful` (legit signal
// values) and NOT generic `total`/`n`/`label`/`trend` (shared by a lone honest vote).
const FORBIDDEN_ENGAGEMENT_TOKENS =
  /helpful_rate|recent_rate|older_rate|by_client|clients_graded|clients_total|requested_min_votes|min_votes|well_received|poorly_received/

function assertNoEngagementAggregate(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(
          !FORBIDDEN_ENGAGEMENT_KEYS.includes(k),
          `${where}: client egress must not carry engagement-aggregate field "${k}" (at ${path})`
        )
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(
    !FORBIDDEN_ENGAGEMENT_TOKENS.test(JSON.stringify(pack)),
    `${where}: engagement-aggregate vocabulary leaked into the serialized client egress`
  )
}

// 10 votes on distinct ascending days so the pure grader's time-split is exactly the
// older-half / recent-half we intend (it sorts by as_of, then signal). Each fixture
// is engineered to land on a specific label×trend corner of the grading space.
const mkVotes18d = (signals) =>
  signals.map((signal, i) => ({ as_of: `2026-05-${String(i + 1).padStart(2, '0')}`, signal }))
//                         older half (days 01-05)            recent half (days 06-10)
const WELL_IMPROVING_18d = mkVotes18d(['helpful', 'helpful', 'helpful', 'not_helpful', 'not_helpful',
  'helpful', 'helpful', 'helpful', 'helpful', 'helpful'])           // 8/10=0.80 → well_received; 0.6→1.0 improving
const POORLY_DECLINING_18d = mkVotes18d(['helpful', 'helpful', 'helpful', 'not_helpful', 'not_helpful',
  'not_helpful', 'not_helpful', 'not_helpful', 'not_helpful', 'helpful']) // 4/10=0.40 → poorly_received; 0.6→0.2 declining
const FAIR_STEADY_18d = mkVotes18d(['helpful', 'not_helpful', 'helpful', 'not_helpful', 'helpful',
  'helpful', 'not_helpful', 'helpful', 'not_helpful', 'helpful'])   // 6/10=0.60 → fair; 0.6→0.6 steady

test('18d — narrateBriefEngagement is silent for the CLIENT across every label and trend; the agency hears it in identifier-free English', () => {
  const fixtures = [
    { label: 'well_received', trend: 'improving', events: WELL_IMPROVING_18d,
      agency: 'Clients found the morning brief useful 8 of 10 times recently (~80%) — well received. Reception has been improving lately.' },
    { label: 'poorly_received', trend: 'declining', events: POORLY_DECLINING_18d,
      agency: 'Clients found the morning brief useful 4 of 10 times recently (~40%) — poorly received; worth a closer look. Heads up — reception has been slipping lately.' },
    { label: 'fair', trend: 'steady', events: FAIR_STEADY_18d,
      agency: 'Clients found the morning brief useful 6 of 10 times recently (~60%) — a fair reception.' },
  ]
  for (const f of fixtures) {
    const grade = summarizeBriefEngagement18d(f.events, { minVotes: 3 })
    assert.equal(grade.status, 'graded', `${f.label}/${f.trend} fixture must grade`)
    assert.equal(grade.label, f.label, `fixture must grade to ${f.label}`)
    assert.equal(grade.trend, f.trend, `fixture must trend ${f.trend}`)
    // THE INVARIANT: the consumer never hears the aggregate, for ANY grade, loud or quiet.
    assert.equal(
      narrateBriefEngagement18d(grade, { audience: 'client' }), '',
      `client narration must be '' for ${f.label}/${f.trend}`
    )
    // The agency DOES hear it — proving the client silence is a deliberate split, not a dead
    // feature — and the candid sentence itself carries no machine identifier ('well received',
    // never 'well_received'), so it could not seed a leak even if mis-routed.
    const agency = narrateBriefEngagement18d(grade, { audience: 'agency' })
    assert.equal(agency, f.agency, 'the agency sentence is grounded verbatim in the grade it explains')
    assert.ok(
      !FORBIDDEN_ENGAGEMENT_TOKENS.test(agency),
      'even the candid agency sentence carries no aggregate identifier'
    )
  }
  // A missing or un-graded grade is half-spoken to no one.
  assert.equal(narrateBriefEngagement18d(null, { audience: 'agency' }), '')
  assert.equal(
    narrateBriefEngagement18d(
      summarizeBriefEngagement18d([{ as_of: '2026-05-01', signal: 'helpful' }], { minVotes: 3 }),
      { audience: 'agency' }
    ),
    '',
    'a grade below the abstention floor is not narrated even to the agency'
  )
})

test('18d — the consumer own-vote egress is exactly { as_of, signal }: the vote reflected back, never an aggregate', async () => {
  await ready()
  const c = await freshClient('Engagement Own-Vote Roofing Co')
  // a fresh morning, no vote yet → signal null, but the shape is still exactly {as_of, signal}.
  const before = await getClientBriefFeedback18d({ clientId: c, asOf: AS_OF })
  assert.deepEqual(Object.keys(before).sort(), ['as_of', 'signal'])
  assert.equal(before.signal, null)
  assertNoEngagementAggregate(before, 'own-vote read before any vote')
  // the client votes 👎, then changes to 👍 — the reversible upsert reflects the LATEST vote
  // straight back, and nothing more.
  const down = await recordBriefFeedback18d({ clientId: c, asOf: AS_OF, signal: 'not_helpful' })
  assert.deepEqual(down, { as_of: AS_OF, signal: 'not_helpful' })
  const up = await recordBriefFeedback18d({ clientId: c, asOf: AS_OF, signal: 'helpful' })
  assert.deepEqual(up, { as_of: AS_OF, signal: 'helpful' })
  // the read-back the UI paints is that same lone vote — and the guard passes on it,
  // including the 👎 echo, proving the legit signal VALUE never trips the aggregate sweep.
  const after = await getClientBriefFeedback18d({ clientId: c, asOf: AS_OF })
  assert.deepEqual(after, { as_of: AS_OF, signal: 'helpful' })
  assertNoEngagementAggregate(after, 'own-vote read after voting')
  assertNoEngagementAggregate(down, 'the 👎 own-vote echo')
})

test('18d — a REAL agency aggregate trips the egress guard, while the same client own-vote read passes: the split is enforced, not hoped', async () => {
  await ready()
  // seed THREE clients with enough votes in a dedicated window to produce a graded portfolio —
  // a per-client reception board, a watch list, helpful_rate, trend halves: the whole instrument.
  const span = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07']
  const seedPlan = [
    { name: 'Engagement Agg A', signals: ['helpful', 'helpful', 'helpful', 'helpful', 'helpful', 'not_helpful'] },          // 5/6 → well_received
    { name: 'Engagement Agg B', signals: ['not_helpful', 'not_helpful', 'not_helpful', 'helpful', 'not_helpful', 'not_helpful'] }, // 1/6 → poorly_received → rides the watch list
    { name: 'Engagement Agg C', signals: ['helpful', 'not_helpful', 'helpful', 'not_helpful', 'helpful', 'not_helpful'] },  // 3/6 → fair
  ]
  let probeClient = null
  for (const p of seedPlan) {
    const id = await freshClient(p.name)
    if (probeClient == null) probeClient = id
    for (let i = 0; i < span.length; i++) {
      await recordBriefFeedback18d({ clientId: id, asOf: span[i], signal: p.signals[i] })
    }
  }
  const aggregate = await getPortfolioEngagement18d({ asOf: '2026-03-07', days: 30, minVotes: 3 })
  // sanity: a real, populated agency instrument — not an empty shell that would trip the guard vacuously.
  assert.equal(aggregate.status, 'graded', 'the seeded window grades into a real portfolio reception')
  assert.ok(
    Array.isArray(aggregate.by_client) && aggregate.by_client.length === 3,
    'the aggregate carries a three-client reception board'
  )
  assert.ok(
    aggregate.watch.some((w) => w.label === 'poorly_received'),
    'and a watch list naming the poorly-received client'
  )
  // THE SPLIT: the consumer guard THROWS on that agency aggregate — proof it is load-bearing,
  // not decorative…
  assert.throws(
    () => assertNoEngagementAggregate(aggregate, 'portfolio-aggregate-probe'),
    /engagement-aggregate field|engagement-aggregate vocabulary/,
    'the agency aggregate is dense with reception machinery — the client guard MUST trip on it',
  )
  // …while the very same client's own-vote read-back — the only engagement bytes they ever
  // receive — passes clean, carrying no neighbour, no rate, no board.
  const own = await getClientBriefFeedback18d({ clientId: probeClient, asOf: '2026-03-07' })
  assert.deepEqual(Object.keys(own).sort(), ['as_of', 'signal'])
  assertNoEngagementAggregate(own, 'the seeded client own-vote read-back')
})

test('18d — the engagement guard is load-bearing: a lone rate, a board, a smuggled label all trip it; the legit own-vote never does', () => {
  // a pack clean of everything but a single helpful_rate is caught BY NAME.
  assert.throws(
    () => assertNoEngagementAggregate({ vote: { signal: 'helpful', helpful_rate: 0.8 } }, 'lone-rate-probe'),
    /helpful_rate/,
    'a lone engagement rate in a client egress must be rejected by name',
  )
  // an agency reception board / watch list is caught by name.
  assert.throws(
    () => assertNoEngagementAggregate({ insight: { by_client: [], watch: [] } }, 'board-probe'),
    /by_client|watch/,
    'an agency reception board in a client egress must be rejected by name',
  )
  // a label VALUE smuggled in as a plain string is caught by the token sweep.
  assert.throws(
    () => assertNoEngagementAggregate({ note: 'this brief was well_received across the book' }, 'label-token-probe'),
    /engagement-aggregate vocabulary/,
    'a label identifier leaked as a string must be rejected by the token sweep',
  )
  // CRITICAL disjointness: the consumer's own vote — INCLUDING the 👎 signal value 'not_helpful' —
  // is real client vocabulary and must NEVER trip the sweep. 'helpful_rate' is not a substring of
  // 'not_helpful', so the rate-catcher and the signal value are provably disjoint.
  assert.doesNotThrow(
    () => assertNoEngagementAggregate({ as_of: '2026-05-18', signal: 'not_helpful' }, 'own-vote-down-probe'),
    "the 👎 own-vote must pass — 'not_helpful' is the signal value, not the aggregate rate",
  )
  assert.doesNotThrow(
    () => assertNoEngagementAggregate({ as_of: '2026-05-18', signal: 'helpful' }, 'own-vote-up-probe'),
    'the 👍 own-vote must pass clean',
  )
})

// ============================================================
// 19d — ENGAGEMENT-EMPHASIS CONFINEMENT: the cap the reception earned re-shapes,
// never leaks.
// ------------------------------------------------------------
// intel-v9 layer 19 closes the engagement loop: the portfolio reception grade
// (layer 18's aggregate 👍/👎) flexes the supporting-cast breadth of TOMORROW's
// brief — a well_received book earns a wider cast (cap 3→4), a poorly_received or
// fading one tightens to the essentials (3→2→1), and the headline is NEVER touched
// (briefEngagementLearning.deriveBriefEmphasis). That knob is AGENCY-ONLY telemetry:
// the portfolio pack carries the full emphasis object under `engagement_policy`
// (brief.js:425, gated on status !== 'abstained'); the CLIENT pack must carry NONE
// of it. The consumer only ever experiences the EFFECT — a tighter or richer brief —
// never the machinery (the cap quartet, the helpful_rate that drove it, the
// widen/tighten direction, the reason). This is the exact precedent of 13d (lead
// policy) and 18d (the engagement aggregate): a deliberate audience SPLIT, not a
// blanket suppression that would also blind the agency.
//
// We exercise the REAL 19a controller (deriveBriefEmphasis) on synthetic grades and,
// for the split test, stub ONLY the engine boundary getPortfolioEngagement reaches —
// same module-object idiom as Section D / Section E — so a deterministic well_received
// reception drives a genuine `tuned` widen through generatePortfolioBrief with no DB
// replay. briefEngagementLearning.test.js (19a) proves the derivation in isolation.
const { deriveBriefEmphasis, narrateBriefEmphasis } = require('../lib/briefEngagementLearning')
const briefEngagementEngineMod = require('../lib/briefEngagementEngine')
const realGetPortfolioEngagement = briefEngagementEngineMod.getPortfolioEngagement
test.after(() => { briefEngagementEngineMod.getPortfolioEngagement = realGetPortfolioEngagement })

// The emphasis object ALWAYS carries the cap quartet — guarding those four keys is a
// COMPLETE structural guard: delta/direction/reason cannot ride along without them.
// Plus the portfolio wrapper key itself. NOT bare `delta`/`direction`/`also` — those
// are legit client vocabulary (focus trend, the supporting-cast array `also`), proven
// disjoint below; `helpful_rate`/`well_received`/`poorly_received` are already the
// 18d set, enforced by delegating to assertNoEngagementAggregate.
const FORBIDDEN_EMPHASIS_KEYS = ['also_cap', 'base_cap', 'min_cap', 'max_cap', 'engagement_policy']
// Distinctive emphasis tokens only — the cap quartet + wrapper as strings, and the two
// reason VALUES not already covered by the 18d sweep (well_received/poorly_received are).
const FORBIDDEN_EMPHASIS_TOKENS =
  /also_cap|base_cap|min_cap|max_cap|engagement_policy|reception_declining|steady_reception/

function assertNoEmphasis(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(
          !FORBIDDEN_EMPHASIS_KEYS.includes(k),
          `${where}: client egress must not carry engagement-emphasis field "${k}" (at ${path})`
        )
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(
    !FORBIDDEN_EMPHASIS_TOKENS.test(JSON.stringify(pack)),
    `${where}: engagement-emphasis vocabulary leaked into the serialized client egress`
  )
  // Belt-and-suspenders: the emphasis grade also carries the 18d aggregate vocabulary
  // (helpful_rate, the label words), so a clean emphasis egress must clear that sweep too.
  assertNoEngagementAggregate(pack, where)
}

// Real controller outputs from synthetic grades — one per corner of the knob's range.
const EMPH_WIDEN   = deriveBriefEmphasis({ status: 'graded', helpful_rate: 0.85, label: 'well_received',   trend: 'improving', n: 10 })
const EMPH_TIGHTEN = deriveBriefEmphasis({ status: 'graded', helpful_rate: 0.40, label: 'poorly_received', trend: 'declining', n: 10 })
const EMPH_IDLE    = deriveBriefEmphasis({ status: 'graded', helpful_rate: 0.60, label: 'fair',            trend: 'steady',    n: 10 })
const EMPH_ABSTAIN = deriveBriefEmphasis({ status: 'insufficient', helpful_rate: null, label: null, trend: null, n: 1 })

test('19d — narrateBriefEmphasis is silent for the CLIENT across widen/tighten/idle/abstained; the agency hears only the moves', () => {
  // Sanity: the real controller landed each fixture on the intended corner — a tuned
  // widen (3→4), a doubly-tightened poor+declining (3→1), a held-neutral fair, an abstain.
  assert.deepEqual(
    { s: EMPH_WIDEN.status, d: EMPH_WIDEN.direction, c: EMPH_WIDEN.also_cap }, { s: 'tuned', d: 'widen', c: 4 },
    'well_received + improving → a tuned widen to cap 4')
  assert.deepEqual(
    { s: EMPH_TIGHTEN.status, d: EMPH_TIGHTEN.direction, c: EMPH_TIGHTEN.also_cap }, { s: 'tuned', d: 'tighten', c: 1 },
    'poorly_received + declining → tighten two steps to the floor cap 1')
  assert.deepEqual(
    { s: EMPH_IDLE.status, d: EMPH_IDLE.direction, c: EMPH_IDLE.also_cap }, { s: 'idle', d: 'neutral', c: 3 },
    'fair + steady → held at the neutral base 3')
  assert.equal(EMPH_ABSTAIN.status, 'abstained', 'a thin/ungraded reception abstains')

  // THE INVARIANT: the consumer never hears the knob, for ANY policy — moved or held.
  for (const [name, p] of [['widen', EMPH_WIDEN], ['tighten', EMPH_TIGHTEN], ['idle', EMPH_IDLE], ['abstained', EMPH_ABSTAIN]]) {
    assert.equal(narrateBriefEmphasis(p, { audience: 'client' }), '', `client narration must be '' for ${name}`)
  }

  // The agency DOES hear the two MOVES — verbatim, grounded in the grade that drove them —
  // proving the client silence is a deliberate split, not a dead feature.
  assert.equal(
    narrateBriefEmphasis(EMPH_WIDEN, { audience: 'agency' }),
    "Reception has been strong (~85% of readers found the brief useful), so it's carrying a little more of the supporting picture (4 items, up from 3).")
  assert.equal(
    narrateBriefEmphasis(EMPH_TIGHTEN, { audience: 'agency' }),
    "Reception has been mixed and slipping (~40% of readers found the brief useful), so it's leading tighter — just the essentials (1 item, down from 3).")
  // …but stays mute when nothing moved — idle and abstained change nothing for the reader.
  assert.equal(narrateBriefEmphasis(EMPH_IDLE, { audience: 'agency' }), '', 'an idle (held-neutral) grade is narrated to no one')
  assert.equal(narrateBriefEmphasis(EMPH_ABSTAIN, { audience: 'agency' }), '', 'an abstained grade is narrated to no one')

  // Even the candid agency sentences carry no machine identifier — they could not seed a
  // leak even if mis-routed (mirrors 18d: 'found the brief useful', never 'helpful_rate').
  for (const sentence of [narrateBriefEmphasis(EMPH_WIDEN, { audience: 'agency' }), narrateBriefEmphasis(EMPH_TIGHTEN, { audience: 'agency' })]) {
    assert.ok(!FORBIDDEN_EMPHASIS_TOKENS.test(sentence), 'agency emphasis sentence carries no emphasis identifier')
    assert.ok(!FORBIDDEN_ENGAGEMENT_TOKENS.test(sentence), 'agency emphasis sentence carries no aggregate identifier')
  }
})

test('19d — generatePortfolioBrief carries the full engagement_policy while generateClientBrief carries none: a split, not suppression', async () => {
  await ready()
  // Drive a deterministic well_received reception → the REAL deriveBriefEmphasis turns it
  // into a tuned widen, so brief.js attaches engagement_policy to the PORTFOLIO pack.
  briefEngagementEngineMod.getPortfolioEngagement =
    async () => ({ status: 'graded', helpful_rate: 0.85, label: 'well_received', trend: 'improving', n: 10 })

  // AGENCY surface: the machinery the client is denied — proof the egress is an audience
  // split, not a blanket suppression that would also blind the agency.
  const port = await generatePortfolioBrief(AS_OF)
  assert.ok('engagement_policy' in port.pack, 'portfolio pack must carry engagement_policy')
  assert.equal(port.pack.engagement_policy.status, 'tuned')
  assert.equal(port.pack.engagement_policy.direction, 'widen')
  assert.equal(port.pack.engagement_policy.also_cap, 4)
  assert.equal(port.pack.engagement_policy.base_cap, 3)
  // The persisted agency read-back keeps the machinery too.
  const portRow = await getPortfolioBrief(AS_OF)
  assert.ok('engagement_policy' in portRow.pack, 'persisted portfolio pack keeps engagement_policy')
  // That very object is dense with emphasis machinery → the client guard MUST trip on it,
  // confirming the client cleanliness below is a real split, not a vacuous pass.
  assert.throws(
    () => assertNoEmphasis(port.pack.engagement_policy, 'portfolio-emphasis-probe'),
    /engagement-emphasis field|engagement-emphasis vocabulary/,
    'the portfolio emphasis object is dense with machinery — the client guard MUST trip on it')

  // CLIENT surface: even with reception tuned, the client pack carries NONE of the knob.
  const c = await freshClient('Engagement Emphasis Confinement Roofing Co')
  const cli = await generateClientBrief(c, AS_OF)
  assert.equal(cli.grounded, true)
  assert.match(cli.brief_text, /^Good morning\./)
  assert.ok(!('engagement_policy' in cli.pack), 'client pack must not carry engagement_policy')
  assertNoEmphasis(cli.pack, 'generateClientBrief')
  // The persisted read-back — the row a client actually fetches — is just as clean.
  const cliRow = await getClientBrief(c, AS_OF)
  assertNoEmphasis(cliRow.pack, 'getClientBrief read-back')
})

test('19d — the emphasis guard is load-bearing: a smuggled cap, wrapper, or reason value trips it; legit client fields never do', () => {
  // a lone supporting-cast cap is caught BY NAME, however deeply nested.
  assert.throws(
    () => assertNoEmphasis({ cap: { also_cap: 4 } }, 'lone-cap-probe'),
    /engagement-emphasis field/,
    'a lone also_cap in a client egress must be rejected by name')
  // the portfolio wrapper key is caught by name.
  assert.throws(
    () => assertNoEmphasis({ wrap: { engagement_policy: {} } }, 'wrapper-probe'),
    /engagement-emphasis field/,
    'the engagement_policy wrapper in a client egress must be rejected by name')
  // a reason VALUE smuggled in as a plain string is caught by the token sweep.
  assert.throws(
    () => assertNoEmphasis({ note: 'the cap moved: reception_declining today' }, 'reason-token-probe'),
    /engagement-emphasis vocabulary/,
    "a reason identifier ('reception_declining') leaked as a string must be rejected by the token sweep")
  assert.throws(
    () => assertNoEmphasis({ note: 'held at steady_reception' }, 'steady-token-probe'),
    /engagement-emphasis vocabulary/,
    "the 'steady_reception' reason leaked as a string must be rejected by the token sweep")
  // the whole derived emphasis object trips (cap quartet present).
  assert.throws(
    () => assertNoEmphasis(EMPH_WIDEN, 'full-emphasis-probe'),
    /engagement-emphasis field|engagement-emphasis vocabulary/,
    'the full emphasis object is dense with machinery and must be rejected')

  // CRITICAL disjointness — the legit client vocabulary the guard must NEVER catch:
  //   focus.direction (metric trend) + delta_pct — Section D's established client fields,
  //   provably disjoint from the emphasis tokens (no `also_cap`/`base_cap`/… substring).
  assert.doesNotThrow(
    () => assertNoEmphasis({ focus: { direction: 'down', delta_pct: -40, label: 'Leads', lane: 'act_now', metric: 'leads' } }, 'client-focus-probe'),
    'the client focus (direction + delta_pct) is legit and must pass clean')
  //   the supporting-cast array key `also` is what the cap SHAPES — and `also` is not a
  //   substring match for `also_cap`, so the EFFECT the client sees must pass clean.
  assert.doesNotThrow(
    () => assertNoEmphasis({ briefing: { also: [{ metric: 'leads', label: 'Leads' }, { metric: 'revenue', label: 'Revenue' }] } }, 'supporting-cast-probe'),
    "the supporting-cast array `also` must pass — it is the knob's EFFECT, not the knob")
  //   the consumer's own engagement vote — the only engagement bytes they ever receive.
  assert.doesNotThrow(
    () => assertNoEmphasis({ as_of: '2026-05-18', signal: 'helpful' }, 'own-vote-probe'),
    'the consumer own-vote must pass clean')
})

// ------------------------------------------------------------
// intel-v9 layer 20b wires the efficacy scorer (20a) into the read path. Layer 19
// FLEXES the supporting-cast cap on every reception grade with fixed steps and never
// checks whether the flex worked; layer 20 closes that gap by MEASURING it. The
// engine derives nothing new — it re-reads the engagement_policy already persisted on
// each portfolio morning (19b) and pairs each decision with its OWN follow-on
// reception: buildEmphasisObservations zips consecutive policied portfolio rows into
// { direction, rate_before(=that morning's helpful_rate), base_cap, rate_after(=the
// NEXT morning's helpful_rate), n_after }, and briefEmphasisEfficacyFor threads the
// agency/PORTFOLIO_KEY/day-window read (listRecentBriefs) through summarizeEmphasisEfficacy
// to a bounded step-scale a future layer-21 controller can feed back into layer 19.
// briefEmphasisEfficacy.test.js (20a) proves the scorer in isolation; these two tests
// prove the WIRING — the pure zip, and the end-to-end read→pair→score over real
// persisted rows with a deterministic verdict and the agency-only narrative.
const { narrateEmphasisEfficacy } = require('../lib/briefEmphasisEfficacy')

test('20b — buildEmphasisObservations zips consecutive policied rows into decision→follow-on pairs, skipping unpolicied/directionless rows', () => {
  const rows = [
    { as_of: '2026-04-01', pack: { engagement_policy: { direction: 'widen',   helpful_rate: 0.80, base_cap: 3, also_cap: 4, n: 10 } } },
    { as_of: '2026-04-02', pack: { briefing: { also: [] } } },                                       // no engagement_policy → skipped
    { as_of: '2026-04-03', pack: { engagement_policy: { direction: 'tighten', helpful_rate: 0.50, base_cap: 3, n: 11 } } },
    { as_of: '2026-04-04', pack: { engagement_policy: { status: 'idle', helpful_rate: 0.60, n: 5 } } }, // policy without a direction → skipped
    { as_of: '2026-04-05', pack: { engagement_policy: { direction: 'neutral', helpful_rate: 0.62, base_cap: 3, n: 9 } } },
  ]
  // policied = [A(widen), C(tighten), E(neutral)] — B and D are filtered BEFORE pairing,
  // so A pairs with C (not B). Each pair maps the DECISION's own fields (direction,
  // rate_before, base_cap) against the NEXT morning's reception (rate_after, n_after).
  assert.deepEqual(buildEmphasisObservations(rows), [
    { as_of: '2026-04-01', direction: 'widen',   rate_before: 0.80, base_cap: 3, rate_after: 0.50, n_after: 11 },
    { as_of: '2026-04-03', direction: 'tighten', rate_before: 0.50, base_cap: 3, rate_after: 0.62, n_after: 9 },
  ])

  // a single policied row has no follow-on → no observation.
  assert.deepEqual(
    buildEmphasisObservations([{ as_of: '2026-04-01', pack: { engagement_policy: { direction: 'widen', helpful_rate: 0.7, base_cap: 3, n: 5 } } }]),
    [])
  // no policied rows at all (missing wrapper, or wrapper without a direction) → [].
  assert.deepEqual(
    buildEmphasisObservations([{ as_of: 'a', pack: {} }, { as_of: 'b', pack: { engagement_policy: { status: 'idle' } } }]),
    [])
  // a normalized row whose pack is null — or, defensively, still an unparsed string — carries
  // no policy (the helper reads an already-parsed object pack, never re-parses).
  assert.deepEqual(
    buildEmphasisObservations([{ as_of: 'a', pack: null }, { as_of: 'b', pack: '{"engagement_policy":{"direction":"widen"}}' }]),
    [])
  // junk / non-array inputs never throw → [].
  for (const junk of [null, undefined, 'nope', 42, {}, NaN]) {
    assert.deepEqual(buildEmphasisObservations(junk), [], `non-array input ${String(junk)} → []`)
  }
})

test('20b — briefEmphasisEfficacyFor reads the agency/PORTFOLIO_KEY day-window and scores a real sustained-widen history; client + out-of-window rows are excluded', async () => {
  await ready()

  // Direct-seed the portfolio engagement_policy history rather than driving
  // generatePortfolioBrief, so every decision/follow-on field is controlled and the
  // verdict is deterministic — the DERIVATION rules (deriveBriefEmphasis) are 19a's
  // contract, not 20b's. Mirror upsertBrief's column shape exactly; pack is stored as a
  // JSON string (normalizeBriefRow parses it back to an object on read).
  async function seedPolicy(asOf, policy, opts = {}) {
    const { scopeKey = PORTFOLIO_KEY, audience = 'agency', clientId = null } = opts
    await db.query(
      `INSERT INTO ai_briefs (scope_key, as_of, audience, client_id, model, pack, brief_text, grounded, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP)
       ON CONFLICT (scope_key, as_of) DO UPDATE SET
         audience = EXCLUDED.audience, client_id = EXCLUDED.client_id, model = EXCLUDED.model,
         pack = EXCLUDED.pack, brief_text = EXCLUDED.brief_text, grounded = EXCLUDED.grounded,
         updated_at = CURRENT_TIMESTAMP`,
      [scopeKey, asOf, audience, clientId, 'test-model',
       JSON.stringify(policy ? { engagement_policy: policy } : {}), 'Good morning.', 1]
    )
  }

  // Order-independent isolation: clear any PORTFOLIO_KEY rows inside our April seed range.
  // (Every other test seeds PORTFOLIO_KEY only at 2026-05-18 — AFTER this anchor, and so
  // outside the window — and our out-of-window probe sits at 2026-01-01, below this floor,
  // so neither is disturbed.)
  await db.query(
    `DELETE FROM ai_briefs WHERE scope_key = $1 AND as_of >= $2 AND as_of <= $3`,
    [PORTFOLIO_KEY, '2026-04-01', '2026-04-16'])

  const wd = (helpful_rate, n) => ({ status: 'tuned', direction: 'widen',   helpful_rate, base_cap: 3, also_cap: 4, min_cap: 1, max_cap: 4, n })
  const nu = (helpful_rate, n) => ({ status: 'idle',  direction: 'neutral', helpful_rate, base_cap: 3, also_cap: 3, min_cap: 1, max_cap: 4, n })

  // Five consecutive WIDEN mornings whose reception SUSTAINS (each next rate within the
  // noise band of the last) → 5 widen observations, all "success". Then four held-NEUTRAL
  // mornings — the CONTROL arm — whose reception drifts flat (never +0.05) → control never
  // "improves". The widen→first-neutral transition stays a SUCCESS because that neutral
  // morning's reception (0.80) is itself within band of the last widen (0.81).
  await seedPolicy('2026-04-08', wd(0.80, 12))
  await seedPolicy('2026-04-09', wd(0.81, 12))
  await seedPolicy('2026-04-10', wd(0.80, 12))
  await seedPolicy('2026-04-11', wd(0.82, 12))
  await seedPolicy('2026-04-12', wd(0.81, 12))
  await seedPolicy('2026-04-13', nu(0.80, 12))
  await seedPolicy('2026-04-14', nu(0.79, 12))
  await seedPolicy('2026-04-15', nu(0.80, 12))
  await seedPolicy('2026-04-16', nu(0.78, 12))

  // Two rows that MUST be excluded by the read's filters:
  //   • an out-of-window agency PORTFOLIO_KEY row (before the 90-day window ending 2026-04-16,
  //     which starts 2026-01-17) → if wrongly included it would be the EARLIEST row and inject
  //     a spurious tighten observation, flipping tighten.n off zero.
  await seedPolicy('2026-01-01', { status: 'tuned', direction: 'tighten', helpful_rate: 0.30, base_cap: 3, n: 12 })
  //   • an in-window CLIENT brief carrying a policy under a client scope → the agency scorer
  //     must never see it (audience AND scope_key both exclude it).
  const c = await freshClient('Emphasis Efficacy Window Probe Roofing')
  await seedPolicy('2026-04-12', { status: 'tuned', direction: 'tighten', helpful_rate: 0.20, base_cap: 3, n: 9 },
    { scopeKey: c, audience: 'client', clientId: c })

  const eff = await briefEmphasisEfficacyFor('2026-04-16', 90)

  // Deterministic scorecard: 5 sustained widen observations, 3 flat neutral controls.
  assert.equal(eff.status, 'graded')
  assert.equal(eff.n, 5, 'only the 5 in-window widen observations are scored')
  assert.equal(eff.directions.widen.n, 5)
  assert.equal(eff.directions.widen.successes, 5)
  assert.equal(eff.directions.widen.failures, 0)
  assert.equal(eff.directions.widen.rate, 1)
  assert.equal(eff.directions.tighten.n, 0, 'the out-of-window tighten row and the client tighten row are BOTH excluded')
  assert.equal(eff.control_n, 3, 'three held-neutral mornings form the control arm')
  assert.equal(eff.control_rate, 0, 'reception never improved after a held-steady morning')
  assert.equal(eff.prior, 0)
  assert.equal(eff.recommendation.verdict, 'endorsed')
  assert.equal(eff.recommendation.reason, 'widen_sustaining')
  assert.equal(eff.recommendation.widen_step_scale, 1.25, 'a confident sustained widen endorses toward the ceiling')
  assert.equal(eff.recommendation.tighten_step_scale, 1, 'tighten has no measured outcomes → base step')

  // The agency hears the self-tuning reasoning, grounded in the very counts above…
  const line = narrateEmphasisEfficacy(eff, { audience: 'agency' })
  assert.match(line, /^Widening is holding up —/)
  assert.match(line, /\(5 of 5\)/)
  assert.match(line, /vs 0% when the brief held steady/)
  assert.match(line, /step ×1\.25/)
  // …and the consumer hears NONE of it — the efficacy loop is agency-only telemetry.
  assert.equal(narrateEmphasisEfficacy(eff, { audience: 'client' }), '')
})

// ============================================================
// 20d — EMPHASIS-EFFICACY CONFINEMENT: the loop that grades the reception flex is
// agency-only telemetry; it rides no client byte — and, unlike 19d's policy, no pack.
// ------------------------------------------------------------
// intel-v9 layer 20 closes the SECOND-order loop. Layer 19 flexes tomorrow's
// supporting-cast cap on today's reception grade with FIXED steps and never checks
// whether the flex paid off; layer 20 measures it — did a sustained widen keep
// reception up (against the CONTROL of mornings the brief held steady)? did a tighten
// recover it? — and emits a BOUNDED step-scale a future layer-21 controller can feed
// back into 19 (summarizeEmphasisEfficacy → recommendation.{widen,tighten}_step_scale).
// That scorecard is the densest agency instrument yet: a control arm, per-direction
// Wilson lifts, a verdict and a machine reason. The consumer must receive NONE of it.
//
// Layer 20's confinement is STRICTER than 19d's by construction. Where 19d's
// engagement_policy DOES ride the PORTFOLIO pack (agency telemetry, gated off the client
// pack), the efficacy summary rides NO pack at all — it exists only as the return of
// briefEmphasisEfficacyFor / the agency-gated /brief-emphasis-efficacy route, computed at
// read time over the persisted policy history. So the agency surface that must trip the
// client guard is the SUMMARY OBJECT ITSELF, not a pack field — and we additionally prove
// neither the client NOR the portfolio pack ever carries the efficacy vocabulary.
// narrateEmphasisEfficacy is '' for the client UNCONDITIONALLY (before any status check),
// the precedent of 18d/19d. 20a proves the scorer/narrator in isolation, 20b the read-path
// wiring with the genuine end-to-end payload; here we prove the EGRESS SPLIT.
const { summarizeEmphasisEfficacy } = require('../lib/briefEmphasisEfficacy')

// The efficacy summary ALWAYS carries the control arm (control_rate, control_n) at its
// root and the step-scale pair (widen_step_scale, tighten_step_scale) in its
// recommendation — for BOTH the graded and the honest-abstention 'insufficient' shape —
// and every scored direction carries lower_lift + median_delta. Guarding those six keys is
// therefore a COMPLETE structural guard: no summary shape can ride along without tripping.
// NOT bare `rate`/`n`/`prior`/`verdict`/`reason`/`direction`/`successes` (generic, shared
// with a lone honest vote or a client focus). And — deliberately — NOT the verdict VALUES
// `steady`/`tempered`/`endorsed`/`insufficient`: `steady` is the agency narrative's own
// plain English ("held steady") AND a client focus trend; `tempered` is live client
// diagnosis prose (pulseDiagnose.js "tempered the rise"); `endorsed`/`insufficient` are
// generic words. Forbidding any bare verdict word would false-positive legit egress. The
// verdict is caught STRUCTURALLY instead — it cannot ride without the step-scale keys
// beside it — and by its distinctive machine REASONS below (mirrors 19d: forbid the
// compound `steady_reception`, never bare `steady`).
const FORBIDDEN_EFFICACY_KEYS = [
  'widen_step_scale', 'tighten_step_scale',
  'control_rate', 'control_n',
  'lower_lift', 'median_delta',
]
// Distinctive efficacy tokens only — the structural keys as strings (plus the bare
// `step_scale` stem, catching any future *_step_scale), and the seven machine REASON
// values. None appears in the agency narrative (which says "holding up" / "leaning in" /
// "easing off" / "in line with holding steady", never the tokens) nor in any client prose.
const FORBIDDEN_EFFICACY_TOKENS =
  /widen_step_scale|tighten_step_scale|step_scale|control_rate|control_n|lower_lift|median_delta|widen_overserving|tighten_not_recovering|widen_sustaining|tighten_recovering|in_line_with_control|no_measured_outcomes|thin_history/

function assertNoEfficacy(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(
          !FORBIDDEN_EFFICACY_KEYS.includes(k),
          `${where}: client egress must not carry emphasis-efficacy field "${k}" (at ${path})`
        )
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(
    !FORBIDDEN_EFFICACY_TOKENS.test(JSON.stringify(pack)),
    `${where}: emphasis-efficacy vocabulary leaked into the serialized client egress`
  )
  // Belt-and-suspenders: a clean efficacy egress must also clear the 19d emphasis sweep
  // (which itself delegates to the 18d aggregate sweep) — the three layers stack.
  assertNoEmphasis(pack, where)
}

// A genuine graded scorecard scored from synthetic observations — five sustained-widen
// mornings (each next reception within the noise band, delta ≥ -0.05 → all "success")
// measured against three held-neutral controls whose reception never rose +0.05 (control
// rate 0). This is the exact OBSERVATION shape buildEmphasisObservations produces and the
// object the /brief-emphasis-efficacy route serializes; 20b proves it end-to-end from the
// persisted history, so here we score it directly (no DB). It lands deterministically on
// the SAME endorsed/widen_sustaining/×1.25 verdict 20b's seeded history produces.
const SUSTAINED_WIDEN_OBS = [
  { as_of: '2026-04-08', direction: 'widen',   rate_before: 0.80, base_cap: 3, rate_after: 0.81, n_after: 12 },
  { as_of: '2026-04-09', direction: 'widen',   rate_before: 0.81, base_cap: 3, rate_after: 0.80, n_after: 12 },
  { as_of: '2026-04-10', direction: 'widen',   rate_before: 0.80, base_cap: 3, rate_after: 0.82, n_after: 12 },
  { as_of: '2026-04-11', direction: 'widen',   rate_before: 0.82, base_cap: 3, rate_after: 0.81, n_after: 12 },
  { as_of: '2026-04-12', direction: 'widen',   rate_before: 0.81, base_cap: 3, rate_after: 0.80, n_after: 12 },
  { as_of: '2026-04-13', direction: 'neutral', rate_before: 0.80, base_cap: 3, rate_after: 0.79, n_after: 12 },
  { as_of: '2026-04-14', direction: 'neutral', rate_before: 0.79, base_cap: 3, rate_after: 0.80, n_after: 12 },
  { as_of: '2026-04-15', direction: 'neutral', rate_before: 0.80, base_cap: 3, rate_after: 0.78, n_after: 12 },
]
const EFF_GRADED = summarizeEmphasisEfficacy(SUSTAINED_WIDEN_OBS)
const EFF_INSUFFICIENT = summarizeEmphasisEfficacy([]) // no observations → honest abstention

test('20d — narrateEmphasisEfficacy is silent for the CLIENT unconditionally; the agency hears the self-tuning, identifier-free', () => {
  // Sanity: the synthetic history scored into a real, MOVED graded scorecard — the same
  // endorsed widen 20b earns end-to-end — so the agency narration below is non-vacuous.
  assert.equal(EFF_GRADED.status, 'graded', 'five widen observations score into a graded scorecard')
  assert.equal(EFF_GRADED.directions.widen.successes, 5, 'all five sustained-widen mornings count as successes')
  assert.equal(EFF_GRADED.recommendation.verdict, 'endorsed', 'a confident sustained widen is endorsed')
  assert.equal(EFF_GRADED.recommendation.reason, 'widen_sustaining')
  assert.equal(EFF_INSUFFICIENT.status, 'insufficient', 'no observations → honest abstention')

  // THE INVARIANT: the consumer never hears the efficacy loop — for ANY summary shape
  // (graded-and-moved, abstained, malformed, junk), narration is '' UNCONDITIONALLY.
  for (const [name, s] of [
    ['graded', EFF_GRADED], ['insufficient', EFF_INSUFFICIENT],
    ['null', null], ['malformed', { status: 'graded' }], ['junk', 'nope'],
  ]) {
    assert.equal(narrateEmphasisEfficacy(s, { audience: 'client' }), '', `client narration must be '' for ${name}`)
  }

  // The agency DOES hear the moved scorecard — proving the client silence is a deliberate
  // split, not a dead feature…
  const agency = narrateEmphasisEfficacy(EFF_GRADED, { audience: 'agency' })
  assert.ok(agency.length > 0, 'the agency hears the self-tuning verdict on a moved scorecard')
  assert.match(agency, /^Widening is holding up —/)
  // …but stays mute when nothing is earned — an abstained scorecard tunes nothing.
  assert.equal(narrateEmphasisEfficacy(EFF_INSUFFICIENT, { audience: 'agency' }), '', 'an abstained scorecard is narrated to no one')

  // Even the candid agency sentence carries no machine identifier — it could not seed a
  // leak even if mis-routed (it says "step ×1.25", "held steady", never "widen_step_scale"/
  // "control_rate"/"widen_sustaining") — and clears the 19d + 18d sweeps too.
  assert.ok(!FORBIDDEN_EFFICACY_TOKENS.test(agency), 'agency efficacy sentence carries no efficacy identifier')
  assert.ok(!FORBIDDEN_EMPHASIS_TOKENS.test(agency), 'agency efficacy sentence carries no emphasis identifier')
  assert.ok(!FORBIDDEN_ENGAGEMENT_TOKENS.test(agency), 'agency efficacy sentence carries no aggregate identifier')
})

test('20d — a real efficacy scorecard trips the client guard, while neither the client nor the portfolio pack carries its vocabulary: an endpoint-only split', async () => {
  await ready()

  // THE AGENCY SURFACE: the scorecard the route returns is dense with the control arm,
  // per-direction lifts and a verdict → the client guard MUST trip on it, confirming the
  // cleanliness below is a real split, not a vacuous pass. (20b proves this same object is
  // the genuine end-to-end briefEmphasisEfficacyFor payload; we score it directly here.)
  assert.throws(
    () => assertNoEfficacy(EFF_GRADED, 'efficacy-scorecard-probe'),
    /emphasis-efficacy field|emphasis-efficacy vocabulary/,
    'the efficacy scorecard is dense with machinery — the client guard MUST trip on it')

  // THE CLIENT SURFACE: the consumer pack carries none of the efficacy machinery — and,
  // carried from 19d, none of the emphasis policy nor the 18d aggregate either (the
  // belt-and-suspenders delegation inside assertNoEfficacy enforces all three layers).
  const c = await freshClient('Emphasis Efficacy Confinement Roofing Co')
  const cli = await generateClientBrief(c, AS_OF)
  assert.equal(cli.grounded, true)
  assert.match(cli.brief_text, /^Good morning\./)
  assertNoEfficacy(cli.pack, 'generateClientBrief')
  // the persisted read-back — the row the client actually fetches — is just as clean.
  const cliRow = await getClientBrief(c, AS_OF)
  assertNoEfficacy(cliRow.pack, 'getClientBrief read-back')

  // STRICTER THAN 19d: the efficacy summary rides NO pack — not even the agency/portfolio
  // pack (it is computed only at read time by briefEmphasisEfficacyFor / the route). The
  // portfolio pack may legitimately carry the 19d engagement_policy, so the full
  // belt-and-suspenders assertNoEfficacy would rightly trip on THAT (the delegated 19d
  // sweep), not on efficacy; we assert the narrower, layer-20-specific truth that the
  // EFFICACY vocabulary in particular never rides the portfolio pack.
  const port = await generatePortfolioBrief(AS_OF)
  assert.ok(
    !FORBIDDEN_EFFICACY_TOKENS.test(JSON.stringify(port.pack)),
    'the efficacy vocabulary must never ride the serialized portfolio pack — it is endpoint-only')
  ;(function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_EFFICACY_KEYS.includes(k), `the portfolio pack must not carry the efficacy field "${k}"`)
        walk(o[k])
      }
    }
  })(port.pack)
})

test('20d — the efficacy guard is load-bearing: a smuggled step-scale, control rate, lift, or reason value trips it; legit client fields never do', () => {
  // each structural key is caught BY NAME, however deeply nested.
  assert.throws(() => assertNoEfficacy({ rec: { widen_step_scale: 1.25 } }, 'step-scale-probe'),
    /emphasis-efficacy field/, 'a lone widen_step_scale must be rejected by name')
  assert.throws(() => assertNoEfficacy({ box: { control_rate: 0.5 } }, 'control-rate-probe'),
    /emphasis-efficacy field/, 'a lone control_rate must be rejected by name')
  assert.throws(() => assertNoEfficacy({ box: { control_n: 3 } }, 'control-n-probe'),
    /emphasis-efficacy field/, 'a lone control_n must be rejected by name')
  assert.throws(() => assertNoEfficacy({ dir: { lower_lift: 0.1 } }, 'lower-lift-probe'),
    /emphasis-efficacy field/, 'a lone lower_lift must be rejected by name')
  assert.throws(() => assertNoEfficacy({ dir: { median_delta: 0.02 } }, 'median-delta-probe'),
    /emphasis-efficacy field/, 'a lone median_delta must be rejected by name')
  // a machine REASON smuggled in as a plain string is caught by the token sweep.
  assert.throws(() => assertNoEfficacy({ note: 'the loop verdict: widen_sustaining today' }, 'reason-token-probe'),
    /emphasis-efficacy vocabulary/, "a reason identifier ('widen_sustaining') leaked as a string must be rejected")
  assert.throws(() => assertNoEfficacy({ note: 'reading in_line_with_control' }, 'control-reason-probe'),
    /emphasis-efficacy vocabulary/, "'in_line_with_control' leaked as a string must be rejected")
  assert.throws(() => assertNoEfficacy({ note: 'thin_history for now' }, 'thin-history-probe'),
    /emphasis-efficacy vocabulary/, "'thin_history' leaked as a string must be rejected")
  // the whole scorecard trips (control arm + step scales present).
  assert.throws(() => assertNoEfficacy(EFF_GRADED, 'full-scorecard-probe'),
    /emphasis-efficacy field|emphasis-efficacy vocabulary/, 'the full scorecard must be rejected')

  // CRITICAL disjointness — the legit client vocabulary the guard must NEVER catch:
  //   the client focus (Section D): direction + delta_pct + a 'steady' metric trend. `steady`
  //   is the verdict VALUE we deliberately did NOT forbid — it is also a plain metric trend and
  //   the agency narrative's own English — so it must pass clean here.
  assert.doesNotThrow(
    () => assertNoEfficacy({ focus: { direction: 'down', delta_pct: -40, label: 'Leads', lane: 'act_now', metric: 'leads', trend: 'steady' } }, 'client-focus-probe'),
    'the client focus (direction + delta_pct + steady trend) is legit and must pass clean')
  //   bare `steady` AND bare `tempered` in plain brief prose — `tempered` is live client
  //   diagnosis copy (pulseDiagnose.js "tempered the rise"), so the efficacy guard forbidding
  //   it would break a real client brief. Both must pass.
  assert.doesNotThrow(
    () => assertNoEfficacy({ note: 'Leads held steady this week; the recent rise was tempered.' }, 'steady-tempered-prose-probe'),
    "bare 'steady'/'tempered' in client prose are disjoint from the efficacy tokens and must pass")
  //   the supporting-cast array the cap shapes — the EFFECT the client sees, not the knob.
  assert.doesNotThrow(
    () => assertNoEfficacy({ briefing: { also: [{ metric: 'leads', label: 'Leads' }, { metric: 'revenue', label: 'Revenue' }] } }, 'supporting-cast-probe'),
    'the supporting-cast array must pass — it is the EFFECT, not the machinery')
  //   the consumer's own engagement vote — the only engagement bytes they ever receive.
  assert.doesNotThrow(
    () => assertNoEfficacy({ as_of: '2026-05-18', signal: 'helpful' }, 'own-vote-probe'),
    'the consumer own-vote must pass clean')
})

// ============================================================
// 21d — EMPHASIS-CONTROL CONFINEMENT: the controller that feeds layer 20's measured
// step-scale back into layer 19's flex MAGNITUDE is the outermost turn of the outward
// loop — and, like the efficacy summary it consumes, it rides NO client byte and NO pack.
// ------------------------------------------------------------
// intel-v9 layer 21 closes the feedback path the four layers describe: 18 grades the brief
// → 19 flexes tomorrow's supporting-cast cap on that grade with FIXED steps → 20 measures
// whether the flex paid off and emits a bounded per-direction step-scale → 21 applies that
// scale back into 19's step MAGNITUDE (a vindicated widen leans in one deeper, an
// over-served widen eases off — never past the [MIN_CAP,MAX_CAP] rails 19 already owns).
// applyEmphasisControl(emphasis, efficacy) is the densest agency instrument the stack
// produces: it carries the move (lean_in/ease_off/hold/none), the machine reason
// (efficacy_endorsed/_tempered/_neutral/no_flex_to_scale/insufficient_efficacy), the
// applied step_scale, the base-vs-controlled step pair, and the PRE-control cap it started
// from (emphasis_also_cap). The consumer must receive NONE of it.
//
// Layer 21's confinement matches 20's, STRICTER than 19's: where 19's engagement_policy
// DOES ride the PORTFOLIO pack (agency telemetry, gated off the client pack), the
// controller verdict rides NO pack at all — it exists only as the return of
// applyEmphasisControl / the agency-gated /brief-emphasis-control route, computed at read
// time over the persisted policy + efficacy history. So the agency surface that must trip
// the client guard is the CONTROLLER VERDICT ITSELF, not a pack field — and we additionally
// prove neither the client NOR the portfolio pack ever carries the control vocabulary.
// narrateEmphasisControl is '' for the client UNCONDITIONALLY (the precedent of 18d/19d/20d).
// 21a proves the controller in isolation, 21b/21c the read-path + UI wiring; here, the
// EGRESS SPLIT — the fourth and outermost guard, stacked on 20→19→18.
const { applyEmphasisControl, narrateEmphasisControl } = require('../lib/briefEmphasisControl')

// Hand-built layer-20 recommendations, mirroring 21a's `eff()` helper — lets us drive each
// control move (ease_off needs a <1 widen scale, hold needs exactly 1.0) without seeding a
// history. applyEmphasisControl reads only efficacy.status + efficacy.recommendation.*, the
// shape both this stub and the genuine summarizeEmphasisEfficacy output satisfy.
const eff20 = (widen, tighten) => ({ status: 'graded', recommendation: { widen_step_scale: widen, tighten_step_scale: tighten, verdict: 'v', reason: 'r' } })

// The controller verdict ALWAYS carries the move + reason at its root, the applied
// step_scale, the base/controlled step pair, and the pre-control emphasis_also_cap — for
// EVERY shape (moved, held, or passed-through). Guarding those six keys is therefore a
// COMPLETE structural guard: no verdict can ride along without tripping. NOT the cap quartet
// (also_cap/base_cap/min_cap/max_cap — those are layer 19's, legit on the portfolio pack and
// already owned by the 19d guard we delegate to). NOT bare `hold`/`none`/`controlled`/
// `tuned`/`idle`/`delta`/`direction` — generic English or shared status words that would
// false-positive legit client prose and the focus object (mirrors 20d sparing bare
// `steady`/`tempered`). The move is caught STRUCTURALLY (it cannot ride without control_move
// beside it) AND by its two distinctive VALUES lean_in/ease_off in the token sweep below.
const FORBIDDEN_CONTROL_KEYS = [
  'control_move', 'control_reason', 'step_scale',
  'base_step', 'controlled_step', 'emphasis_also_cap',
]
// Distinctive control tokens only — the structural keys as strings (plus the bare
// `step_scale` stem, shared with 20d), the five machine REASON values, and the two
// distinctive MOVE values lean_in/ease_off. Deliberately NOT bare `hold`/`none`: `hold` is
// the agency narrative's own word ("holding a little more of the picture") and generic
// client prose; `none` is ubiquitous English. The narrative says "paying off" / "leaning in
// further" / "easing back toward the essentials" / "recovering attention", never the tokens.
const FORBIDDEN_CONTROL_TOKENS =
  /control_move|control_reason|step_scale|base_step|controlled_step|emphasis_also_cap|efficacy_endorsed|efficacy_tempered|efficacy_neutral|no_flex_to_scale|insufficient_efficacy|lean_in|ease_off/

function assertNoControl(pack, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(
          !FORBIDDEN_CONTROL_KEYS.includes(k),
          `${where}: client egress must not carry emphasis-control field "${k}" (at ${path})`
        )
        walk(o[k], `${path}.${k}`)
      }
    }
  })(pack, 'pack')
  assert.ok(
    !FORBIDDEN_CONTROL_TOKENS.test(JSON.stringify(pack)),
    `${where}: emphasis-control vocabulary leaked into the serialized client egress`
  )
  // Belt-and-suspenders: a clean control egress must also clear the 20d efficacy sweep
  // (which delegates to 19d → 18d) — all four turns of the outward loop stack here.
  assertNoEfficacy(pack, where)
}

// The real controller verdict: a vindicated layer-19 widen (EMPH_WIDEN, cap 3→4) re-scaled
// by layer-20's endorsed ×1.25 → a lean_in to cap 5, the SAME verdict 21b earns end-to-end.
const CTRL_TUNED = applyEmphasisControl(EMPH_WIDEN, EFF_GRADED)

test('21d — narrateEmphasisControl is silent for the CLIENT unconditionally; the agency hears the re-tuned knob, identifier-free', () => {
  // Sanity: the real upstream pair produced a MOVED, dense controller verdict — a lean_in
  // that pushed the vindicated widen one deeper (pre-cap 4 → controlled cap 5), the same the
  // /brief-emphasis-control route serves, so the agency narration below is non-vacuous.
  assert.deepEqual(
    { m: CTRL_TUNED.control_move, r: CTRL_TUNED.control_reason, cap: CTRL_TUNED.also_cap, pre: CTRL_TUNED.emphasis_also_cap, ctl: CTRL_TUNED.controlled },
    { m: 'lean_in', r: 'efficacy_endorsed', cap: 5, pre: 4, ctl: true },
    'endorsed efficacy leans the vindicated widen one deeper: pre-cap 4 → controlled cap 5')

  // THE INVARIANT: the consumer never hears the controller — for ANY shape (moved, held,
  // passed-through, abstained, or malformed), narration is '' UNCONDITIONALLY.
  for (const [name, c] of [
    ['lean_in', CTRL_TUNED],
    ['ease_off', applyEmphasisControl(EMPH_WIDEN, eff20(0.5, 1.0))],
    ['hold', applyEmphasisControl(EMPH_WIDEN, eff20(1.0, 1.0))],
    ['passthrough', applyEmphasisControl(EMPH_IDLE, EFF_GRADED)],
    ['insufficient', applyEmphasisControl(EMPH_WIDEN, EFF_INSUFFICIENT)],
    ['null', null], ['malformed', { controlled: true }], ['junk', 'nope'],
  ]) {
    assert.equal(narrateEmphasisControl(c, { audience: 'client' }), '', `client narration must be '' for ${name}`)
  }

  // The agency DOES hear the moved controller — grounded in the efficacy that drove it —
  // proving the client silence is a deliberate split, not a dead feature…
  const agency = narrateEmphasisControl(CTRL_TUNED, { audience: 'agency' })
  assert.ok(agency.length > 0, 'the agency hears the controller on a moved verdict')
  assert.match(agency, /paying off|leaning in/, 'the lean_in verdict reads as plain English')
  // …but stays mute on a pass-through (19 idle → no flex to scale) and on a neutral hold.
  assert.equal(narrateEmphasisControl(applyEmphasisControl(EMPH_IDLE, EFF_GRADED), { audience: 'agency' }), '',
    'the agency hears nothing when there was no flex to scale')
  assert.equal(narrateEmphasisControl(applyEmphasisControl(EMPH_WIDEN, eff20(1.0, 1.0)), { audience: 'agency' }), '',
    'the agency hears nothing on a neutral hold')

  // Even the candid agency sentence carries no machine identifier — it could not seed a leak
  // even if mis-routed (it says "leaning in further", "easing back", never "lean_in"/
  // "ease_off"/"step_scale") — and clears the 20d + 19d + 18d sweeps too.
  assert.ok(!FORBIDDEN_CONTROL_TOKENS.test(agency), 'agency control sentence carries no control identifier')
  assert.ok(!FORBIDDEN_EFFICACY_TOKENS.test(agency), 'agency control sentence carries no efficacy identifier')
  assert.ok(!FORBIDDEN_EMPHASIS_TOKENS.test(agency), 'agency control sentence carries no emphasis identifier')
  assert.ok(!FORBIDDEN_ENGAGEMENT_TOKENS.test(agency), 'agency control sentence carries no aggregate identifier')
})

test('21d — the controller verdict trips the client guard, yet neither the client nor the portfolio pack carries its vocabulary: an endpoint-only split', async () => {
  await ready()

  // THE AGENCY SURFACE: the verdict the route returns is dense with control_move/
  // control_reason/step_scale/base_step/controlled_step/emphasis_also_cap → the client guard
  // MUST trip on it, confirming the cleanliness below is a real split, not a vacuous pass.
  assert.throws(
    () => assertNoControl(CTRL_TUNED, 'controller-verdict-probe'),
    /emphasis-control field|emphasis-control vocabulary/,
    'the controller verdict is dense with machinery — the client guard MUST trip on it')

  // THE CLIENT SURFACE: the consumer pack carries none of the control machinery — and, by
  // the stacked delegation inside assertNoControl, none of the 20d efficacy / 19d emphasis /
  // 18d aggregate vocabulary either (all four outward-loop layers enforced at once).
  const c = await freshClient('Emphasis Control Confinement Roofing Co')
  const cli = await generateClientBrief(c, AS_OF)
  assert.equal(cli.grounded, true)
  assert.match(cli.brief_text, /^Good morning\./)
  assertNoControl(cli.pack, 'generateClientBrief')
  // the persisted read-back — the row the client actually fetches — is just as clean.
  const cliRow = await getClientBrief(c, AS_OF)
  assertNoControl(cliRow.pack, 'getClientBrief read-back')

  // LIKE 20d: the controller rides NO pack — not even the agency/portfolio pack (it is
  // computed only at read time by applyEmphasisControl / the route). The portfolio pack may
  // legitimately carry the 19d engagement_policy PROJECTION, so the full belt-and-suspenders
  // assertNoControl would rightly trip on THAT (the delegated 19d sweep), not on control; we
  // assert the narrower, layer-21-specific truth: the CONTROL vocabulary never rides it.
  const port = await generatePortfolioBrief(AS_OF)
  assert.ok(
    !FORBIDDEN_CONTROL_TOKENS.test(JSON.stringify(port.pack)),
    'the control vocabulary must never ride the serialized portfolio pack — it is endpoint-only')
  ;(function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_CONTROL_KEYS.includes(k), `the portfolio pack must not carry the control field "${k}"`)
        walk(o[k])
      }
    }
  })(port.pack)

  // …and the layer-19 projection the portfolio pack DOES carry stays pure layer 19: if the
  // engagement_policy is present, it speaks only the 19 cap-policy vocabulary — no step_scale
  // / control_move rode back in with the controller's feedback (21b persists the cap policy,
  // never the controller verdict).
  if (port.pack && port.pack.engagement_policy) {
    const ep = port.pack.engagement_policy
    assert.ok(!FORBIDDEN_CONTROL_TOKENS.test(JSON.stringify(ep)),
      'the engagement_policy projection must carry no control vocabulary')
    for (const k of FORBIDDEN_CONTROL_KEYS) {
      assert.ok(!(k in ep), `the engagement_policy projection must not carry the control field "${k}"`)
    }
  }
})

test('21d — the control guard is load-bearing: a smuggled move, reason, scale, or step trips it; legit client fields never do', () => {
  // each structural key is caught BY NAME, however deeply nested.
  assert.throws(() => assertNoControl({ ctl: { control_move: 'lean_in' } }, 'move-probe'),
    /emphasis-control field/, 'a lone control_move must be rejected by name')
  assert.throws(() => assertNoControl({ ctl: { control_reason: 'efficacy_endorsed' } }, 'reason-probe'),
    /emphasis-control field/, 'a lone control_reason must be rejected by name')
  assert.throws(() => assertNoControl({ box: { step_scale: 1.25 } }, 'scale-probe'),
    /emphasis-control field/, 'a lone step_scale must be rejected by name')
  assert.throws(() => assertNoControl({ box: { base_step: 1 } }, 'base-step-probe'),
    /emphasis-control field/, 'a lone base_step must be rejected by name')
  assert.throws(() => assertNoControl({ box: { controlled_step: 2 } }, 'controlled-step-probe'),
    /emphasis-control field/, 'a lone controlled_step must be rejected by name')
  assert.throws(() => assertNoControl({ box: { emphasis_also_cap: 4 } }, 'pre-cap-probe'),
    /emphasis-control field/, 'a lone emphasis_also_cap must be rejected by name')
  // a machine REASON / MOVE value smuggled in as a plain string is caught by the token sweep.
  assert.throws(() => assertNoControl({ note: 'the loop logged efficacy_tempered today' }, 'reason-token-probe'),
    /emphasis-control vocabulary/, "a reason identifier ('efficacy_tempered') leaked as a string must be rejected")
  assert.throws(() => assertNoControl({ note: 'reason: no_flex_to_scale' }, 'no-flex-token-probe'),
    /emphasis-control vocabulary/, "'no_flex_to_scale' leaked as a string must be rejected")
  assert.throws(() => assertNoControl({ note: 'we are easing: ease_off now' }, 'move-token-probe'),
    /emphasis-control vocabulary/, "'ease_off' leaked as a string must be rejected")
  // the whole controller verdict trips (move + reason + step pair all present).
  assert.throws(() => assertNoControl(CTRL_TUNED, 'full-verdict-probe'),
    /emphasis-control field|emphasis-control vocabulary/, 'the full controller verdict must be rejected')

  // CRITICAL disjointness — the legit client vocabulary the guard must NEVER catch:
  //   the client focus (Section D): direction + delta_pct + a 'steady' trend + a lane. None
  //   of these is a control token (we forbid neither bare `direction` nor `steady`).
  assert.doesNotThrow(
    () => assertNoControl({ focus: { direction: 'down', delta_pct: -40, label: 'Leads', lane: 'act_now', metric: 'leads', trend: 'steady' } }, 'client-focus-probe'),
    'the client focus is legit and must pass clean')
  //   bare 'hold'/'holding'/'none' in plain brief prose — the move words we deliberately did
  //   NOT forbid ('hold' is the agency narrative's own word; 'none' is generic English), so a
  //   real client sentence using them must pass.
  assert.doesNotThrow(
    () => assertNoControl({ note: 'Leads hold steady; none of the channels slipped, so we are holding.' }, 'hold-none-prose-probe'),
    "bare 'hold'/'none' in client prose are disjoint from the control tokens and must pass")
  //   the supporting-cast array the controlled cap ultimately shapes — the EFFECT the client
  //   sees, not the knob that sized it.
  assert.doesNotThrow(
    () => assertNoControl({ briefing: { also: [{ metric: 'leads', label: 'Leads' }, { metric: 'revenue', label: 'Revenue' }] } }, 'supporting-cast-probe'),
    'the supporting-cast array must pass — it is the EFFECT of the cap, not the machinery')
  //   the consumer's own engagement vote — the only engagement byte they ever send.
  assert.doesNotThrow(
    () => assertNoControl({ as_of: '2026-05-18', signal: 'helpful' }, 'own-vote-probe'),
    'the consumer own-vote must pass clean')

  // FINAL disjointness ledger: the distinctive control tokens never appear in the generic
  // English the brief actually uses — so stacking 21→20→19→18 can never false-positive a
  // legit client egress on a control identifier (mirrors 20d's closing ledger).
  assert.ok(!FORBIDDEN_CONTROL_TOKENS.test('hold none steady tempered holding leaning easing'),
    'the control sweep is disjoint from the generic English the brief actually uses')
})
