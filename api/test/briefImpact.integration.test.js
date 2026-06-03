// ============================================================
// test/briefImpact.integration.test.js — editorial PRECISION, wired (intel-v7 12b).
//
// (12a) test/briefImpact.test.js pins the PURE grader on hand-built observations:
// given a list of { adverse, followups } it returns an earned/fair/overcalled hit
// rate. This file proves the SEAM 12b adds — lib/briefImpactEngine.getBriefImpact —
// which is the half that earns its keep: it READS the briefs we actually shipped
// (ai_briefs), REPLAYS the same self-tuning day-pulse over the mornings that FOLLOWED
// each lead, and feeds the resulting observations into summarizeBriefImpact. No human
// grading, no model, no fixtures the pure test could have used — the verdict is joined
// from two real reads (the brief corpus and the daily fact series).
//
// THE FIXTURE — "CrashCo": one client, a leads series that holds flat (~200/day) for
// nine weeks and then suffers a decisive, sustained crash (~5/day) for the final five.
// On crash mornings we shipped:
//   • six CLIENT briefs leading with `focus` = leads/down/paid, each placed deep enough
//     that all seven follow-up mornings sit INSIDE the crash → every follow-up still
//     fires the same adverse drop → the lead is CONFIRMED → a hit;
//   • one CLIENT brief ON asOf — no follow-up morning remains in the corpus, so it is
//     honestly ABSTAINED on ('unknown'), never fabricated and never punished;
//   • one AGENCY portfolio brief whose `headline` NAMES CrashCo — resolved through the
//     clients name→id index, graded against the very same series, counted as agency;
//   • one CLIENT brief leading with a NON-pulse metric (roas) — excluded wholesale by
//     the metric guard, proving the engine only grades leads it can actually replay.
//
// WHAT IS HARD vs SOFT. A follow-up morning deep in the loaded corpus ALWAYS has a full
// pulse baseline behind it, so dayPulse returns 'signal' or 'normal' — never
// 'insufficient'. That means every lead carrying ≥1 in-corpus follow-up RESOLVES (hit
// or miss, never unknown). So the observation construction — sample, judged, unknown,
// the client/agency split, the metric guard, the per-bucket invariant — is fully
// DETERMINISTIC and asserted hard, independent of whether the sensor fires. Only the
// hit-vs-miss SPLIT depends on the crash actually reading adverse; that is a separate,
// decisive-crash block (a 97.5% sustained drop fires under any sane tuned band).
//
// Isolated temp SQLite, same idiom as test/briefDelivery.integration.test.js: forced
// SQLITE_PATH before requiring ../db, ANTHROPIC_API_KEY deleted so nothing reaches the
// network (the impact narration is pure template by construction anyway).
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
const DB_PATH = path.join(os.tmpdir(), `briefimpact_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { getBriefImpact }       = require('../lib/briefImpactEngine')
const { narrateBriefImpact }   = require('../lib/briefImpact')
const { PORTFOLIO_KEY, leadPolicyHealthFor } = require('../lib/brief')
const { resolvePortfolioScope } = require('../routes/ai')
const { deriveLeadPolicy, narrateLeadPolicy } = require('../lib/briefLeadPolicy')
const policyHealth = require('../lib/briefLeadPolicyHealth')
const { narrateLeadPolicyHealth, shouldRevertToNeutral } = policyHealth

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── harness ─────────────────────────────────────────────────────────────────────
let migrated = false
async function ready() { if (migrated) return; await db.migrate(); migrated = true }
async function reset() {
  await ready()
  await db.query('DELETE FROM ai_briefs')
  await db.query('DELETE FROM fact_metric')
  await db.query('DELETE FROM clients')
}

const CLIENT_ID   = `crashco-${process.pid}`
const CLIENT_NAME = `CrashCo ${process.pid}`

// The engine loads span = days(30) + PULSE_LOOKBACK_DAYS(63) + window(7) = 100 days back
// from asOf, so the calendar spine is [asOf-100 .. asOf] = idx 0..100. Pin the clock to
// match: idx 0 = asOf-100 (oldest), idx 100 = asOf.
const ASOF = '2026-06-01'
const SPAN = 100
const isoMinus = (n) =>
  new Date(Date.parse(ASOF + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10)
const isoAtIdx = (idx) => isoMinus(SPAN - idx)

// seedDaily(clientId, factKey, oldestFirst): one value per day on the whole spine,
// oldest-first (oldestFirst[0] = asOf-100, …[100] = asOf). factKey is the ATOMIC
// metric_key stored in fact_metric ('revenue'|'leads'|'spend'|'closed_won'); all rows
// go on channel_id 1 (loadDailySeries sums across channels). Mirrors insights.pulse.test.
async function seedDaily(clientId, factKey, oldestFirst) {
  for (let i = 0; i < oldestFirst.length; i++) {
    const v = oldestFirst[i]
    if (!v) continue
    await db.query(
      `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ($1,$2,1,NULL,$3,$4)`,
      [clientId, isoMinus(oldestFirst.length - 1 - i), factKey, v]
    )
  }
}

// seedBrief: one ai_briefs row (mirror test/briefDelivery.integration.test.js seed()).
async function seedBrief({ scopeKey, asOf, audience, pack, clientId = null }) {
  await db.query(
    `INSERT INTO ai_briefs
       (scope_key, as_of, audience, client_id, model, pack, brief_text, grounded, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP)`,
    [scopeKey, asOf, audience, clientId, 'claude-opus-4-7', JSON.stringify(pack), 'brief.', 1]
  )
}

// The persisted pack shapes the engine reads: a client brief LEADS with `focus`, an
// agency brief with `headline` (which names a client). Mirrors lib/pulseBrief.js.
const clientFocus = (metric, direction, lane) =>
  ({ audience: 'client', focus: { metric, label: metric, direction, delta_pct: -97, lane }, meta: { has_focus: true } })
const agencyHeadline = (name, metric, direction, lane) =>
  ({ audience: 'agency', headline: { client_name: name, metric, label: metric, lane, direction, delta_pct: -97 }, meta: { has_action: true } })

// ── 1. the join: shipped leads graded against the day-pulse that followed ──────────
test('getBriefImpact replays the pulse over each shipped lead — deterministic construction, earned on a decisive crash, honest abstain where follow-through is absent', async () => {
  await reset()
  await db.query('INSERT INTO clients (id, name) VALUES ($1,$2)', [CLIENT_ID, CLIENT_NAME])

  // Flat ~200/day for 64 days (idx 0..63), then a decisive sustained crash to ~5/day
  // for the rest (idx 64..100). Every 7-day window from idx 70 on is therefore entirely
  // inside the crash — a ~97.5% drop vs a ~1400 baseline window — so the replayed sensor
  // fires an adverse drop on every follow-up morning we grade.
  const leads = Array.from({ length: SPAN + 1 }, (_, i) => (i < 64 ? 200 : 5))
  await seedDaily(CLIENT_ID, 'leads', leads)

  // Six CLIENT crash briefs, placed so all 7 follow-up mornings (idx+1..idx+7) land
  // inside the crash and inside the corpus (deepest is idx 83 → follow-ups to idx 90).
  const crashIdx = [73, 75, 77, 79, 81, 83]
  for (const idx of crashIdx) {
    await seedBrief({ scopeKey: CLIENT_ID, asOf: isoAtIdx(idx), audience: 'client', clientId: CLIENT_ID, pack: clientFocus('leads', 'down', 'paid') })
  }
  // One CLIENT brief ON asOf — zero follow-up mornings remain → honest 'unknown'.
  await seedBrief({ scopeKey: CLIENT_ID, asOf: isoAtIdx(100), audience: 'client', clientId: CLIENT_ID, pack: clientFocus('leads', 'down', 'paid') })
  // One AGENCY portfolio headline NAMING the client — resolved via name→id, graded agency.
  await seedBrief({ scopeKey: PORTFOLIO_KEY, asOf: isoAtIdx(78), audience: 'agency', clientId: null, pack: agencyHeadline(CLIENT_NAME, 'leads', 'down', 'paid') })
  // One CLIENT brief leading with a NON-pulse metric — excluded by the metric guard.
  await seedBrief({ scopeKey: CLIENT_ID, asOf: isoAtIdx(85), audience: 'client', clientId: CLIENT_ID, pack: clientFocus('roas', 'down', 'paid') })

  const impact = await getBriefImpact({ asOf: ASOF, days: 30 })

  // ── HARD — observation construction is deterministic. A follow-up deep in the corpus
  //    is never 'insufficient', so every lead with ≥1 in-corpus follow-up RESOLVES; only
  //    the asOf lead (no follow-ups) is unknown. None of this depends on the sensor firing.
  assert.equal(impact.sample, 8, 'nine briefs seeded; the roas lead is excluded by the metric guard → eight observations')
  assert.equal(impact.judged, 7, 'six client crash + one agency lead each carry seven in-corpus follow-ups → all resolve')
  assert.equal(impact.unknown, 1, 'only the asOf lead has no follow-up morning left in the corpus')
  assert.equal(impact.hits + impact.misses + impact.unknown, impact.sample, 'overall tally invariant')
  assert.equal(impact.status, 'graded', 'judged (7) ≥ min_sample (4)')
  assert.equal(impact.min_sample, 4)
  assert.equal(impact.window, 7, 'the engine grades over the PULSE_WINDOW follow-up horizon')

  // audience split is exact
  assert.equal(impact.by_audience.client.sample, 7, 'six crash + one asOf client leads')
  assert.equal(impact.by_audience.client.judged, 6, 'the asOf client lead stays unknown, not judged')
  assert.equal(impact.by_audience.agency.sample, 1, 'the lone name-resolved portfolio headline')
  assert.equal(impact.by_audience.agency.judged, 1)
  assert.equal(
    impact.by_audience.client.sample + impact.by_audience.agency.sample,
    impact.sample,
    'every observation is exactly one of client/agency'
  )

  // lane rollup + per-bucket invariant
  assert.ok(impact.by_lane.paid, 'all leads carried the paid lane')
  assert.equal(impact.by_lane.paid.sample, 8)
  for (const k of Object.keys(impact.by_lane)) {
    const b = impact.by_lane[k]
    assert.equal(b.hits + b.misses + b.unknown, b.sample, `by_lane.${k} tally invariant`)
  }
  for (const k of ['client', 'agency']) {
    const b = impact.by_audience[k]
    assert.equal(b.hits + b.misses + b.unknown, b.sample, `by_audience.${k} tally invariant`)
  }

  // ── DECISIVE-CRASH — a 97.5% sustained drop confirms every graded down-lead, so the
  //    record reads a clean 'earned' and the agency narration speaks it. (Robust: the
  //    tuned band, learned from a clean flat-then-crash, only ever gets MORE sensitive.)
  assert.equal(impact.misses, 0, 'a sustained crash never refutes an adverse down-lead')
  assert.equal(impact.hits, 7, 'all seven judged leads were confirmed by the crash that followed')
  assert.equal(impact.hit_rate, 1, '7 of 7 held up')
  assert.equal(impact.label, 'earned', 'a perfect-confirm record is earned')

  const agencyNarr = narrateBriefImpact(impact, { audience: 'agency' })
  assert.ok(agencyNarr && /earned their place 7 of 7 times/.test(agencyNarr), `agency narration present: ${agencyNarr}`)
  // The client voice only ever REINFORCES a strong record — never the count/pct/lane machinery.
  assert.equal(
    narrateBriefImpact(impact, { audience: 'client' }),
    'When we lead your morning brief with something, it has usually held up.'
  )
})

// ── 2. the read endpoint is agency-gated, exactly like brief-health ────────────────
test('GET /api/ai/brief-impact shares the portfolio 403 posture (resolvePortfolioScope)', () => {
  assert.deepEqual(resolvePortfolioScope({ user: { role: 'agency' } }), {}, 'an agency token may read the editorial-precision grade')
  const denied = resolvePortfolioScope({ user: { role: 'client', id: CLIENT_ID } })
  assert.equal(denied.status, 403, 'a client-scoped token is refused')
  assert.match(denied.error, /not authorized/, 'with the portfolio-brief refusal message')
})

// ── 3. the lead-policy read seam (13b): GET /api/ai/lead-policy derives a TUNED policy
//    from the very same real join, and that policy is agency-gated + client-silent. This
//    is the exact call chain the route runs — resolvePortfolioScope gate → getBriefImpact
//    → deriveLeadPolicy → narrateLeadPolicy — proven end-to-end on the crash corpus, not
//    on a hand-built impact object. The MEASURE half (12a/b) earned a clean 'earned' on
//    `paid`; here the TUNE half (13a/b) turns that track record into a learned promotion.
test('GET /api/ai/lead-policy — agency-gated, derives a well-formed tuned policy from the real join, and stays client-silent', async () => {
  // same gate the route applies before it ever reads
  assert.deepEqual(resolvePortfolioScope({ user: { role: 'agency' } }), {}, 'agency may read the learned lead policy')
  assert.equal(resolvePortfolioScope({ user: { role: 'client', id: CLIENT_ID } }).status, 403, 'a client token is refused the portfolio-wide policy')

  // rebuild the exact flat-then-crash corpus from test 1, independent of test order
  await reset()
  await db.query('INSERT INTO clients (id, name) VALUES ($1,$2)', [CLIENT_ID, CLIENT_NAME])
  const leads = Array.from({ length: SPAN + 1 }, (_, i) => (i < 64 ? 200 : 5))
  await seedDaily(CLIENT_ID, 'leads', leads)
  for (const idx of [73, 75, 77, 79, 81, 83]) {
    await seedBrief({ scopeKey: CLIENT_ID, asOf: isoAtIdx(idx), audience: 'client', clientId: CLIENT_ID, pack: clientFocus('leads', 'down', 'paid') })
  }

  // the route body, verbatim in spirit: grade the corpus, then learn from the grade
  const impact = await getBriefImpact({ asOf: ASOF, days: 30 })
  assert.equal(impact.status, 'graded', 'the join produced a gradeable record')
  assert.equal(impact.by_lane.paid.hit_rate, 1, 'paid earned a perfect confirm record on the crash')

  const policy = deriveLeadPolicy(impact)
  assert.equal(policy.status, 'tuned', 'a clean earned record on paid moves the policy off neutral')
  // bounds are well-formed: a symmetric band straddling 1.0, never inverted
  assert.ok(policy.bounds && policy.bounds.max > 1 && policy.bounds.min > 0 && policy.bounds.min < 1,
    `bounds straddle neutral: ${JSON.stringify(policy.bounds)}`)
  // the learned move on paid is a PROMOTION pinned to the max of the band (hit_rate 1.0 → 1.2)
  assert.ok(policy.lanes.paid, 'paid carries a learned entry')
  assert.equal(policy.lanes.paid.direction, 'promote', 'a perfect record promotes the lane')
  assert.equal(policy.lanes.paid.weight, policy.bounds.max, 'a perfect 1.0 hit rate pins to the top of the band')
  assert.equal(policy.lanes.paid.adjusted, true)
  assert.equal(policy.lanes.paid.judged, 6, 'tuned off the six judged client crash leads this corpus resolved')
  // act_now is never demoted by this corpus — the safety lane carries no learned entry here,
  // and the floor list still names it (the asymmetry is structural, not data-dependent)
  assert.ok(policy.safety_floor_lanes.includes('act_now'), 'the safety floor still protects act_now')

  // the agency one-liner speaks the learned promotion; the client voice stays silent
  const agencyNarr = narrateLeadPolicy(policy, { audience: 'agency' })
  assert.match(agencyNarr, /front-page track record/, 'agency narration names the learned track record')
  assert.match(agencyNarr, /lead more with paid/, 'and the specific learned promotion')
  assert.equal(narrateLeadPolicy(policy, { audience: 'client' }), '', 'lead-selection tuning is never client-facing')
})

// ── 4. the watch-the-watcher read seam (14b): GET /api/ai/lead-policy-health grades the
//    TRAJECTORY of the tuner over the same real join — six day-anchors, one deriveLeadPolicy
//    apiece (leadPolicyHealthFor → leadPolicyHistoryFor) — and the verdict is agency-gated +
//    client-silent, exactly like /lead-policy. We assert only what the MONOTONIC crash corpus
//    makes deterministic: a flat-then-crash can promote/neutral `paid` but never demote it, so
//    the tuner's trajectory cannot oscillate. The precise verdict STATUS (saturated_high once
//    `paid` pins to the band ceiling, vs settling/stable while it climbs) rides on the engine's
//    default grading window and is deliberately NOT asserted — only the stability invariants are.
test('GET /api/ai/lead-policy-health — agency-gated, well-formed over the real join, NEVER reverts on a monotonic crash, and stays client-silent', async () => {
  // same gate the route applies before it ever reads (identical posture to /lead-policy)
  assert.deepEqual(resolvePortfolioScope({ user: { role: 'agency' } }), {}, 'agency may read the loop-stability verdict')
  assert.equal(resolvePortfolioScope({ user: { role: 'client', id: CLIENT_ID } }).status, 403, 'a client token is refused the portfolio-wide stability verdict')

  // rebuild the exact flat-then-crash corpus, independent of test order
  await reset()
  await db.query('INSERT INTO clients (id, name) VALUES ($1,$2)', [CLIENT_ID, CLIENT_NAME])
  const leads = Array.from({ length: SPAN + 1 }, (_, i) => (i < 64 ? 200 : 5))
  await seedDaily(CLIENT_ID, 'leads', leads)
  for (const idx of [73, 75, 77, 79, 81, 83]) {
    await seedBrief({ scopeKey: CLIENT_ID, asOf: isoAtIdx(idx), audience: 'client', clientId: CLIENT_ID, pack: clientFocus('leads', 'down', 'paid') })
  }

  // the route body, verbatim in spirit: walk the tuner's last six grades and judge their stability
  const v = await leadPolicyHealthFor(ASOF)

  // well-formed verdict shape (never an abstain on this corpus — every anchor mints a policy)
  assert.equal(typeof v.status, 'string', 'a verdict carries a status string')
  assert.notEqual(v.status, 'abstained', 'six in-corpus anchors clear the min-history floor')
  assert.ok(v.counts && v.bounds && v.lanes, 'verdict carries counts, bounds and per-lane state')
  // the window math is exact: default span is the monitor window (6), and every anchor produced
  // a (truthy) policy, so history fills the window and window_used pins to min(history_len, 6).
  assert.ok(v.history_len >= policyHealth.DEFAULT_MIN_HISTORY && v.history_len <= policyHealth.DEFAULT_WINDOW,
    `history_len sits within [${policyHealth.DEFAULT_MIN_HISTORY}, ${policyHealth.DEFAULT_WINDOW}]: ${v.history_len}`)
  assert.equal(v.window_used, Math.min(v.history_len, policyHealth.DEFAULT_WINDOW), 'window_used = min(history_len, monitor window)')

  // THE STABILITY INVARIANT — a monotonic crash can only ever promote/neutral `paid`, never
  // demote it, so the tuner's trajectory carries ZERO promote↔demote reversals and the monitor
  // must NOT order a revert. This is the deterministic spine of the test.
  assert.equal(v.counts.oscillating, 0, 'a monotonic crash trajectory has no oscillating lane')
  assert.equal(shouldRevertToNeutral(v), false, 'and so the monitor never orders a self-heal')
  assert.notEqual(v.recommended_action, 'revert_to_neutral', 'the recommended action is never revert on a monotonic crash')
  if (v.lanes.paid) assert.equal(v.lanes.paid.flips, 0, 'the paid lane never reverses direction here')
  // bounds are the same well-formed band the tuner published: symmetric, straddling neutral
  assert.ok(v.bounds.max > 1 && v.bounds.min > 0 && v.bounds.min < 1, `bounds straddle neutral: ${JSON.stringify(v.bounds)}`)

  // the agency may hear the verdict; the client voice is silent under EVERY status the monitor emits
  assert.equal(typeof narrateLeadPolicyHealth(v, { audience: 'agency' }), 'string', 'agency narration is a string (possibly empty when settling/idle)')
  assert.equal(narrateLeadPolicyHealth(v, { audience: 'client' }), '', 'loop-stability monitoring is never client-facing')
})
