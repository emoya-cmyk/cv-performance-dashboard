'use strict'

// Always-on heartbeat — the external-cron substitute for the in-process scheduler.
//
// Render's free tier SLEEPS the web service after ~15 min idle, which stops the
// in-process node-cron (scheduler.js) dead: no sync, no self-heal watchdog, no
// nightly insights sweep. The autonomy machinery is all there, but a sleeping
// host never fires it. This module is that same work, factored so an EXTERNAL
// cron (a Render Cron Job, GitHub Actions, cron-job.org, ...) can POST one authed
// request and drive it — so the loop survives the host sleeping.
//
// It runs the three IDEMPOTENT, INTERNAL jobs only:
//   sync     — refresh every active connection's facts (runSync per connection)
//   watchdog — the selective, backoff-gated self-heal recovery loop
//   insights — the nightly self-improving intelligence sweep
// The weekly email DIGEST is deliberately NOT here: it sends client-facing emails
// (an external, gated side-effect), so it must never be fired by a bare heartbeat
// ping. It stays on its own weekly cadence in scheduler.js.
//
// Design notes:
//   • Pure & dependency-injected — every collaborator (query, runSync,
//     runInsightsForAll, runConnectionWatchdog, logger) is passed in, so the
//     module is trivially unit-testable with no database and no network.
//   • Per-job isolation — each job runs in its own try/catch and reports a
//     structured { ok, ... } result; one failing job never sinks the others.
//   • Canonical order — sync → watchdog → insights, regardless of the order the
//     caller lists them (fresh facts first, then heal anything dark, then sweep
//     on the fresh data). De-duplicated.
//   • Idempotent — running the heartbeat twice back-to-back is safe: sync UPSERTs
//     facts, the watchdog is deterministic-backoff-gated, insights re-grades and
//     re-snapshots the same window.

const VALID_JOBS = ['sync', 'watchdog', 'insights']

// Sync every active connection — the bulk freshness sweep (mirrors the 6-hour
// SYNC cron in scheduler.js, the same idempotent runSync per connection). Isolates
// each connection's failure so one dead channel never sinks the sweep.
async function runSyncAll({ query, runSync, logger = console }) {
  let scanned = 0, synced = 0, failed = 0
  const errors = []
  const { rows } = await query(
    `SELECT client_id, channel FROM client_connections WHERE is_active = true`
  )
  for (const { client_id, channel } of rows) {
    scanned++
    try {
      const r = await runSync(client_id, channel)
      synced++
      logger.log?.(`[heartbeat:sync] ${channel} → client ${client_id}: ${r && r.rows != null ? r.rows : '?'} rows`)
    } catch (err) {
      failed++
      errors.push({ client_id, channel, error: err.message })
      logger.error?.(`[heartbeat:sync] ${channel} → client ${client_id}: ${err.message}`)
    }
  }
  return { scanned, synced, failed, errors }
}

// Run the requested heartbeat jobs in canonical order, each isolated. Returns
// { ok, jobs, results } where results[job] is the job's structured outcome plus
// { ok, ms }. `ok` is true iff every requested job succeeded.
//
// Throws (code: 'UNKNOWN_JOB') BEFORE running anything if the caller asks for a
// job that doesn't exist — the route turns that into a 400, so a typo'd cron
// config fails loud instead of silently doing nothing.
async function runHeartbeat(deps = {}) {
  const {
    jobs,
    query,
    runSync,
    runInsightsForAll,
    runConnectionWatchdog,
    logger = console,
  } = deps

  const requested = Array.isArray(jobs) && jobs.length ? jobs : VALID_JOBS
  const unknown = requested.filter((j) => !VALID_JOBS.includes(j))
  if (unknown.length) {
    const err = new Error(`unknown job(s): ${unknown.join(', ')}`)
    err.code = 'UNKNOWN_JOB'
    throw err
  }
  // Canonical order, de-duplicated regardless of how the caller listed them.
  const order = VALID_JOBS.filter((j) => requested.includes(j))

  const results = {}
  for (const job of order) {
    const started = Date.now()
    try {
      if (job === 'sync') {
        results.sync = { ok: true, ...(await runSyncAll({ query, runSync, logger })) }
      } else if (job === 'watchdog') {
        const r = await runConnectionWatchdog({ query, runSync, logger })
        results.watchdog = { ok: true, ...r }
      } else if (job === 'insights') {
        const r = await runInsightsForAll()
        results.insights = { ok: true, ...r }
      }
    } catch (err) {
      results[job] = { ok: false, error: err.message }
      logger.error?.(`[heartbeat:${job}] fatal: ${err.message}`)
    }
    results[job].ms = Date.now() - started
  }

  const ok = order.every((j) => results[j] && results[j].ok)
  return { ok, jobs: order, results }
}

module.exports = { runHeartbeat, runSyncAll, VALID_JOBS }
