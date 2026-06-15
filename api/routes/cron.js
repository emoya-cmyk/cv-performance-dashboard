'use strict'

// External-cron entry point — the authenticated HTTP surface that drives the
// in-process scheduler's idempotent work when the host has been asleep.
//
// WHY THIS EXISTS
//   Render's free tier sleeps the web service after ~15 min idle, which stops the
//   in-process node-cron (scheduler.js) dead. The autonomy machinery is all there
//   but a sleeping host never fires it. An EXTERNAL cron (a Render Cron Job, a
//   GitHub Actions schedule, cron-job.org, ...) POSTs one authed request here and
//   drives the same three idempotent internal jobs — so the self-healing loop
//   survives the host sleeping. (The weekly client-email DIGEST is deliberately
//   NOT reachable here; see lib/heartbeat.js.)
//
//   This router is mounted OUTSIDE requireAuth in server.js (a cron service holds
//   no user JWT), so cronAuth below is its ONLY gate. It must be strict and it
//   must fail CLOSED.

const crypto  = require('crypto')
const express = require('express')

const { query }                 = require('../db')
const { runSync }               = require('./sync')
const { runInsightsForAll }     = require('../lib/insights')
const { runConnectionWatchdog } = require('../lib/connectionWatchdog')
const { runHeartbeat, VALID_JOBS } = require('../lib/heartbeat')
const { governMemory }          = require('../lib/memoryGovernor')
const { captureAllClients }     = require('../lib/memoryCapture')

// Constant-time bearer-token guard for the cron driver.
//
//   • FAILS CLOSED — if CRON_SECRET is unset the endpoint is 503 (disabled),
//     never open. A missing secret must never read as "let everyone in"; the
//     operator provisions CRON_SECRET (Class-C) to arm the route.
//   • CONSTANT-TIME — both sides are SHA-256'd to a fixed 32 bytes and compared
//     with crypto.timingSafeEqual, so a caller can neither probe the secret by
//     timing 401s nor learn its length from a short-circuit. Hashing also lets an
//     empty/garbage header compare safely (no length-mismatch throw).
//   • Read at REQUEST time (not module load) so the closed→armed transition needs
//     no restart and can't be fooled by load order.
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'cron endpoint disabled (CRON_SECRET unset)' })
  }
  const header    = req.get('authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest()
  if (!crypto.timingSafeEqual(sha(presented), sha(secret))) {
    return res.status(401).json({ error: 'invalid cron credential' })
  }
  next()
}

const router = express.Router()

// GET /api/cron/health — public liveness probe for the cron driver itself.
// Reports whether the route is ARMED (CRON_SECRET present) WITHOUT requiring the
// secret, so an external monitor can confirm the endpoint is mounted and armed.
// Returns only booleans + the job catalog — never the secret, never client data.
router.get('/health', (_req, res) => {
  res.json({
    ok:    true,
    armed: Boolean(process.env.CRON_SECRET),
    jobs:  VALID_JOBS,
    ts:    new Date().toISOString(),
  })
})

// GET /api/cron/tick — Vercel cron driver (cronAuth-gated).
// Vercel sends GET requests (not POST) and automatically adds
//   Authorization: Bearer $CRON_SECRET
// so the existing cronAuth middleware gates it identically to /heartbeat.
// Runs all three idempotent jobs (sync → watchdog → insights) on every tick.
// Schedule is defined in vercel.json "crons"; each invocation is idempotent.
router.get('/tick', cronAuth, async (_req, res) => {
  try {
    const result = await runHeartbeat({
      query,
      runSync,
      runInsightsForAll,
      runConnectionWatchdog,
      logger: console,
    })
    res.json(result)
  } catch (err) {
    if (err.code === 'UNKNOWN_JOB') {
      return res.status(400).json({ error: err.message, code: 'UNKNOWN_JOB' })
    }
    res.status(500).json({ error: err.message })
  }
})

// POST /api/cron/heartbeat — the external-cron entry point (cronAuth-gated).
// Runs the three idempotent internal jobs (sync → watchdog → insights) in
// canonical order, or the subset named in req.body.jobs, against the SAME
// collaborators the scheduler uses. Response contract:
//   • 200 { ok, jobs, results } — the heartbeat RAN. A single job's internal
//     failure is isolated (results[job].ok === false) and still returns 200,
//     because the request was well-formed and the heartbeat executed.
//   • 400 — a malformed REQUEST: an unknown job name (UNKNOWN_JOB, nothing ran)
//     or a `jobs` field that isn't an array (BAD_JOBS). Fail loud on a typo'd
//     cron config instead of silently doing the wrong thing.
//   • 500 — an unexpected error escaping the orchestrator.
router.post('/heartbeat', cronAuth, async (req, res) => {
  const jobs = req.body && req.body.jobs
  if (jobs !== undefined && !Array.isArray(jobs)) {
    return res.status(400).json({ error: 'jobs must be an array of job names', code: 'BAD_JOBS' })
  }
  try {
    const result = await runHeartbeat({
      jobs,
      query,
      runSync,
      runInsightsForAll,
      runConnectionWatchdog,
      logger: console,
    })
    res.json(result)
  } catch (err) {
    if (err.code === 'UNKNOWN_JOB') {
      return res.status(400).json({ error: err.message, code: 'UNKNOWN_JOB' })
    }
    res.status(500).json({ error: err.message })
  }
})

// POST /api/cron/memory — the DAILY memory-autonomy driver (cronAuth-gated).
// Separate from /heartbeat on purpose: memory governance + capture are daily/
// weekly work, not the ~15-min heartbeat cadence — so they ride their own
// external cron. This is what makes the Memory OS self-heal/self-capture even on
// a free-tier host whose in-process node-cron is asleep. Each step is isolated;
// a single step's failure still returns 200 with that step's { ok:false } so a
// well-formed request never 500s on an internal hiccup. Fails CLOSED on auth like
// every cron route (503 without CRON_SECRET, 401 on a bad bearer).
router.post('/memory', cronAuth, async (_req, res) => {
  const result = { ok: true, governance: null, capture: null }
  try {
    result.governance = await governMemory()           // never throws; returns an audit
    if (result.governance && result.governance.ok === false) result.ok = false
  } catch (err) {
    result.ok = false; result.governance = { ok: false, reason: err.message }
  }
  try {
    result.capture = await captureAllClients()          // per-client isolated
  } catch (err) {
    result.ok = false; result.capture = { ok: false, error: err.message }
  }
  res.json(result)
})

module.exports = { router, cronAuth }
