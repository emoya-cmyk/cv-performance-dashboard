// ============================================================
// test/insights.test.js — the autonomous intelligence engine (lib/insights.js).
//
// Two halves:
//   1. PURE detection brain — detectFindings() over hand-built weekly series,
//      with no DB / no clock / no network. Pins each finding kind (anomaly,
//      trend, forecast, pacing, data_health), BOTH suppression rules
//      (anomaly ⊳ trend, forecast ⊳ pacing), the "stay quiet when nothing is
//      unusual" contract, fingerprint stability, and that every number in a
//      title/detail traces back to the evidence pack.
//   2. PERSISTENCE — runInsightsForClient() end to end against an isolated temp
//      SQLite DB: writes the insight feed + the baselines cache, is idempotent on
//      the fingerprint, and EXPIRES findings whose condition has cleared. Plus the
//      read+sort path (getOpenInsights) and the empty-client no-op.
//
// ANTHROPIC_API_KEY is deleted up front so narration takes the deterministic
// template branch (grounded by construction) — no network. Run with:  npm test
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// No key → deterministic template narration, no network.
delete process.env.ANTHROPIC_API_KEY

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `insights_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { verifyGrounding } = require('../lib/ai')
const {
  detectFindings, fingerprintOf, titleFor, templateDetailFor,
  recommendedAction, isAdverse,
  runInsightsForClient, upsertInsight, getOpenInsights, normalizeInsightRow,
  // self-tuning loop: lock in a projection → grade it once the month closes →
  // roll the graded history into this client's learned forecast calibration.
  loadMonthTotals, snapshotForecast, gradeDueForecasts,
  deriveAndPersistCalibration, loadCalibration,
  // feed (read) + lifecycle (write) + portfolio roll-up + autonomous portfolio sweep.
  getInsightFeed, getPortfolioInsights, setInsightStatus,
  ackInsight, resolveInsight, runInsightsForAll,
} = require('../lib/insights')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `expected ${a} ≈ ${b}`)

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── helpers ─────────────────────────────────────────────────────────────────
let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

let seq = 0
async function freshClient(name) {
  const id = `insights-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}

async function seedWeek(clientId, weekStart, w = {}) {
  await db.query(
    `INSERT INTO weekly_reports
       (client_id, week_start, ads_spend, lsa_spend, meta_spend, raw_leads, closed_won, projected_revenue)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [clientId, weekStart, w.ads_spend || 0, w.lsa_spend || 0, w.meta_spend || 0,
     w.raw_leads || 0, w.closed_won || 0, w.projected_revenue || 0]
  )
}

async function allInsights(clientId) {
  const { rows } = await db.query(`SELECT * FROM insights WHERE client_id = $1`, [clientId])
  return rows.map(normalizeInsightRow)
}
async function baselineRows(clientId) {
  const { rows } = await db.query(`SELECT * FROM metric_baselines WHERE client_id = $1`, [clientId])
  return rows
}

// A month's goal row (loadGoal reads client_goals keyed by month = 'YYYY-MM-01').
async function seedGoal(clientId, month, g = {}) {
  await db.query(
    `INSERT INTO client_goals (client_id, month, revenue_target, leads_target, jobs_target)
     VALUES ($1,$2,$3,$4,$5)`,
    [clientId, month, g.revenue_target ?? null, g.leads_target ?? null, g.jobs_target ?? null]
  )
}
// The self-tuning ledger + learned calibration, read straight from the tables.
async function gradeRows(clientId) {
  const { rows } = await db.query(
    `SELECT * FROM forecast_grades WHERE client_id = $1 ORDER BY month, metric`, [clientId])
  return rows
}
async function calibrationRows(clientId) {
  const { rows } = await db.query(
    `SELECT * FROM metric_calibration WHERE client_id = $1 ORDER BY metric`, [clientId])
  return rows
}

// Eight consecutive Mondays ending 2026-05-04 (oldest → newest).
const MONDAYS = [
  '2026-03-16', '2026-03-23', '2026-03-30', '2026-04-06',
  '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04',
]
const seriesOf = (weeks, key, values) =>
  values.map((v, i) => ({ week_start: weeks[i], [key]: v }))

// ============================================================
// 1. PURE DETECTION BRAIN
// ============================================================

test('anomaly: a spike is flagged critical/up and suppresses a redundant trend', () => {
  // Calm noisy history (so the band is non-zero), then a 6× spike.
  const series = seriesOf(MONDAYS.slice(2), 'revenue', [780, 820, 790, 810, 800, 5000])
  const out = detectFindings(series, { asOf: '2026-05-06' })

  // Exactly one finding for revenue, and it's the anomaly — the trend that the
  // same spike would also produce is suppressed so we don't double-report it.
  assert.equal(out.length, 1)
  const a = out[0]
  assert.equal(a.kind, 'anomaly')
  assert.equal(a.metric, 'revenue')
  assert.equal(a.severity, 'critical')
  assert.equal(a.direction, 'up')
  assert.equal(a.evidence.latest, 5000)
  assert.equal(a.evidence.baseline, 800)          // median of the prior 5 weeks
  assert.ok(a.score > 3, 'robust z is well past the critical threshold')
})

test('trend: a sustained noisy drift surfaces as a trend (no anomaly on that metric)', () => {
  // Rising but jittery enough that the latest point stays inside the band — so
  // it is NOT an anomaly, but the multi-week slope still registers.
  const series = seriesOf(MONDAYS, 'leads', [50, 90, 70, 110, 90, 130, 110, 140])
  const out = detectFindings(series, { asOf: '2026-05-06' })

  const trend = out.find(f => f.kind === 'trend' && f.metric === 'leads')
  assert.ok(trend, 'an upward leads trend is detected')
  assert.equal(trend.direction, 'up')
  assert.equal(trend.severity, 'info')            // ~11.8%/wk → info band [8,15)
  assert.equal(trend.evidence.weeks, 8)
  // The latest week is unremarkable on its own → no anomaly competes with it.
  assert.equal(out.some(f => f.kind === 'anomaly' && f.metric === 'leads'), false)
})

test('pacing: month-to-date far below a goal is flagged behind pace', () => {
  const series = [
    { week_start: '2026-05-04', revenue: 500 },
    { week_start: '2026-05-11', revenue: 500 },
  ]
  // Day 20 of 31 → run-rate 1000/(20/31) ≈ 1550 vs a 5000 target → critically behind.
  const out = detectFindings(series, { goal: { revenue_target: 5000 }, asOf: '2026-05-20' })

  assert.equal(out.length, 1)
  const p = out[0]
  assert.equal(p.kind, 'pacing')
  assert.equal(p.metric, 'revenue')
  assert.equal(p.severity, 'critical')
  assert.equal(p.direction, 'down')
  assert.equal(p.evidence.mtd, 1000)
  assert.equal(p.evidence.target, 5000)
  assert.equal(p.evidence.pct, 20)                // 1000 / 5000
})

test('forecast: a trend landing far below goal fires a grounded critical forecast', () => {
  // Flat $1k/wk for six weeks — enough history (≥5) to project. As of day 17 of
  // 31, two weeks count this month (mtd $2000) and 14 days remain → the trend
  // values those two remaining weeks at $1000/wk = $2000, landing at $4000:
  // exactly half of an $8000 goal → critical.
  const weeks  = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  const series = seriesOf(weeks, 'revenue', [1000, 1000, 1000, 1000, 1000, 1000])
  const out    = detectFindings(series, { goal: { revenue_target: 8000 }, asOf: '2026-05-17' })

  assert.equal(out.length, 1)
  const f = out[0]
  assert.equal(f.kind, 'forecast')
  assert.equal(f.metric, 'revenue')
  assert.equal(f.severity, 'critical')
  assert.equal(f.direction, 'down')
  assert.equal(f.score, 50)                        // |1 − 0.5| × 100
  assert.equal(f.evidence.mtd, 2000)
  assert.equal(f.evidence.target, 8000)
  assert.equal(f.evidence.projected_total, 4000)   // 2000 mtd + 1000/wk × 2 wks
  assert.equal(f.evidence.pct_of_target, 50)
  assert.equal(f.evidence.weekly_rate, 1000)
  assert.equal(f.evidence.days_elapsed, 17)
  assert.equal(f.evidence.days_in_month, 31)
  // Forecast OWNS the metric → the naive pacing alarm for revenue is suppressed.
  assert.equal(out.some(x => x.kind === 'pacing'), false)

  // Title + detail are grounded by construction — every figure is in evidence.
  const text = `${titleFor(f)} ${templateDetailFor(f)}`
  const { grounded, offending } = verifyGrounding(text, { values: f.evidence })
  assert.equal(grounded, true, `ungrounded tokens: ${offending.join(', ')}`)
})

test('forecast ⊳ pacing: an on-track projection silences the naive behind-pace alarm', () => {
  // CONTROL — only the two in-month weeks, no history to forecast from. Naive
  // pacing fires: mtd $2000 on day 24 of 31 → run-rate ~$2583 vs a $3000 goal,
  // ~86% → behind-pace warning.
  const inMonthOnly = [
    { week_start: '2026-05-04', revenue: 1000 },
    { week_start: '2026-05-11', revenue: 1000 },
  ]
  const control = detectFindings(inMonthOnly, { goal: { revenue_target: 3000 }, asOf: '2026-05-24' })
  assert.equal(control.length, 1)
  assert.equal(control[0].kind, 'pacing')
  assert.equal(control[0].severity, 'warning')

  // SAME in-month data, now with four prior weeks of flat $1k history. The
  // forecast can project ($2000 mtd + $1000 for the one remaining week = $3000,
  // exactly the goal → on track), so it OWNS revenue: the behind-pace warning
  // above is suppressed and the on-track forecast itself stays quiet. The feed
  // goes silent instead of crying a false alarm.
  const withHistory = [
    { week_start: '2026-04-06', revenue: 1000 },
    { week_start: '2026-04-13', revenue: 1000 },
    { week_start: '2026-04-20', revenue: 1000 },
    { week_start: '2026-04-27', revenue: 1000 },
    { week_start: '2026-05-04', revenue: 1000 },
    { week_start: '2026-05-11', revenue: 1000 },
  ]
  const out = detectFindings(withHistory, { goal: { revenue_target: 3000 }, asOf: '2026-05-24' })
  assert.equal(out.some(f => f.kind === 'pacing'), false, 'pacing suppressed by forecast')
  assert.equal(out.some(f => f.kind === 'forecast'), false, 'on-track forecast stays quiet')
  assert.deepEqual(out, [])
})

test('data_health: a stale feed surfaces as a reconnect signal', () => {
  // Latest data is 2026-04-13; as of 2026-05-20 the freshest completed week is
  // 2026-05-11 → 4 weeks behind → critical "reconnect the source".
  const series = [
    { week_start: '2026-04-06', revenue: 800 },
    { week_start: '2026-04-13', revenue: 810 },
  ]
  const out = detectFindings(series, { asOf: '2026-05-20' })

  assert.equal(out.length, 1)
  const d = out[0]
  assert.equal(d.kind, 'data_health')
  assert.equal(d.metric, null)
  assert.equal(d.severity, 'critical')
  assert.equal(d.evidence.weeks_behind, 4)
  assert.equal(d.period_start, '2026-04-13')
  assert.match(titleFor(d), /reconnect the source/i)
})

test('quiet client: in-band, fresh, no goal → no findings at all', () => {
  const series = seriesOf(MONDAYS.slice(2), 'revenue', [800, 810, 790, 805, 800, 802])
  const out = detectFindings(series, { asOf: '2026-05-06' })
  assert.deepEqual(out, [])
})

test('detectFindings never throws on empty / garbage input', () => {
  assert.deepEqual(detectFindings([], { asOf: '2026-05-06' }), [])
  assert.deepEqual(detectFindings(null, {}), [])
  assert.deepEqual(detectFindings(undefined), [])
})

test('fingerprint: stable per identity, distinct across kind / metric / client / period', () => {
  const f = { scope: 'client', kind: 'anomaly', metric: 'revenue', period_start: '2026-05-04' }
  assert.equal(fingerprintOf('c1', f), fingerprintOf('c1', { ...f }))           // stable
  assert.notEqual(fingerprintOf('c1', f), fingerprintOf('c1', { ...f, metric: 'leads' }))
  assert.notEqual(fingerprintOf('c1', f), fingerprintOf('c1', { ...f, kind: 'trend' }))
  assert.notEqual(fingerprintOf('c1', f), fingerprintOf('c1', { ...f, period_start: '2026-04-27' }))
  assert.notEqual(fingerprintOf('c1', f), fingerprintOf('c2', f))               // per-client
})

test('grounding: every number in a generated title + detail traces to the evidence', () => {
  // Reuse the anomaly finding; both the deterministic title and template detail
  // must be grounded — no figure that is not in the evidence pack.
  const series = seriesOf(MONDAYS.slice(2), 'revenue', [780, 820, 790, 810, 800, 5000])
  const f = detectFindings(series, { asOf: '2026-05-06' })[0]
  const text = `${titleFor(f)} ${templateDetailFor(f)}`
  const { grounded, offending } = verifyGrounding(text, { values: f.evidence })
  assert.equal(grounded, true, `ungrounded tokens: ${offending.join(', ')}`)
})

// ============================================================
// 2. PERSISTENCE + LIFECYCLE
// ============================================================

test('runInsightsForClient persists the feed + baselines and is idempotent', async () => {
  await ready()
  const c = await freshClient('Anomaly Roofing Co')
  const weeks = MONDAYS.slice(2)
  const rev = [780, 820, 790, 810, 800, 5000]
  for (let i = 0; i < weeks.length; i++) await seedWeek(c, weeks[i], { projected_revenue: rev[i] })

  const run1 = await runInsightsForClient(c, { asOf: '2026-05-06' })
  assert.equal(run1.count, 1)

  const rows1 = await allInsights(c)
  assert.equal(rows1.length, 1)
  const ins = rows1[0]
  assert.equal(ins.kind, 'anomaly')
  assert.equal(ins.metric, 'revenue')
  assert.equal(ins.severity, 'critical')
  assert.equal(ins.status, 'open')
  assert.equal(ins.grounded, true)                 // normalized boolean (SQLite 0/1)
  assert.equal(typeof ins.evidence, 'object')      // normalized from TEXT
  assert.equal(ins.evidence.latest, 5000)

  // Baselines cached for every metric that had data; revenue carries the full-
  // series profile (n = 6 weeks, latest = 5000).
  const base = await baselineRows(c)
  const revBase = base.find(b => b.metric === 'revenue')
  assert.ok(revBase)
  assert.equal(Number(revBase.n), 6)
  assert.equal(Number(revBase.latest), 5000)

  // Re-running the same sweep refreshes the SAME row in place — no duplicate.
  const run2 = await runInsightsForClient(c, { asOf: '2026-05-06' })
  assert.equal(run2.count, 1)
  const rows2 = await allInsights(c)
  assert.equal(rows2.length, 1)
  assert.equal(rows2[0].status, 'open')
})

test('a finding whose condition clears is expired on the next sweep', async () => {
  await ready()
  const c = await freshClient('Recover Roofing Co')

  // Run 1: only two old weeks → the feed is stale → one critical data_health.
  await seedWeek(c, '2026-04-06', { projected_revenue: 800 })
  await seedWeek(c, '2026-04-13', { projected_revenue: 800 })
  await runInsightsForClient(c, { asOf: '2026-05-20' })
  let rows = await allInsights(c)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'data_health')
  assert.equal(rows[0].status, 'open')

  // Run 2: fresh weeks land (all flat → no new findings) and the data is current
  // as of 2026-05-18 → the data_health condition no longer holds → expired.
  for (const wk of ['2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']) {
    await seedWeek(c, wk, { projected_revenue: 800 })
  }
  const run2 = await runInsightsForClient(c, { asOf: '2026-05-18' })
  assert.equal(run2.count, 0)

  rows = await allInsights(c)
  assert.equal(rows.length, 1)                      // same row, not a new one
  assert.equal(rows[0].kind, 'data_health')
  assert.equal(rows[0].status, 'expired')           // closed out automatically
  assert.deepEqual(await getOpenInsights(c), [])    // no longer in the open feed
})

test('getOpenInsights returns open rows sorted critical → warning → info', async () => {
  await ready()
  const c = await freshClient('Sort Roofing Co')
  const stamp = new Date().toISOString()
  const mk = (kind, metric, severity, score, period) =>
    ({ scope: 'client', kind, metric, severity, direction: 'up', score, period_start: period, evidence: { x: 1 } })
  const narr = (title) => ({ title, detail: 'd', model: 'template', grounded: true, stampIso: stamp })

  await upsertInsight(c, mk('trend',   'leads',   'info',     5, '2026-05-04'),
    { ...narr('info one'),  fingerprint: `fp-info-${c}` })
  await upsertInsight(c, mk('anomaly', 'revenue', 'critical', 9, '2026-05-04'),
    { ...narr('crit one'),  fingerprint: `fp-crit-${c}` })
  await upsertInsight(c, mk('pacing',  'jobs',    'warning',  7, '2026-05-01'),
    { ...narr('warn one'),  fingerprint: `fp-warn-${c}` })

  const open = await getOpenInsights(c)
  assert.deepEqual(open.map(r => r.severity), ['critical', 'warning', 'info'])
  assert.equal(open[0].grounded, true)              // normalized boolean
  assert.equal(typeof open[0].evidence, 'object')   // normalized from TEXT

  // Same fingerprint upserts in place (title refreshed), never duplicates.
  await upsertInsight(c, mk('anomaly', 'revenue', 'critical', 9, '2026-05-04'),
    { ...narr('crit refreshed'), fingerprint: `fp-crit-${c}` })
  const open2 = await getOpenInsights(c)
  assert.equal(open2.length, 3)
  assert.equal(open2[0].title, 'crit refreshed')
})

test('runInsightsForClient on a data-less client is a safe no-op', async () => {
  await ready()
  const c = await freshClient('Empty Roofing Co')
  const res = await runInsightsForClient(c, { asOf: '2026-05-06' })
  assert.equal(res.count, 0)
  assert.deepEqual(await allInsights(c), [])
  assert.deepEqual(await baselineRows(c), [])
})

// ============================================================
// 3. SELF-TUNING LOOP (DB-backed) — the market-is-teacher cycle
//    snapshot → grade (model vs naive vs realized) → derive calibration → read back.
//    This is the half that makes the engine self-IMPROVING with no operator: it
//    grades its own published projections against reality and re-tunes the next
//    sweep's forecast gates + bias-correction from the result.
// ============================================================

test('self-tuning: closed projections are graded model-vs-naive-vs-actual, then learned as calibration', async () => {
  await ready()
  const c = await freshClient('Learning Roofing Co')

  // Two CLOSED months of real revenue (additive over the month's weeks):
  //   Feb 2026 — four Mondays × $1000 = $4000 realized
  //   Mar 2026 — five  Mondays × $1000 = $5000 realized
  // Plus one APRIL week that must NOT leak into either month total — this guards
  // the month-boundary math in loadMonthTotals (the [monthFirst, monthLast] window).
  for (const wk of ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23'])
    await seedWeek(c, wk, { projected_revenue: 1000 })
  for (const wk of ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30'])
    await seedWeek(c, wk, { projected_revenue: 1000 })
  await seedWeek(c, '2026-04-06', { projected_revenue: 9999 })   // out-of-window guard

  // loadMonthTotals isolates each month — April's $9999 leaks into neither.
  assert.equal((await loadMonthTotals(c, '2026-02-01')).revenue, 4000)
  assert.equal((await loadMonthTotals(c, '2026-03-01')).revenue, 5000)

  // Lock in each month's published projection with honest forward lead time. Both
  // are deliberately +10% hot and both BEAT their naive run-rate by the same margin.
  await snapshotForecast(c, { metric: 'revenue', monthFirst: '2026-02-01', projectedTotal: 4400, naiveProjected: 3600, target: 5000 }, '2026-02-05')
  await snapshotForecast(c, { metric: 'revenue', monthFirst: '2026-03-01', projectedTotal: 5500, naiveProjected: 4500, target: 6000 }, '2026-03-05')

  // Grade everything now closed (asOf in May → both Feb and Mar are due).
  const { graded } = await gradeDueForecasts(c, { asOf: '2026-05-15' })
  assert.equal(graded, 2)

  const g   = await gradeRows(c)
  const feb = g.find(r => String(r.month).startsWith('2026-02'))
  const mar = g.find(r => String(r.month).startsWith('2026-03'))
  // Feb: projected 4400 vs actual 4000 → 10% over; naive 3600 also 10% off → tie,
  // and a tie counts as a model win (the smarter method isn't penalised).
  approx(feb.actual_total, 4000)
  approx(feb.abs_pct_error, 0.1)          // |4400-4000|/4000
  approx(feb.naive_abs_pct_error, 0.1)    // |3600-4000|/4000
  approx(feb.bias, 0.1)                    // signed: over-projected
  assert.equal(Number(feb.model_won), 1)
  // Mar: projected 5500 vs actual 5000 → same 10% over, same tie-win.
  approx(mar.actual_total, 5000)
  approx(mar.abs_pct_error, 0.1)
  approx(mar.bias, 0.1)
  assert.equal(Number(mar.model_won), 1)

  // Derive + persist calibration from the two graded months. samples 2 ≥ the floor
  // → a REAL (non-neutral) calibration: mape 0.1, win-rate 1, bias +0.1.
  //   trust       = 0.6·skill(0.8) + 0.4·win(1)            = 0.88
  //   warn_ratio  = lerp(0.85, 0.92, 0.88)                 = 0.912  (tighter than 0.9 default)
  //   crit_ratio  = lerp(0.60, 0.75, 0.88)                 = 0.732  (tighter than 0.7 default)
  //   bias_factor = 1 + (1/1.1 − 1)·conf(2/4)              = 0.955  (pull hot projections DOWN)
  const cal = await deriveAndPersistCalibration(c, '2026-05-15T00:00:00.000Z')
  assert.equal(cal.revenue.samples, 2)
  approx(cal.revenue.trust, 0.88)
  approx(cal.revenue.warn_ratio, 0.912)
  approx(cal.revenue.crit_ratio, 0.732)
  approx(cal.revenue.bias_factor, 0.955)
  approx(cal.revenue.mape, 0.1)
  assert.ok(cal.revenue.bias_factor < 1, 'a hot track record is corrected DOWNWARD')

  // The readback the next sweep consumes matches what we just derived + persisted.
  const loaded = await loadCalibration(c)
  assert.equal(loaded.revenue.samples, 2)
  approx(loaded.revenue.warn_ratio, 0.912)
  approx(loaded.revenue.crit_ratio, 0.732)
  approx(loaded.revenue.bias_factor, 0.955)
  approx(loaded.revenue.trust, 0.88)
  // exactly one persisted calibration row for this client.
  assert.equal((await calibrationRows(c)).length, 1)
})

test('self-tuning: a learned bias-correction changes the published forecast verdict', async () => {
  // Flat $1k/wk × 6 → raw landing $4000 against an $8000 goal. With NO calibration
  // that is 50% of plan → a hard "critical". Feed the SAME series this client's
  // learned calibration (it has been running 50% HOT, so bias_factor 1.5 pulls the
  // projection UP toward where its numbers actually land) and the published landing
  // becomes $6000 = 75% of plan → the verdict softens to "warning". Same data, a
  // different — and earned — conclusion: the calibration READ path end to end.
  const weeks  = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  const series = seriesOf(weeks, 'revenue', [1000, 1000, 1000, 1000, 1000, 1000])

  const base = detectFindings(series, { goal: { revenue_target: 8000 }, asOf: '2026-05-17' })
  const f0   = base.find(f => f.kind === 'forecast' && f.metric === 'revenue')
  assert.equal(f0.severity, 'critical')
  assert.equal(f0.evidence.projected_total, 4000)
  assert.equal(f0.evidence.pct_of_target, 50)

  const tuned = detectFindings(series, {
    goal: { revenue_target: 8000 }, asOf: '2026-05-17',
    calibration: { forecast: { revenue: { bias_factor: 1.5, warn_ratio: 0.9, crit_ratio: 0.7 } } },
  })
  const f1 = tuned.find(f => f.kind === 'forecast' && f.metric === 'revenue')
  assert.equal(f1.severity, 'warning')              // 6000/8000 = 0.75 → between crit .7 and warn .9
  assert.equal(f1.evidence.projected_total, 6000)   // 4000 × bias_factor 1.5
  assert.equal(f1.evidence.pct_of_target, 75)
})

test('self-tuning: snapshots are insert-once and grading is idempotent', async () => {
  await ready()
  const c = await freshClient('Idempotent Roofing Co')
  for (const wk of ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30'])
    await seedWeek(c, wk, { projected_revenue: 1000 })          // Mar realized $5000

  // First snapshot wins; a second (wiser, nearer-the-end) guess for the SAME
  // client/metric/month is silently dropped — honest forward lead time is preserved.
  await snapshotForecast(c, { metric: 'revenue', monthFirst: '2026-03-01', projectedTotal: 5500, naiveProjected: 4500, target: 6000 }, '2026-03-05')
  await snapshotForecast(c, { metric: 'revenue', monthFirst: '2026-03-01', projectedTotal: 9999, naiveProjected: 1,    target: 1    }, '2026-03-28')
  let g = await gradeRows(c)
  assert.equal(g.length, 1)
  approx(g[0].projected_total, 5500)                  // the FIRST snapshot, not the overwrite
  approx(g[0].target, 6000)

  // Grade once → the row gets its realized actual + error decomposition.
  const r1 = await gradeDueForecasts(c, { asOf: '2026-05-15' })
  assert.equal(r1.graded, 1)
  g = await gradeRows(c)
  approx(g[0].actual_total, 5000)
  approx(g[0].abs_pct_error, 0.1)                     // |5500-5000|/5000

  // Grade AGAIN → nothing re-grades (actual_total IS NOT NULL guard) and the row
  // is untouched. The sweep is safe to run on any cadence.
  const r2 = await gradeDueForecasts(c, { asOf: '2026-05-15' })
  assert.equal(r2.graded, 0)
  g = await gradeRows(c)
  assert.equal(g.length, 1)
  approx(g[0].actual_total, 5000)
  approx(g[0].abs_pct_error, 0.1)
})

test('self-tuning: runInsightsForClient locks in THIS month for later grading without grading it early', async () => {
  await ready()
  const c = await freshClient('Wiring Roofing Co')
  await seedGoal(c, '2026-05-01', { revenue_target: 8000 })
  const weeks = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  for (const wk of weeks) await seedWeek(c, wk, { projected_revenue: 1000 })

  // A real sweep mid-May: it surfaces the critical forecast AND locks in the
  // current month's published projection ($4000, bias-neutral — no history yet).
  const run1 = await runInsightsForClient(c, { asOf: '2026-05-17' })
  assert.ok(run1.findings.some(f => f.kind === 'forecast' && f.metric === 'revenue'),
    'the sweep surfaces the revenue forecast')

  let g = await gradeRows(c)
  assert.equal(g.length, 1)
  assert.equal(g[0].metric, 'revenue')
  assert.equal(String(g[0].month).slice(0, 10), '2026-05-01')
  assert.equal(g[0].actual_total, null)               // May is still OPEN → not graded
  approx(g[0].projected_total, 4000)                   // bias_factor neutral (no calibration)
  assert.equal(String(g[0].as_of).slice(0, 10), '2026-05-17')

  // A later sweep the SAME month must not overwrite the first lead-time snapshot,
  // and must still not grade the (open) current month.
  await runInsightsForClient(c, { asOf: '2026-05-24' })
  g = await gradeRows(c)
  assert.equal(g.length, 1)                            // insert-once held across sweeps
  approx(g[0].projected_total, 4000)                   // the 05-17 snapshot, not a 05-24 re-guess
  assert.equal(g[0].actual_total, null)               // still open → still ungraded
})

// ============================================================
// 4. FEED · LIFECYCLE · PORTFOLIO · AUTONOMOUS SWEEP
//    The live read+write surface the Intelligence UI and the nightly scheduler
//    drive. The contract that makes the layer self-sustaining: a human's ack/
//    resolve is permanent (re-sweeps never overwrite it), yet reality can still
//    auto-close an acknowledged finding — so nothing rots in the feed untouched.
// ============================================================

// Build a bare finding + its template narration. Local to this section (mirrors
// the helpers the getOpenInsights sort test defines inline).
const FEED_STAMP = new Date().toISOString()
const mkFinding = (kind, metric, severity, score, period = '2026-05-04') =>
  ({ scope: 'client', kind, metric, severity, direction: 'up', score, period_start: period, evidence: { x: 1 } })
const mkNarr = (title) => ({ title, detail: 'd', model: 'template', grounded: true, stampIso: FEED_STAMP })
async function idForFingerprint(fp) {
  const { rows } = await db.query(`SELECT id FROM insights WHERE fingerprint = $1`, [fp])
  return rows.length ? rows[0].id : null
}

test('feed: acknowledge keeps a finding (muted, sunk below open); resolve drops it', async () => {
  await ready()
  const c = await freshClient('Lifecycle Roofing Co')

  // One critical, two same-severity warnings (scores 8 then 7), one info.
  await upsertInsight(c, mkFinding('anomaly', 'revenue', 'critical', 9), { ...mkNarr('crit'),  fingerprint: `fp-c-${c}` })
  await upsertInsight(c, mkFinding('pacing',  'jobs',    'warning',  8), { ...mkNarr('warnA'), fingerprint: `fp-wa-${c}` })
  await upsertInsight(c, mkFinding('pacing',  'leads',   'warning',  7), { ...mkNarr('warnB'), fingerprint: `fp-wb-${c}` })
  await upsertInsight(c, mkFinding('trend',   'leads',   'info',     5), { ...mkNarr('info'),  fingerprint: `fp-i-${c}` })

  // Fresh feed: severity DESC, then score DESC within a tier → warnA(8) ahead of warnB(7).
  const feed0 = await getInsightFeed(c)
  assert.deepEqual(feed0.map(r => r.title),  ['crit', 'warnA', 'warnB', 'info'])
  assert.deepEqual(feed0.map(r => r.status), ['open', 'open', 'open', 'open'])

  // Acknowledge the HIGHER-scored warning. It stays in the feed but sinks below the
  // still-open warnB despite warnB's lower score — active status outranks score.
  const acked = await ackInsight(await idForFingerprint(`fp-wa-${c}`))
  assert.equal(acked.status, 'acknowledged')
  assert.equal(acked.title, 'warnA')
  assert.equal(acked.grounded, true)                 // normalized boolean (SQLite 0/1)
  assert.equal(typeof acked.evidence, 'object')      // normalized from TEXT

  const feed1 = await getInsightFeed(c)
  assert.equal(feed1.length, 4)                      // ack does NOT drop it
  assert.deepEqual(feed1.map(r => r.title),  ['crit', 'warnB', 'warnA', 'info'])
  assert.deepEqual(feed1.map(r => r.status), ['open', 'open', 'acknowledged', 'open'])

  // Resolve the info finding → it leaves the feed entirely (terminal).
  const resolved = await resolveInsight(await idForFingerprint(`fp-i-${c}`))
  assert.equal(resolved.status, 'resolved')

  const feed2 = await getInsightFeed(c)
  assert.deepEqual(feed2.map(r => r.title), ['crit', 'warnB', 'warnA'])
  assert.ok(!feed2.some(r => r.title === 'info'), 'a resolved finding is gone from the feed')

  // The resolved row still exists in the table — just not in the active feed.
  const all = await allInsights(c)
  assert.equal(all.find(r => r.title === 'info').status, 'resolved')

  // setInsightStatus on an unknown id is a clean null (the route turns this into 404).
  assert.equal(await setInsightStatus(999999, 'resolved'), null)
})

test('portfolio: getPortfolioInsights spans clients, tags client_name, ranks by severity', async () => {
  await ready()
  const a = await freshClient('Alpha Roofing Co')
  const b = await freshClient('Bravo Roofing Co')
  await upsertInsight(a, mkFinding('pacing',  'jobs',    'warning',  6), { ...mkNarr('a-warn'), fingerprint: `fp-aw-${a}` })
  await upsertInsight(b, mkFinding('anomaly', 'revenue', 'critical', 9), { ...mkNarr('b-crit'), fingerprint: `fp-bc-${b}` })

  const port = await getPortfolioInsights()
  const aRow = port.find(r => r.title === 'a-warn')
  const bRow = port.find(r => r.title === 'b-crit')
  assert.ok(aRow && bRow, 'the portfolio stream spans both clients')
  assert.equal(aRow.client_name, 'Alpha Roofing Co')   // the JOINed name rides along
  assert.equal(bRow.client_name, 'Bravo Roofing Co')

  // Across the whole portfolio, b's critical sorts ahead of a's warning.
  assert.ok(port.indexOf(bRow) < port.indexOf(aRow), 'critical ranks ahead of warning portfolio-wide')

  // Resolving a finding pulls it from the portfolio stream too.
  await resolveInsight(await idForFingerprint(`fp-aw-${a}`))
  const port2 = await getPortfolioInsights()
  assert.ok(!port2.some(r => r.title === 'a-warn'), 'a resolved finding leaves the portfolio feed')
})

test('feed: an acknowledged finding still auto-expires once its condition clears', async () => {
  await ready()
  const c = await freshClient('Onit Roofing Co')

  // Run 1: two stale weeks → one open data_health.
  await seedWeek(c, '2026-04-06', { projected_revenue: 800 })
  await seedWeek(c, '2026-04-13', { projected_revenue: 800 })
  await runInsightsForClient(c, { asOf: '2026-05-20' })
  let rows = await allInsights(c)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'data_health')

  // A human acknowledges it ("we're on the data gap") — it stays in the feed, muted.
  const acked = await ackInsight(rows[0].id)
  assert.equal(acked.status, 'acknowledged')
  assert.equal((await getInsightFeed(c)).length, 1)    // acknowledged ⇒ still visible

  // Run 2: fresh weeks land, the data is current → the condition clears. expireStale
  // now reaches 'acknowledged' too, so the finding closes itself — no human needed.
  for (const wk of ['2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11'])
    await seedWeek(c, wk, { projected_revenue: 800 })
  await runInsightsForClient(c, { asOf: '2026-05-18' })

  rows = await allInsights(c)
  assert.equal(rows.length, 1)                          // same row, not a duplicate
  assert.equal(rows[0].status, 'expired')               // acknowledged → expired
  assert.deepEqual(await getInsightFeed(c), [])         // gone from the active feed
})

test('feed: a resolved finding is terminal — re-sweeps never reopen it, clearing never expires it', async () => {
  await ready()
  const c = await freshClient('Closed Roofing Co')

  // Run 1: two stale weeks → one open data_health, which a human resolves.
  await seedWeek(c, '2026-04-06', { projected_revenue: 800 })
  await seedWeek(c, '2026-04-13', { projected_revenue: 800 })
  await runInsightsForClient(c, { asOf: '2026-05-20' })
  let rows = await allInsights(c)
  assert.equal((await resolveInsight(rows[0].id)).status, 'resolved')

  // Run 2: the SAME stale condition still holds → the engine re-detects it and
  // upserts the SAME fingerprint. Status must NOT be dragged back to 'open' — the
  // human's close survives the re-sweep.
  await runInsightsForClient(c, { asOf: '2026-05-21' })
  rows = await allInsights(c)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'resolved')              // upsert never overwrites status
  assert.deepEqual(await getInsightFeed(c), [])         // and stays out of the feed

  // Run 3: fresh weeks clear the condition. expireStale targets open/acknowledged
  // only, so a resolved row is left exactly as the human left it.
  for (const wk of ['2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11'])
    await seedWeek(c, wk, { projected_revenue: 800 })
  await runInsightsForClient(c, { asOf: '2026-05-18' })
  rows = await allInsights(c)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'resolved')              // terminal — never flipped to expired
})

test('sweep: runInsightsForAll covers every client and reports a clean summary', async () => {
  await ready()
  const a = await freshClient('Fleet A Roofing Co')
  const b = await freshClient('Fleet B Roofing Co')
  for (const cid of [a, b]) {
    await seedGoal(cid, '2026-05-01', { revenue_target: 8000 })
    for (const wk of ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11'])
      await seedWeek(cid, wk, { projected_revenue: 1000 })
  }

  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*) AS n FROM clients`)
  const total = Number(n)

  const res = await runInsightsForAll({ asOf: '2026-05-17' })
  assert.equal(res.clients, total)                      // every client in the table…
  assert.equal(res.swept, total)                        // …was swept…
  assert.equal(res.failed, 0)                           // …none threw…
  assert.deepEqual(res.errors, [])                      // …so the error log is empty.
  assert.ok(res.findings >= 2, 'the sweep surfaced findings across the portfolio')

  // Each NEW client got its own forecast finding persisted by the one portfolio pass.
  for (const cid of [a, b]) {
    const feed = await getInsightFeed(cid)
    assert.ok(feed.some(f => f.kind === 'forecast' && f.metric === 'revenue'),
      'the portfolio sweep persisted each client’s forecast')
  }
})

// ============================================================
// 5. RECOMMENDED ACTION — observation → advice (deterministic)
// ============================================================
// recommendedAction(finding) is a pure, total function of fields already on the
// finding (kind, metric, direction, severity, evidence). It is what turns the
// engine from an observer into an advisor, and it rides on every normalized row
// so each surface inherits the same guidance for free. These tests pin: (a) the
// adverse-vs-favorable split per metric direction, (b) the urgency↔severity lane
// map, (c) that cited numbers come straight from evidence (never "undefined%"),
// (d) totality on garbage input, and (e) that normalizeInsightRow attaches it.

// Minimal finding factory — mirrors the shape detectFindings emits.
const finding = (over = {}) => ({
  kind: 'anomaly', metric: 'revenue', direction: 'down',
  severity: 'warning', evidence: {}, ...over,
})

test('action urgency maps straight off severity: critical→act_now, warning→plan, info→monitor', () => {
  assert.equal(recommendedAction(finding({ severity: 'critical' })).urgency, 'act_now')
  assert.equal(recommendedAction(finding({ severity: 'warning'  })).urgency, 'plan')
  assert.equal(recommendedAction(finding({ severity: 'info'     })).urgency, 'monitor')
})

test('isAdverse reads each metric’s good direction (revenue↑ good, spend/cpl↑ bad)', () => {
  assert.equal(isAdverse(finding({ metric: 'revenue', direction: 'down' })), true)   // less money = bad
  assert.equal(isAdverse(finding({ metric: 'revenue', direction: 'up'   })), false)  // more money = good
  assert.equal(isAdverse(finding({ metric: 'spend',   direction: 'up'   })), true)   // more spend = bad
  assert.equal(isAdverse(finding({ metric: 'spend',   direction: 'down' })), false)
  assert.equal(isAdverse(finding({ metric: 'cpl',     direction: 'up'   })), true)   // costlier lead = bad
  assert.equal(isAdverse(finding({ metric: 'cpl',     direction: 'down' })), false)  // cheaper lead = good
  assert.equal(isAdverse(finding({ metric: 'roas',    direction: 'down' })), true)
  assert.equal(isAdverse({ kind: 'data_health', metric: null }), true)               // stale data always bad
  assert.equal(isAdverse(finding({ metric: 'revenue', direction: null })), true)     // unknown move → needs eyes
})

test('action: an adverse move prescribes the corrective lever; a favorable one says keep it', () => {
  // Adverse anomaly (revenue down, critical) → act-now lever.
  const bad = recommendedAction(finding({ kind: 'anomaly', metric: 'revenue', direction: 'down', severity: 'critical' }))
  assert.equal(bad.urgency, 'act_now')
  assert.ok(bad.text.includes('Revenue'))
  assert.ok(bad.text.includes('out of its normal range'))
  assert.ok(bad.text.includes('shift budget toward your best-return channels'))      // leverFor('revenue')

  // Favorable anomaly (revenue up) → confirm-then-keep, no alarm.
  const good = recommendedAction(finding({ kind: 'anomaly', metric: 'revenue', direction: 'up', severity: 'info' }))
  assert.equal(good.urgency, 'monitor')
  assert.ok(good.text.includes('in your favor'))
  assert.ok(good.text.includes('hold the current plan and consider raising the goal'))  // keepFor('revenue')
})

test('action: direction-neutral wording stays correct for good-when-down metrics (cpl falling = a win)', () => {
  const good = recommendedAction(finding({ kind: 'anomaly', metric: 'cpl', direction: 'down', severity: 'info' }))
  assert.ok(good.text.includes('Cost per lead'))
  assert.ok(good.text.includes('in your favor'))                          // NOT "spiked above normal"
  assert.ok(good.text.includes('lock in whatever pulled cost-per-lead down'))  // keepFor('cpl')
})

test('action: trend cites the streak length and pulls the metric’s lever', () => {
  const bad = recommendedAction(finding({ kind: 'trend', metric: 'cpl', direction: 'up', severity: 'warning', evidence: { weeks: 6 } }))
  assert.equal(bad.urgency, 'plan')
  assert.ok(bad.text.includes('6 straight weeks'))
  assert.ok(bad.text.includes('trim the high-cost keywords'))             // leverFor('cpl')

  const good = recommendedAction(finding({ kind: 'trend', metric: 'leads', direction: 'up', severity: 'info', evidence: { weeks: 8 } }))
  assert.ok(good.text.includes('improved steadily for 8 weeks'))
  assert.equal(good.urgency, 'monitor')
})

test('action: forecast quotes pct-of-goal when present and falls back cleanly when it isn’t', () => {
  const withPct = recommendedAction(finding({ kind: 'forecast', metric: 'revenue', direction: 'down', severity: 'critical', evidence: { pct_of_target: 50 } }))
  assert.ok(withPct.text.includes('to land at 50% of the Revenue goal'))
  assert.ok(withPct.text.includes('shift budget'))                        // leverFor('revenue')

  // No pct in evidence → must NOT print "land at undefined% …": degrade to prose.
  const noPct = recommendedAction(finding({ kind: 'forecast', metric: 'revenue', direction: 'down', severity: 'critical', evidence: {} }))
  assert.ok(noPct.text.includes('to fall short of the Revenue goal'))
  assert.ok(!noPct.text.includes('undefined'))
  assert.ok(!noPct.text.includes('null'))

  const ahead = recommendedAction(finding({ kind: 'forecast', metric: 'revenue', direction: 'up', severity: 'info', evidence: { pct_of_target: 120 } }))
  assert.ok(ahead.text.includes('Tracking to beat the Revenue goal'))
})

test('action: pacing quotes run-rate pct and falls back cleanly without it', () => {
  const behind = recommendedAction(finding({ kind: 'pacing', metric: 'revenue', direction: 'down', severity: 'critical', evidence: { pct: 20 } }))
  assert.ok(behind.text.includes('at 20% of goal'))
  assert.ok(behind.text.includes('shift budget'))
  const noPct = recommendedAction(finding({ kind: 'pacing', metric: 'revenue', direction: 'down', severity: 'warning', evidence: {} }))
  assert.ok(noPct.text.includes('behind goal'))
  assert.ok(!noPct.text.includes('undefined'))
})

test('action: data_health always says reconnect, pluralizing weeks and naming the lag', () => {
  const crit = recommendedAction({ kind: 'data_health', metric: null, severity: 'critical', evidence: { weeks_behind: 4 } })
  assert.equal(crit.urgency, 'act_now')
  assert.ok(/reconnect/i.test(crit.text))
  assert.ok(crit.text.includes('4 weeks behind'))

  const one = recommendedAction({ kind: 'data_health', metric: null, severity: 'warning', evidence: { weeks_behind: 1 } })
  assert.ok(one.text.includes('1 week behind'))                          // singular
  assert.ok(!one.text.includes('1 weeks'))
})

test('recommendedAction is total: never throws, always returns {text, urgency} even on junk', () => {
  for (const junk of [null, undefined, {}, { kind: 'who_knows' }, { kind: 'anomaly', metric: 'not_a_metric' }]) {
    const a = recommendedAction(junk)
    assert.equal(typeof a.text, 'string')
    assert.ok(a.text.length > 0)
    assert.ok(['act_now', 'plan', 'monitor'].includes(a.urgency))
  }
})

test('normalizeInsightRow attaches recommended_action (evidence parsed from its stored JSON string)', () => {
  const raw = {
    id: 7, client_id: 'c1', kind: 'forecast', metric: 'revenue', direction: 'down',
    severity: 'critical', score: 50, status: 'open', grounded: 0,
    period_start: '2026-05-01', evidence: JSON.stringify({ pct_of_target: 50 }),
  }
  const norm = normalizeInsightRow(raw)
  assert.ok(norm.recommended_action, 'every normalized row carries advice')
  assert.equal(norm.recommended_action.urgency, 'act_now')
  assert.ok(norm.recommended_action.text.includes('to land at 50% of the Revenue goal'))
})

test('every detected finding, once normalized, carries actionable advice end-to-end', () => {
  // A live forecast finding straight from the brain, run through the read path.
  const weeks  = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  const series = seriesOf(weeks, 'revenue', [1000, 1000, 1000, 1000, 1000, 1000])
  const [f]    = detectFindings(series, { goal: { revenue_target: 8000 }, asOf: '2026-05-17' })
  const norm   = normalizeInsightRow({ ...f, period_start: f.period_start || '2026-05-01', evidence: JSON.stringify(f.evidence), grounded: 0, status: 'open' })
  assert.equal(norm.recommended_action.urgency, 'act_now')                // critical forecast
  assert.ok(norm.recommended_action.text.includes('50% of the Revenue goal'))
  assert.ok(norm.recommended_action.text.includes('shift budget'))
})
