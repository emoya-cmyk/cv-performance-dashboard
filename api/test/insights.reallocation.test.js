'use strict'

// ============================================================
// test/insights.reallocation.test.js — the ENGINE WIRING for channel
// reallocation (intel-v10 24b). lib/channelEfficiency.js is unit-tested in
// isolation in channelEfficiency.test.js; this file proves the four reads that
// put that PURE prescriptive core onto live data:
//
//   • loadChannelEfficiencySeries(clientId) — pulls per-channel WEEKLY spend +
//     outcome windows from the ATOMIC grain (fact_metric ⋈ dim_channel), summed
//     per (channel, date, metric_key) in SQL and JS-bucketed into ISO weeks, into
//     the [{ channel, points:[{spend,outcomes}] }] shape the module expects —
//     always the configured channel set/order, data-less channels emitting [];
//   • analyzeChannelReallocation(channels) — partitions channels by OUTCOME (cpo is
//     only comparable within one outcome unit: $/lead vs $/lead, never $/lead vs
//     $/booked-job), runs the pure analyzer per partition, and picks the single most
//     actionable proposal across partitions;
//   • getClientReallocation(clientId) — one client's chosen proposal + every
//     partition's own result + the flat per-channel cpo assessment, AGENCY-FACING
//     (never folded into the client payload);
//   • getPortfolioReallocation() — the agency ROSTER: only clients with a live
//     'reallocate' move, name-tagged, agency-narrated, most-defensible first, with
//     data-less clients contributing nothing and never throwing.
//
// LEAK POSTURE (the load-bearing invariant of this layer): a reallocation is an
// internal media-buying call, not a client scoreboard line. We prove the per-client
// analysis object carries NO narration of any kind, and that narrateReallocation
// returns '' for a client audience UNCONDITIONALLY while the SAME proposal narrates
// a real sentence for the agency — so the silence is audience-gated, not absence.
//
// Runs end to end against an isolated temp SQLite DB (its own SQLITE_PATH, migrated
// once — which also seeds dim_channel, the JOIN this layer needs). ANTHROPIC_API_KEY
// is deleted so nothing reaches the network; reallocation narration is pure template
// by construction anyway. Seeding mirrors insights.pulse.test's seedWeekly: one
// weekly total per NON-OVERLAPPING 7-day window, placed on that window's day, so each
// (channel, week) bucket gets exactly one spend point and one outcome point.
//
// The fixture is deliberately the live comparison: google_ads (cheaper per lead, the
// PUSH target) vs meta (pricier per lead, the PULL source), both measuring `leads`;
// lsa (booked_jobs) is left empty so its partition abstains and the leads move wins —
// exactly the shape production sees today.
// ============================================================

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// No key → deterministic narration, no network.
delete process.env.ANTHROPIC_API_KEY

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `insights_realloc_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const {
  getClientReallocation,
  getPortfolioReallocation,
  analyzeChannelReallocation,
  loadChannelEfficiencySeries,
  bucketReallocSeries,
} = require('../lib/insights')
// The PURE narrator, unit-tested exhaustively in channelEfficiency.test.js. Here it is
// the leak-posture oracle: same proposal → '' for clients, a sentence for the agency.
const { narrateReallocation } = require('../lib/channelEfficiency')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── harness (mirrors insights.pulse.test.js) ────────────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }  // also seeds dim_channel

let seq = 0
async function freshClient(name) {
  const id = `realloc-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

// Pin the clock so the trailing window is deterministic relative to the seeded weeks.
const ASOF = '2026-06-01'
const isoMinus = (n) =>
  new Date(Date.parse(ASOF + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10)

// Place one weekly value per NON-OVERLAPPING 7-day window on a SPECIFIC channel +
// metric_key. weekly[0] is the latest week (days-ago 0), weekly[k] the k-th prior week
// (days-ago 7k); the whole-week value lands on its window's day. spend and the outcome
// share the same per-week day, so each (channel, ISO-week) bucket gets a paired
// {spend>0, outcomes>0} point — a VALID window for the module.
async function seedChannelWeekly(clientId, channelId, metricKey, weekly) {
  for (let k = 0; k < weekly.length; k++) {
    const v = weekly[k]
    if (!v) continue
    await db.query(
      `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ($1,$2,$3,NULL,$4,$5)`,
      [clientId, isoMinus(7 * k), channelId, metricKey, v]
    )
  }
}

// ── the live leads-partition fixture ────────────────────────────────────────────
// 6 weekly windows each (confidence saturates at 6 → 1.0). Spend VARIES (CV ≈ 0.13 ≥
// the 0.10 trend gate) so the module is allowed to read a returns slope; here it reads
// 'flat' for both (cpo ~level across spend) → a level-only, 'tentative' move, which is
// the honest verdict for this data and still clears the gap + confidence gates.
const GA_SPEND   = [800, 1000, 1200, 900, 1100, 1000]   // Σ 6000
const GA_LEADS   = [27, 33, 40, 30, 37, 33]             // Σ 200 → cpo $30 (cheaper → target)
const META_SPEND = [800, 1000, 1200, 900, 1100, 1000]   // Σ 6000
const META_LEADS = [13, 17, 20, 15, 18, 17]             // Σ 100 → cpo $60 (pricier → source)

async function seedReallocClient(name) {
  const c = await freshClient(name)
  await seedChannelWeekly(c, 1, 'spend', GA_SPEND)    // channel_id 1 = google_ads
  await seedChannelWeekly(c, 1, 'leads', GA_LEADS)
  await seedChannelWeekly(c, 2, 'spend', META_SPEND)  // channel_id 2 = meta
  await seedChannelWeekly(c, 2, 'leads', META_LEADS)
  // lsa (channel_id 3 / booked_jobs) intentionally left EMPTY → its partition abstains.
  return c
}

// ── loadChannelEfficiencySeries + bucketReallocSeries: faithful series shape ─────
test('loadChannelEfficiencySeries yields the configured channels with weekly paired windows', async () => {
  await ready()
  const c = await seedReallocClient('series shape')

  const series = await loadChannelEfficiencySeries(c, { asOf: ASOF })

  // always the configured channel set, in config order — even the data-less one.
  assert.deepEqual(series.map(s => s.channel), ['google_ads', 'meta', 'lsa'])

  const [ga, meta, lsa] = series
  assert.equal(ga.points.length, 6)    // 6 distinct ISO weeks → 6 windows
  assert.equal(meta.points.length, 6)
  assert.equal(lsa.points.length, 0)   // no rows → empty points (module will abstain on it)

  // every window is a VALID pair (spend>0 AND outcomes>0), and the totals round-trip.
  for (const pt of ga.points) assert.ok(pt.spend > 0 && pt.outcomes > 0)
  assert.equal(ga.points.reduce((s, p) => s + p.spend, 0), 6000)
  assert.equal(ga.points.reduce((s, p) => s + p.outcomes, 0), 200)
  assert.equal(meta.points.reduce((s, p) => s + p.spend, 0), 6000)
  assert.equal(meta.points.reduce((s, p) => s + p.outcomes, 0), 100)

  // the pure bucketer over the same loaded series is identical (engine shares the core).
  assert.deepEqual(series, bucketReallocSeries(await rawFactRows(c)))
})

// helper for the equality check above: the raw summed fact rows the engine buckets.
async function rawFactRows(clientId) {
  const { rows } = await db.query(
    `SELECT c.key AS channel, f.date AS date, f.metric_key AS metric_key, SUM(f.metric_value) AS total
       FROM fact_metric f JOIN dim_channel c ON c.id = f.channel_id
      WHERE f.client_id = $1
        AND c.key IN ('google_ads','meta','lsa')
        AND f.metric_key IN ('spend','leads','booked_jobs')
      GROUP BY c.key, f.date, f.metric_key
      ORDER BY f.date`,
    [clientId]
  )
  return rows
}

// ── getClientReallocation: the in-partition leads move surfaces, comparably ──────
test('getClientReallocation surfaces the leads-partition reallocate proposal (meta → google_ads)', async () => {
  await ready()
  const c = await seedReallocClient('client reallocation')

  const out = await getClientReallocation(c, { asOf: ASOF })

  assert.equal(out.as_of, ASOF)
  assert.equal(out.proposal_outcome, 'leads')           // the winning partition…
  assert.equal(out.proposal_outcome_label, 'lead')      // …with its human label

  const p = out.proposal
  assert.equal(p.status, 'reallocate')
  assert.equal(p.from, 'meta')                           // pricier per lead → PULL source
  assert.equal(p.to,   'google_ads')                     // cheaper per lead → PUSH target
  assert.equal(p.from_cpo, 60)
  assert.equal(p.to_cpo,   30)
  assert.equal(p.gap_pct, 0.5)                           // (60-30)/60 — a CURRENT FACT
  assert.equal(p.saved_per_outcome, 30)
  assert.equal(p.test_fraction, 0.1)
  assert.equal(p.suggested_shift, 100)                   // 10% of meta's $1000 avg-window spend
  assert.equal(p.confidence, 0.7)                        // sample 1.0 × 0.7 level-only corroboration
  assert.equal(p.hypothesis, true)                       // the forward claim is flagged, by construction

  // outcome partitions are reasoned about INDEPENDENTLY: leads moves, booked_jobs abstains.
  assert.equal(out.by_outcome.length, 2)
  assert.equal(out.by_outcome.find(e => e.outcome === 'leads').proposal.status, 'reallocate')
  assert.equal(out.by_outcome.find(e => e.outcome === 'booked_jobs').proposal.status, 'insufficient')

  // flat per-channel assessment carries all three channels; cpo compares only within `leads`.
  const byCh = new Map(out.channels.map(v => [v.channel, v]))
  assert.equal(byCh.get('google_ads').cpo, 30)
  assert.equal(byCh.get('meta').cpo, 60)
  assert.equal(byCh.get('lsa').status, 'insufficient')   // alone in its outcome → never mis-compared
})

// ── cold start: a data-less client abstains, never throws ────────────────────────
test('getClientReallocation abstains to insufficient for a client with no paid-channel history', async () => {
  await ready()
  const c = await freshClient('cold start')

  const out = await getClientReallocation(c, { asOf: ASOF })

  assert.equal(out.proposal.status, 'insufficient')
  assert.equal(out.proposal.from, null)
  assert.equal(out.proposal.to, null)
  assert.equal(out.proposal_outcome, 'leads')            // best-of-partitions is still the leads abstention
  assert.ok(Array.isArray(out.channels))                 // shape intact, no throw
})

// ── getPortfolioReallocation: agency roster includes the move, names it, narrates it ─
test('getPortfolioReallocation rosters the reallocate client (named + agency-narrated), excludes data-less', async () => {
  await ready()
  const hot  = await seedReallocClient('roster reallocate')
  const cold = await freshClient('roster cold')

  const { as_of, roster } = await getPortfolioReallocation({ asOf: ASOF })
  assert.equal(as_of, ASOF)
  assert.ok(Array.isArray(roster))

  const mine = roster.find(r => r.client_id === String(hot))
  assert.ok(mine, 'the reallocate client must appear in the agency roster')
  assert.equal(mine.from, 'meta')
  assert.equal(mine.to,   'google_ads')
  assert.equal(mine.outcome, 'leads')
  assert.equal(mine.outcome_label, 'lead')
  assert.equal(mine.from_label, 'Facebook/Meta')         // raw key → human label for the agency
  assert.equal(mine.to_label,   'Google Ads')
  assert.equal(mine.confidence, 0.7)
  assert.equal(mine.gap_pct, 0.5)
  assert.equal(mine.suggested_shift, 100)
  assert.equal(mine.test_fraction, 0.1)
  assert.equal(mine.strength, 'tentative')
  assert.equal(mine.hypothesis, true)

  // the agency HEARS a real sentence — and it is identifier-free budget language.
  assert.equal(typeof mine.message, 'string')
  assert.ok(mine.message.length > 0)
  assert.ok(mine.message.includes('Google Ads'))
  assert.ok(mine.message.includes('Facebook/Meta'))

  // a data-less client contributes NOTHING to the roster.
  assert.ok(!roster.some(r => r.client_id === String(cold)))
})

// ── LEAK POSTURE: the per-client analysis carries no narration; clients narrate to '' ─
test('reallocation is agency-only: no narration on the per-client object, "" for a client audience', async () => {
  await ready()
  const c = await seedReallocClient('leak posture')

  const out = await getClientReallocation(c, { asOf: ASOF })

  // the per-client analysis exposes NO narration of any kind (agency or client).
  assert.ok(!('message' in out),        'per-client object must not carry an agency message')
  assert.ok(!('client_message' in out), 'per-client object must not carry a client message')
  assert.ok(!('client_text' in out.proposal), 'the proposal must not carry client-facing text')

  // the SAME proposal: silent for a client UNCONDITIONALLY…
  assert.equal(narrateReallocation(out.proposal, { audience: 'client' }), '')

  // …but a real sentence for the agency — proving the '' is audience-gated, not absence.
  const agency = narrateReallocation(out.proposal, {
    audience: 'agency',
    labels: { meta: 'Facebook/Meta', google_ads: 'Google Ads' },
    outcomeLabel: out.proposal_outcome_label,
  })
  assert.ok(agency.length > 0)
  assert.ok(agency.includes('Facebook/Meta') && agency.includes('Google Ads'))
})
