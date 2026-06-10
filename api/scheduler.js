// Auto-sync scheduler — runs every 6 hours by default
// Iterates all active client_connections and calls runSync for each.
// The schedule can be overridden via SYNC_CRON env var (cron syntax).
//
// External cron alternative (for Render free tier which sleeps):
//   Point a cron service (render.com cron job, GitHub Actions, etc.) to:
//   POST https://your-api.onrender.com/api/sync/all
//   with Authorization: Bearer <CRON_SECRET>  (set CRON_SECRET in env)

const cron           = require('node-cron')
const { query }      = require('./db')
const { runSync }    = require('./routes/sync')
const { sendDigest, sendBriefDeliveryAlert, sendImpactWinsAlert } = require('./lib/emailDigest')
const { getOrGenerateRecap, getRecap } = require('./lib/recap')
const { detectImpactMilestone } = require('./lib/impactPush')
const { runInsightsForAll }  = require('./lib/insights')
const { listRecentBriefs }      = require('./lib/brief')
const { summarizeBriefQuality } = require('./lib/briefQuality')
const { assessBriefDelivery, narrateBriefDelivery } = require('./lib/briefDelivery')
const { runConnectionWatchdog } = require('./lib/connectionWatchdog')
const { recordHeartbeat, classifyRunStatus, loadRecentRuns, assessOps } = require('./lib/opsHealth')
const { planJobRecovery } = require('./lib/opsRecovery')
const { fireAlert }       = require('./lib/alertDelivery')

const SCHEDULE          = process.env.SYNC_CRON     || '0 */6 * * *'  // every 6 hours
const DIGEST_SCHEDULE   = process.env.DIGEST_CRON   || '0 8 * * 1'    // Monday 8am UTC
const INSIGHTS_SCHEDULE = process.env.INSIGHTS_CRON || '0 7 * * *'    // daily 7am UTC
const WATCHDOG_SCHEDULE   = process.env.WATCHDOG_CRON   || '*/15 * * * *' // every 15 minutes
const THRESHOLD_SCHEDULE  = process.env.THRESHOLD_CRON  || '30 7 * * *'   // daily 7:30am UTC

// Minimal stats builder for digest (mirrors deriveStats in metrics.js)
function digestStats(row) {
  const f = k => parseFloat(row?.[k]) || 0
  const spend = f('ads_spend') + f('lsa_spend') + f('meta_spend')
  const rev   = f('projected_revenue')
  return {
    total_revenue: rev,
    total_closed:  f('closed_won'),
    total_leads:   f('raw_leads'),
    roas:          spend > 0 ? rev / spend : 0,
  }
}

const DIGEST_AGG = `
  COALESCE(SUM(ads_spend),0)        AS ads_spend,
  COALESCE(SUM(lsa_spend),0)        AS lsa_spend,
  COALESCE(SUM(meta_spend),0)       AS meta_spend,
  COALESCE(SUM(raw_leads),0)        AS raw_leads,
  COALESCE(SUM(closed_won),0)       AS closed_won,
  COALESCE(SUM(projected_revenue),0) AS projected_revenue
`

function startScheduler() {
  if (!cron.validate(SCHEDULE)) {
    console.warn('[scheduler] invalid SYNC_CRON, using default 0 */6 * * *')
  }

  cron.schedule(SCHEDULE, async () => {
    console.log('[scheduler] starting scheduled sync', new Date().toISOString())

    const startedAt = Date.now()
    let total = 0
    let errors = 0
    let fatal = false

    try {
      const { rows } = await query(
        `SELECT client_id, channel FROM client_connections WHERE is_active = true`
      )

      for (const { client_id, channel } of rows) {
        try {
          const r = await runSync(client_id, channel)
          console.log(`[scheduler] ${channel} → client ${client_id}: ${r.rows} rows`)
          total++
        } catch (err) {
          console.error(`[scheduler] ${channel} → client ${client_id}: ${err.message}`)
          errors++
        }
      }
    } catch (err) {
      fatal = true
      console.error('[scheduler] fatal', err)
    }

    console.log(`[scheduler] done — ${total} succeeded, ${errors} failed`)

    // Heartbeat — record this run so the autonomy-liveness layer (lib/opsHealth)
    // can prove the sync sweep is alive and on-cadence. Best-effort and fully
    // isolated: a ledger write must NEVER disturb the sweep it records. A fatal
    // enumeration failure records 'error' (engine alive but degraded), never a
    // false 'success'. detail carries aggregate counters only — never client PII.
    try {
      await recordHeartbeat({
        query,
        job: 'sync',
        status: fatal ? 'error' : classifyRunStatus(total, errors),
        durationMs: Date.now() - startedAt,
        detail: { scanned: total + errors, synced: total, failed: errors },
        now: new Date().toISOString(),
      })
    } catch (err) {
      console.error('[scheduler] heartbeat record failed (sync):', err.message)
    }
  })

  console.log(`[scheduler] running on schedule: ${SCHEDULE}`)

  // ── Weekly email digest — Monday 8am ──────────────────────────────────────
  cron.schedule(DIGEST_SCHEDULE, async () => {
    console.log('[digest] starting weekly digest', new Date().toISOString())
    const startedAt = Date.now()
    let sent = 0, errors = 0
    let fatal = false

    const now          = new Date()
    const weekAgo      = new Date(now); weekAgo.setUTCDate(weekAgo.getUTCDate() - 7)
    const twoWeeksAgo  = new Date(now); twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14)
    const cutCurr      = weekAgo.toISOString().slice(0, 10)
    const cutPrev      = twoWeeksAgo.toISOString().slice(0, 10)
    const thisMonthDay = new Date().toISOString().slice(0, 7) + '-01'

    try {
      const { rows: clients } = await query(
        `SELECT id, name, digest_email, unsubscribe_token
           FROM clients
          WHERE digest_enabled = true AND digest_email IS NOT NULL`
      )

      for (const client of clients) {
        try {
          const [currR, prevR, goalR, updR] = await Promise.all([
            query(`SELECT ${DIGEST_AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`, [client.id, cutCurr]),
            query(`SELECT ${DIGEST_AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2 AND week_start < $3`, [client.id, cutPrev, cutCurr]),
            query(`SELECT * FROM client_goals   WHERE client_id = $1 AND month = $2 LIMIT 1`, [client.id, thisMonthDay]),
            query(`SELECT * FROM client_updates WHERE client_id = $1 ORDER BY week_start DESC LIMIT 1`, [client.id]),
          ])

          // Grounded AI recap for the same completed week the digest summarizes.
          // getOrGenerateRecap caches in ai_recaps, so the LLM is hit at most once
          // per client-week. Never blocks the send: on any failure we fall back to
          // the manual client_updates note inside buildHtml.
          let recapText = null
          let recapObj  = null
          try {
            recapObj  = await getOrGenerateRecap(client.id)
            recapText = recapObj?.recap_text || null
          } catch (err) {
            console.error(`[digest] recap failed for ${client.name}: ${err.message}`)
          }

          await sendDigest({
            client,
            stats:     digestStats(currR.rows[0]),
            prevStats: digestStats(prevR.rows[0]),
            goal:      goalR.rows[0] || null,
            update:    updR.rows[0]  || null,
            recap:     recapText,
          })
          console.log(`[digest] ✓ ${client.name} → ${client.digest_email}`)
          sent++

          // ── Client wins milestone (intel-v12 B4) ─────────────────────────────
          // Event-driven, autonomous, leak-proof. The week a client's intelligence
          // track record first crosses into PROVEN (detectImpactMilestone fires a
          // false→true crossing), send ONE celebratory client note carrying only the
          // figure-free {note}. Reads the impact snapshot off the recap we just built
          // and compares it to the prior week's STORED recap (getRecap never generates,
          // so an absent prior is treated as not-proven → a first-ever proven week is
          // itself the milestone). In its OWN try so it never disturbs the digest
          // accounting above — a missed celebration costs nothing, a broken digest does.
          try {
            const currImpact = recapObj?.evidence_pack?.intelligence?.impact || null
            const currWeek   = recapObj?.week_start || null
            if (currImpact && currWeek) {
              const d = new Date(`${currWeek}T00:00:00Z`)
              d.setUTCDate(d.getUTCDate() - 7)
              const priorWeek  = d.toISOString().slice(0, 10)
              const prevRecap  = await getRecap(client.id, priorWeek)
              const prevImpact = prevRecap?.evidence_pack?.intelligence?.impact || null
              const push = detectImpactMilestone(prevImpact, currImpact)
              if (push.reached && push.note) {
                const r = await sendImpactWinsAlert({ client, push })
                console.log(`[wins] ${client.name} crossed to proven` +
                  (r.sent ? ` → ${r.to}` : ` (${r.reason})`))
              }
            }
          } catch (err) {
            console.error(`[wins] ${client.name}: ${err.message}`)
          }
        } catch (err) {
          console.error(`[digest] ✗ ${client.name}: ${err.message}`)
          errors++
        }
      }

      if (!clients.length) console.log('[digest] no clients with digest enabled')
    } catch (err) {
      fatal = true
      console.error('[digest] fatal', err)
    }

    console.log(`[digest] done — ${sent} sent, ${errors} errors`)

    // Heartbeat — record the weekly digest run for the autonomy-liveness layer.
    // Isolated so a ledger write never disturbs the (already-sent) client emails.
    // detail carries only aggregate send counts — never a recipient or PII.
    try {
      await recordHeartbeat({
        query,
        job: 'digest',
        status: fatal ? 'error' : classifyRunStatus(sent, errors),
        durationMs: Date.now() - startedAt,
        detail: { sent, errors },
        now: new Date().toISOString(),
      })
    } catch (err) {
      console.error('[digest] heartbeat record failed:', err.message)
    }

    // ── Narration self-check — does the agency need to know its OWN brief-writer
    //    is failing? ────────────────────────────────────────────────────────────
    // The digest above is per-client and client-facing; this is its agency-only
    // counterpart. Grade the last 30 mornings of our own narrator and, ONLY when
    // its voice is degrading, push a single internal alert (BRIEF_ALERT_TO) with the
    // self-heal step. Silent + self-healing otherwise — clients already saw the safe,
    // grounded template, so nothing they received was ever wrong. Isolated in its own
    // try so a brief-health hiccup can't disturb the client digest run above, and
    // placed AFTER it so it fires even if the digest loop itself threw.
    try {
      const briefRows = await listRecentBriefs({ asOf: null, days: 30 })
      const signal    = assessBriefDelivery(summarizeBriefQuality(briefRows))
      const narrative = narrateBriefDelivery(signal, { audience: 'agency' })
      const latestAsOf = briefRows.length ? briefRows[briefRows.length - 1].as_of : null
      const r = await sendBriefDeliveryAlert({ signal, narrative, asOf: latestAsOf })
      console.log(`[brief-alert] narrator ${signal.status}` +
        (r.sent ? ` → alerted ${r.to}` : ` (${r.reason})`))
    } catch (err) {
      console.error('[brief-alert] fatal', err.message)
    }
  })

  console.log(`[scheduler] digest on schedule: ${DIGEST_SCHEDULE}`)

  // ── Nightly intelligence sweep — the autonomous heartbeat ─────────────────
  // Runs the full self-improving pass for every client: grade closed projections,
  // learn each client's calibration, detect findings with the learned knobs, and
  // snapshot this month for later grading. No operator involved — this is what
  // makes the layer self-sustaining. Fired before the Monday digest so its email
  // can read fresh insights. runInsightsForAll isolates per-client failures, so a
  // single bad client never sinks the sweep.
  if (!cron.validate(INSIGHTS_SCHEDULE)) {
    console.warn('[insights] invalid INSIGHTS_CRON, using default 0 7 * * *')
  }
  cron.schedule(INSIGHTS_SCHEDULE, async () => {
    console.log('[insights] starting nightly sweep', new Date().toISOString())
    const startedAt = Date.now()
    let r = null
    try {
      r = await runInsightsForAll()
      console.log(`[insights] done — ${r.swept}/${r.clients} clients, ${r.findings} findings, ${r.failed} failed`)
      for (const e of r.errors) console.error(`[insights] client ${e.client_id}: ${e.error}`)
    } catch (err) {
      console.error('[insights] fatal', err)
    }

    // Heartbeat — record the nightly self-improving sweep for the autonomy-liveness
    // layer. A throw leaves r=null → recorded 'error' (engine alive, sweep failed).
    // detail carries only aggregate sweep counts — never a client identifier.
    try {
      await recordHeartbeat({
        query,
        job: 'insights',
        status: r ? classifyRunStatus(r.swept, r.failed) : 'error',
        durationMs: Date.now() - startedAt,
        detail: r
          ? { swept: r.swept, clients: r.clients, findings: r.findings, failed: r.failed }
          : { swept: 0, clients: 0, findings: 0, failed: 0 },
        now: new Date().toISOString(),
      })
    } catch (err) {
      console.error('[insights] heartbeat record failed:', err.message)
    }
  })

  console.log(`[scheduler] insights on schedule: ${INSIGHTS_SCHEDULE}`)

  // ── WoW threshold alerts — daily 7:30am UTC ───────────────────────────────────
  // Compares the two most recent weekly_reports rows per client. Fires a warning
  // for revenue or lead drops >20% WoW and a critical for >40% drops. Skips any
  // client with fewer than 2 weeks of data. Prior-week baseline must be non-zero
  // to avoid false alarms on clients with no data in a given week.
  cron.schedule(THRESHOLD_SCHEDULE, async () => {
    console.log('[threshold] starting WoW check', new Date().toISOString())
    try {
      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() - 21)
      const cutoffStr = cutoff.toISOString().slice(0, 10)

      const { rows } = await query(
        `SELECT wr.client_id, c.name AS client_name, wr.week_start,
                COALESCE(wr.projected_revenue, 0) AS revenue,
                COALESCE(wr.raw_leads, 0)         AS leads
           FROM weekly_reports wr
           JOIN clients c ON c.id = wr.client_id
          WHERE wr.week_start >= $1
          ORDER BY wr.client_id, wr.week_start DESC`,
        [cutoffStr]
      )

      const byClient = {}
      for (const row of rows) {
        if (!byClient[row.client_id]) byClient[row.client_id] = { name: row.client_name, weeks: [] }
        if (byClient[row.client_id].weeks.length < 2) byClient[row.client_id].weeks.push(row)
      }

      for (const [, data] of Object.entries(byClient)) {
        const [curr, prev] = data.weeks
        if (!curr || !prev) continue

        const checks = [
          { metric: 'Revenue', curr: Number(curr.revenue), prev: Number(prev.revenue) },
          { metric: 'Leads',   curr: Number(curr.leads),   prev: Number(prev.leads)   },
        ]
        for (const c of checks) {
          if (c.prev <= 0) continue
          const drop = (c.prev - c.curr) / c.prev
          if (drop <= 0.2) continue
          const pct      = Math.round(drop * 100)
          const severity = drop >= 0.4 ? 'critical' : 'warning'
          fireAlert({
            title:      `${data.name} — ${c.metric} down ${pct}% WoW`,
            body:       `${data.name} ${c.metric.toLowerCase()} fell from ${c.prev.toFixed(0)} to ${c.curr.toFixed(0)} (−${pct}%) vs the prior week.`,
            severity,
            clientName: data.name,
            metric:     c.metric,
            value:      `-${pct}%`,
          })
          console.log(`[threshold] ${severity.toUpperCase()}: ${data.name} ${c.metric} −${pct}%`)
        }
      }
    } catch (err) {
      console.error('[threshold] fatal:', err.message)
    }
  })
  console.log(`[scheduler] threshold alerts on schedule: ${THRESHOLD_SCHEDULE}`)

  // ── Self-healing pipeline watchdog — every 15 minutes (intel-v11) ─────────────
  // The 6-hour sync sweep above is the bulk heartbeat; this is the tight, SELECTIVE,
  // backoff-gated recovery loop that keeps channels from going dark between sweeps. It
  // reads every connection's recent sync history, lets the brain (connectionHealth) judge
  // each one, and re-syncs ONLY the connections whose deterministic exponential backoff
  // has come due — never hammering, always plateauing, never giving up on a transient
  // fault. The Class-C invariant is absolute: AUTH failures (operator_required) are never
  // in the due set, so a revoked credential is surfaced for a human reconnect and NEVER
  // auto-retried. runConnectionWatchdog isolates each connection's failure, so one bad
  // re-sync can't sink the sweep. An in-flight guard skips a tick if the previous sweep
  // is still running (a long recovery batch must never stack on itself).
  if (!cron.validate(WATCHDOG_SCHEDULE)) {
    console.warn('[watchdog] invalid WATCHDOG_CRON, using default */15 * * * *')
  }

  // ── ops-v2 self-heal: the executor-owned job→re-run map ─────────────────────
  // The ONLY jobs the watchdog may auto-recover, each mapped to its pure, idempotent,
  // internal re-run. insights is the lone safe target — a heavy nightly sweep with no
  // recovery organ of its own (sync has the per-connection watchdog below; digest =
  // external comms and watchdog = circular are HARD-denied inside opsRecovery and can
  // never be added here). RECOVERABLE_JOBS derives from the map's keys so the allow-list
  // can never drift from what is actually executable. The cooldown ledger persists across
  // ticks (a process restart resets it — acceptable, a restart is itself a fresh start) so
  // a genuinely-failing sweep backs off 2h instead of thrashing every 15 minutes.
  const RECOVERY_THUNKS  = { insights: () => runInsightsForAll() }
  const RECOVERABLE_JOBS = Object.keys(RECOVERY_THUNKS)
  const recoveryCooldown = {}

  let watchdogRunning = false
  cron.schedule(WATCHDOG_SCHEDULE, async () => {
    if (watchdogRunning) {
      console.log('[watchdog] previous sweep still running — skipping this tick')
      return
    }
    watchdogRunning = true
    const startedAt = Date.now()
    let r = null
    try {
      r = await runConnectionWatchdog({ query, runSync, logger: console })
      console.log(
        `[watchdog] swept ${r.scanned} — ${r.healed} re-synced, ${r.failed} failed, ` +
        `${r.operator_required} need reconnect`
      )
    } catch (err) {
      console.error('[watchdog] fatal', err.message)
    } finally {
      watchdogRunning = false
    }

    // ── Self-healing CLOSURE (ops-v2) ─────────────────────────────────────────────
    // Seeing an overdue/stale job is not healing — this is the HAND that acts on what
    // opsHealth SEES. Grade the engine off the same ledger the agency strip reads, ask
    // the pure planner which recoverable jobs are due (allow-list ∩ status ∩ cooldown ∩
    // cap), then re-run each and STAMP A FRESH heartbeat for it — that heartbeat is what
    // actually re-grades the job 'live' and clears the overdue condition, so the loop is
    // genuinely closed, not merely re-run. Fully isolated: a recovery fault can never
    // crash the tick (its own try), and every attempt — success OR failure — stamps the
    // cooldown so a broken sweep backs off instead of being hammered every 15 minutes.
    let recovered = 0
    let recoveryFailed = 0
    try {
      const nowIso     = new Date().toISOString()
      const runs       = await loadRecentRuns({ query, now: nowIso })
      const assessment = assessOps({ runs, now: nowIso })
      const plan = planJobRecovery({
        assessment,
        recoverable: RECOVERABLE_JOBS,
        cooldownLedger: recoveryCooldown,
        now: Date.now(),
      })

      for (const item of plan.recover) {
        const thunk = RECOVERY_THUNKS[item.job]
        if (typeof thunk !== 'function') continue
        recoveryCooldown[item.job] = Date.now()   // stamp the ATTEMPT — back off win or lose
        const recStart = Date.now()
        try {
          const res    = await thunk()
          const status = res ? classifyRunStatus(res.swept, res.failed) : 'error'
          // Stamp a fresh heartbeat for the recovered job — this is what re-grades it
          // 'live' (or live+degraded) and closes the overdue condition. Mirrors exactly
          // what that job's own cron records after a normal run. Its own try so a ledger
          // write never disturbs the recovery accounting.
          try {
            await recordHeartbeat({
              query,
              job: item.job,
              status,
              durationMs: Date.now() - recStart,
              detail: res
                ? { swept: res.swept, clients: res.clients, findings: res.findings, failed: res.failed, recovered_by: 'watchdog' }
                : { swept: 0, clients: 0, findings: 0, failed: 0, recovered_by: 'watchdog' },
              now: new Date().toISOString(),
            })
          } catch (e) {
            console.error(`[watchdog] recovery heartbeat failed (${item.job}):`, e.message)
          }
          if (status === 'error') {
            recoveryFailed++
            console.error(`[watchdog] recovery ${item.job}: re-ran but graded error (was ${item.status})`)
          } else {
            recovered++
            console.log(`[watchdog] recovery ${item.job}: re-ran ${status} — cleared ${item.status}`)
          }
        } catch (err) {
          recoveryFailed++
          console.error(`[watchdog] recovery ${item.job} threw:`, err.message)
        }
      }

      if (plan.skipped.length) {
        console.log('[watchdog] recovery held:', plan.skipped.map((s) => `${s.job}:${s.reason}`).join(', '))
      }
    } catch (err) {
      console.error('[watchdog] recovery pass failed:', err.message)
    }

    // Heartbeat — record this watchdog sweep for the autonomy-liveness layer. The
    // watchdog is the self-healing organ itself; its 15-min heartbeat is what proves
    // the loop is still actively watching. A throw leaves r=null → recorded 'error'.
    // detail carries only aggregate machine counters — never client PII. The job
    // recoveries performed just above FOLD into `healed` (so the existing "N self-heals"
    // counter surfaces them with no new read path) and are also broken out distinctly.
    try {
      await recordHeartbeat({
        query,
        job: 'watchdog',
        status: r ? classifyRunStatus(r.scanned, r.failed) : 'error',
        durationMs: Date.now() - startedAt,
        detail: r
          ? { scanned: r.scanned, healed: (r.healed || 0) + recovered, failed: r.failed, operator_required: r.operator_required, job_recovered: recovered, job_recovery_failed: recoveryFailed }
          : { scanned: 0, healed: recovered, failed: 0, operator_required: 0, job_recovered: recovered, job_recovery_failed: recoveryFailed },
        now: new Date().toISOString(),
      })
    } catch (err) {
      console.error('[watchdog] heartbeat record failed:', err.message)
    }
  })

  console.log(`[scheduler] watchdog on schedule: ${WATCHDOG_SCHEDULE}`)
}

module.exports = { startScheduler }
