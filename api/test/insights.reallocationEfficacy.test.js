'use strict'

// ============================================================
// test/insights.reallocationEfficacy.test.js — the ENGINE WIRING for the
// reallocation FEEDBACK LOOP (intel-v10 25b). lib/reallocationEfficacy.js is the
// PURE grader, unit-tested in isolation in reallocationEfficacy.test.js; THIS file
// proves the three reads that put that grader onto live data:
//
//   • buildReallocationTrials(rows, {asOf,…}) — the backtest RECONSTRUCTOR. Layer-24
//     decisions are computed-on-read (never persisted), so we rebuild each past
//     episode by re-slicing the atomic fact rows into the 26-week window a proposal
//     WOULD have seen (decision) and the 4-week window that FOLLOWED it (realized),
//     re-running the SAME pure proposer on the decision slice and the SAME cost-per-
//     outcome estimator on the realized slice — emitting one graded-shape trial per
//     past 'reallocate' (abstains are not decisions to grade).
//   • getClientReallocationEfficacy(clientId) — one client's track record: pulls the
//     (W+B·H)-week span once, reconstructs+grades in memory, serializes the table.
//   • getPortfolioReallocationEfficacy() — pools EVERY client's reconstructed trials
//     into ONE calibration the engine consumes, plus a names-and-counts by_client
//     breakdown; data-less clients contribute nothing and it never throws.
//
// The trial reconstruction is the load-bearing wire, so Test 1 drives it on SYNTHETIC
// fact rows (no DB) where we control exactly which weeks carry data: a decision window
// seeded with the live cheap-Google / pricey-Meta leads fixture (→ a reallocate
// meta→google_ads at gap 0.5, confidence 0.7) and a following realized window seeded to
// HOLD that edge (ga $30 / meta $60 → vindicated). Tests 3-4 then run the two DB reads
// end to end against an isolated temp SQLite DB (its own SQLITE_PATH, migrated once —
// which also seeds dim_channel, the JOIN this layer needs), asserting a well-formed
// serialized table (calibration + overall + ranked + by_strength + by_pair + by_client).
//
// AGENCY-ONLY, like all of Layer 24/25: a budget-shift track record is an internal
// media-buying instrument. The serialized table is dense with agency machinery
// (vindicated/refuted/hit_rate/calibration/from_cpo/to_cpo) — Layer 25d proves none of
// it ever reaches a client payload; here we only prove the wiring produces it.
// ============================================================

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// No key → no network (the reallocation path is pure template anyway).
delete process.env.ANTHROPIC_API_KEY

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `insights_realloc_eff_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const {
  buildReallocationTrials,
  getClientReallocationEfficacy,
  getPortfolioReallocationEfficacy,
  serializeReallocationEfficacy,
} = require('../lib/insights')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── clock + week math (mirrors the engine's reconstruction exactly) ──────────────
const DAY_MS = 86400000
const ASOF   = '2026-06-01'
const asOfMs = Date.parse(ASOF + 'T00:00:00Z')
const isoMinusDays = (n) => new Date(asOfMs - n * DAY_MS).toISOString().slice(0, 10)

// engine episode geometry (defaults H=4, B=6, W=26): episode 0 (most recent gradeable)
// has decisionEnd = day−H·7 = day−28, decision window [day−210, day−28] INCLUSIVE, and
// realized window (day−28, day]. We seed decision weeks at offsets 35..70 (all inside
// [28,210]) and realized weeks at offsets 0..21 (all inside (0,28]); offset 28 — the
// decision/realized boundary — is left empty so neither side is muddied.
const DECISION_OFFSETS = [35, 42, 49, 56, 63, 70]
const REALIZED_OFFSETS = [0, 7, 14, 21]

// the live leads fixture (identical to insights.reallocation.test): ga cheaper per lead
// (the PUSH target), meta pricier (the PULL source) → meta→google_ads reallocate, gap 0.5,
// confidence 0.7. lsa is never seeded → its partition abstains and the leads move wins.
const GA_SPEND   = [800, 1000, 1200, 900, 1100, 1000]  // Σ 6000
const GA_LEADS   = [27, 33, 40, 30, 37, 33]            // Σ 200 → cpo $30
const META_SPEND = [800, 1000, 1200, 900, 1100, 1000]  // Σ 6000
const META_LEADS = [13, 17, 20, 15, 18, 17]            // Σ 100 → cpo $60

const row = (channel, off, metric_key, total) =>
  ({ client_id: 'c1', channel, date: isoMinusDays(off), metric_key, total })

// Build the synthetic atomic fact rows the engine would have READ: the decision window
// carries the 6-week live fixture; the realized window carries a 4-week HOLD of the same
// edge (ga $30 / meta $60) so episode 0 grades 'vindicated'. Disjoint by construction —
// every decision row dates ≤ decisionEnd, every realized row dates > decisionEnd.
function syntheticReallocRows() {
  const rows = []
  DECISION_OFFSETS.forEach((off, i) => {
    rows.push(row('google_ads', off, 'spend', GA_SPEND[i]),  row('google_ads', off, 'leads', GA_LEADS[i]))
    rows.push(row('meta',       off, 'spend', META_SPEND[i]), row('meta',       off, 'leads', META_LEADS[i]))
  })
  for (const off of REALIZED_OFFSETS) {
    rows.push(row('google_ads', off, 'spend', 900), row('google_ads', off, 'leads', 30))  // realized cpo $30
    rows.push(row('meta',       off, 'spend', 900), row('meta',       off, 'leads', 15))   // realized cpo $60
  }
  return rows
}

// ── Test 1: buildReallocationTrials reconstructs episode 0's decision + realized halves ──
test('buildReallocationTrials reconstructs the past reallocate decision and grades its realized edge', () => {
  const trials = buildReallocationTrials(syntheticReallocRows(), { asOf: ASOF })

  // at least episode 0 fires (its decision window holds the full 6-week live fixture).
  assert.ok(Array.isArray(trials) && trials.length >= 1, 'a gradeable trial is reconstructed')

  // trials are pushed in episode order (k=0 first), so trials[0] is the most-recent episode,
  // anchored at decisionEnd = day − H·7 = day − 28.
  const t0 = trials[0]
  assert.equal(t0.as_of, isoMinusDays(28), 'episode 0 is anchored at decisionEnd = day − 28')
  assert.equal(t0.outcome, 'leads')         // the winning partition…
  assert.equal(t0.outcome_label, 'lead')    // …with its human label

  // the DECISION half is the proposer's verdict on the decision window — the live move,
  // identical to what getClientReallocation surfaces today on this fixture.
  assert.equal(t0.decision.from, 'meta')          // pricier per lead → PULL source
  assert.equal(t0.decision.to,   'google_ads')    // cheaper per lead → PUSH target
  assert.equal(t0.decision.from_cpo, 60)
  assert.equal(t0.decision.to_cpo,   30)
  assert.equal(t0.decision.gap_pct,  0.5)         // (60−30)/60 — the decision-time edge
  assert.equal(t0.decision.confidence, 0.7)
  assert.equal(typeof t0.decision.strength, 'string')

  // the REALIZED half is the SAME two channels' cost-per-outcome re-measured over the
  // following 4 weeks — here the edge HELD (ga $30 / meta $60), so it grades vindicated.
  assert.equal(t0.realized.to_cpo,   30, 'google_ads stayed at $30 per lead')
  assert.equal(t0.realized.from_cpo, 60, 'meta stayed at $60 per lead')
  assert.ok(t0.realized.to_cpo < t0.realized.from_cpo, 'the cheaper channel stayed cheaper')
})

// ── Test 2: the reconstructor is TOTAL — junk and empty inputs yield [] (never throws) ──
test('buildReallocationTrials is total: junk and empty inputs yield [] (never throws)', () => {
  assert.deepEqual(buildReallocationTrials([], { asOf: ASOF }), [])
  assert.deepEqual(buildReallocationTrials(null, { asOf: ASOF }), [])
  assert.deepEqual(buildReallocationTrials(undefined, { asOf: ASOF }), [])
  // a bad/absent as-of can't anchor the episode geometry → empty, no throw.
  assert.deepEqual(buildReallocationTrials(syntheticReallocRows(), { asOf: 'not-a-date' }), [])
  assert.deepEqual(buildReallocationTrials(syntheticReallocRows(), { asOf: null }), [])
  // rows present but no realloc-worthy decision window (a single thin week) → no trial.
  assert.deepEqual(
    buildReallocationTrials([row('google_ads', 49, 'spend', 1000), row('google_ads', 49, 'leads', 33)], { asOf: ASOF }),
    [])
})

// ============================================================
// DB harness (mirrors insights.reallocation.test.js): isolated temp SQLite, migrated
// once. seedChannelWeekly places weekly[k] on the day k weeks ago (offset 7k); falsy
// entries are skipped. Indices 0..3 land in episode 0's realized window, 5..10 in its
// decision window (idx 4 = the boundary week, left empty).
// ============================================================
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }  // also seeds dim_channel

let seq = 0
async function freshClient(name) {
  const id = `realloc-eff-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

async function seedChannelWeekly(clientId, channelId, metricKey, weekly) {
  for (let k = 0; k < weekly.length; k++) {
    const v = weekly[k]
    if (!v) continue
    await db.query(
      `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ($1,$2,$3,NULL,$4,$5)`,
      [clientId, isoMinusDays(7 * k), channelId, metricKey, v]
    )
  }
}

// the same decision+realized pattern as the synthetic fixture, indexed by week-offset:
//   realized weeks (idx 0..3): ga $30 / meta $60   ·   gap week (idx 4): empty
//   decision weeks (idx 5..10): the live cheap-ga / pricey-meta leads fixture
const GA_SPEND_WK   = [900, 900, 900, 900, 0, ...GA_SPEND]
const GA_LEADS_WK   = [30, 30, 30, 30, 0, ...GA_LEADS]
const META_SPEND_WK = [900, 900, 900, 900, 0, ...META_SPEND]
const META_LEADS_WK = [15, 15, 15, 15, 0, ...META_LEADS]

async function seedReallocClient(name) {
  const c = await freshClient(name)
  await seedChannelWeekly(c, 1, 'spend', GA_SPEND_WK)    // channel_id 1 = google_ads
  await seedChannelWeekly(c, 1, 'leads', GA_LEADS_WK)
  await seedChannelWeekly(c, 2, 'spend', META_SPEND_WK)  // channel_id 2 = meta
  await seedChannelWeekly(c, 2, 'leads', META_LEADS_WK)
  // lsa (channel_id 3 / booked_jobs) intentionally left EMPTY → its partition abstains.
  return c
}

// ── Test 3: getClientReallocationEfficacy serializes a well-formed agency table ──
test('getClientReallocationEfficacy serializes a well-formed agency track-record table', async () => {
  await ready()
  const c = await seedReallocClient('client efficacy')

  const out = await getClientReallocationEfficacy(c, { asOf: ASOF })

  // meta envelope: the client id + the episode params it reconstructed against.
  assert.equal(out.as_of, ASOF)
  assert.equal(out.client_id, String(c))
  assert.equal(out.horizon_weeks, 4)
  assert.equal(out.boundaries, 6)
  assert.equal(out.decision_weeks, 26)
  assert.ok(out.trials >= 1, 'at least episode 0 reconstructs a gradeable trial')

  // CALIBRATION — the knob the engine consumes — is always present, well-shaped, and a
  // behavioral no-op-to-mild at this thin evidence (factor clamped to [0.5, 1.2]).
  assert.ok(out.calibration && typeof out.calibration === 'object')
  assert.ok(Number.isFinite(out.calibration.factor))
  assert.ok(out.calibration.factor >= 0.5 && out.calibration.factor <= 1.2)
  assert.ok(Number.isFinite(out.calibration.n) && out.calibration.n >= 1)
  assert.equal(typeof out.calibration.basis, 'string')

  // the pooled OVERALL record + the served views.
  assert.ok(out.overall && out.overall.n >= 1, 'the pooled overall record carries the decided trial(s)')
  assert.ok(out.overall.vindicated >= 1, 'the held edge graded vindicated')
  assert.ok(Array.isArray(out.ranked) && out.ranked.length >= 1)
  assert.ok(Array.isArray(out.by_strength) && out.by_strength.length >= 1)
  assert.ok(Array.isArray(out.by_pair))
  assert.ok(out.base && typeof out.base === 'object')

  // every served strength row carries the agency machinery + the (n<4 → null) note slot.
  const r0 = out.ranked[0]
  for (const k of ['key', 'n', 'vindicated', 'refuted', 'hit_rate', 'lower', 'band']) {
    assert.ok(k in r0, `ranked row exposes ${k}`)
  }
  assert.ok('note' in r0, 'ranked row carries the agency note slot (null until n ≥ 4)')

  // the meta→google_ads pair is the one that was graded.
  const pair = out.by_pair.find(p => p.key === 'meta->google_ads')
  assert.ok(pair && pair.n >= 1, 'the meta→google_ads pair recorded the decided trial')
})

// ── Test 4: getPortfolioReallocationEfficacy pools clients into ONE calibration ──
test('getPortfolioReallocationEfficacy pools clients into ONE calibration with a by_client breakdown, excluding data-less', async () => {
  await ready()
  const hot  = await seedReallocClient('portfolio efficacy hot')
  const cold = await freshClient('portfolio efficacy cold')

  const out = await getPortfolioReallocationEfficacy({ asOf: ASOF })

  assert.equal(out.as_of, ASOF)
  assert.equal(out.scope, 'portfolio')
  assert.equal(out.horizon_weeks, 4)
  assert.equal(out.boundaries, 6)
  assert.equal(out.decision_weeks, 26)
  assert.ok(out.trials >= 1)

  // the single pooled calibration knob.
  assert.ok(Number.isFinite(out.calibration.factor))
  assert.ok(out.calibration.factor >= 0.5 && out.calibration.factor <= 1.2)
  assert.ok(out.overall && out.overall.n >= 1)
  assert.ok(Array.isArray(out.ranked))
  assert.ok(Array.isArray(out.by_strength))
  assert.ok(Array.isArray(out.by_pair))

  // by_client names who contributed graded decisions — the hot client is IN, the cold one OUT,
  // and the headline `clients` count equals the breakdown length.
  assert.ok(Array.isArray(out.by_client))
  assert.equal(out.clients, out.by_client.length)
  const mine = out.by_client.find(e => e.client_id === String(hot))
  assert.ok(mine, 'the seeded client appears in the by_client breakdown')
  assert.ok(mine.trials >= 1)
  assert.ok(typeof mine.client_name === 'string' && mine.client_name.length > 0)
  assert.ok(!out.by_client.some(e => e.client_id === String(cold)),
    'a data-less client contributes nothing to the roster')
})

// ── Test 5: serializeReallocationEfficacy degrades to a neutral, well-shaped table ──
// The route relies on this default branch for the empty/cold-start portfolio: a neutral
// 1.0 calibration the engine can multiply through blindly, plus empty served views.
test('serializeReallocationEfficacy degrades to a neutral 1.0 table for an empty/absent table', () => {
  const out = serializeReallocationEfficacy(null, { as_of: ASOF, scope: 'portfolio' })
  assert.equal(out.as_of, ASOF)
  assert.equal(out.scope, 'portfolio')
  assert.equal(out.calibration.factor, 1)        // a behavioral no-op
  assert.equal(out.overall, null)
  assert.deepEqual(out.ranked, [])
  assert.deepEqual(out.by_strength, [])
  assert.deepEqual(out.by_pair, [])
  assert.ok(out.base && out.base.n === 0)
})

// ============================================================
// 25d — REALLOCATION-EFFICACY CONFINEMENT: layer 25 is the FEEDBACK LOOP that grades
// layer 24's past budget moves against what realized over the following horizon and emits
// the confidence CALIBRATION the proposer consumes. Like 24 it is the strictest tier in
// the tower — it rides NEITHER a client byte NOR any brief pack, existing ONLY as the
// return of getClientReallocationEfficacy / getPortfolioReallocationEfficacy on the
// agency-gated /api/insights/reallocation-efficacy route, folded into NO pack at all. So
// 25d must prove, on a client whose data DID reconstruct a graded 'vindicated' trial:
//   (1) the agency track-record tables + the trial reconstructor are DENSE with grading
//       machinery — vindicated/refuted/vindication_rate/mean_confidence/median_hold on the
//       served rows, from_cpo/to_cpo/gap_pct on every reconstructed trial — so the client
//       guard MUST trip on them (the cleanliness below is a real split, not a vacuous pass);
//   (2) the client GET /api/insights/:clientId payload, the always-structured client brief
//       pack + its persisted read-back, and even the portfolio pack carry NONE of it.
//
// The forbidden set is the empirically-narrowed intersection of "what the efficacy surface
// emits" and "what NO client-riding sibling speaks". grep across lib/ proves
// `vindication_rate`/`median_hold`/`hold_ratio`/`decision_gap`/`realized_gap` are
// reallocationEfficacy-EXCLUSIVE, and `vindicated`/`refuted`/`mean_confidence` live only in
// reallocationEfficacy.js + its insights.js agency wiring — never a client loader nor a
// brief module. `from_cpo`/`to_cpo`/`gap_pct`/`\bcpo\b` are shared with layer 24, but 24d
// already proved they ride neither the client payload nor any pack. DELIBERATELY SPARED,
// exactly as 24d spared `saturat`/`easing`: `hit_rate` (≥5 brief modules that ride the
// client surface name it), `calibration` (pulse-tuning + brief client surfaces speak it),
// and the BARE stems `vindicat*`/`refut*` (briefImpact's editorial-precision narration can
// tell a client a past call was "vindicated"/"refuted" in plain prose) — these last three
// are forbidden as exact agency KEYS only, NEVER as substring tokens, so a client narration
// sentence can never false-positive the sweep. `\bcpo\b` stays word-anchored so plain
// "cost"/"cost per lead" pass clean. Forbidding any spared word would break the gate on a
// genuinely clean egress — the same trap the 24d empirical scan caught and avoided.
// ============================================================

// The client read path + brief surfaces this block proves clean. getClientReallocationEfficacy
// / getPortfolioReallocationEfficacy (already imported above) are the agency surfaces that
// MUST trip; these are the egress surfaces that must NOT.
const {
  getInsightFeed,
  getClientStanding,
  getRecentRecoveries,
  getClientPacing,
  getClientPulse,
  getEfficacyTable,
  attachEfficacyNotes,
  attachEscalations,
  clientSafePulse,
} = require('../lib/insights')
const { scoreClient } = require('../lib/health')
const { generateClientBrief, getClientBrief, generatePortfolioBrief } = require('../lib/brief')

// The reconstructed GET /api/insights/:clientId res.json — byte-faithful to routes/insights.js
// (the SAME six loaders, the SAME attachEscalations(attachEfficacyNotes(...)) decoration, the
// SAME inline severity tally, the SAME nine client-safe keys). Pinned to ASOF so both sides of
// the egress split are computed on the identical reallocation-worthy snapshot the agency
// efficacy tables see. The efficacy reads are NEVER called inside it — that architectural
// disjointness is exactly what this block guards.
const CLIENT_PAYLOAD_KEYS = [
  'client_id', 'insights', 'count', 'by_severity',
  'health', 'benchmark', 'recoveries', 'pacing', 'pulse',
]
async function clientFacingPayload(clientId) {
  const [insights, standing, recoveries, pacing, pulse, effTable] = await Promise.all([
    getInsightFeed(clientId, { limit: 50 }),
    getClientStanding(clientId, { asOf: ASOF }),
    getRecentRecoveries(clientId, { limit: 10, days: 30 }),
    getClientPacing(clientId, { asOf: ASOF }),
    getClientPulse(clientId, { asOf: ASOF }),
    getEfficacyTable(),
  ])
  const annotated = attachEscalations(attachEfficacyNotes(insights, effTable), effTable)
  const t = { critical: 0, warning: 0, info: 0 }
  for (const i of annotated) if (t[i.severity] != null) t[i.severity]++
  return {
    client_id: clientId,
    insights: annotated,
    count: annotated.length,
    by_severity: t,
    health: scoreClient(annotated),
    benchmark: standing,
    recoveries,
    pacing,
    pulse: clientSafePulse(pulse),
  }
}

// Distinctive structural compounds emitted by reallocationEfficacy + its insights.js wiring.
// The served record rows carry vindicated/refuted/vindication_rate/median_hold/mean_confidence
// and the reconstructed trials carry from_cpo/to_cpo/gap_pct — so guarding these by name is a
// COMPLETE structural guard: no served table, calibration, or trial can ride a client surface
// without tripping. DELIBERATELY NOT `hit_rate`/`calibration` (named by sibling layers that
// legitimately ride the client payload + the brief), NOT the bare stems `vindicat`/`refut`
// (briefImpact's client-visible precision prose can say "vindicated"/"refuted"), and NOT bare
// `from`/`to`/`gap`/`hold`/`confidence`/`strength`/`band`/`lower`/`note`/`factor`/`basis`/
// `mean`/`median` — generic or shared client-safe facts caught (where distinctive) by the token
// sweep. vindicated/refuted ARE forbidden, but as exact agency KEYS only — never as tokens.
const FORBIDDEN_REALLOC_EFF_KEYS = [
  'reallocation_efficacy', 'reallocationEfficacy',
  'vindicated', 'refuted', 'vindication_rate',
  'median_hold', 'hold_ratio', 'mean_confidence',
  'decision_gap', 'realized_gap',
  'from_cpo', 'to_cpo', 'gap_pct',
]
// Distinctive efficacy tokens only — the EXCLUSIVE compounds plus the word-anchored realized
// cost-per-outcome identifier and the two wrapper names as strings. DELIBERATELY NOT bare
// `vindicat`/`refut` (briefImpact client narration speaks them), NOT `hit_rate`/`calibration`
// (sibling client surfaces speak them), NOT bare `from`/`to`/`gap`/`hold`/`mean`/`median`/
// `cost`/`confidence`/`strength`/channel labels/dollar values — real client facts. `\bcpo\b`
// is anchored so "cost"/"cost per lead" pass clean. Mirrors 24d sparing `saturat`/`easing`.
const FORBIDDEN_REALLOC_EFF_TOKENS =
  /vindication_rate|mean_confidence|median_hold|hold_ratio|decision_gap|realized_gap|from_cpo|to_cpo|gap_pct|reallocation_efficacy|reallocationEfficacy|\bcpo\b/

function assertNoReallocEfficacy(payload, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(
          !FORBIDDEN_REALLOC_EFF_KEYS.includes(k),
          `${where}: client egress must not carry reallocation-efficacy field "${k}" (at ${path})`
        )
        walk(o[k], `${path}.${k}`)
      }
    }
  })(payload, 'payload')
  assert.ok(
    !FORBIDDEN_REALLOC_EFF_TOKENS.test(JSON.stringify(payload)),
    `${where}: reallocation-efficacy vocabulary leaked into the serialized client egress`
  )
}

test('25d — the efficacy track-record tables + trial reconstructor trip the client guard, yet the client read path and the brief carry none of their vocabulary: an agency endpoint-only split', async () => {
  await ready()
  const c = await seedReallocClient('realloc-eff confinement egress')

  // THE AGENCY SURFACE (A): the per-client track-record table the /reallocation-efficacy route
  // returns is dense with vindicated/refuted/vindication_rate/mean_confidence/median_hold → the
  // client guard MUST trip on it, on the SAME client whose payload is proven clean below.
  const cliEff = await getClientReallocationEfficacy(c, { asOf: ASOF })
  assert.ok(cliEff.overall && cliEff.overall.vindicated >= 1, 'the client efficacy table graded a vindicated trial — the proof is live, not vacuous')
  assert.throws(
    () => assertNoReallocEfficacy(cliEff, 'client-efficacy-probe'),
    /reallocation-efficacy field|reallocation-efficacy vocabulary/,
    'the served per-client efficacy table is dense with grading machinery — the client guard MUST trip on it')

  // THE AGENCY SURFACE (B): the pooled portfolio table + its by_client roster trips it too.
  const portEff = await getPortfolioReallocationEfficacy({ asOf: ASOF })
  assert.ok(portEff.overall && portEff.overall.n >= 1, 'the portfolio efficacy table pooled at least one graded trial')
  assert.throws(
    () => assertNoReallocEfficacy(portEff, 'portfolio-efficacy-probe'),
    /reallocation-efficacy field|reallocation-efficacy vocabulary/,
    'the pooled portfolio efficacy table must trip the client guard')

  // THE AGENCY SURFACE (C): the trial RECONSTRUCTOR — the load-bearing wire — emits graded-shape
  // trials whose decision/realized halves carry from_cpo/to_cpo/gap_pct, NON-EMPTY on this very
  // fixture, so the proof is live: the client guard must trip on the reconstructed episodes.
  const trials = buildReallocationTrials(syntheticReallocRows(), { asOf: ASOF })
  assert.ok(trials.length >= 1 && trials[0].decision && trials[0].decision.from_cpo != null,
    'the reconstructor yields live graded trials the calibration is built from')
  assert.throws(
    () => assertNoReallocEfficacy(trials, 'efficacy-trials-probe'),
    /reallocation-efficacy field|reallocation-efficacy vocabulary/,
    'the reconstructed trials are dense with cost machinery — the client guard MUST trip on them')

  // THE CLIENT SURFACE (A): the actual GET /api/insights/:clientId wire payload — reconstructed
  // byte-faithful — carries NONE of the efficacy machinery, and its key-set is EXACTLY the nine
  // client-safe keys (no efficacy surface among them), on the SAME client whose reconstructed
  // trial just graded vindicated above.
  const payload = await clientFacingPayload(c)
  assertNoReallocEfficacy(payload, 'clientFacingPayload')
  assert.deepEqual(Object.keys(payload).sort(), [...CLIENT_PAYLOAD_KEYS].sort(),
    'the per-client payload exposes exactly the nine client-safe keys — no efficacy surface among them')

  // THE CLIENT SURFACE (B): layer 25 rides NO brief, but prove it belt-and-suspenders — the
  // always-structured client brief pack (and its persisted read-back, the row the client fetches)
  // carry none of the grading vocabulary.
  const cli = await generateClientBrief(c, ASOF)
  assert.equal(cli.grounded, true)
  assertNoReallocEfficacy(cli.pack, 'generateClientBrief')
  const cliRow = await getClientBrief(c, ASOF)
  assertNoReallocEfficacy(cliRow.pack, 'getClientBrief read-back')

  // THE PORTFOLIO PACK: the efficacy layer is endpoint-only — it rides neither the client nor the
  // agency/portfolio brief pack (it exists only as the route's return). Prove the portfolio pack
  // never carries the vocabulary either, by token sweep AND by name at any depth.
  const port = await generatePortfolioBrief(ASOF)
  assert.ok(!FORBIDDEN_REALLOC_EFF_TOKENS.test(JSON.stringify(port.pack)),
    'the efficacy vocabulary must never ride the serialized portfolio pack — it is endpoint-only')
  ;(function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_REALLOC_EFF_KEYS.includes(k), `the portfolio pack must not carry the efficacy field "${k}"`)
        walk(o[k])
      }
    }
  })(port.pack)
})

test('25d — the efficacy guard is load-bearing: a smuggled cpo, vindication_rate, or hold_ratio trips it; legit client fields — incl the spared hit_rate/calibration/vindicated-prose — never do', () => {
  // each distinctive structural compound is caught BY NAME, however deeply nested.
  assert.throws(() => assertNoReallocEfficacy({ row: { from_cpo: 60 } }, 'from-cpo-probe'),
    /reallocation-efficacy field/, 'a lone from_cpo must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { to_cpo: 30 } }, 'to-cpo-probe'),
    /reallocation-efficacy field/, 'a lone to_cpo must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { gap_pct: 0.5 } }, 'gap-probe'),
    /reallocation-efficacy field/, 'a lone gap_pct must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { vindication_rate: 0.66 } }, 'vrate-probe'),
    /reallocation-efficacy field/, 'a lone vindication_rate must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { median_hold: 0.5 } }, 'mhold-probe'),
    /reallocation-efficacy field/, 'a lone median_hold must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { mean_confidence: 0.7 } }, 'mconf-probe'),
    /reallocation-efficacy field/, 'a lone mean_confidence must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ trial: { hold_ratio: 0.4 } }, 'hratio-probe'),
    /reallocation-efficacy field/, 'a lone hold_ratio must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ trial: { decision_gap: 0.5 } }, 'dgap-probe'),
    /reallocation-efficacy field/, 'a lone decision_gap must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ trial: { realized_gap: 0.4 } }, 'rgap-probe'),
    /reallocation-efficacy field/, 'a lone realized_gap must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { vindicated: 3 } }, 'vindicated-key-probe'),
    /reallocation-efficacy field/, 'a vindicated COUNT key must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ row: { refuted: 1 } }, 'refuted-key-probe'),
    /reallocation-efficacy field/, 'a refuted COUNT key must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ box: { reallocation_efficacy: {} } }, 'wrapper-snake-probe'),
    /reallocation-efficacy field/, 'a reallocation_efficacy wrapper must be rejected by name')
  assert.throws(() => assertNoReallocEfficacy({ box: { reallocationEfficacy: {} } }, 'wrapper-camel-probe'),
    /reallocation-efficacy field/, 'a reallocationEfficacy wrapper must be rejected by name')

  // the EXCLUSIVE compounds and a bare cpo, smuggled as plain strings, are caught by the token sweep.
  assert.throws(() => assertNoReallocEfficacy({ note: 'the cpo on this channel rose' }, 'cpo-token-probe'),
    /reallocation-efficacy vocabulary/, "a bare 'cpo' leaked as a string must be rejected")
  assert.throws(() => assertNoReallocEfficacy({ note: 'vindication_rate climbed last horizon' }, 'vrate-token-probe'),
    /reallocation-efficacy vocabulary/, "'vindication_rate' leaked as a string must be rejected")
  assert.throws(() => assertNoReallocEfficacy({ note: 'mean_confidence outran the realized hits' }, 'mconf-token-probe'),
    /reallocation-efficacy vocabulary/, "'mean_confidence' leaked as a string must be rejected")
  // the whole graded trial trips (decision + realized cost machinery all present).
  assert.throws(() => assertNoReallocEfficacy({ as_of: '2026-05-04', decision: { from_cpo: 60, to_cpo: 30, gap_pct: 0.5 }, realized: { from_cpo: 60, to_cpo: 30 }, hold_ratio: 1, decision_gap: 0.5, realized_gap: 0.5 }, 'full-trial-probe'),
    /reallocation-efficacy field|reallocation-efficacy vocabulary/, 'a full graded trial must be rejected')

  // CRITICAL disjointness — the legit client vocabulary the guard must NEVER catch:
  //   the channel labels and outcome words the client surface speaks freely — none is an efficacy
  //   token (\bcpo\b is anchored so "cost"/"cost per lead" pass clean).
  assert.doesNotThrow(
    () => assertNoReallocEfficacy({ focus: { label: 'Leads', metric: 'leads', direction: 'up', delta_pct: 12 }, note: 'Google Ads brought in leads at about $30 cost per lead while Facebook/Meta ran near $60.' }, 'channel-prose-probe'),
    'the channel labels, leads, and cost-per-lead prose are legit client facts and must pass clean')
  //   THE EMPIRICAL TRAP this block avoids: hit_rate and calibration are named (as keys AND as
  //   prose) by sibling layers that legitimately ride the client payload + the brief — they MUST
  //   pass clean, or every clean client egress carrying a pulse calibration or efficacy hit-rate
  //   would false-positive and break the gate.
  assert.doesNotThrow(
    () => assertNoReallocEfficacy({ efficacy: { hit_rate: 0.62, note: 'this play has a strong hit rate' }, pulse: { calibration: { factor: 1.1, note: 'sensor calibration eased' } } }, 'spared-siblings-probe'),
    "the sibling 'hit_rate'/'calibration' fields ride the client surface and must pass clean")
  //   briefImpact's client-visible editorial-precision prose can tell a client a past call was
  //   "vindicated" or "refuted" — those BARE stems, as string VALUES (not agency count keys), must
  //   pass the token sweep clean (we forbid them as exact keys only).
  assert.doesNotThrow(
    () => assertNoReallocEfficacy({ insights: [{ severity: 'info', message: "Last week's call that leads would climb was vindicated; the prior dip warning was refuted." }] }, 'precision-prose-probe'),
    "briefImpact's bare 'vindicated'/'refuted' narration prose must pass clean (forbidden as keys only)")
  //   a client focus carrying bare from/to (a date range), gap, hold, confidence, strength, band,
  //   lower, factor, basis, mean, median — none forbidden (we forbid only the compound identifiers).
  assert.doesNotThrow(
    () => assertNoReallocEfficacy({ focus: { from: '2026-05-01', to: '2026-05-31', gap: 4, hold: 2, confidence: 0.8, strength: 'clear', band: 'high', lower: 0.4, factor: 1.0, basis: 'steady', mean: 30, median: 28 } }, 'client-focus-probe'),
    'bare from/to/gap/hold/confidence/strength/band/lower/factor/basis/mean/median are legit and must pass clean')
  //   the sibling-layer words SPARED since 24d — 'saturated'/'easing' ride the client payload via
  //   briefLeadPolicy*/systemic/pulse* — must still pass clean.
  assert.doesNotThrow(
    () => assertNoReallocEfficacy({ pulse: [{ metric: 'leads', note: 'demand is saturated; growth is easing into the weekend.' }] }, 'sibling-words-probe'),
    "the sibling-layer 'saturated'/'easing' words ride the client surface and must pass clean")
  //   the consumer's own engagement vote — the only byte they send back.
  assert.doesNotThrow(
    () => assertNoReallocEfficacy({ as_of: '2026-05-18', signal: 'helpful' }, 'own-vote-probe'),
    'the consumer own-vote must pass clean')

  // FINAL disjointness ledger: the distinctive efficacy tokens never appear in the generic English
  // the client surface actually uses (this string deliberately includes bare `from`, `to`, `gap`,
  // `hold`, `cost`, `confidence`, `strength`, `band`, `lower`, `factor`, `basis`, `mean`, `median`,
  // `hit rate`, `calibration`, `vindicated`, `refuted`, and the sibling words `saturated`/`easing` —
  // ALL legal) — so the sweep can never false-positive a legit client egress on an efficacy
  // identifier (mirrors 24d's closing ledger sparing the sibling vocabulary).
  assert.ok(!FORBIDDEN_REALLOC_EFF_TOKENS.test('from to gap hold cost confidence strength band lower factor basis mean median hit rate calibration vindicated refuted saturated demand easing growth lead leads channel budget Google Ads Facebook Meta cost per lead lower cost held its cost'),
    'the efficacy sweep is disjoint from the generic English the client surface actually uses')
})
