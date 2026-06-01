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
  getInsightFeed, getPortfolioInsights, getPortfolioHealth, setInsightStatus,
  ackInsight, resolveInsight, runInsightsForAll,
  // cross-client peer benchmarking: agency-wide distribution + a client's own standing.
  getPortfolioBenchmarks, getClientStanding,
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

// ── attribution wiring: composite findings explain WHICH driver moved ─────────
// lib/attribution.js is unit-tested in isolation; these two pin that the engine
// actually STAMPS that decomposition onto the right findings (trend first→latest,
// anomaly prior→latest) and stays a strict no-op for non-composite metrics.

test('attribution: a composite trend carries its driver decomposition; a plain metric does not', () => {
  // revenue ≡ spend × roas. Hold roas flat at 4 and drift spend up on the SAME
  // jittery shape as the leads-trend fixture (~11.8%/wk → an info trend, not an
  // anomaly), so revenue tracks it 4×. The engine should decompose the first→latest
  // revenue move and find spend carried all of it — roas never moved.
  const spend  = [50, 90, 70, 110, 90, 130, 110, 140]
  const series = MONDAYS.map((wk, i) => ({
    week_start: wk, spend: spend[i], roas: 4, revenue: spend[i] * 4,
  }))
  const out = detectFindings(series, { asOf: '2026-05-06' })

  const trend = out.find(f => f.kind === 'trend' && f.metric === 'revenue')
  assert.ok(trend, 'a revenue trend is detected')
  const attr = trend.evidence.attribution
  assert.ok(attr, 'the composite trend carries an attribution decomposition')
  assert.equal(attr.direction, 'up')
  assert.equal(attr.lead, 'spend')                 // spend did all the work
  approx(attr.pct, 180)                            // 200 → 560 across the window
  const [s, r] = attr.drivers                       // presentation order: spend, roas
  assert.equal(s.metric, 'spend'); approx(s.share, 1); assert.equal(s.share_pct, 100)
  assert.equal(r.metric, 'roas');  approx(r.share, 0); assert.equal(r.share_pct, 0)
  approx(s.share + r.share, 1)                       // exact partition of the log-move

  // …and the SAME run's spend trend is NON-composite, so it carries no attribution —
  // the wiring is a strict no-op anywhere off the two exact identities.
  const spendTrend = out.find(f => f.kind === 'trend' && f.metric === 'spend')
  assert.ok(spendTrend, 'spend also trends up')
  assert.equal('attribution' in spendTrend.evidence, false)
})

test('attribution: a composite anomaly explains its week-over-week jump by driver', () => {
  // The same 6× revenue spike as the anomaly fixture, but built from real drivers:
  // roas held at 4 while spend leaps 200 → 1250 in the final week, so revenue runs
  // 780…800 → 5000. The anomaly the engine raises should carry the prior→latest
  // decomposition, pinning spend and agreeing with the pct_vs_prior it already reports.
  const spend  = [195, 205, 197.5, 202.5, 200, 1250]
  const series = MONDAYS.slice(2).map((wk, i) => ({
    week_start: wk, spend: spend[i], roas: 4, revenue: spend[i] * 4,
  }))
  const out = detectFindings(series, { asOf: '2026-05-06' })

  const a = out.find(f => f.kind === 'anomaly' && f.metric === 'revenue')
  assert.ok(a, 'the revenue spike is flagged as an anomaly')
  const attr = a.evidence.attribution
  assert.ok(attr, 'the composite anomaly carries an attribution decomposition')
  assert.equal(attr.direction, 'up')               // latest 5000 vs prior 800
  assert.equal(attr.lead, 'spend')
  // the decomposition explains the SAME step the evidence already reports as pct_vs_prior
  approx(Math.abs(attr.pct), a.evidence.pct_vs_prior)

  // spend spikes too, but it is non-composite → no attribution stamped.
  const sp = out.find(f => f.kind === 'anomaly' && f.metric === 'spend')
  assert.ok(sp, 'spend spikes too')
  assert.equal('attribution' in sp.evidence, false)
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
  // Keystone: with no learned track record there's no earned interval — the
  // evidence stays a clean point, byte-identical to before the band existed.
  assert.equal('projected_low'  in f.evidence, false)
  assert.equal('projected_high' in f.evidence, false)
  assert.equal('interval_pct'   in f.evidence, false)
  // …and with no band there's nothing to calibrate the alarm against, so the
  // critical stands at full strength and no softening flag is stamped.
  assert.equal('goal_in_band'   in f.evidence, false)

  // Title + detail are grounded by construction — every figure is in evidence.
  const text = `${titleFor(f)} ${templateDetailFor(f)}`
  const { grounded, offending } = verifyGrounding(text, { values: f.evidence })
  assert.equal(grounded, true, `ungrounded tokens: ${offending.join(', ')}`)
})

test('forecast interval: a learned track record sizes a visible prediction band', () => {
  // SAME flat-$1k history as the test above (projects to $4000 vs an $8000 goal),
  // but now this client carries a realized calibration: 4 graded months at a 20%
  // mape. selftune#intervalFor turns that learned error into an 80% band around the
  // projection — no hand-set width. With zero bias the point stays $4000 and the
  // severity stays critical; only the band is added.
  const weeks  = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  const series = seriesOf(weeks, 'revenue', [1000, 1000, 1000, 1000, 1000, 1000])
  const out    = detectFindings(series, {
    goal: { revenue_target: 8000 }, asOf: '2026-05-17',
    calibration: { forecast: { revenue: { samples: 4, mape: 0.2 } } },
  })

  assert.equal(out.length, 1)
  const f = out[0]
  assert.equal(f.kind, 'forecast')
  assert.equal(f.severity, 'critical')             // bias_factor defaults to 1 → point unchanged
  assert.equal(f.evidence.projected_total, 4000)   // band is centered on the point
  assert.equal(f.evidence.interval_pct, 80)
  // rel = Z_80·√(π/2)·0.2 ≈ 0.3212 → 4000·(1∓0.3212)
  assert.equal(f.evidence.projected_low, 2715)
  assert.equal(f.evidence.projected_high, 5285)
  assert.ok(f.evidence.projected_low  < f.evidence.projected_total)
  assert.ok(f.evidence.projected_high > f.evidence.projected_total)
  // Calibrated-alarm boundary: the $8000 goal sits ABOVE the $5,285 band ceiling —
  // even the optimistic edge falls short, so this is a confident miss. The critical
  // stands and no softening flag is stamped.
  assert.equal('goal_in_band' in f.evidence, false)
  // The band's edges are themselves grounded — they live in evidence, so a narrated
  // "likely $2,715–$5,285" can never drift from the numbers behind it.
  const text = `${titleFor(f)} ${templateDetailFor(f)}`
  const { grounded, offending } = verifyGrounding(text, { values: f.evidence })
  assert.equal(grounded, true, `ungrounded tokens: ${offending.join(', ')}`)
})

test('calibrated alarm: a goal inside the learned band softens warning → info', () => {
  // SAME flat-$1k history (projects to $4000), but a $4500 goal: the point lands at
  // 89% of goal → a behind-pace WARNING on the raw ratio. This client carries a
  // realized 20% mape, though, so the 80% band is $2,715–$5,285 — and $4500 sits
  // squarely inside it. Hitting the goal is still plausible within their own forecast
  // error, so the engine right-sizes the alarm down to info (monitor) and records why.
  const weeks  = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  const series = seriesOf(weeks, 'revenue', [1000, 1000, 1000, 1000, 1000, 1000])
  const out    = detectFindings(series, {
    goal: { revenue_target: 4500 }, asOf: '2026-05-17',
    calibration: { forecast: { revenue: { samples: 4, mape: 0.2 } } },
  })

  assert.equal(out.length, 1)
  const f = out[0]
  assert.equal(f.kind, 'forecast')
  assert.equal(f.direction, 'down')                // still tracking below the point
  assert.equal(f.severity, 'info')                 // …but softened from warning: goal is in-band
  assert.equal(f.evidence.goal_in_band, true)
  assert.equal(f.evidence.projected_total, 4000)
  assert.equal(f.evidence.projected_low, 2715)
  assert.equal(f.evidence.projected_high, 5285)
  assert.equal(f.evidence.pct_of_target, 89)       // 4000 / 4500
  // The goal lies between the band edges — that's the whole reason it softened.
  assert.ok(f.evidence.target > f.evidence.projected_low)
  assert.ok(f.evidence.target < f.evidence.projected_high)
  // Monotonic safety: softening only ever LOWERS urgency, never silences — the card
  // is still here, just at monitor strength with an honest "still within reach" frame.
  assert.equal(f.score, 11)                        // |1 − 4000/4500| × 100, unchanged by softening

  const text = `${titleFor(f)} ${templateDetailFor(f)}`
  const { grounded, offending } = verifyGrounding(text, { values: f.evidence })
  assert.equal(grounded, true, `ungrounded tokens: ${offending.join(', ')}`)
})

test('calibrated alarm: a goal inside the learned band softens critical → warning', () => {
  // A noisier client (50% mape) earns a much WIDER band. Same $4000 projection, now
  // against a $7000 goal: the point is 57% of goal → a CRITICAL on the raw ratio. But
  // the 80% band is ~$787–$7,213, and $7000 still falls inside it — so with this much
  // realized scatter the miss isn't yet confident, and critical is softened to warning
  // (plan), not silenced. Demonstrates the one-level step on the upper rung.
  const weeks  = ['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11']
  const series = seriesOf(weeks, 'revenue', [1000, 1000, 1000, 1000, 1000, 1000])
  const out    = detectFindings(series, {
    goal: { revenue_target: 7000 }, asOf: '2026-05-17',
    calibration: { forecast: { revenue: { samples: 6, mape: 0.5 } } },
  })

  assert.equal(out.length, 1)
  const f = out[0]
  assert.equal(f.kind, 'forecast')
  assert.equal(f.direction, 'down')
  assert.equal(f.severity, 'warning')              // softened from critical: goal is in the wide band
  assert.equal(f.evidence.goal_in_band, true)
  assert.equal(f.evidence.projected_total, 4000)
  assert.equal(f.evidence.interval_pct, 80)
  assert.ok(f.evidence.target > f.evidence.projected_low)
  assert.ok(f.evidence.target < f.evidence.projected_high)

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

test('coverage_gap: title + detail name the channel, its own cadence, and the dark span', () => {
  // A daily channel (cadence ≈ 1) silent for 30 days. The narration must contrast
  // the channel's OWN rhythm with the gap and resolve to one instruction: reconnect.
  const f = {
    kind: 'coverage_gap', metric: null, severity: 'critical',
    evidence: { channel_label: 'Meta Ads', days_dark: 30, cadence_days: 1 },
  }
  const title = titleFor(f)
  assert.ok(title.includes('Meta Ads'))
  assert.ok(title.includes('30 days'))
  assert.match(title, /reconnect/i)

  const detail = templateDetailFor(f)
  assert.ok(detail.includes('every 1 day'))                  // cadence singular
  assert.ok(detail.includes("hasn't sent data in 30 days"))
  assert.ok(detail.includes('other sources are still flowing'))
  assert.match(detail, /reconnect Meta Ads/i)

  // A weekly channel pluralizes its own cadence ("every 7 days").
  const weekly = templateDetailFor({
    kind: 'coverage_gap', metric: null,
    evidence: { channel_label: 'GHL CRM', days_dark: 21, cadence_days: 7 },
  })
  assert.ok(weekly.includes('every 7 days'))
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

test('fingerprint: coverage_gap splits by channel key; other kinds stay byte-identical', () => {
  const crypto = require('crypto')
  // Two channels dark on the SAME last_date must NOT collide — the optional
  // fingerprint_key discriminator gives each its own stable identity.
  const base = { scope: 'client', kind: 'coverage_gap', metric: null, period_start: '2026-05-10' }
  const meta = fingerprintOf('c1', { ...base, fingerprint_key: 'meta' })
  const ga   = fingerprintOf('c1', { ...base, fingerprint_key: 'google_ads' })
  assert.notEqual(meta, ga)                                                  // distinct per channel
  assert.equal(meta, fingerprintOf('c1', { ...base, fingerprint_key: 'meta' }))   // …and stable
  // Back-compat: a kind that sets NO fingerprint_key hashes EXACTLY as it did before
  // the discriminator existed — recomputed here independently, byte for byte.
  const legacy   = { scope: 'client', kind: 'anomaly', metric: 'revenue', period_start: '2026-05-04' }
  const expected = crypto.createHash('sha1')
    .update(['client', 'c1', 'anomaly', 'revenue', '2026-05-04'].join('|')).digest('hex')
  assert.equal(fingerprintOf('c1', legacy), expected)
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

test('runInsightsForClient flags a silently-dead channel off the atomic grain, and is idempotent', async () => {
  await ready()
  const c = await freshClient('Coverage Roofing Co')
  const ASOF = '2026-06-01'

  // Insert one daily fact for every day in [fromDaysAgo .. toDaysAgo] before ASOF.
  const isoMinus = (n) =>
    new Date(Date.parse(ASOF + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10)
  async function seedDaily(channelId, metricKey, fromDaysAgo, toDaysAgo) {
    for (let n = fromDaysAgo; n >= toDaysAgo; n--) {
      await db.query(
        `INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [c, isoMinus(n), channelId, metricKey, 100]
      )
    }
  }

  // No weekly_reports for this client → detectFindings() returns [] → coverage is the
  // SOLE source of findings, isolating exactly what we're testing.
  // google_ads (id 1): HEALTHY — delivered daily right up to yesterday (1d dark ≈ its cadence).
  await seedDaily(1, 'spend', 40, 1)
  // meta (id 2): DEAD — delivered daily, then went dark 30 days ago. 30d − 1d cadence = 29 beyond.
  await seedDaily(2, 'spend', 60, 30)

  await runInsightsForClient(c, { asOf: ASOF })
  const gaps1 = (await allInsights(c)).filter(r => r.kind === 'coverage_gap')
  assert.equal(gaps1.length, 1, 'exactly one coverage_gap — the dead meta channel')
  const gap = gaps1[0]
  assert.equal(gap.metric, null)
  assert.equal(gap.severity, 'critical')           // beyond 29 ≥ 14 → critical
  assert.equal(gap.status, 'open')
  assert.equal(gap.grounded, true)                 // deterministic template branch, grounded
  assert.equal(gap.evidence.channel, 'meta')
  assert.equal(gap.evidence.channel_label, 'Meta Ads')
  assert.equal(gap.evidence.days_dark, 30)
  assert.equal(gap.evidence.cadence_days, 1)       // daily history → cadence 1
  assert.equal(gap.period_start, isoMinus(30))     // stable while dark → SAME row refreshes
  // The healthy channel is within its own rhythm → NOT flagged.
  assert.equal(gaps1.some(r => r.evidence.channel === 'google_ads'), false)
  // The advice routes the operator to the single fix.
  assert.match(gap.recommended_action.text, /reconnect meta ads/i)

  // Idempotent: a second identical sweep refreshes the SAME row in place — no duplicate.
  await runInsightsForClient(c, { asOf: ASOF })
  const gaps2 = (await allInsights(c)).filter(r => r.kind === 'coverage_gap')
  assert.equal(gaps2.length, 1)
  assert.equal(gaps2[0].status, 'open')
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

test('portfolio health: getPortfolioHealth rolls every client into one score, ranks worst-first, keeps the findingless', async () => {
  await ready()
  // Three fresh clients: one bleeding a critical, one a lone warning, one spotless.
  const crit  = await freshClient('Healthscore Critical Co')
  const warn  = await freshClient('Healthscore Warning Co')
  const clean = await freshClient('Healthscore Clean Co')
  await upsertInsight(crit, mkFinding('anomaly', 'revenue', 'critical', 9), { ...mkNarr('hc-crit'), fingerprint: `fp-hcc-${crit}` })
  await upsertInsight(warn, mkFinding('pacing',  'jobs',    'warning',  6), { ...mkNarr('hc-warn'), fingerprint: `fp-hcw-${warn}` })
  // `clean` gets NOTHING on purpose — the whole point of the roster: a client with no
  // active findings must still appear, scored a flawless 100. getPortfolioInsights()
  // (per-finding grain) would omit it entirely; the triage roster is the COMPLETE
  // picture, so the healthy clients are visible (and sink to the bottom), not absent.

  const roster = await getPortfolioHealth()
  const rc = roster.find(r => r.client_id === crit)
  const rw = roster.find(r => r.client_id === warn)
  const rk = roster.find(r => r.client_id === clean)
  assert.ok(rc && rw && rk, 'the roster spans every client, the findingless one included')

  // The JOINed client_name rides along on each client-grain verdict.
  assert.equal(rc.client_name, 'Healthscore Critical Co')
  assert.equal(rw.client_name, 'Healthscore Warning Co')
  assert.equal(rk.client_name, 'Healthscore Clean Co')

  // Exact per-client synthesis — with no learned precision history the factor is a
  // neutral 1, so the pure severity scores hold: critical 45 / warning 80 / clean 100.
  assert.equal(rc.score, 45);  assert.equal(rc.band, 'at_risk')
  assert.equal(rw.score, 80);  assert.equal(rw.band, 'watch')
  assert.equal(rk.score, 100); assert.equal(rk.band, 'healthy')
  assert.equal(rc.driver.severity, 'critical')   // the headline bite is named
  assert.equal(rc.counts.total, 1)
  assert.equal(rk.driver, null)                   // a clean client has no driver…
  assert.equal(rk.counts.total, 0)                // …and no findings to its name

  // Worst-first, robust to whatever clients earlier tests left in the DB: the
  // critical sinks to the top of MY three, the clean client to the bottom.
  assert.ok(roster.indexOf(rc) < roster.indexOf(rw), 'critical ranks ahead of warning')
  assert.ok(roster.indexOf(rw) < roster.indexOf(rk), 'warning ranks ahead of the clean client')

  // Lifecycle flows straight through the synthesis: resolve the critical and the
  // client's health recovers to a clean 100 on the next read — and it STILL appears
  // on the roster (now findingless), proving the seed-every-client contract again.
  await resolveInsight(await idForFingerprint(`fp-hcc-${crit}`))
  const after = await getPortfolioHealth()
  const rc2 = after.find(r => r.client_id === crit)
  assert.ok(rc2, 'the client stays on the roster after its only finding resolves')
  assert.equal(rc2.score, 100)
  assert.equal(rc2.band, 'healthy')
  assert.equal(rc2.counts.total, 0)
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
  assert.equal(isAdverse({ kind: 'coverage_gap', metric: null }), true)              // a dark channel always needs eyes
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

test('action: coverage_gap says reconnect THIS channel, pluralizing days and naming the lag', () => {
  const crit = recommendedAction({ kind: 'coverage_gap', metric: null, severity: 'critical', evidence: { channel_label: 'Meta Ads', days_dark: 30 } })
  assert.equal(crit.urgency, 'act_now')
  assert.match(crit.text, /reconnect meta ads/i)
  assert.ok(crit.text.includes('30 days ago'))
  assert.ok(crit.text.includes('other sources keep flowing'))

  const one = recommendedAction({ kind: 'coverage_gap', metric: null, severity: 'warning', evidence: { channel_label: 'GHL CRM', days_dark: 1 } })
  assert.equal(one.urgency, 'plan')
  assert.ok(one.text.includes('1 day ago'))                            // singular
  assert.ok(!one.text.includes('1 days'))

  // No day count in evidence → degrade to prose, never "undefined days".
  const vague = recommendedAction({ kind: 'coverage_gap', metric: null, severity: 'critical', evidence: { channel_label: 'Local Services Ads' } })
  assert.ok(vague.text.includes('several days ago'))
  assert.ok(!vague.text.includes('undefined'))
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

// ============================================================
// 6. CROSS-CLIENT PEER BENCHMARKING — the one axis self-history can't see.
//    Every other detector measures a client against its OWN past; this ranks it
//    against the LIVE portfolio. Two reads: getPortfolioBenchmarks (agency-wide
//    distribution, names peers) and getClientStanding (a client's own ANONYMOUS
//    standing, never a peer identity). The DB is shared/polluted across tests, so
//    we seed our OWN cohort and assert membership + RELATIVE order, never absolute
//    positions/counts — exactly the portfolio-health roster's robustness contract.
// ============================================================

// Repeat one identical week across the benchmark window [2026-04-20 … 2026-05-04]
// (the three Mondays getPortfolioBenchmarks reads for asOf 2026-05-12, weeks 3).
const BENCH_WK = ['2026-04-20', '2026-04-27', '2026-05-04']
async function seedBench(name, perWeek) {
  const id = await freshClient(name)
  for (const wk of BENCH_WK) await seedWeek(id, wk, perWeek)
  return id
}

test('benchmark: the agency distribution ranks the live cohort; window ratios derive from summed totals; the denominator gate keeps derive() zero-fill out', async () => {
  await ready()

  // Six core peers with ASCENDING roas r = 2..7. Each of the three weeks is
  // identical, so the window TOTALS are spend 3000 / leads 30 / closed 9 /
  // revenue 3000·r → derive() recomputes WINDOW ratios roas=r, cpl=100,
  // close_rate=30 for every core peer (matching the live dashboard's math).
  const core = []
  for (let r = 2; r <= 7; r++) {
    const id = await seedBench(`Bench Core roas=${r}`, {
      ads_spend: 1000, raw_leads: 10, closed_won: 3, projected_revenue: 1000 * r,
    })
    core.push({ r, id })
  }
  const lowId  = core[0].id   // roas 2 — worst of my core
  const highId = core[5].id   // roas 7 — best of my core

  // Two probes that derive()'s zero-fill would POISON if the engine ranked raw
  // ratios blind. The benchmarkable() gate reads WINDOW TOTALS, not the ratio:
  //   • noSpend — ran no ads → fake roas 0 / cpl 0. Drop from roas & cpl; KEEP
  //     where the basis is real (close_rate, revenue, leads, jobs).
  const noSpend = await seedBench('Bench NoSpend', {
    ads_spend: 0, raw_leads: 8, closed_won: 2, projected_revenue: 5000,
  }) // window totals: spend 0 / leads 24 / closed 6 / revenue 15000
  //   • noLeads — real spend, zero leads → fake close_rate 0 / cpl 0, but a
  //     GENUINE roas 10 (revenue 30000 / spend 3000). Keep on roas & revenue;
  //     drop from every lead-basis metric (cpl, close_rate, leads, jobs).
  const noLeads = await seedBench('Bench NoLeads', {
    ads_spend: 1000, raw_leads: 0, closed_won: 0, projected_revenue: 10000,
  }) // window totals: spend 3000 / leads 0 / closed 0 / revenue 30000 → roas 10

  const pb = await getPortfolioBenchmarks({ asOf: '2026-05-12', weeks: 3 })

  // Window math is exact and independent of whatever else lives in the DB.
  assert.deepEqual(pb.period, { from: '2026-04-20', to: '2026-05-04', weeks: 3 })
  // cohort_size counts DISTINCT contributing clients — at least my eight seeds.
  assert.ok(pb.cohort_size >= 8, `cohort spans my eight seeds, saw ${pb.cohort_size}`)

  const find = (block, id) => (block && block.clients.find((c) => c.client_id === id))

  // ── roas: efficiency framing, a real cohort, ascending values derive correctly ──
  const roas = pb.metrics.roas
  assert.ok(roas, 'roas block present')
  assert.equal(roas.kind, 'efficiency')
  assert.equal(roas.cohort, 'ok')            // my 7 roas-eligible alone clear MIN_COHORT
  // sum-then-derive: the low peer reads exactly 2, the high peer exactly 7.
  approx(find(roas, lowId).value, 2)
  approx(find(roas, highId).value, 7)
  // higher roas ranks better (rank 1 = best) and scores a higher percentile.
  // Asserted RELATIVE to my own ids — never absolute positions (DB is shared).
  assert.ok(find(roas, highId).rank < find(roas, lowId).rank, 'roas 7 outranks roas 2')
  assert.ok(find(roas, highId).percentile > find(roas, lowId).percentile)
  // strictly monotone across all six core peers, best-first.
  for (let i = 1; i < core.length; i++) {
    const lo = find(roas, core[i - 1].id)
    const hi = find(roas, core[i].id)
    assert.ok(hi.rank < lo.rank, `roas ${core[i].r} outranks roas ${core[i - 1].r}`)
    assert.ok(hi.percentile > lo.percentile, `roas ${core[i].r} scores above roas ${core[i - 1].r}`)
  }
  // mean-rank keeps the extremes strictly inside (0,100): the best peer is never a
  // misleading exact 100, the worst never an exact 0.
  for (const c of roas.clients) {
    assert.ok(c.percentile > 0 && c.percentile < 100, `percentile ${c.percentile} strictly inside (0,100)`)
  }

  // ── the denominator-basis gate: derive() zero-fill never poisons a cohort ──
  // roas: noSpend (fake 0) DROPPED; noLeads (genuine 10) KEPT and reads 10.
  assert.equal(find(roas, noSpend), undefined, 'no-spend client is absent from roas')
  assert.ok(find(roas, noLeads), 'genuine-roas no-leads client IS present on roas')
  approx(find(roas, noLeads).value, 10)
  // cpl: BOTH probes lack a sound basis → absent; the six real-spend peers remain.
  assert.equal(find(pb.metrics.cpl, noSpend), undefined, 'no-spend absent from cpl')
  assert.equal(find(pb.metrics.cpl, noLeads), undefined, 'no-leads absent from cpl')
  assert.ok(find(pb.metrics.cpl, lowId), 'a real-spend peer is present on cpl')
  approx(find(pb.metrics.cpl, lowId).value, 100)        // 3000 spend / 30 leads
  // close_rate: leads-basis → noSpend KEPT (24 leads), noLeads DROPPED (0 leads).
  assert.ok(find(pb.metrics.close_rate, noSpend), 'no-spend present on close_rate')
  assert.equal(find(pb.metrics.close_rate, noLeads), undefined, 'no-leads absent from close_rate')
  approx(find(pb.metrics.close_rate, lowId).value, 30)  // 9 closed / 30 leads · 100
  // revenue (volume): real for BOTH probes → both present.
  assert.ok(find(pb.metrics.revenue, noSpend), 'no-spend present on revenue')
  assert.ok(find(pb.metrics.revenue, noLeads), 'no-leads present on revenue')
  // leads & jobs are lead-basis: noSpend KEPT, noLeads DROPPED.
  assert.ok(find(pb.metrics.leads, noSpend), 'no-spend present on leads')
  assert.equal(find(pb.metrics.leads, noLeads), undefined, 'no-leads absent from leads')
  assert.ok(find(pb.metrics.jobs, noSpend), 'no-spend present on jobs')
  assert.equal(find(pb.metrics.jobs, noLeads), undefined, 'no-leads absent from jobs')

  // volume framing is stamped distinctly from efficiency.
  assert.equal(pb.metrics.revenue.kind, 'volume')
  assert.equal(pb.metrics.leads.kind, 'volume')
  assert.equal(pb.metrics.jobs.kind, 'volume')
})

test('benchmark: getClientStanding returns a client OWN anonymous standing — agency sees peers, the client never does', async () => {
  await ready()

  // A fresh roas ladder, independent of the prior test's clients (both persist in
  // the shared DB — fine, we assert on our own ids and on cross-payload equality).
  const core = []
  for (let r = 2; r <= 7; r++) {
    const id = await seedBench(`Standing Core roas=${r}`, {
      ads_spend: 1000, raw_leads: 10, closed_won: 3, projected_revenue: 1000 * r,
    })
    core.push({ r, id })
  }
  const highId   = core[5].id
  const highName = 'Standing Core roas=7'

  const pb = await getPortfolioBenchmarks({ asOf: '2026-05-12', weeks: 3 })

  // AGENCY surface: the per-metric block DOES carry peer identity (id + name) —
  // the agency is allowed to see who is who.
  const roasBlock   = pb.metrics.roas
  const agencyEntry = roasBlock.clients.find((c) => c.client_id === highId)
  assert.ok(agencyEntry, 'agency block names the client')
  assert.equal(agencyEntry.client_name, highName)

  // CLIENT surface: the SAME client, stripped to its OWN anonymous numbers.
  const mine = await getClientStanding(highId, { asOf: '2026-05-12', weeks: 3 })
  assert.deepEqual(mine.period, { from: '2026-04-20', to: '2026-05-04', weeks: 3 })
  assert.ok(typeof mine.cohort_size === 'number' && mine.cohort_size >= 8)
  assert.ok(Array.isArray(mine.standing) && mine.standing.length > 0, 'the client qualifies somewhere')

  const myRoas = mine.standing.find((s) => s.metric === 'roas')
  assert.ok(myRoas, 'the client sees its own roas standing')
  // EVERY exposed field is anonymous + self-only — no peer id, name, or roster.
  for (const s of mine.standing) {
    assert.ok(!('client_id' in s),   'standing leaks no client_id')
    assert.ok(!('client_name' in s), 'standing leaks no client_name')
    assert.ok(!('clients' in s),     'standing leaks no peer roster')
    assert.ok(s.percentile >= 0 && s.percentile <= 100, 'own percentile is a valid 0–100')
    assert.ok(typeof s.cohort_size === 'number', 'cohort_size is a bare count')
    assert.ok(['top', 'upper', 'lower', 'bottom'].includes(s.quartile), 'a published quartile')
    assert.ok(Number.isFinite(s.value) && Number.isFinite(s.rank) && Number.isFinite(s.median))
  }
  // Same computation, two privacy views: the client's own roas value, percentile,
  // and rank MATCH the agency block exactly.
  approx(myRoas.value, 7)
  assert.equal(myRoas.percentile, agencyEntry.percentile)
  assert.equal(myRoas.rank, agencyEntry.rank)
})
