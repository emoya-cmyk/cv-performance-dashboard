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
  // ── the CLIENT-facing read path (GET /api/insights/:clientId) reconstructed in the 24d
  // CONFINEMENT block below, byte-faithful to routes/insights.js, so the leak guard runs over
  // the ACTUAL client wire payload — not a hand-rolled stand-in for it ──
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
// The PURE narrator, unit-tested exhaustively in channelEfficiency.test.js. Here it is
// the leak-posture oracle: same proposal → '' for clients, a sentence for the agency.
// reallocationRails is the compact agency move the engine/UI consume — dense with the
// machinery (from_cpo/to_cpo/suggested_shift/test_fraction), so 24d uses it as a load-bearing
// agency surface the client guard MUST trip on.
const { narrateReallocation, reallocationRails } = require('../lib/channelEfficiency')
const { scoreClient } = require('../lib/health')
// Layer 24 rides NO brief (unlike 18-23 — it lives on its own agency /reallocation route); we
// assert the client brief pack stays clean belt-and-suspenders, and that the portfolio brief
// never carries the reallocation vocabulary either.
const { generateClientBrief, getClientBrief, generatePortfolioBrief } = require('../lib/brief')

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

// ============================================================
// 24d — CHANNEL-REALLOCATION CONFINEMENT: the first PRESCRIPTIVE budget layer is the one turn of
// the whole intelligence tower that rides NEITHER a client byte NOR any brief pack. Every layer
// 18-23 confinement guarded a field that travels INSIDE the morning brief (the client pack carries
// the effect, the agency pack the machinery); layer 24 is structurally stricter — the reallocation
// proposal exists ONLY as the return of getClientReallocation / getPortfolioReallocation, served on
// the agency-gated /api/insights/reallocation route, and is folded into NO pack at all. So the two
// things 24d must prove are: (1) the client-facing GET /api/insights/:clientId payload — the actual
// wire shape the client view fetches — never carries the reallocation vocabulary, computed on a
// client whose data WOULD generate a live move; and (2) the narrator is '' for a client audience
// UNCONDITIONALLY while the agency hears a real, identifier-free budget sentence.
//
// The reallocation fingerprints are CLEANLY DISTINCTIVE — like 23's, and unlike 22's run-counters
// that collided with the layer-14 lead-policy monitor. `from_cpo`/`to_cpo`/`suggested_shift`/
// `test_fraction`/`saved_per_outcome`/`gap_pct`/`pull_candidate`/`push_candidate` and the coined
// verb `reallocat*` are emitted by channelEfficiency + its insights.js wiring ALONE; grep confirms
// no sibling that rides the client payload or any pack names them. The one trap the empirical token
// scan caught: `saturat`/`easing` are emitted by sibling layers that DO ride the client surface
// (briefLeadPolicy*/systemic/pulse*/ai/insights), so they are DELIBERATELY SPARED — forbidding them
// would false-positive a clean client egress and break the gate (the same discipline that made 23d
// spare bare `reach`, 22d spare bare `hold`/`idle`). `\bcpo\b` is word-anchored so it catches the
// realized cost-per-outcome identifier without ever catching "cost"/"cost per lead", the plain
// English the client surface speaks freely.
// ============================================================

// The reconstructed GET /api/insights/:clientId res.json — byte-faithful to routes/insights.js: the
// SAME six loaders, the SAME attachEscalations(attachEfficacyNotes(...)) decoration, the SAME inline
// severity tally, the SAME nine client-safe keys incl health/benchmark/pulse(clientSafePulse). The
// asOf-aware loaders are pinned to ASOF so both sides of the egress split are computed on the
// identical reallocation-worthy snapshot the agency surfaces see. getClientReallocation is NEVER
// called here — that architectural disjointness is exactly what this block guards.
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

// Distinctive structural compounds. from_cpo/to_cpo/suggested_shift/test_fraction are emitted on
// EVERY actionable reallocate move (and on reallocationRails), so guarding them by name is a
// COMPLETE structural guard — no proposal, rails object, or roster entry can ride along without
// tripping. Plus saved_per_outcome/gap_pct and the two conceptual wrapper names. DELIBERATELY NOT
// bare `from`/`to`/`confidence`/`strength`/`message`/`channel`/`outcome`/`status`/`as_of` — generic
// or shared client-safe facts (a focus carries a from/to date range, a finding carries a message and
// a channel, an own-vote carries as_of) caught (where distinctive) by the token sweep below.
const FORBIDDEN_REALLOC_KEYS = [
  'channel_reallocation', 'reallocation',
  'from_cpo', 'to_cpo', 'saved_per_outcome', 'gap_pct', 'suggested_shift', 'test_fraction',
]
// Distinctive reallocation tokens only — the coined verb, the two internal candidate flags, the
// word-anchored realized cost-per-outcome identifier, and the structural compounds as strings.
// DELIBERATELY NOT `saturat`/`easing` (emitted by sibling layers that legitimately ride the client
// payload and the brief — forbidding them false-positives a clean egress), NOT bare `from`/`to`/
// `shift`/`gap`/`cost`/`confidence`/`strength`/`message`/`lead`/`leads`/channel labels/dollar values
// (real client facts the surface speaks freely), and `\bcpo\b` is anchored so "cost"/"cost per lead"
// pass clean. Mirrors 23d sparing bare `reach`, 22d sparing bare `hold`/`idle`.
const FORBIDDEN_REALLOC_TOKENS =
  /reallocat|pull_candidate|push_candidate|\bcpo\b|from_cpo|to_cpo|suggested_shift|test_fraction|saved_per_outcome|gap_pct/

function assertNoReallocation(payload, where) {
  ;(function walk(o, path) {
    if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(
          !FORBIDDEN_REALLOC_KEYS.includes(k),
          `${where}: client egress must not carry reallocation field "${k}" (at ${path})`
        )
        walk(o[k], `${path}.${k}`)
      }
    }
  })(payload, 'payload')
  assert.ok(
    !FORBIDDEN_REALLOC_TOKENS.test(JSON.stringify(payload)),
    `${where}: reallocation vocabulary leaked into the serialized client egress`
  )
}

test('24d — narrateReallocation is silent for the CLIENT unconditionally; the agency hears the budget move across tentative/strong, identifier-free', async () => {
  await ready()
  const c = await seedReallocClient('realloc confinement narration')

  // Sanity: the live fixture produced a dense, actionable reallocate proposal — the move the
  // /api/insights/reallocation route serves — so the agency narration below is non-vacuous.
  const out = await getClientReallocation(c, { asOf: ASOF })
  assert.equal(out.proposal.status, 'reallocate')
  assert.equal(out.proposal.from, 'meta')
  assert.equal(out.proposal.to, 'google_ads')

  // THE INVARIANT: the consumer never hears the budget call — for ANY proposal shape (reallocate
  // tentative or strong, hold, insufficient, null, malformed, junk), client narration is ''
  // UNCONDITIONALLY (the audience gate returns before the status gate is even consulted).
  const STRONG = { ...out.proposal, strength: 'strong' }
  for (const [name, p] of [
    ['reallocate-tentative', out.proposal],
    ['reallocate-strong', STRONG],
    ['hold', { status: 'hold', from: 'meta', to: 'google_ads' }],
    ['insufficient', { status: 'insufficient', from: null, to: null }],
    ['null', null], ['malformed', { status: 'reallocate' }], ['junk', 'nope'],
  ]) {
    assert.equal(narrateReallocation(p, { audience: 'client' }), '', `client narration must be '' for ${name}`)
  }

  const labels = { meta: 'Facebook/Meta', google_ads: 'Google Ads' }
  // The agency DOES hear the move — on BOTH the tentative (level-gap) and strong (climbing-cost)
  // shapes — proving the client silence is a deliberate split, not a dead feature…
  const agencyTentative = narrateReallocation(out.proposal, { audience: 'agency', labels, outcomeLabel: out.proposal_outcome_label })
  const agencyStrong    = narrateReallocation(STRONG,       { audience: 'agency', labels, outcomeLabel: out.proposal_outcome_label })
  assert.ok(agencyTentative.length > 0 && agencyStrong.length > 0, 'the agency hears the move on both shapes')
  assert.match(agencyTentative, /lower cost/, 'the tentative move reads as plain budget English')
  assert.match(agencyStrong, /climbing|holds its cost/, 'the strong move reads as plain budget English')
  // …and stays mute on the two non-actionable states (nothing to do yet).
  for (const silent of ['hold', 'insufficient']) {
    assert.equal(narrateReallocation({ status: silent, from: 'meta', to: 'google_ads' }, { audience: 'agency' }), '',
      `the agency is silent on the ${silent} state`)
  }

  // Even the candid agency sentences carry NO machine identifier — they speak human labels and
  // "cost per lead", never 'cpo'/'reallocate'/'suggested_shift'/'gap_pct' — so they could not seed
  // a leak even if mis-routed onto a client surface, and they never leak the raw channel keys.
  for (const s of [agencyTentative, agencyStrong]) {
    assert.ok(!FORBIDDEN_REALLOC_TOKENS.test(s), 'agency budget sentence carries no reallocation identifier')
    assert.ok(s.includes('Facebook/Meta') && s.includes('Google Ads'), 'agency sentence speaks human labels')
    assert.ok(!s.includes('google_ads'), 'agency sentence never leaks the raw channel key')
  }
})

test('24d — the reallocation move trips the client guard, yet the client read path and the brief carry none of its vocabulary: an agency endpoint-only split', async () => {
  await ready()
  const c = await seedReallocClient('realloc confinement egress')

  // THE AGENCY SURFACE: the proposal the /reallocation route returns is dense with from_cpo/to_cpo/
  // suggested_shift/test_fraction/gap_pct + the reallocate status → the client guard MUST trip on
  // it, confirming the cleanliness below is a real split, not a vacuous pass.
  const out = await getClientReallocation(c, { asOf: ASOF })
  assert.throws(
    () => assertNoReallocation(out.proposal, 'reallocation-proposal-probe'),
    /reallocation field|reallocation vocabulary/,
    'the reallocate proposal is dense with machinery — the client guard MUST trip on it')
  // the compact rails the engine/UI consume trip it too — and they are NON-NULL on this very
  // proposal, so the proof is live, not theoretical.
  const rails = reallocationRails(out.proposal)
  assert.ok(rails && rails.from_cpo != null, 'the reallocate proposal yields live rails the engine acts on')
  assert.throws(() => assertNoReallocation(rails, 'reallocation-rails-probe'),
    /reallocation field|reallocation vocabulary/, 'the agency rails must trip the client guard')
  // and the agency roster entry (names the client, carries the move) trips it as well.
  const { roster } = await getPortfolioReallocation({ asOf: ASOF })
  const entry = roster.find(r => r.client_id === String(c))
  assert.ok(entry, 'the reallocate client is on the agency roster')
  assert.throws(() => assertNoReallocation(entry, 'reallocation-roster-probe'),
    /reallocation field|reallocation vocabulary/, 'the agency roster entry must trip the client guard')

  // THE CLIENT SURFACE (A): the actual GET /api/insights/:clientId wire payload — reconstructed
  // byte-faithful — carries NONE of the reallocation machinery, and its key-set is EXACTLY the nine
  // client-safe keys (no reallocation wrapper among them), on the SAME client whose data just
  // generated the live move above.
  const payload = await clientFacingPayload(c)
  assertNoReallocation(payload, 'clientFacingPayload')
  assert.deepEqual(Object.keys(payload).sort(), [...CLIENT_PAYLOAD_KEYS].sort(),
    'the per-client payload exposes exactly the nine client-safe keys — no reallocation surface among them')

  // THE CLIENT SURFACE (B): layer 24 rides NO brief, but prove it belt-and-suspenders — the
  // always-structured client brief pack (and its persisted read-back, the row the client fetches)
  // carry none of the vocabulary.
  const cli = await generateClientBrief(c, ASOF)
  assert.equal(cli.grounded, true)
  assertNoReallocation(cli.pack, 'generateClientBrief')
  const cliRow = await getClientBrief(c, ASOF)
  assertNoReallocation(cliRow.pack, 'getClientBrief read-back')

  // THE PORTFOLIO PACK: the reallocation layer is endpoint-only — it rides neither the client nor
  // the agency/portfolio brief pack (it exists only as the route's return). Prove the portfolio pack
  // never carries the vocabulary either, by token sweep AND by name at any depth.
  const port = await generatePortfolioBrief(ASOF)
  assert.ok(!FORBIDDEN_REALLOC_TOKENS.test(JSON.stringify(port.pack)),
    'the reallocation vocabulary must never ride the serialized portfolio pack — it is endpoint-only')
  ;(function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        assert.ok(!FORBIDDEN_REALLOC_KEYS.includes(k), `the portfolio pack must not carry the reallocation field "${k}"`)
        walk(o[k])
      }
    }
  })(port.pack)
})

test('24d — the reallocation guard is load-bearing: a smuggled cpo, shift, or gap trips it; legit client fields never do', () => {
  // each distinctive structural compound is caught BY NAME, however deeply nested.
  assert.throws(() => assertNoReallocation({ move: { from_cpo: 60 } }, 'from-cpo-probe'),
    /reallocation field/, 'a lone from_cpo must be rejected by name')
  assert.throws(() => assertNoReallocation({ move: { to_cpo: 30 } }, 'to-cpo-probe'),
    /reallocation field/, 'a lone to_cpo must be rejected by name')
  assert.throws(() => assertNoReallocation({ move: { suggested_shift: 100 } }, 'shift-probe'),
    /reallocation field/, 'a lone suggested_shift must be rejected by name')
  assert.throws(() => assertNoReallocation({ move: { test_fraction: 0.1 } }, 'fraction-probe'),
    /reallocation field/, 'a lone test_fraction must be rejected by name')
  assert.throws(() => assertNoReallocation({ move: { gap_pct: 0.5 } }, 'gap-probe'),
    /reallocation field/, 'a lone gap_pct must be rejected by name')
  assert.throws(() => assertNoReallocation({ move: { saved_per_outcome: 30 } }, 'saved-probe'),
    /reallocation field/, 'a lone saved_per_outcome must be rejected by name')
  assert.throws(() => assertNoReallocation({ box: { channel_reallocation: {} } }, 'wrapper-probe'),
    /reallocation field/, 'a lone channel_reallocation wrapper must be rejected by name')

  // the coined verb, the internal candidate flags, and a bare cpo, smuggled as plain strings, are
  // caught by the token sweep.
  assert.throws(() => assertNoReallocation({ note: 'we will reallocate budget next week' }, 'reallocat-token-probe'),
    /reallocation vocabulary/, "the verb ('reallocate') leaked as a string must be rejected")
  assert.throws(() => assertNoReallocation({ note: 'flagged pull_candidate this week' }, 'pull-cand-probe'),
    /reallocation vocabulary/, "'pull_candidate' leaked as a string must be rejected")
  assert.throws(() => assertNoReallocation({ note: 'tagged push_candidate' }, 'push-cand-probe'),
    /reallocation vocabulary/, "'push_candidate' leaked as a string must be rejected")
  assert.throws(() => assertNoReallocation({ note: 'the cpo on this channel rose' }, 'cpo-token-probe'),
    /reallocation vocabulary/, "a bare 'cpo' leaked as a string must be rejected")
  // the whole reallocate move trips (structural compounds + status all present).
  assert.throws(() => assertNoReallocation({ status: 'reallocate', from_cpo: 60, to_cpo: 30, suggested_shift: 100, test_fraction: 0.1, gap_pct: 0.5 }, 'full-move-probe'),
    /reallocation field|reallocation vocabulary/, 'a full reallocate move must be rejected')

  // CRITICAL disjointness — the legit client vocabulary the guard must NEVER catch:
  //   the channel labels and outcome words the client surface speaks freely — 'Google Ads',
  //   'Facebook/Meta', 'leads'/'lead', 'cost', and dollar cost-per-lead figures — none is a
  //   reallocation token (\bcpo\b is anchored so "cost"/"cost per lead" pass clean).
  assert.doesNotThrow(
    () => assertNoReallocation({ focus: { label: 'Leads', metric: 'leads', direction: 'up', delta_pct: 12 }, note: 'Google Ads brought in leads at about $30 cost per lead while Facebook/Meta ran near $60.' }, 'channel-prose-probe'),
    'the channel labels, leads, and cost-per-lead prose are legit client facts and must pass clean')
  //   a client focus (Section D) carrying bare from/to (a date range), confidence, strength — none
  //   forbidden (we forbid only the compound machine identifiers from_cpo/.../test_fraction).
  assert.doesNotThrow(
    () => assertNoReallocation({ focus: { from: '2026-05-01', to: '2026-05-31', metric: 'leads', label: 'Leads', confidence: 0.8, strength: 'clear' } }, 'client-focus-probe'),
    'bare from/to/confidence/strength in a client focus are legit and must pass clean')
  //   an adverse finding's channel + outcome + plain message — 'channel'/'outcome'/'message' are
  //   everyday client vocabulary, and even bare 'shifted budget' prose is disjoint from the tokens.
  assert.doesNotThrow(
    () => assertNoReallocation({ insights: [{ severity: 'warning', channel: 'google_ads', outcome: 'leads', message: 'Leads dipped this week; we shifted budget toward the cheaper channel.' }] }, 'finding-probe'),
    "a finding's channel/outcome/message — incl bare 'shifted budget' prose — must pass clean")
  //   the sibling-layer words SPARED on purpose — 'saturated'/'easing' ride the client payload via
  //   briefLeadPolicy*/systemic/pulse* — must pass clean (the empirical trap this block avoided).
  assert.doesNotThrow(
    () => assertNoReallocation({ pulse: [{ metric: 'leads', note: 'demand is saturated; growth is easing into the weekend.' }] }, 'sibling-words-probe'),
    "the sibling-layer 'saturated'/'easing' words ride the client surface and must pass clean")
  //   the consumer's own engagement vote — the only byte they send back.
  assert.doesNotThrow(
    () => assertNoReallocation({ as_of: '2026-05-18', signal: 'helpful' }, 'own-vote-probe'),
    'the consumer own-vote must pass clean')

  // FINAL disjointness ledger: the distinctive reallocation tokens never appear in the generic
  // English the client surface actually uses (this string deliberately includes bare `from`, `to`,
  // `shift`, `gap`, `cost`, `confidence`, `strength`, `lead`, `leads`, `channel`, `budget`, and the
  // sibling words `saturated`/`easing` — ALL legal) — so the sweep can never false-positive a legit
  // client egress on a reallocation identifier (mirrors 23d's closing ledger sparing bare `reach`).
  assert.ok(!FORBIDDEN_REALLOC_TOKENS.test('from to shift gap cost confidence strength lead leads channel budget saturated demand easing growth Google Ads Facebook Meta cost per lead lower cost holds its cost'),
    'the reallocation sweep is disjoint from the generic English the client surface actually uses')
})
