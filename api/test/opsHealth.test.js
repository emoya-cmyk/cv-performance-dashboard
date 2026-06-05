'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const {
  assessOps,
  assessJob,
  countHeals,
  classifyRunStatus,
  recordHeartbeat,
  loadRecentRuns,
  toMs,
  EXPECTED_MS,
  JOBS,
  RUN_STATUSES,
  GRACE_FACTOR,
  STALE_FACTOR,
  HEAL_WINDOW_MS,
} = require('../lib/opsHealth')

// Deterministic clock — every assertion measures age relative to this fixed epoch,
// so the grader is tested with zero reliance on the wall clock.
const NOW = 1_700_000_000_000          // 2023-11-14T22:13:20.000Z
const H   = 60 * 60 * 1000             // one hour in ms
const MIN  = 60 * 1000                 // one minute in ms
const DAY = 24 * H                     // one day in ms

// A fake `query` that records every (sql, params) it is handed — lets us assert the
// exact INSERT shape recordHeartbeat emits without a real database.
function captureQuery() {
  const calls = []
  const fn = async (sql, params) => { calls.push({ sql, params }); return { rows: [] } }
  fn.calls = calls
  return fn
}

// ── toMs: timestamp normalization ───────────────────────────────────────────────
test('toMs passes a finite number through and rejects junk', () => {
  assert.equal(toMs(NOW), NOW)
  assert.equal(toMs(0), 0)
  assert.equal(toMs(null), null)
  assert.equal(toMs(undefined), null)
  assert.equal(toMs('not a date'), null)
  assert.equal(toMs(NaN), null)
  assert.equal(toMs(Infinity), null)
})

test('toMs reads a Date and an ISO string identically', () => {
  const iso = new Date(NOW).toISOString()
  assert.equal(toMs(new Date(NOW)), NOW)
  assert.equal(toMs(iso), NOW)
})

test('toMs treats the SQLite CURRENT_TIMESTAMP form as UTC, not local', () => {
  // 'YYYY-MM-DD HH:MM:SS' (space, no zone) is what SQLite writes. V8 would parse it
  // as LOCAL time; the module must normalize it to UTC so age math is offset-free.
  const sqliteForm = '2023-11-14 22:13:20'
  assert.equal(toMs(sqliteForm), Date.parse('2023-11-14T22:13:20Z'))
  assert.equal(toMs(sqliteForm), NOW)
})

// ── assessJob: one job graded against cadence ───────────────────────────────────
test('assessJob: a fresh run inside the grace window is live', () => {
  const run = { job: 'sync', status: 'success', ran_at: NOW - 4 * H }
  const a = assessJob('sync', run, NOW)
  assert.equal(a.status, 'live')
  assert.equal(a.ageMs, 4 * H)
  assert.equal(a.expectedMs, 6 * H)
  assert.equal(a.overdueByMs, 0)
  assert.equal(a.degraded, false)
  assert.equal(a.lastStatus, 'success')
  assert.equal(a.lastRunAt, new Date(NOW - 4 * H).toISOString())
})

test('assessJob: past grace but within stale is overdue, with overdueByMs measured from grace', () => {
  // sync cadence 6h → grace 9h, stale 18h. Age 12h ⇒ overdue, 3h past the grace line.
  const run = { job: 'sync', status: 'success', ran_at: NOW - 12 * H }
  const a = assessJob('sync', run, NOW)
  assert.equal(a.status, 'overdue')
  assert.equal(a.ageMs, 12 * H)
  assert.equal(a.overdueByMs, 3 * H)
})

test('assessJob: beyond the stale multiple is stale', () => {
  const run = { job: 'sync', status: 'success', ran_at: NOW - 24 * H }   // > 18h
  assert.equal(assessJob('sync', run, NOW).status, 'stale')
})

test('assessJob: no run on record is the non-alarming never', () => {
  const a = assessJob('digest', null, NOW)
  assert.equal(a.status, 'never')
  assert.equal(a.lastRunAt, null)
  assert.equal(a.ageMs, null)
  assert.equal(a.expectedMs, 7 * DAY)
  assert.equal(a.overdueByMs, 0)
  assert.equal(a.degraded, false)
})

test('assessJob: a missing clock degrades safely to never (never invents an alarm)', () => {
  const run = { job: 'sync', status: 'success', ran_at: NOW }
  assert.equal(assessJob('sync', run, null).status, 'never')
})

test('assessJob: an on-cadence run whose last outcome was error is live + degraded', () => {
  const run = { job: 'watchdog', status: 'error', ran_at: NOW - 5 * MIN }
  const a = assessJob('watchdog', run, NOW)
  assert.equal(a.status, 'live', 'still on cadence')
  assert.equal(a.degraded, true, 'but the run itself failed')
  assert.equal(a.lastStatus, 'error')
})

test('assessJob: a precomputed _t wins over a bad ran_at', () => {
  const a = assessJob('sync', { _t: NOW - 2 * H, ran_at: 'garbage' }, NOW)
  assert.equal(a.status, 'live')
  assert.equal(a.ageMs, 2 * H)
})

// ── countHeals: the visible self-healing tally ──────────────────────────────────
test('countHeals sums watchdog heals in-window, from both JSON-string and object detail', () => {
  const runs = [
    { job: 'watchdog', ran_at: NOW - 2 * DAY, detail: { healed: 2 } },         // object
    { job: 'watchdog', ran_at: NOW - 1 * DAY, detail: '{"healed":3}' },        // JSON string
    { job: 'watchdog', ran_at: NOW - 8 * DAY, detail: { healed: 99 } },        // out of window
    { job: 'watchdog', ran_at: NOW + 1 * DAY, detail: { healed: 7 } },         // future — ignored
    { job: 'sync',     ran_at: NOW - 1 * H,   detail: { healed: 100 } },       // wrong job — ignored
    { job: 'watchdog', ran_at: NOW - 3 * H,   detail: { scanned: 5 } },        // no healed key
  ]
  assert.equal(countHeals(runs, NOW), 5)
})

test('countHeals tolerates bad input', () => {
  assert.equal(countHeals(null, NOW), 0)
  assert.equal(countHeals([], NOW), 0)
  assert.equal(countHeals([{ job: 'watchdog', ran_at: NOW, detail: 'not-json' }], NOW), 0)
  assert.equal(countHeals([{ job: 'watchdog', ran_at: NOW, detail: { healed: 2 } }], null), 0)
})

// ── assessOps: whole-engine rollup ──────────────────────────────────────────────
test('assessOps reduces multiple runs per job to the latest by ran_at', () => {
  const runs = [
    { job: 'sync', status: 'success', ran_at: NOW - 20 * H },   // older, stale-aged
    { job: 'sync', status: 'success', ran_at: NOW - 2 * H },    // newest, live
  ]
  const ops = assessOps({ runs, now: NOW })
  const sync = ops.jobs.find((j) => j.job === 'sync')
  assert.equal(sync.status, 'live', 'the newest run wins, not the first in the array')
  assert.equal(sync.ageMs, 2 * H)
})

test('assessOps rollup precedence: any stale ⇒ stale overall', () => {
  const runs = [
    { job: 'sync',     status: 'success', ran_at: NOW - 24 * H },   // stale  (>18h)
    { job: 'watchdog', status: 'success', ran_at: NOW - 5 * MIN },  // live
    { job: 'insights', status: 'success', ran_at: NOW - 40 * H },   // overdue (>36h, <72h)
    // digest: no run ⇒ never
  ]
  const ops = assessOps({ runs, now: NOW })
  assert.equal(ops.status, 'stale')
  assert.equal(ops.liveCount, 1)
  assert.equal(ops.overdueCount, 1)
  assert.equal(ops.staleCount, 1)
  assert.equal(ops.neverCount, 1)
  assert.equal(ops.total, 4)
  assert.equal(ops.headline, 'Autonomy engine degraded — 1 job stalled (engine may be down)')
})

test('assessOps: all jobs live ⇒ live with the "all N" headline', () => {
  const runs = [
    { job: 'sync',     status: 'success', ran_at: NOW - 1 * H },
    { job: 'watchdog', status: 'success', ran_at: NOW - 5 * MIN },
    { job: 'insights', status: 'success', ran_at: NOW - 2 * H },
    { job: 'digest',   status: 'success', ran_at: NOW - 1 * DAY },
  ]
  const ops = assessOps({ runs, now: NOW })
  assert.equal(ops.status, 'live')
  assert.equal(ops.liveCount, 4)
  assert.equal(ops.headline, 'Autonomy engine live — all 4 jobs on cadence')
})

test('assessOps: live jobs + a never-run job ⇒ live with an honest "3/4" headline', () => {
  const runs = [
    { job: 'sync',     status: 'success', ran_at: NOW - 1 * H },
    { job: 'watchdog', status: 'success', ran_at: NOW - 5 * MIN },
    { job: 'insights', status: 'success', ran_at: NOW - 2 * H },
    // digest never ran (cadence-gated on having digest-enabled clients)
  ]
  const ops = assessOps({ runs, now: NOW })
  assert.equal(ops.status, 'live')
  assert.equal(ops.neverCount, 1)
  assert.equal(ops.headline, 'Autonomy engine live — 3/4 jobs on cadence')
})

test('assessOps: nothing has ever run ⇒ warming (cold-start-honest, not a failure)', () => {
  const ops = assessOps({ runs: [], now: NOW })
  assert.equal(ops.status, 'warming')
  assert.equal(ops.neverCount, 4)
  assert.equal(ops.liveCount, 0)
  assert.equal(ops.headline, 'Autonomy engine warming up — no scheduled jobs have run yet')
})

test('assessOps: a degraded live engine names the failing runs in the headline', () => {
  const runs = [
    { job: 'sync',     status: 'success', ran_at: NOW - 1 * H },
    { job: 'watchdog', status: 'error',   ran_at: NOW - 5 * MIN },  // on cadence but errored
    { job: 'insights', status: 'success', ran_at: NOW - 2 * H },
    { job: 'digest',   status: 'success', ran_at: NOW - 1 * DAY },
  ]
  const ops = assessOps({ runs, now: NOW })
  assert.equal(ops.status, 'live')
  assert.equal(ops.degradedCount, 1)
  assert.equal(ops.headline, 'Autonomy engine live — all 4 jobs on cadence (1 job ran with errors)')
})

test('assessOps surfaces the trailing self-heal tally and an ISO now', () => {
  const runs = [
    { job: 'watchdog', status: 'success', ran_at: NOW - 5 * MIN, detail: { healed: 2 } },
    { job: 'watchdog', status: 'success', ran_at: NOW - 3 * DAY, detail: { healed: 4 } },
  ]
  const ops = assessOps({ runs, now: NOW })
  assert.equal(ops.healsRecent, 6)
  assert.equal(ops.healWindowMs, HEAL_WINDOW_MS)
  assert.equal(ops.now, new Date(NOW).toISOString())
})

test('assessOps is pure — it never mutates the runs it is given', () => {
  const runs = [
    { job: 'sync', status: 'success', ran_at: NOW - 2 * H },
    { job: 'sync', status: 'success', ran_at: NOW - 1 * H },
  ]
  const before = JSON.stringify(runs)
  assessOps({ runs, now: NOW })
  assert.equal(JSON.stringify(runs), before)
})

// ── recordHeartbeat: the ledger writer ──────────────────────────────────────────
test('recordHeartbeat with an explicit now writes ISO ran_at + JSON detail', async () => {
  const q = captureQuery()
  const r = await recordHeartbeat({
    query: q, job: 'watchdog', status: 'success', durationMs: 1234,
    detail: { healed: 2, scanned: 11 }, now: NOW,
  })
  assert.equal(q.calls.length, 1)
  assert.match(q.calls[0].sql, /INSERT INTO job_heartbeats/)
  assert.match(q.calls[0].sql, /ran_at/, 'explicit ran_at column is written')
  assert.deepEqual(q.calls[0].params, [
    'watchdog', 'success', new Date(NOW).toISOString(), 1234, '{"healed":2,"scanned":11}',
  ])
  assert.deepEqual(r, { job: 'watchdog', status: 'success', ranAt: new Date(NOW).toISOString() })
})

test('recordHeartbeat without now relies on the column DEFAULT (no ran_at in the SQL)', async () => {
  const q = captureQuery()
  await recordHeartbeat({ query: q, job: 'sync', status: 'partial', durationMs: 50, detail: null })
  assert.doesNotMatch(q.calls[0].sql, /ran_at/)
  assert.deepEqual(q.calls[0].params, ['sync', 'partial', 50, null])
})

test('recordHeartbeat passes a string detail through untouched and defaults status to success', async () => {
  const q = captureQuery()
  const r = await recordHeartbeat({ query: q, job: 'insights', detail: 'already-json', now: NOW })
  assert.equal(q.calls[0].params[1], 'success', 'status defaults to success')
  assert.equal(q.calls[0].params[4], 'already-json', 'a string detail is not re-stringified')
  assert.equal(r.status, 'success')
})

test('recordHeartbeat fails loud on bad inputs (so a typo cannot write garbage)', async () => {
  await assert.rejects(() => recordHeartbeat({ job: 'sync', now: NOW }), /query function is required/)
  await assert.rejects(() => recordHeartbeat({ query: captureQuery(), job: 'nope', now: NOW }), /unknown job/)
  await assert.rejects(
    () => recordHeartbeat({ query: captureQuery(), job: 'sync', status: 'weird', now: NOW }),
    /invalid status/,
  )
})

// ── classifyRunStatus: counters → run status ─────────────────────────────────────
test('classifyRunStatus maps the (processed, failed) pair to success/partial/error', () => {
  assert.equal(classifyRunStatus(10, 0), 'success', 'nothing failed → success')
  assert.equal(classifyRunStatus(0, 0), 'success', 'an empty sweep is a clean no-op, not an error')
  assert.equal(classifyRunStatus(8, 2), 'partial', 'some through, some failed → partial')
  assert.equal(classifyRunStatus(0, 3), 'error', 'every attempt failed → error')
})

test('classifyRunStatus coerces non-finite counters to zero (never throws, never NaN)', () => {
  assert.equal(classifyRunStatus(undefined, undefined), 'success')
  assert.equal(classifyRunStatus(null, null), 'success')
  assert.equal(classifyRunStatus('5', '1'), 'partial', 'numeric strings coerce')
  assert.equal(classifyRunStatus(NaN, 4), 'error', 'NaN processed with real failures → error')
  assert.equal(classifyRunStatus(2, NaN), 'success', 'NaN failures count as zero failures')
})

// ── loadRecentRuns: the ledger reader ────────────────────────────────────────────
// A fake `query` that answers the two read shapes loadRecentRuns issues: the
// per-job "latest" read (… ORDER BY ran_at DESC LIMIT 1, param [job]) and the
// watchdog heal-window read (… AND ran_at >= $2).
function routeQuery({ latest = {}, healWindow = [] } = {}) {
  const calls = []
  const fn = async (sql, params) => {
    calls.push({ sql, params })
    if (/LIMIT 1/.test(sql)) {
      const row = latest[params[0]]
      return { rows: row ? [row] : [] }
    }
    if (/ran_at >=/.test(sql)) return { rows: healWindow }
    return { rows: [] }
  }
  fn.calls = calls
  return fn
}

test('loadRecentRuns merges latest-per-job with the heal window and dedupes the shared watchdog row by id', async () => {
  const wdLatest = { id: 2, job: 'watchdog', status: 'success', ran_at: new Date(NOW - 5 * MIN).toISOString(), detail: { healed: 2 } }
  const q = routeQuery({
    latest: {
      sync:     { id: 1, job: 'sync',     status: 'success', ran_at: new Date(NOW - 2 * H).toISOString() },
      watchdog: wdLatest,
      insights: { id: 3, job: 'insights', status: 'success', ran_at: new Date(NOW - 6 * H).toISOString() },
      digest:   { id: 4, job: 'digest',   status: 'success', ran_at: new Date(NOW - 2 * DAY).toISOString() },
    },
    healWindow: [
      wdLatest,                                                                                                       // same id:2 — must NOT double count
      { id: 5, job: 'watchdog', status: 'success', ran_at: new Date(NOW - 2 * DAY).toISOString(), detail: { healed: 1 } },
    ],
  })

  const runs = await loadRecentRuns({ query: q, now: NOW })
  const ids = runs.map(r => r.id).sort((a, b) => a - b)
  assert.deepEqual(ids, [1, 2, 3, 4, 5], 'one row per job + the extra heal row; watchdog id:2 appears once')

  // The dedupe is provable through the heal tally: 2 + 1, NOT 2 + 1 + 2.
  const ops = assessOps({ runs, now: NOW })
  assert.equal(ops.healsRecent, 3, 'shared watchdog row counted once')
})

test('loadRecentRuns requires a query function', async () => {
  await assert.rejects(() => loadRecentRuns({ now: NOW }), /query function is required/)
})

test('loadRecentRuns without a now skips the heal-window read entirely', async () => {
  const q = routeQuery({ latest: { sync: { id: 1, job: 'sync', status: 'success', ran_at: new Date(NOW).toISOString() } } })
  const runs = await loadRecentRuns({ query: q })
  assert.equal(q.calls.length, JOBS.length, 'only the per-job latest reads run — no heal-window query')
  for (const c of q.calls) assert.match(c.sql, /LIMIT 1/, 'every issued read is a bounded latest-per-job read')
  assert.deepEqual(runs.map(r => r.id), [1])
})

test('loadRecentRuns reads the latest row per job UNBOUNDED so a long-stalled job still returns (grades stale, not never)', async () => {
  const q = routeQuery({
    latest: { sync: { id: 9, job: 'sync', status: 'success', ran_at: new Date(NOW - 30 * DAY).toISOString() } },
  })
  const runs = await loadRecentRuns({ query: q, now: NOW })
  const perJob = q.calls.filter(c => /LIMIT 1/.test(c.sql))
  assert.equal(perJob.length, JOBS.length)
  for (const c of perJob) assert.doesNotMatch(c.sql, /ran_at >=/, 'the latest-per-job read carries no lower-bound cutoff')
  const sync = runs.find(r => r.job === 'sync')
  assert.ok(sync, 'a 30-day-stalled sync row is still loaded')
  assert.equal(assessJob('sync', sync, NOW).status, 'stale', 'and grades stale, not a misleading never')
})

test('loadRecentRuns scopes the heal-window read to watchdog with an ISO now-minus-window cutoff', async () => {
  const q = routeQuery({ healWindow: [] })
  await loadRecentRuns({ query: q, now: NOW })
  const heal = q.calls.find(c => /ran_at >=/.test(c.sql))
  assert.ok(heal, 'a heal-window read was issued')
  assert.equal(heal.params[0], 'watchdog', 'heal read is scoped to the watchdog job')
  assert.equal(heal.params[1], new Date(NOW - HEAL_WINDOW_MS).toISOString(), 'cutoff is now minus the heal window, ISO')
})

// ── constants: documented contract ──────────────────────────────────────────────
test('constants mirror the scheduler cadences and grading factors', () => {
  assert.deepEqual(JOBS, ['sync', 'watchdog', 'insights', 'digest'])
  assert.deepEqual(RUN_STATUSES, ['success', 'partial', 'error'])
  assert.equal(EXPECTED_MS.sync, 6 * H)
  assert.equal(EXPECTED_MS.watchdog, 15 * MIN)
  assert.equal(EXPECTED_MS.insights, 24 * H)
  assert.equal(EXPECTED_MS.digest, 7 * DAY)
  assert.equal(GRACE_FACTOR, 1.5)
  assert.equal(STALE_FACTOR, 3)
  assert.equal(HEAL_WINDOW_MS, 7 * DAY)
})
