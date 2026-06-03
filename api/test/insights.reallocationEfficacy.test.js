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
