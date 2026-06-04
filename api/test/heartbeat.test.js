'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { runHeartbeat, runSyncAll, VALID_JOBS } = require('../lib/heartbeat')

// Silent logger double so the tests don't spam stdout. Both methods optional —
// the module guards with `?.`, but we provide them to assert call counts.
function quietLogger() {
  return { log() {}, error() {} }
}

// A fake `query` that returns a fixed active-connections set for the sync sweep.
function connQuery(conns) {
  return async () => ({ rows: conns })
}

// ── runSyncAll ────────────────────────────────────────────────────────────────
test('runSyncAll syncs every active connection and tallies the result', async () => {
  const conns = [
    { client_id: 'c1', channel: 'google_ads' },
    { client_id: 'c1', channel: 'ghl' },
    { client_id: 'c2', channel: 'meta' },
  ]
  const seen = []
  const runSync = async (client_id, channel) => { seen.push(`${channel}:${client_id}`); return { rows: 7 } }

  const r = await runSyncAll({ query: connQuery(conns), runSync, logger: quietLogger() })

  assert.equal(r.scanned, 3)
  assert.equal(r.synced, 3)
  assert.equal(r.failed, 0)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(seen, ['google_ads:c1', 'ghl:c1', 'meta:c2'], 'runSync called once per active connection')
})

test('runSyncAll isolates a per-connection failure — one dead channel never sinks the sweep', async () => {
  const conns = [
    { client_id: 'c1', channel: 'google_ads' },
    { client_id: 'c2', channel: 'meta' },     // this one throws
    { client_id: 'c3', channel: 'lsa' },
  ]
  const runSync = async (client_id, channel) => {
    if (channel === 'meta') throw new Error('token expired')
    return { rows: 3 }
  }

  const r = await runSyncAll({ query: connQuery(conns), runSync, logger: quietLogger() })

  assert.equal(r.scanned, 3)
  assert.equal(r.synced, 2, 'the two healthy channels still synced')
  assert.equal(r.failed, 1)
  assert.deepEqual(r.errors, [{ client_id: 'c2', channel: 'meta', error: 'token expired' }])
})

// ── runHeartbeat: orchestration ─────────────────────────────────────────────────
test('runHeartbeat runs all three jobs in canonical order by default', async () => {
  const order = []
  const deps = {
    query: connQuery([{ client_id: 'c1', channel: 'google_ads' }]),
    runSync: async () => { order.push('sync'); return { rows: 1 } },
    runConnectionWatchdog: async () => { order.push('watchdog'); return { scanned: 1, healed: 0, failed: 0, operator_required: 0 } },
    runInsightsForAll: async () => { order.push('insights'); return { swept: 1, clients: 1, findings: 2, failed: 0, errors: [] } },
    logger: quietLogger(),
  }

  const r = await runHeartbeat(deps)

  assert.equal(r.ok, true)
  assert.deepEqual(r.jobs, ['sync', 'watchdog', 'insights'])
  // sync runs runSync inside the sweep, so 'sync' appears first, then the others.
  assert.deepEqual(order, ['sync', 'watchdog', 'insights'], 'canonical execution order')
  assert.equal(r.results.sync.ok, true)
  assert.equal(r.results.sync.synced, 1)
  assert.equal(r.results.watchdog.ok, true)
  assert.equal(r.results.insights.ok, true)
  assert.equal(r.results.insights.findings, 2)
  for (const j of r.jobs) assert.equal(typeof r.results[j].ms, 'number', `${j} carries an ms timing`)
})

test('runHeartbeat runs only the requested subset — still in canonical order', async () => {
  const order = []
  const deps = {
    jobs: ['insights', 'sync'],   // reversed on purpose
    query: connQuery([]),
    runSync: async () => ({ rows: 0 }),
    runConnectionWatchdog: async () => { order.push('watchdog'); return {} },
    runInsightsForAll: async () => { order.push('insights'); return { swept: 0, clients: 0, findings: 0, failed: 0, errors: [] } },
    logger: quietLogger(),
  }
  // mark sync via a logger? simpler: push from runSync isn't hit (no conns). Use the result jobs list.
  const r = await runHeartbeat(deps)

  assert.deepEqual(r.jobs, ['sync', 'insights'], 'watchdog omitted; canonical order despite reversed input')
  assert.equal(order.includes('watchdog'), false, 'watchdog never ran')
  assert.equal(r.results.watchdog, undefined)
  assert.equal(r.ok, true)
})

test('runHeartbeat isolates a throwing job — the others still run, overall ok=false', async () => {
  const deps = {
    query: connQuery([{ client_id: 'c1', channel: 'google_ads' }]),
    runSync: async () => ({ rows: 1 }),
    runConnectionWatchdog: async () => { throw new Error('watchdog blew up') },
    runInsightsForAll: async () => ({ swept: 1, clients: 1, findings: 0, failed: 0, errors: [] }),
    logger: quietLogger(),
  }

  const r = await runHeartbeat(deps)

  assert.equal(r.ok, false, 'a single job failure makes the overall heartbeat not-ok')
  assert.equal(r.results.sync.ok, true, 'sync still ran and succeeded')
  assert.equal(r.results.watchdog.ok, false)
  assert.equal(r.results.watchdog.error, 'watchdog blew up')
  assert.equal(r.results.insights.ok, true, 'insights still ran after the watchdog threw')
  assert.equal(typeof r.results.watchdog.ms, 'number')
})

test('runHeartbeat rejects an unknown job before running anything', async () => {
  let ran = false
  const deps = {
    jobs: ['sync', 'digest'],   // 'digest' is intentionally NOT a heartbeat job
    query: connQuery([]),
    runSync: async () => { ran = true; return { rows: 0 } },
    runConnectionWatchdog: async () => { ran = true; return {} },
    runInsightsForAll: async () => { ran = true; return {} },
    logger: quietLogger(),
  }

  await assert.rejects(
    () => runHeartbeat(deps),
    (err) => err.code === 'UNKNOWN_JOB' && /digest/.test(err.message),
    'unknown job throws UNKNOWN_JOB and names the offender'
  )
  assert.equal(ran, false, 'nothing runs when validation fails — fail loud, not silently')
})

test('runHeartbeat passes the right deps into the watchdog', async () => {
  let received = null
  const query = connQuery([])
  const runSync = async () => ({ rows: 0 })
  const deps = {
    jobs: ['watchdog'],
    query,
    runSync,
    runConnectionWatchdog: async (args) => { received = args; return { scanned: 0 } },
    runInsightsForAll: async () => ({}),
    logger: quietLogger(),
  }

  await runHeartbeat(deps)

  assert.equal(received.query, query, 'watchdog gets the same query handle')
  assert.equal(received.runSync, runSync, 'watchdog gets runSync so it can re-sync due connections')
  assert.ok(received.logger, 'watchdog gets a logger')
})

test('VALID_JOBS is the canonical heartbeat job set, in order', () => {
  assert.deepEqual(VALID_JOBS, ['sync', 'watchdog', 'insights'])
})
