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
const { getClientPulse, getPortfolioPulse, loadDailySeries } = require('../lib/insights')

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
