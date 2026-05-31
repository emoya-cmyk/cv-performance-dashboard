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
  runInsightsForClient, upsertInsight, getOpenInsights, normalizeInsightRow,
} = require('../lib/insights')

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
