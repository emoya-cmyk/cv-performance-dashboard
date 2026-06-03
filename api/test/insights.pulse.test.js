'use strict'

// ============================================================
// test/insights.pulse.test.js — the engine wiring for the intra-week pulse
// (intel-v7 1b). lib/dayPulse.js is unit-tested in isolation in dayPulse.test.js;
// this file proves the two reads that put it on the ATOMIC DAILY grain:
//
//   • loadDailySeries(clientId)  — sums fact_metric across ALL channels per
//     (date, metric_key), densifies into oldest→newest zero-filled daily arrays
//     on a UTC calendar spine, and maps each atomic key back to its engine metric;
//   • getClientPulse(clientId)   — runs dayPulse per sum-aggregable flow metric
//     (revenue/leads/spend/jobs) with the metric's adverse polarity, and bakes
//     BOTH a `message` (agency tone) and a `client_message` (client tone) onto
//     each signal so the same payload serves the agency card and /my-dashboard;
//   • getPortfolioPulse()        — the agency roster: every client × flagged
//     metric, name-tagged and ranked worst-first, with data-less clients
//     contributing nothing and never throwing.
//
// It runs end to end against an isolated temp SQLite DB (its own SQLITE_PATH,
// migrated once). ANTHROPIC_API_KEY is deleted so nothing reaches the network —
// the pulse narration is pure template by construction anyway. The seeding mirrors
// dayPulse.test's `blocks` builder: one full weekly total per NON-OVERLAPPING
// 7-day window, placed on that window's end-day, so each test names a week's sum
// directly (the within-window layout is irrelevant to a 7-day window SUM).
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
const DB_PATH = path.join(os.tmpdir(), `insights_pulse_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { getClientPulse, getPortfolioPulse, loadDailySeries, clientSafePulse, METRIC_META } = require('../lib/insights')
// The pure triage contract (severity×confidence → priority/lane/reason), unit-tested
// exhaustively in pulseTriage.test.js. Here we only assert the ENGINE emits exactly
// what these produce for its own signals — i.e. the wiring is faithful, not a re-impl.
const { triagePriority, triageLane, narrateTriage } = require('../lib/pulseTriage')
// The predictive-precision self-audit (intel-v7 5a), unit-tested in full in
// pulseAccuracy.test.js. Here we only assert the ENGINE replays it over the SAME loaded
// series and stamps the firing signal with exactly what the pure module returns — the
// wiring is faithful, not a re-impl — and that it attaches NOTHING when the record is
// too thin to grade. loadDailySeries gives us the very series the engine grades.
const { pulseAccuracy, narratePulseAccuracy } = require('../lib/pulseAccuracy')
// The self-tuning controller (intel-v7 6a) that closes the pulse loop: it reads the
// canonical-band precision the audit above produces and returns the {warn, crit} the LIVE
// sensor should use — a lighter trigger where warnings have proven out. Unit-tested in full
// in pulseTuning.test.js; here we only assert the ENGINE attaches its output verbatim to the
// firing signal, keeps the accuracy SURFACE canonical (non-circular), and never lets the
// calibration machinery reach a client.
const { tunePulseThresholds, narratePulseTuning } = require('../lib/pulseTuning')
// The synthesis capstone (intel-v7 7a), unit-tested in full in insights.pulseBriefing.test.js.
// Here we only assert the ENGINE published EXACTLY what the pure module computes over its own
// roster/signals — the briefing is forwarded faithfully, never re-derived — and that the
// client briefing is machinery-free at the wire and rides clientSafePulse untouched.
const { summarizePortfolioPulse, summarizeClientPulse } = require('../lib/pulseBriefing')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── harness ───────────────────────────────────────────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

let seq = 0
async function freshClient(name) {
  const id = `pulse-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

// Pin the clock so the calendar spine is deterministic. The pulse window math:
//   spine = [ASOF-63 .. ASOF] = 64 days (idx 0..63); latest 7-day window = idx 57..63
//   (= days-ago 6..0, ending ON ASOF); 8 prior NON-OVERLAPPING windows end at
//   days-ago 7,14,…,56 → baseline.n = 8 (> minWindows 3).
const ASOF = '2026-06-01'
const isoMinus = (n) =>
  new Date(Date.parse(ASOF + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10)

// seedWeekly(clientId, factKey, sums): place one weekly total per non-overlapping
// 7-day window. sums[0] is the LATEST week (days-ago 0), sums[k] the k-th prior
// week (days-ago 7k). Each whole week-sum lands on its window's end-day — a 7-day
// trailing SUM is invariant to where inside the window the activity sits, so this
// lets each test name a week's total directly. factKey is the ATOMIC metric_key
// stored in fact_metric ('revenue' | 'leads' | 'spend' | 'closed_won'); all rows
// go on channel_id 1 (loadDailySeries sums across channels, so the channel is
// irrelevant — only the client-level daily total matters).
async function seedWeekly(clientId, factKey, sums) {
  for (let k = 0; k < sums.length; k++) {
    const v = sums[k]
    if (!v) continue
    await db.query(
      `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ($1,$2,1,NULL,$3,$4)`,
      [clientId, isoMinus(7 * k), factKey, v]
    )
  }
}

// seedDaily(clientId, factKey, dailyOldestFirst): place a value on EVERY day of the
// 64-day spine, oldest-first (dailyOldestFirst[0] = days-ago 63, …[63] = ASOF). Unlike
// seedWeekly (one lump per week), this gives the within-week daily STRUCTURE pulseAccuracy
// needs: a sustained drop reads low at the lead-day early call too, so the early warning
// fires in lockstep with each low week's close — a gradeable, proven track record (the
// case that exercises the 5b accuracy wiring). Zero values are skipped (dense-zero spine).
async function seedDaily(clientId, factKey, dailyOldestFirst) {
  for (let i = 0; i < dailyOldestFirst.length; i++) {
    const v = dailyOldestFirst[i]
    if (!v) continue
    await db.query(
      `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ($1,$2,1,NULL,$3,$4)`,
      [clientId, isoMinus(dailyOldestFirst.length - 1 - i), factKey, v]
    )
  }
}

// A tight, in-band 9-week history (latest == baseline median) → z 0 → normal.
const STABLE_LEADS = [100, 98, 102, 99, 101, 100, 103, 97, 100]

// ── loadDailySeries: the densifier ────────────────────────────────────────────
test('loadDailySeries: sums across channels into a zero-filled UTC spine, keyed by engine metric', async () => {
  await ready()
  const c = await freshClient('Densifier Co')
  // Two channels, same day, same atomic key → must SUM to the client-level total.
  await db.query(
    `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
     VALUES ($1,$2,1,NULL,'leads',30),($1,$2,2,NULL,'leads',12)`,
    [c, isoMinus(3)]
  )
  // The atomic key for the 'jobs' engine metric is 'closed_won' — must remap.
  await db.query(
    `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
     VALUES ($1,$2,1,NULL,'closed_won',5)`,
    [c, isoMinus(3)]
  )

  const { start, end, dates, series } = await loadDailySeries(c, { asOf: ASOF })
  assert.equal(end, ASOF)
  assert.equal(start, isoMinus(63))
  assert.equal(dates.length, 64)                  // inclusive spine, oldest→newest
  assert.equal(dates[63], ASOF)
  assert.equal(dates[57], isoMinus(6))            // latest-window start
  // engine metrics present, each a dense 64-long array
  for (const m of ['revenue', 'leads', 'spend', 'jobs']) {
    assert.ok(Array.isArray(series[m]) && series[m].length === 64, `${m} dense`)
  }
  // the two leads channels summed onto day "days-ago 3" (= idx 60); zero elsewhere
  assert.equal(series.leads[60], 42)
  assert.equal(series.leads[59], 0)
  assert.equal(series.jobs[60], 5)                // closed_won → jobs
  assert.equal(series.revenue.reduce((a, b) => a + b, 0), 0)   // untouched metric stays all-zero
})

// ── getClientPulse: the leads-collapse anchor (grounded strings, both audiences) ─
test('getClientPulse: a collapsed trailing week fires ONE adverse drop signal, grounded for both audiences', async () => {
  await ready()
  const c = await freshClient('Collapse Roofing')
  // baseline weeks (days-ago 7..56), median 100; latest week (days-ago 0) = 20.
  await seedWeekly(c, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])

  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.as_of, ASOF)
  assert.equal(out.window, 7)
  assert.equal(out.lookback_days, 63)
  assert.equal(out.signals.length, 1)             // leads only — the other metrics are all-zero ⇒ normal

  const s = out.signals[0]
  assert.equal(s.metric, 'leads')
  assert.equal(s.label, 'Leads')
  assert.equal(s.direction, 'down')
  assert.equal(s.severity, 'critical')
  assert.equal(s.adverse, true)                   // leads drop = bad polarity
  assert.equal(s.latest, 20)
  assert.equal(s.baseline.median, 100)
  assert.equal(Math.round(s.delta_pct), -80)
  // the trailing window is anchored to real calendar dates for display
  assert.equal(s.window_end, ASOF)
  assert.equal(s.window_start, isoMinus(6))
  // both narrations are baked, every figure copied off the verdict
  assert.equal(
    s.message,
    "Leads over the last 7 days total 20 — about 80% below this client's usual week (≈100). Flagged today.",
  )
  assert.equal(
    s.client_message,
    'Leads over the last 7 days total 20 — about 80% below your usual week (≈100). Flagged today.',
  )
})

// ── polarity: a SPIKE on a "bad-when-up" metric is adverse ──────────────────────
test('getClientPulse: a spend spike fires an adverse signal via the spike polarity', async () => {
  await ready()
  const c = await freshClient('Spike Roofing')
  // baseline median 3000; latest week 5400 (+80%). spend is goodWhenUp:false ⇒ spike is adverse.
  await seedWeekly(c, 'spend', [5400, 2700, 3000, 3300, 2850, 3150, 3000, 2950, 3050])

  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.signals.length, 1)
  const s = out.signals[0]
  assert.equal(s.metric, 'spend')
  assert.equal(s.label, 'Ad spend')
  assert.equal(s.direction, 'up')
  assert.equal(s.adverse, true)                   // up + bad-when-up ⇒ adverse
  assert.equal(s.baseline.median, 3000)
  assert.equal(Math.round(s.delta_pct), 80)
  assert.equal(
    s.message,
    "Ad spend over the last 7 days total 5,400 — about 80% above this client's usual week (≈3,000). Flagged today.",
  )
  assert.equal(
    s.client_message,
    'Ad spend over the last 7 days total 5,400 — about 80% above your usual week (≈3,000). Flagged today.',
  )
})

// ── abstention: data, but in-band → silence (distinct from a data-less client) ──
test('getClientPulse: a stable in-band history yields zero signals', async () => {
  await ready()
  const c = await freshClient('Stable Roofing')
  await seedWeekly(c, 'leads', STABLE_LEADS)      // latest == median ⇒ z 0 ⇒ normal
  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.signals.length, 0)
})

test('getClientPulse: a data-less client abstains cleanly — no signals, no throw', async () => {
  await ready()
  const c = await freshClient('Empty Roofing')   // no facts at all
  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.as_of, ASOF)
  assert.equal(out.signals.length, 0)             // all-zero series ⇒ robustZ 0 ⇒ normal, never a false signal
})

// ── multi-signal ranking within one client: worst-first by |z| ──────────────────
test('getClientPulse: multiple flagged metrics are ranked worst-first (severe collapse over a mild dip)', async () => {
  await ready()
  const c = await freshClient('Ranking Roofing')
  // leads: a severe collapse (tiny spread → |z| huge, critical)
  await seedWeekly(c, 'leads', [10, 100, 98, 102, 99, 101, 100, 103, 97])
  // revenue: a moderate dip against a wide band (|z|≈2.9 → warning)
  await seedWeekly(c, 'revenue', [3500, 5000, 4000, 6000, 4500, 5500, 5000, 4800, 5200])

  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.signals.length, 2)
  // both adverse drops; ranked by |z| desc ⇒ the leads collapse leads
  assert.equal(out.signals[0].metric, 'leads')
  assert.equal(out.signals[0].severity, 'critical')
  assert.equal(out.signals[0].adverse, true)
  assert.equal(out.signals[1].metric, 'revenue')
  assert.equal(out.signals[1].severity, 'warning')
  assert.equal(out.signals[1].adverse, true)
  assert.ok(Math.abs(out.signals[0].z) > Math.abs(out.signals[1].z), 'ranked by |z| descending')
})

// ── getPortfolioPulse: name-tagged roster, isolation, worst-first ───────────────
test('getPortfolioPulse: names each flagged client, skips the quiet/empty ones, ranks worst-first', async () => {
  await ready()
  const pCollapse = await freshClient('Portfolio Collapse Co')
  const pSpike    = await freshClient('Portfolio Spike Co')
  const pStable   = await freshClient('Portfolio Stable Co')
  const pEmpty    = await freshClient('Portfolio Empty Co')   // no facts
  await seedWeekly(pCollapse, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])
  await seedWeekly(pSpike,    'spend', [5400, 2700, 3000, 3300, 2850, 3150, 3000, 2950, 3050])
  await seedWeekly(pStable,   'leads', STABLE_LEADS)

  const out = await getPortfolioPulse({ asOf: ASOF })
  assert.equal(out.as_of, ASOF)
  assert.equal(out.window, 7)
  assert.equal(out.lookback_days, 63)

  // membership is robust to whatever other clients this file created: filter to mine.
  const mine = new Set([pCollapse, pSpike, pStable, pEmpty])
  const rows = out.roster.filter(r => mine.has(r.client_id))
  assert.equal(rows.length, 2)                    // exactly the two that fired
  const byClient = new Map(rows.map(r => [r.client_id, r]))

  const collapseRow = byClient.get(pCollapse)
  assert.ok(collapseRow, 'collapse client present')
  assert.equal(collapseRow.client_name, 'Portfolio Collapse Co')   // name-tagged for the agency
  assert.equal(collapseRow.metric, 'leads')
  assert.equal(collapseRow.adverse, true)
  assert.ok(collapseRow.message && collapseRow.client_message)     // both tones ride along

  const spikeRow = byClient.get(pSpike)
  assert.ok(spikeRow, 'spike client present')
  assert.equal(spikeRow.client_name, 'Portfolio Spike Co')
  assert.equal(spikeRow.metric, 'spend')

  // the quiet and the data-less clients contribute nothing
  assert.ok(!byClient.has(pStable), 'stable client absent')
  assert.ok(!byClient.has(pEmpty),  'empty client absent')

  // the WHOLE roster is correctly ranked: adverse-first, then |z| descending.
  for (let i = 1; i < out.roster.length; i++) {
    const a = out.roster[i - 1], b = out.roster[i]
    const adv = Number(b.adverse) - Number(a.adverse)
    assert.ok(adv <= 0, 'adverse rows sort ahead of non-adverse')
    if (adv === 0) {
      assert.ok(Math.abs(a.z) >= Math.abs(b.z) - 1e-9, 'ties broken by |z| descending')
    }
  }
})

// ── intel-v7 (2): the "why" — a COMPOSITE move decomposes; an atomic one doesn't ─
// jobs ≡ leads × (close_rate/100). Halving leads while holding the close rate at 50%
// collapses BOTH jobs and leads to a fifth of their usual week, so both fire as
// critical drops — but only the composite (jobs) carries a driver diagnosis. The
// baseline window the diagnosis picks is a usual week (jobs 100 / leads 200 / close
// 50%); the latest week is jobs 20 / leads 40 / close 50%, so leads moved the whole
// identity and the close rate held.
test('getClientPulse: a jobs collapse is diagnosed as leads-driven (close rate held); the atomic leads signal carries no diagnosis', async () => {
  await ready()
  const c = await freshClient('Diagnosis Jobs Co')
  await seedWeekly(c, 'closed_won', [20, 90, 100, 110, 95, 105, 100, 98, 102])
  await seedWeekly(c, 'leads',      [40, 180, 200, 220, 190, 210, 200, 196, 204])

  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.signals.length, 2)             // jobs + leads (close_rate isn't a pulse metric)

  // the COMPOSITE — jobs, decomposed into its exact stored drivers
  const jobs = out.signals.find(s => s.metric === 'jobs')
  assert.ok(jobs, 'jobs signal present')
  assert.equal(jobs.severity, 'critical')
  assert.equal(jobs.adverse, true)
  assert.ok(jobs.diagnosis, 'jobs carries a diagnosis')
  assert.equal(jobs.diagnosis.direction, 'down')
  assert.equal(jobs.diagnosis.lead, 'leads')      // leads moved the identity; close rate held
  const jLeads = jobs.diagnosis.drivers.find(d => d.metric === 'leads')
  const jClose = jobs.diagnosis.drivers.find(d => d.metric === 'close_rate')
  assert.equal(jLeads.pct, -80)                   // leads fell 80% …
  assert.equal(jLeads.share_pct, 100)             // … which is 100% of the move
  assert.equal(jClose.pct, 0)                     // close rate didn't budge …
  assert.equal(jClose.share_pct, 0)               // … so it owns none of the move
  assert.equal(
    jobs.diagnosis_message,
    'Jobs won is down 80% — the driver is Leads (down 80%), while Close rate held.',
  )
  assert.equal(
    jobs.diagnosis_client_message,
    'Your jobs won is down 80% — the driver is Leads (down 80%), while Close rate held.',
  )

  // the ATOMIC sibling — leads fires the same collapse but cannot decompose
  const leads = out.signals.find(s => s.metric === 'leads')
  assert.ok(leads, 'leads signal present')
  assert.equal(leads.severity, 'critical')
  assert.equal(leads.diagnosis, undefined)
  assert.equal(leads.diagnosis_message, undefined)
  assert.equal(leads.diagnosis_client_message, undefined)
})

// ── intel-v7 (2): the showcase — a revenue drop with a CUSHIONING driver ────────
// revenue ≡ spend × roas. Spend is cut harder (−50%) than revenue falls (−30%), so
// ROAS actually ROSE (1.0 → 1.4) and SOFTENED the drop — a negative-share driver,
// the case a flat "revenue is down" alert can't express. spend fires too, but a drop
// on a spike-adverse metric is non-adverse, and spend is atomic ⇒ no decomposition.
test('getClientPulse: a revenue drop is diagnosed as spend-driven, with ROAS shown as a cushion', async () => {
  await ready()
  const c = await freshClient('Diagnosis Revenue Co')
  await seedWeekly(c, 'revenue', [700, 1000, 900, 1100, 1000, 1050, 950, 1000, 1020])
  await seedWeekly(c, 'spend',   [500, 1000, 950, 1050, 1000, 980, 1020, 1000, 990])

  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.signals.length, 2)             // revenue (adverse) + spend (a drop on a spike-adverse metric ⇒ not adverse)

  // the COMPOSITE — revenue, decomposed: spend is the lever, ROAS the cushion
  const rev = out.signals.find(s => s.metric === 'revenue')
  assert.ok(rev, 'revenue signal present')
  assert.equal(rev.severity, 'critical')
  assert.equal(rev.adverse, true)
  assert.ok(rev.diagnosis, 'revenue carries a diagnosis')
  assert.equal(rev.diagnosis.direction, 'down')
  assert.equal(rev.diagnosis.lead, 'spend')       // spend, not ROAS, drove the drop
  const dSpend = rev.diagnosis.drivers.find(d => d.metric === 'spend')
  const dRoas  = rev.diagnosis.drivers.find(d => d.metric === 'roas')
  assert.equal(dSpend.pct, -50)                   // spend fell 50% …
  assert.equal(dSpend.share_pct, 194)             // … over-explaining the 30% drop (share > 1)
  assert.ok(dSpend.share > 1)
  assert.equal(dRoas.pct, 40)                     // ROAS rose 40% …
  assert.equal(dRoas.share_pct, -94)              // … a NEGATIVE share: it cushioned the move
  assert.ok(dRoas.share < 0)
  assert.equal(
    rev.diagnosis_message,
    'Revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop.',
  )
  assert.equal(
    rev.diagnosis_client_message,
    'Your revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop.',
  )

  // the ATOMIC sibling — spend fires too, but cannot decompose
  const spend = out.signals.find(s => s.metric === 'spend')
  assert.ok(spend, 'spend signal present')
  assert.equal(spend.adverse, false)              // a spend DROP isn't adverse on a spike-adverse metric
  assert.equal(spend.diagnosis, undefined)
  assert.equal(spend.diagnosis_message, undefined)
})

// ── intel-v7 (4): reliability-weighted triage wired onto BOTH reads ─────────────
// pulseTriage.js is unit-tested in full in pulseTriage.test.js (the severity×confidence
// arithmetic, the lane grid, the narrator, and the headline cross — a reliable Warning
// outranking a noisy Critical). These wiring tests prove only that the ENGINE forwards
// its real signals through that module faithfully: getClientPulse stamps each signal
// with the INTRINSIC triage fields the pure module returns for THAT signal (priority /
// lane / triage_reason / triage_client_reason — but NOT priority_rank, a feed-position
// meaningless on a single client's per-metric list), and getPortfolioPulse additionally
// emits the ranked, adverse-only "Act today" feed on top of the unchanged roster.

test('getClientPulse: each signal carries the intrinsic triage fields (faithful to pulseTriage), and NO priority_rank', async () => {
  await ready()
  const c = await freshClient('Triage Client Co')
  await seedWeekly(c, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])   // critical adverse drop
  const out = await getClientPulse(c, { asOf: ASOF })
  assert.equal(out.signals.length, 1)
  const s = out.signals[0]

  // the engine attached EXACTLY what the pure module computes from this very signal —
  // proving it forwarded the real severity / reliability / delta_pct, not a stale copy.
  assert.equal(s.priority, triagePriority(s))
  assert.equal(s.lane, triageLane(s))
  assert.equal(s.triage_reason, narrateTriage(s, { audience: 'agency' }))
  assert.equal(s.triage_client_reason, narrateTriage(s, { audience: 'client' }))

  // intrinsic only — a per-metric list is already worst-first; a feed-rank would lie here.
  assert.equal(s.priority_rank, undefined)

  // and the fields are substantive: a critical adverse drop lands in an action lane.
  assert.ok(s.priority > 0, 'priority is positive for a real adverse firing')
  assert.ok(s.lane === 'act_now' || s.lane === 'verify', 'critical adverse → act_now or verify')
  assert.ok(s.triage_reason.length > 0 && s.triage_client_reason.length > 0, 'both reasons grounded')
})

test('getPortfolioPulse: emits a ranked, adverse-only "Act today" feed; the roster stays the full worst-first stream', async () => {
  await ready()
  const aCollapse = await freshClient('Act Collapse Co')   // critical adverse leads drop
  const aDip      = await freshClient('Act Dip Co')         // warning  adverse revenue dip
  const aTailwind = await freshClient('Act Tailwind Co')    // leads SPIKE → a NON-adverse signal
  const aEmpty    = await freshClient('Act Empty Co')       // no facts → contributes nothing
  await seedWeekly(aCollapse, 'leads',   [20, 90, 100, 110, 95, 105, 100, 98, 102])
  await seedWeekly(aDip,      'revenue', [3500, 5000, 4000, 6000, 4500, 5500, 5000, 4800, 5200])
  await seedWeekly(aTailwind, 'leads',   [220, 100, 98, 102, 99, 101, 100, 103, 97])  // +120% surge

  const out = await getPortfolioPulse({ asOf: ASOF })
  assert.ok(Array.isArray(out.act_today), 'act_today feed present on the portfolio payload')

  const mine = new Set([aCollapse, aDip, aTailwind, aEmpty])

  // the tailwind IS in the worst-first roster (a non-adverse leads surge), proving the
  // roster still carries the full stream — but it must NOT appear in the action feed.
  const tailRow = out.roster.find(r => r.client_id === aTailwind && r.metric === 'leads')
  assert.ok(tailRow, 'the non-adverse leads surge is present in the roster')
  assert.equal(tailRow.adverse, false)
  assert.equal(tailRow.lane, 'tailwind')                                   // and lane-classed as a tailwind
  assert.ok(!out.act_today.some(r => r.client_id === aTailwind), 'tailwind excluded from Act today')

  // my two ADVERSE firings both surface in the feed; the empty client never does.
  const feed = out.act_today.filter(r => mine.has(r.client_id))
  assert.equal(feed.length, 2, 'exactly the two adverse firings reach the feed')
  assert.ok(!feed.some(r => r.client_id === aEmpty), 'data-less client absent from feed')

  // every feed row: adverse, faithfully triaged, and stamped with a 1-based feed rank.
  for (const r of feed) {
    assert.equal(r.adverse, true)
    assert.equal(r.priority, triagePriority(r))
    assert.equal(r.lane, triageLane(r))
    assert.equal(r.triage_reason, narrateTriage(r, { audience: 'agency' }))
    assert.ok(Number.isInteger(r.priority_rank) && r.priority_rank >= 1, 'stamped with a feed rank')
  }

  // the WHOLE feed is adverse-only and ordered by priority desc (then |z|) — "what to
  // touch today, in order" — with a contiguous 1..N rank. This is the end-to-end half of
  // the headline cross: the per-row priority already folds in learned reliability (proven
  // arithmetically in pulseTriage.test.js), so ranking by it lands a reliable Warning
  // above a noisy Critical whenever the grades diverge.
  for (const r of out.act_today) assert.equal(r.adverse, true)
  out.act_today.forEach((r, i) => assert.equal(r.priority_rank, i + 1, 'priority_rank is contiguous 1..N'))
  for (let i = 1; i < out.act_today.length; i++) {
    assert.ok(out.act_today[i - 1].priority >= out.act_today[i].priority - 1e-9, 'feed ranked by priority desc')
  }

  // and the roster itself is UNCHANGED in contract: still worst-first (adverse, then |z|).
  for (let i = 1; i < out.roster.length; i++) {
    const a = out.roster[i - 1], b = out.roster[i]
    const adv = Number(b.adverse) - Number(a.adverse)
    assert.ok(adv <= 0, 'roster: adverse rows still sort ahead of non-adverse')
    if (adv === 0) assert.ok(Math.abs(a.z) >= Math.abs(b.z) - 1e-9, 'roster: ties still broken by |z| desc')
  }
})

// ── getClientPulse: the predictive-precision self-audit (intel-v7 5b wiring) ─────
test('getClientPulse: a firing signal over a PROVEN own-history carries a graded accuracy block, faithful to pulseAccuracy + narratePulseAccuracy for both audiences', async () => {
  await ready()
  const c = await freshClient('Proven Track Co')
  // A sustained DAILY-level drop: ~5 weeks at 100/day, then ~4 weeks at 20/day, spread
  // across every day (not lumped per week). That intra-week structure is what makes the
  // record gradeable: the lead-day early call sees the low level in lockstep with each
  // low week's close, so prior firings line up with prior adverse weeks → a real, PROVEN
  // track record. seedWeekly's single-day lumps can't express this (the lead day reads
  // zero on every non-lump day) — hence seedDaily.
  await seedDaily(c, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))

  const out = await getClientPulse(c, { asOf: ASOF })
  const sig = out.signals.find(s => s.metric === 'leads')
  assert.ok(sig, 'the sustained leads drop still fires a signal')

  // Recompute the audit from the VERY series the engine loaded (same default 64-day
  // spine, same polarity) — proving the attached block is forwarded faithfully, not a
  // stale or parallel computation.
  const { series } = await loadDailySeries(c, { asOf: ASOF })
  const expected = pulseAccuracy(series.leads, { window: 7, adverseWhen: 'drop' })

  // the fixture must actually exercise a graded, PROVEN record — else the test is vacuous.
  assert.equal(expected.status, 'graded')
  assert.equal(expected.label, 'proven')

  // the engine attached EXACTLY the audit's figures — the curated projection, nothing more.
  assert.deepEqual(sig.accuracy, {
    status:        expected.status,
    precision:     expected.precision,
    recall:        expected.recall,
    f1:            expected.f1,
    avg_lead_days: expected.avg_lead_days,
    label:         expected.label,
    lead_day:      expected.lead_day,
    weeks_graded:  expected.weeks_graded,
    fires:         expected.fires,
    adverse_weeks: expected.adverse_weeks,
    tp:            expected.tp,
    fp:            expected.fp,
    fn:            expected.fn,
    tn:            expected.tn,
  })
  assert.equal(sig.accuracy_label, expected.label)

  // … and one grounded sentence per audience, byte-identical to the pure narrator.
  assert.equal(sig.accuracy_note,        narratePulseAccuracy(expected, { label: 'Leads', audience: 'agency' }))
  assert.equal(sig.accuracy_client_note, narratePulseAccuracy(expected, { label: 'Leads', audience: 'client' }))

  // the strings are substantive and audience-shaped: the agency line quantifies the hit
  // rate and lands the verdict; the client line reassures without volunteering a figure.
  assert.match(sig.accuracy_note, /called the week right \d+ of \d+/)
  assert.match(sig.accuracy_note, /proven lead\.$/)
  assert.match(sig.accuracy_client_note, /spotting shifts like this early/)
  assert.ok(!/\d/.test(sig.accuracy_client_note), 'client note carries no raw hit-rate number')
})

test('getClientPulse: a too-thin own-history fires but attaches NO accuracy surface — byte-identical', async () => {
  await ready()
  const c = await freshClient('Thin Record Co')
  // The single-collapse anchor: one sharp latest-week drop over an otherwise flat history.
  // It FIRES hard (critical z), but at the lead day only 1–2 prior weeks ever cross the
  // fire threshold — short of minFires — so the audit is NOT gradeable.
  await seedWeekly(c, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])

  const out = await getClientPulse(c, { asOf: ASOF })
  const sig = out.signals.find(s => s.metric === 'leads')
  assert.ok(sig, 'the collapse still fires a signal')

  // it is genuinely ungradeable on this history …
  const { series } = await loadDailySeries(c, { asOf: ASOF })
  assert.notEqual(pulseAccuracy(series.leads, { window: 7, adverseWhen: 'drop' }).status, 'graded')

  // … so the engine attaches no accuracy surface AT ALL — truly absent, not a zeroed
  // block — preserving byte-identity for clients without a provable record.
  assert.equal(sig.accuracy, undefined)
  assert.equal(sig.accuracy_label, undefined)
  assert.equal(sig.accuracy_note, undefined)
  assert.equal(sig.accuracy_client_note, undefined)
})

// ── getClientPulse × pulseTuning: the self-tuning feedback edge (intel-v7 6b) ─────────
// pulseTuning's own math is exhaustively unit-tested in pulseTuning.test.js. These two
// tests assert only the ENGINE contract: (1) a PROVEN own-history earns a sensitized live
// trigger and the applied band is attached VERBATIM from the pure tuner, while the accuracy
// SURFACE the client/agency reads stays canonical (the loop never eats its own tail), and
// the calibration machinery never reaches a client; (2) an UNGRADED record abstains to the
// canonical band — no calibration surface attached, a provable no-op against the sensor.
test('getClientPulse: a PROVEN own-history earns a SENSITIZED live trigger — the applied band is attached verbatim from the pure tuner, the accuracy surface stays canonical (non-circular), and the machinery never reaches the client', async () => {
  await ready()
  const c = await freshClient('Self-Tuning Co')
  // The SAME sustained daily drop that grades 'proven' (precision 1.0) in the accuracy test
  // above. Proven precision sits ABOVE the 0.70 target, so the controller lowers the live
  // band: a sensor that has called the week right earns a lighter trigger.
  await seedDaily(c, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))

  const out = await getClientPulse(c, { asOf: ASOF })
  const sig = out.signals.find(s => s.metric === 'leads')
  assert.ok(sig, 'the sustained leads drop still fires a signal')

  // Recompute audit + tune from the VERY series the engine loaded. The audit is graded at
  // the CANONICAL band (no warn/crit), exactly as the engine computes it; the tune is its
  // pure consequence. The engine must attach this consequence verbatim — not a re-impl.
  const { series } = await loadDailySeries(c, { asOf: ASOF })
  const expectedAcc = pulseAccuracy(series.leads, { window: 7, adverseWhen: 'drop' })
  const expectedTune = tunePulseThresholds(expectedAcc)

  // the fixture must actually EARN a non-neutral, lighter trigger — else the test is vacuous.
  assert.equal(expectedTune.status, 'tuned')
  assert.equal(expectedTune.direction, 'sensitize')
  assert.ok(expectedTune.factor < 1, 'proven precision lowers the band')

  // the engine attached EXACTLY the curated tuning projection — the moved band, the factor,
  // and the canonical base it scaled from — and nothing more (the 9-key surface contract).
  assert.deepEqual(sig.tuning, {
    status: expectedTune.status,
    factor: expectedTune.factor,
    direction: expectedTune.direction,
    warn: expectedTune.warn,
    crit: expectedTune.crit,
    base_warn: expectedTune.base_warn,
    base_crit: expectedTune.base_crit,
    precision: expectedTune.precision,
    label: expectedTune.label,
  })

  // the band genuinely MOVED below the canonical 2/3, and BOTH legs scaled by the SAME
  // factor — the 2:3 warning/critical shape is preserved, only overall sensitivity shifts.
  assert.ok(sig.tuning.warn < sig.tuning.base_warn && sig.tuning.crit < sig.tuning.base_crit)
  assert.ok(Math.abs(sig.tuning.warn / sig.tuning.base_warn - sig.tuning.factor) < 1e-9)
  assert.ok(Math.abs(sig.tuning.crit / sig.tuning.base_crit - sig.tuning.factor) < 1e-9)

  // one grounded AGENCY sentence, byte-identical to the pure narrator, that lands the verdict.
  assert.equal(sig.tuning_note, narratePulseTuning(expectedTune, { label: 'Leads', audience: 'agency' }))
  assert.match(sig.tuning_note, /earned a lighter trigger\.$/)

  // NON-CIRCULARITY: the accuracy SURFACE is STILL the canonical-band audit — unmoved by the
  // tuning it fed. If the loop ate its own tail, precision/fires would drift off the default
  // band; they must equal pulseAccuracy at the DEFAULT band exactly.
  assert.equal(sig.accuracy.precision, expectedAcc.precision)
  assert.equal(sig.accuracy.label, expectedAcc.label)
  assert.equal(sig.accuracy.fires, expectedAcc.fires)
  assert.equal(sig.accuracy.tp, expectedAcc.tp)
  assert.equal(sig.accuracy.fp, expectedAcc.fp)

  // CLIENT SAFETY: calibration is internal. The pure narrator refuses a client audience
  // outright, and the engine never stamps a client-toned tuning key — the client sees only
  // the EFFECT (an earlier warning), never the dial.
  assert.equal(narratePulseTuning(expectedTune, { label: 'Leads', audience: 'client' }), '')
  assert.equal(sig.tuning_client_note, undefined)
})

test('getClientPulse: an UNGRADED own-history tunes to the canonical band — no calibration surface is attached, and the live trigger is a provable no-op', async () => {
  await ready()
  const c = await freshClient('No Track Record Co')
  // One sharp latest-week collapse over an otherwise flat history (the same anchor the
  // too-thin accuracy case uses). It FIRES hard, but too few prior weeks cross the lead-day
  // fire bar to grade → no precision → the controller earns nothing and abstains.
  await seedWeekly(c, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])

  const out = await getClientPulse(c, { asOf: ASOF })
  const sig = out.signals.find(s => s.metric === 'leads')
  assert.ok(sig, 'the collapse still fires a signal')

  // the record is genuinely ungradeable → the tuner abstains to the canonical band verbatim.
  const { series } = await loadDailySeries(c, { asOf: ASOF })
  const tune = tunePulseThresholds(pulseAccuracy(series.leads, { window: 7, adverseWhen: 'drop' }))
  assert.equal(tune.status, 'default')
  assert.equal(tune.direction, 'neutral')
  assert.equal(tune.warn, 2)
  assert.equal(tune.crit, 3)

  // so NO calibration surface is attached — truly absent, not a neutral block — and because
  // the band handed to dayPulse WAS the canonical 2/3, the live signal is byte-identical to
  // an untuned sensor.
  assert.equal(sig.tuning, undefined)
  assert.equal(sig.tuning_note, undefined)
  assert.equal(sig.tuning_client_note, undefined)
})

// ── 6d: clientSafePulse — the CLIENT-EGRESS machinery strip ───────────────────────
// 6b above proved the ENGINE attaches the self-tuning controller's OUTPUT (sig.tuning +
// the agency-toned sig.tuning_note) to an earned signal and never stamps a client-toned
// variant. 6d proves the COMPLEMENTARY, surface-facing half of the contract: at the
// client-shared GET /:clientId egress the dial is stripped from the WIRE — not merely
// unread by the client UI — while the EFFECT (the live signal already fired at the tuned
// band) rides through whole. The pure helper is tested hermetically first; the end-to-end
// test then runs it over the very proven/sensitized pulse the engine actually produces.
test('clientSafePulse: strips EVERY tuning* key from each signal, leaves all else byte-identical, is pure, and no-ops BY REFERENCE when there is nothing to strip', () => {
  // a tuned signal (the 6b shape) beside an untuned one, carrying the dual-toned observation
  // fields the client surface actually reads — the strip must take the dial and ONLY the dial,
  // including a hypothetical FUTURE tuning_* key (the prefix match is fail-closed).
  const tunedSig = {
    metric: 'leads', label: 'Leads', adverse: true, severity: 'critical', delta_pct: -80,
    message: 'AGENCY: leads cratered', client_message: 'Your leads are well below your usual week.',
    reliability_client_note: 'This alert has held up before.', accuracy_client_note: 'We tend to catch this early.',
    diagnosis: { drivers: [] }, diagnosis_client_message: 'Mostly fewer form fills.',
    triage_client_reason: 'Worth a look today.',
    tuning: { status: 'tuned', factor: 0.9, direction: 'sensitize', warn: 1.8, crit: 2.7, base_warn: 2, base_crit: 3, precision: 0.9, label: 'proven' },
    tuning_note: "Leads early-warnings here have proven out — it's earned a lighter trigger.",
    tuning_debug: { raw: 1 },
  }
  const plainSig = { metric: 'revenue', label: 'Revenue', adverse: false, severity: 'normal', delta_pct: 3, client_message: 'Revenue is right where it usually sits.' }
  const pulse = { as_of: '2026-06-01', window: 7, lookback_days: 63, signals: [tunedSig, plainSig] }

  const safe = clientSafePulse(pulse)

  // a NEW envelope (a strip happened), same scalar envelope fields preserved.
  assert.notEqual(safe, pulse)
  assert.equal(safe.as_of, pulse.as_of)
  assert.equal(safe.window, pulse.window)
  assert.equal(safe.lookback_days, pulse.lookback_days)
  assert.equal(safe.signals.length, 2)

  // the tuned signal: EVERY tuning* key gone (object, note, AND the future-proofed extra),
  // and not one client-readable field disturbed — byte-identical minus the dial.
  const cTuned = safe.signals[0]
  assert.equal(Object.keys(cTuned).some(k => k.startsWith('tuning')), false)
  assert.equal(cTuned.tuning, undefined)
  assert.equal(cTuned.tuning_note, undefined)
  assert.equal(cTuned.tuning_debug, undefined)
  const { tuning, tuning_note, tuning_debug, ...expectedTuned } = tunedSig
  assert.deepEqual(cTuned, expectedTuned)

  // PURITY: the input signal still carries its full machinery — the agency roster reads the
  // same underlying objects and must be unharmed.
  assert.ok(tunedSig.tuning && tunedSig.tuning_note && tunedSig.tuning_debug, 'input untouched')

  // NO-OP BY REFERENCE: an untouched signal is returned as the SAME object (cheap + byte-
  // identical for the common, untuned client) even when a sibling did get stripped.
  assert.equal(safe.signals[1], plainSig)
})

test('clientSafePulse: a null / signal-less / all-untuned pulse passes through verbatim (same reference — a strip allocates only when earned)', () => {
  assert.equal(clientSafePulse(null), null)
  assert.equal(clientSafePulse(undefined), undefined)
  const noSignals = { as_of: '2026-06-01', window: 7 }
  assert.equal(clientSafePulse(noSignals), noSignals)               // signals not an array → untouched
  const emptySignals = { as_of: '2026-06-01', signals: [] }
  assert.equal(clientSafePulse(emptySignals), emptySignals)         // nothing to strip → same ref
  const clean = { signals: [{ metric: 'leads', client_message: 'ok' }, { metric: 'spend', client_message: 'ok' }] }
  assert.equal(clientSafePulse(clean), clean)                        // all-untuned roster → same ref
})

test('clientSafePulse over a PROVEN/sensitized client: the EFFECT (the tuned-band warning) reaches the client envelope while the calibration machinery is stripped from the WIRE', async () => {
  await ready()
  const c = await freshClient('Egress-Safe Tuning Co')
  // the SAME sustained drop that earns a sensitized trigger in the 6b engine test above.
  await seedDaily(c, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))

  // what the AGENCY roster reads (getPortfolioPulse spreads this very per-client result).
  const agencyPulse = await getClientPulse(c, { asOf: ASOF })
  const aSig = agencyPulse.signals.find(s => s.metric === 'leads')
  assert.ok(aSig, 'the sustained drop fires')
  // the sensor was genuinely RETUNED — else the egress test is vacuous.
  assert.ok(aSig.tuning && aSig.tuning.direction === 'sensitize', 'agency carries the earned dial')
  assert.ok(aSig.tuning.warn < aSig.tuning.base_warn, 'the live band actually moved lighter')
  assert.ok(aSig.tuning_note, 'agency carries the why')

  // what GET /:clientId serves.
  const clientPulse = clientSafePulse(agencyPulse)
  const cSig = clientPulse.signals.find(s => s.metric === 'leads')
  assert.ok(cSig, 'the SAME signal reaches the client')

  // EFFECT flows through: this signal already fired at the tuned band, and the client-facing
  // read of it is intact — the grounded sentence, the magnitude, and the foresight note ride.
  assert.equal(cSig.client_message, aSig.client_message)
  assert.ok(cSig.client_message, 'the client gets the grounded warning')
  assert.equal(cSig.severity, aSig.severity)
  assert.equal(cSig.delta_pct, aSig.delta_pct)
  assert.equal(cSig.accuracy_client_note, aSig.accuracy_client_note)

  // MACHINERY stripped WHOLE from the wire: not one tuning* key survives on the client signal.
  assert.equal(Object.keys(cSig).some(k => k.startsWith('tuning')), false)
  assert.equal(cSig.tuning, undefined)
  assert.equal(cSig.tuning_note, undefined)
  assert.equal(cSig.tuning_client_note, undefined)

  // and no client-readable string SMUGGLES the dial: the agency tuning_note text appears
  // nowhere in the serialized client signal.
  assert.equal(JSON.stringify(cSig).includes(aSig.tuning_note), false)

  // PURITY: the agency object the roster still reads is unharmed by the client projection.
  const agencyAfter = agencyPulse.signals.find(s => s.metric === 'leads')
  assert.ok(agencyAfter.tuning && agencyAfter.tuning_note, 'agency machinery intact after the strip')
})

// ── intel-v7 (7b): the morning briefing wired onto BOTH reads ───────────────────
// pulseBriefing.js is unit-tested in full in insights.pulseBriefing.test.js (the helper
// thresholds, the headline===act_today[0] invariant, the count phrasing, the confidence
// split, and the machinery-free client guard). These wiring tests prove only that the
// ENGINE forwards its REAL roster/signals through that module faithfully — the published
// briefing is byte-identical to calling the pure synthesiser over the very roster/signals
// the engine itself published — and that the agency headline can never disagree with the
// act_today feed it sits atop, while the client briefing carries zero machinery and rides
// clientSafePulse through untouched.

test('getPortfolioPulse: publishes a briefing byte-identical to summarizePortfolioPulse over its own roster, whose headline IS act_today[0]', async () => {
  await ready()
  const bCollapse = await freshClient('Briefing Collapse Co')   // critical adverse leads drop
  const bDip      = await freshClient('Briefing Dip Co')         // warning  adverse revenue dip
  const bTailwind = await freshClient('Briefing Tailwind Co')    // leads SPIKE → a NON-adverse tailwind
  await seedWeekly(bCollapse, 'leads',   [20, 90, 100, 110, 95, 105, 100, 98, 102])
  await seedWeekly(bDip,      'revenue', [3500, 5000, 4000, 6000, 4500, 5500, 5000, 4800, 5200])
  await seedWeekly(bTailwind, 'leads',   [220, 100, 98, 102, 99, 101, 100, 103, 97])

  const out = await getPortfolioPulse({ asOf: ASOF })
  assert.ok(out.briefing, 'a briefing rides the portfolio payload')

  // FAITHFUL WIRE: the engine published EXACTLY what the pure synthesiser computes over the
  // roster it ALSO published — not a parallel or stale derivation. summarizePortfolioPulse
  // re-ranks internally (adverse-only, deterministic), so feeding it the published `roster`
  // re-derives the identical briefing the engine built from the raw roster.
  assert.deepEqual(out.briefing, summarizePortfolioPulse(out.roster))

  // THE HEADLINE INVARIANT — the capstone of the whole loop: the "one thing" is, by
  // construction, the top of the SAME reliability-weighted feed the agency already acts
  // from, so the headline can never disagree with the list beneath it.
  assert.deepEqual(out.briefing.headline, out.act_today[0])
  assert.equal(out.briefing.counts.adverse, out.act_today.length)

  // and the synthesis is substantive: my fixture guarantees a non-quiet book, so the
  // briefing is a real 'briefing' with a valid posture, a grounded headline sentence that
  // embeds the lead signal's own triage reason verbatim, and a confidence read on the day.
  assert.equal(out.briefing.status, 'briefing')
  assert.ok(['act', 'watch', 'steady'].includes(out.briefing.posture))
  assert.ok(out.briefing.headline_text.includes(out.act_today[0].triage_reason),
    'the headline sentence carries the lead signal\'s own triage reason')
  assert.ok(['high', 'moderate', 'building', 'n/a'].includes(out.briefing.confidence.label))
})

test('getClientPulse: publishes a client briefing byte-identical to summarizeClientPulse over its own signals, machinery-free even for a tuned client', async () => {
  await ready()
  const c = await freshClient('Briefing Client Co')
  // the PROVEN/sensitized fixture — its signal carries the full machinery (a `tuning` block
  // and a `baseline`): the strongest case for the briefing's client-safety, since it must
  // surface the same metric while leaking none of that dial.
  await seedDaily(c, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))

  const out = await getClientPulse(c, { asOf: ASOF })
  assert.ok(out.briefing, 'a briefing rides the per-client payload')

  // the underlying signal genuinely carries machinery — else the leak guard below is vacuous.
  const sig = out.signals.find(s => s.metric === 'leads')
  assert.ok(sig.tuning && sig.baseline, 'the live signal carries the tuning dial and a baseline')

  // FAITHFUL WIRE: byte-identical to the pure synthesiser over the published signals.
  assert.deepEqual(out.briefing, summarizeClientPulse(out.signals))

  // SHAPE: a real one-sentence briefing whose `focus` exposes EXACTLY the five client-visible
  // fields — no z, no baseline, no tuning_* — the machinery-free contract by construction.
  assert.equal(out.briefing.status, 'briefing')
  assert.ok(out.briefing.headline_text.length > 0)
  assert.deepEqual(Object.keys(out.briefing.focus).sort(),
    ['delta_pct', 'direction', 'label', 'lane', 'metric'])

  // LEAK GUARD: nowhere in the serialized client briefing does the machinery surface — not
  // the tuning dial, not the raw baseline — even though the signal it summarises carries both.
  const wire = JSON.stringify(out.briefing)
  assert.equal(wire.includes('tuning'), false, 'no tuning machinery in the client briefing')
  assert.equal(wire.includes('baseline'), false, 'no raw baseline in the client briefing')
})

test('clientSafePulse: carries the client briefing through untouched — same reference on both the strip and the no-strip path', async () => {
  await ready()
  // (1) a PROVEN/sensitized client → a strip happens (a new envelope is allocated); the
  // briefing sibling must ride that {...pulse} spread through as the SAME object.
  const cTuned = await freshClient('Briefing Egress Tuned Co')
  await seedDaily(cTuned, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))
  const tunedPulse = await getClientPulse(cTuned, { asOf: ASOF })
  const tSig = tunedPulse.signals.find(s => s.metric === 'leads')
  assert.ok(tSig.tuning, 'the tuned signal carries a dial → clientSafePulse will strip and re-allocate')
  const safeTuned = clientSafePulse(tunedPulse)
  assert.notEqual(safeTuned, tunedPulse, 'a strip happened — a new envelope')
  assert.equal(safeTuned.briefing, tunedPulse.briefing, 'the briefing rides the spread as the SAME object')
  assert.ok(safeTuned.briefing && safeTuned.briefing.status, 'and it is intact')

  // (2) a plain collapse client → nothing to strip → clientSafePulse returns the SAME pulse
  // reference, so the briefing is trivially preserved.
  const cPlain = await freshClient('Briefing Egress Plain Co')
  await seedWeekly(cPlain, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])
  const plainPulse = await getClientPulse(cPlain, { asOf: ASOF })
  assert.equal(plainPulse.signals.find(s => s.metric === 'leads').tuning, undefined, 'no dial to strip')
  const safePlain = clientSafePulse(plainPulse)
  assert.equal(safePlain, plainPulse, 'no strip → same pulse reference')
  assert.equal(safePlain.briefing, plainPulse.briefing, 'briefing preserved on the no-strip path')
})

// ============================================================
// MORNING MEMORY — getClientPulse / getPortfolioPulse continuity wiring (intel-v7 8b)
//
// lib/pulseContinuity.js is unit-tested exhaustively in pulseContinuity.test.js; the math
// (firing replay, streak, trend, status, the narrators, the portfolio fold) is proven
// there. These tests prove only that the ENGINE wires it FAITHFULLY:
//
//   • every metric — firing or not — gets a continuity descriptor replayed over the SAME
//     tuned band the live sensor fired on, so back=0 ⇔ today's signal;
//   • the per-client `continuity` sibling is byte-identical to summarizeContinuity over the
//     very items the engine built (focus keyed to the briefing's focus, lane from the
//     published triage), with the two overnight-resolved notes attached;
//   • a metric that fired YESTERDAY and cleared TODAY surfaces as a 'resolved' win even
//     though it never enters `signals`;
//   • the continuity sibling is machinery-free and rides clientSafePulse untouched (the
//     SAME object), exactly like `briefing`;
//   • the portfolio `continuity` is byte-identical to summarizePortfolioContinuity folded
//     over the REAL per-client memories, with the agency narration self-consistent.
//
// Faithful-by-construction: expectedContinuity() re-runs the engine's own fold from the
// loaded series + the engine's PUBLISHED focus/lane, so the assertion can't drift from a
// re-implementation — it IS the wiring, replayed.
// ============================================================

const {
  metricContinuity, summarizeContinuity, narrateContinuity, narrateResolved,
  summarizePortfolioContinuity, narratePortfolioContinuity,
} = require('../lib/pulseContinuity')

// The engine's sum-aggregable flow set, in PULSE_METRICS order (see the file header and
// getClientPulse's loop). Continuity is replayed for each, firing or not.
const PULSE_FLOW = ['revenue', 'leads', 'spend', 'jobs']

// expectedContinuity(clientId, publishedSignals, briefing) — re-derive the per-client
// `continuity` sibling EXACTLY as getClientPulse does (lib/insights.js): load the same daily
// series, and for EVERY flow metric grade its canonical-band precision, tune the band, then
// replay metricContinuity at that tuned band. is_focus is keyed to the engine's OWN published
// briefing.focus.metric and lane to the published signal's lane — the very values the engine
// folded with — so this mirror is the wiring replayed, not a parallel guess. Then fold with
// summarizeContinuity and attach the overnight-resolved notes, just like the engine's tail.
async function expectedContinuity(clientId, publishedSignals, briefing) {
  const { series } = await loadDailySeries(clientId, { asOf: ASOF })
  const focusMetric = briefing && briefing.focus ? briefing.focus.metric : null
  const laneBy = new Map((publishedSignals || []).map((s) => [s.metric, s.lane]))
  const items = PULSE_FLOW.map((m) => {
    const meta = METRIC_META[m]
    const adverseWhen = meta.goodWhenUp ? 'drop' : 'spike'
    const acc  = pulseAccuracy(series[m], { window: 7, adverseWhen })
    const tune = tunePulseThresholds(acc)
    const cont = metricContinuity(series[m], { window: 7, adverseWhen, warn: tune.warn, crit: tune.crit })
    return {
      metric: m,
      label: meta.label,
      is_focus: m === focusMetric,
      lane: laneBy.has(m) ? laneBy.get(m) : null,
      continuity: cont,
    }
  })
  const continuity = summarizeContinuity(items)
  const rNote  = narrateResolved(continuity.resolved, { audience: 'agency' })
  const rcNote = narrateResolved(continuity.resolved, { audience: 'client' })
  if (rNote)  continuity.resolved_note        = rNote
  if (rcNote) continuity.resolved_client_note = rcNote
  return continuity
}

// ── Test A: a PERSISTING firing metric — the sustained, proven collapse ──────────
test('getClientPulse: a sustained collapse is stamped PERSISTING — sig.continuity is the tuned-band replay, the sibling folds it faithfully, and the focus carries the streak machinery-free', async () => {
  await ready()
  const c = await freshClient('Continuity Persist Co')
  // The PROVEN/sensitized fixture: 29 mornings of a leads collapse (idx35..63 = 20 vs a 100
  // baseline). Every sampled morning in memory fires → 'persisting', the streak fills the
  // memory window (capped), and today vs yesterday is flat → 'steady'.
  await seedDaily(c, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))

  const out = await getClientPulse(c, { asOf: ASOF })
  const sig = out.signals.find((s) => s.metric === 'leads')
  assert.ok(sig, 'leads is firing today')

  // FAITHFUL PER-SIGNAL WIRE: sig.continuity is metricContinuity replayed at the metric's OWN
  // tuned band — back=0 is byte-identical to the live signal, by construction.
  const { series } = await loadDailySeries(c, { asOf: ASOF })
  const tune = tunePulseThresholds(pulseAccuracy(series.leads, { window: 7, adverseWhen: 'drop' }))
  const expectedCont = metricContinuity(series.leads, { window: 7, adverseWhen: 'drop', warn: tune.warn, crit: tune.crit })
  assert.deepEqual(sig.continuity, expectedCont)

  // the fixture is doing its job — a real, capped, persisting streak (else the below is vacuous).
  assert.equal(expectedCont.status, 'persisting')
  assert.equal(expectedCont.firing_today, true)
  assert.equal(expectedCont.prev_firing, true)
  assert.equal(expectedCont.streak_capped, true)
  assert.ok(expectedCont.streak >= 2)

  // the two suffix notes are byte-identical to the narrators, one per audience.
  assert.equal(sig.continuity_note,        narrateContinuity(expectedCont, { audience: 'agency' }))
  assert.equal(sig.continuity_client_note, narrateContinuity(expectedCont, { audience: 'client' }))
  assert.match(sig.continuity_note,        /morning running/)
  assert.match(sig.continuity_client_note, /tracking this for/)

  // FAITHFUL SIBLING: the top-level continuity is byte-identical to the engine's own fold.
  assert.deepEqual(out.continuity, await expectedContinuity(c, out.signals, out.briefing))

  // and it says what we expect: leads is the focus, persisting, counted once, nothing new or
  // resolved this morning.
  assert.equal(out.continuity.focus.metric, 'leads')
  assert.equal(out.continuity.focus.status, 'persisting')
  assert.equal(out.continuity.persisting_count, 1)
  assert.equal(out.continuity.new_count, 0)
  assert.deepEqual(out.continuity.resolved, [])

  // the focus exposes EXACTLY the seven client-visible fields — no z, no baseline, no band.
  assert.deepEqual(Object.keys(out.continuity.focus).sort(),
    ['label', 'metric', 'since_back', 'status', 'streak', 'streak_capped', 'trend'])
  const wire = JSON.stringify(out.continuity)
  assert.equal(wire.includes('tuning'), false, 'no tuning machinery in the continuity sibling')
  assert.equal(wire.includes('baseline'), false, 'no raw baseline in the continuity sibling')
})

// ── Test C: a metric that fired YESTERDAY and cleared TODAY → a RESOLVED win ──────
test('getClientPulse: an overnight recovery surfaces as a RESOLVED win — absent from signals, present in continuity.resolved with both grounded notes', async () => {
  await ready()
  const c = await freshClient('Continuity Resolved Co')
  // Alternating 105/95 (a calm ~700 weekly book) with ONE zero on the day that is exclusive
  // to YESTERDAY's trailing window (days-ago 7 = idx56): today's window (idx57..63) is clean
  // ≈ baseline → not firing; yesterday's window (idx56..62) carries the hole → a ~14% drop,
  // |z| ≫ crit → fired. firing = [false, true, …] → 'resolved'.
  const daily = Array.from({ length: 64 }, (_, i) => (i % 2 === 1 ? 105 : 95))
  daily[56] = 0
  await seedDaily(c, 'leads', daily)

  const out = await getClientPulse(c, { asOf: ASOF })

  // it cleared — leads is NOT in the live feed today.
  assert.equal(out.signals.find((s) => s.metric === 'leads'), undefined, 'no live leads signal today')

  // but the morning memory remembers yesterday's alarm: 'resolved'.
  const { series } = await loadDailySeries(c, { asOf: ASOF })
  const tune = tunePulseThresholds(pulseAccuracy(series.leads, { window: 7, adverseWhen: 'drop' }))
  const cont = metricContinuity(series.leads, { window: 7, adverseWhen: 'drop', warn: tune.warn, crit: tune.crit })
  assert.equal(cont.status, 'resolved')
  assert.equal(cont.firing_today, false)
  assert.equal(cont.prev_firing, true)

  // FAITHFUL SIBLING + the resolved win is surfaced with both grounded notes.
  assert.deepEqual(out.continuity, await expectedContinuity(c, out.signals, out.briefing))
  assert.deepEqual(out.continuity.resolved, [{ metric: 'leads', label: 'Leads' }])
  assert.equal(out.continuity.resolved_note,        narrateResolved(out.continuity.resolved, { audience: 'agency' }))
  assert.equal(out.continuity.resolved_client_note, narrateResolved(out.continuity.resolved, { audience: 'client' }))
  assert.match(out.continuity.resolved_note,        /^Resolved since yesterday: leads\.$/)
  assert.match(out.continuity.resolved_client_note, /^Good news —/)

  // a cleared alarm is not "firing": no focus, nothing new or persisting this morning.
  assert.equal(out.continuity.focus, null)
  assert.equal(out.continuity.new_count, 0)
  assert.equal(out.continuity.persisting_count, 0)
})

// ── Test D: the portfolio fold — whole-book memory, faithfully ───────────────────
test('getPortfolioPulse: the portfolio continuity is byte-identical to summarizePortfolioContinuity over the REAL per-client memories, with a self-consistent agency narration', async () => {
  await ready()
  const cPersist  = await freshClient('Book Persist Co')
  const cResolved = await freshClient('Book Resolved Co')
  await seedDaily(cPersist, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))
  const daily = Array.from({ length: 64 }, (_, i) => (i % 2 === 1 ? 105 : 95))
  daily[56] = 0
  await seedDaily(cResolved, 'leads', daily)

  const out = await getPortfolioPulse({ asOf: ASOF })
  assert.ok(out.continuity, 'a continuity aggregate rides the portfolio payload')

  // FAITHFUL WIRE: re-run the engine's OWN loop — every client in the book, same asOf, same
  // per-client call — fold it with summarizePortfolioContinuity, narrate, and the engine's
  // published aggregate must be byte-identical.
  const { rows } = await db.query('SELECT id, name FROM clients')
  const mems = []
  for (const r of rows) {
    try {
      const { continuity } = await getClientPulse(r.id, { asOf: ASOF })
      if (continuity) mems.push({ client_id: String(r.id), client_name: r.name, continuity })
    } catch { /* data-less / brand-new → skip, exactly like the engine */ }
  }
  const agg  = summarizePortfolioContinuity(mems)
  const note = narratePortfolioContinuity(agg)
  assert.deepEqual(out.continuity, note ? { ...agg, note } : agg)

  // my two seeded clients move the book: at least one persisting and one resolved overnight.
  assert.ok(out.continuity.persisting_count >= 1, 'the persisting client is counted')
  assert.ok(out.continuity.resolved_count   >= 1, 'the resolved client is counted')
  assert.ok(out.continuity.clients_resolved >= 1)

  // the resolved roll-up names the client + metric, machinery-free (no z / baseline).
  const mine = out.continuity.resolved.find((r) => r.client_id === String(cResolved) && r.metric === 'leads')
  assert.ok(mine, 'the overnight-resolved client appears in the portfolio resolved list')
  assert.deepEqual(Object.keys(mine).sort(), ['client_id', 'client_name', 'label', 'metric'])

  // the agency narration is self-consistent and reports the overnight wins.
  assert.equal(out.continuity.note, narratePortfolioContinuity(out.continuity))
  assert.match(out.continuity.note, /resolved since yesterday/)
})

// ── Test E: the continuity sibling rides clientSafePulse untouched ───────────────
test('clientSafePulse: carries the continuity sibling through untouched — the SAME object on the strip path, machinery-free, with the tuning dial gone', async () => {
  await ready()
  // (1) a PROVEN/sensitized client → a strip happens (a new envelope is allocated); the
  // continuity sibling must ride that {...pulse} spread through as the SAME object, exactly
  // like briefing, with the agency tuning dial stripped off the signal.
  const cTuned = await freshClient('Continuity Egress Tuned Co')
  await seedDaily(cTuned, 'leads', Array.from({ length: 64 }, (_, i) => (i < 35 ? 100 : 20)))
  const tunedPulse = await getClientPulse(cTuned, { asOf: ASOF })
  const tSig = tunedPulse.signals.find((s) => s.metric === 'leads')
  assert.ok(tSig.tuning, 'the tuned signal carries a dial → clientSafePulse will strip and re-allocate')
  assert.ok(tunedPulse.continuity && tunedPulse.continuity.focus, 'a real continuity sibling rides the tuned pulse')

  const safeTuned = clientSafePulse(tunedPulse)
  assert.notEqual(safeTuned, tunedPulse, 'a strip happened — a new envelope')
  assert.equal(safeTuned.continuity, tunedPulse.continuity, 'the continuity sibling rides the spread as the SAME object')

  // the per-signal continuity + its client note survive the strip; the tuning dial does not.
  const safeSig = safeTuned.signals.find((s) => s.metric === 'leads')
  assert.equal(safeSig.tuning, undefined, 'the agency tuning dial is stripped from the client signal')
  assert.deepEqual(safeSig.continuity, tSig.continuity, 'the per-signal continuity survives untouched')
  assert.equal(safeSig.continuity_client_note, tSig.continuity_client_note, 'the client continuity note survives')

  // machinery-free at the wire — no tuning dial, no raw baseline anywhere in the sibling.
  const cwire = JSON.stringify(safeTuned.continuity)
  assert.equal(cwire.includes('tuning'), false)
  assert.equal(cwire.includes('baseline'), false)

  // (2) a plain collapse client → nothing to strip → clientSafePulse returns the SAME pulse
  // reference, so the continuity sibling is trivially preserved.
  const cPlain = await freshClient('Continuity Egress Plain Co')
  await seedWeekly(cPlain, 'leads', [20, 90, 100, 110, 95, 105, 100, 98, 102])
  const plainPulse = await getClientPulse(cPlain, { asOf: ASOF })
  assert.equal(plainPulse.signals.find((s) => s.metric === 'leads').tuning, undefined, 'no dial to strip')
  const safePlain = clientSafePulse(plainPulse)
  assert.equal(safePlain, plainPulse, 'no strip → same pulse reference')
  assert.equal(safePlain.continuity, plainPulse.continuity, 'continuity preserved on the no-strip path')
})
