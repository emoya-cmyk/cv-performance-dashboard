// Sync engine — runs connectors and upserts weekly_reports
// Called by the scheduler, manual "Sync Now" button, or external cron

const express    = require('express')
const { query }  = require('../db')
const { broadcast } = require('./realtime')

const googleAds = require('../connectors/googleAds')
const meta      = require('../connectors/meta')
const ghl       = require('../connectors/ghl')
const gbp       = require('../connectors/gbp')
const ga4       = require('../connectors/ga4')
const lsa       = require('../connectors/lsa')

const router = express.Router()

const CONNECTORS = { google_ads: googleAds, meta, ghl, gbp, ga4, lsa }

// ── Core sync function ────────────────────────────────────────────────────────
async function runSync(clientId, channel, weeksBack = 8) {
  const { rows: connRows } = await query(
    `SELECT credentials FROM client_connections
     WHERE client_id = $1 AND channel = $2 AND is_active = true`,
    [clientId, channel]
  )
  if (!connRows.length) throw new Error(`No active ${channel} connection for this client`)

  const creds     = connRows[0].credentials
  const connector = CONNECTORS[channel]
  if (!connector) throw new Error(`Unknown channel: ${channel}`)

  // Start run log
  const { rows: [run] } = await query(
    `INSERT INTO sync_runs (client_id, channel) VALUES ($1, $2) RETURNING id`,
    [clientId, channel]
  )
  const runId = run.id

  try {
    const rows = await connector.fetchStats(creds, weeksBack)
    let written = 0

    for (const row of rows) {
      await upsertWeeklyReport(clientId, row)
      written++
    }

    await query(
      `UPDATE sync_runs SET status='success', finished_at=NOW(), rows_written=$1 WHERE id=$2`,
      [written, runId]
    )
    await query(
      `UPDATE client_connections
       SET last_synced_at=NOW(), last_error=NULL, updated_at=NOW()
       WHERE client_id=$1 AND channel=$2`,
      [clientId, channel]
    )

    broadcast('refresh', { source: 'sync', channel, clientId })
    return { ok: true, rows: written }

  } catch (err) {
    await query(
      `UPDATE sync_runs SET status='error', finished_at=NOW(), error=$1 WHERE id=$2`,
      [err.message, runId]
    )
    await query(
      `UPDATE client_connections
       SET last_error=$1, updated_at=NOW()
       WHERE client_id=$2 AND channel=$3`,
      [err.message, clientId, channel]
    )
    throw err
  }
}

// Smart upsert: never overwrite a non-zero field with zero
// (prevents Google Ads sync from clearing GHL-sourced CRM data)
async function upsertWeeklyReport(clientId, row) {
  const { week_start, ...fields } = row

  // Strip internal keys prefixed with _
  const clean = {}
  Object.entries(fields).forEach(([k, v]) => {
    if (!k.startsWith('_') && v !== undefined && v !== null) clean[k] = v
  })

  const cols = Object.keys(clean)
  if (!cols.length) return

  // For numeric columns, only update if the incoming value is > 0
  const sets = cols.map(c => `${c} = CASE WHEN EXCLUDED.${c} > 0 THEN EXCLUDED.${c} ELSE weekly_reports.${c} END`)

  await query(
    `INSERT INTO weekly_reports (client_id, week_start, ${cols.join(',')})
     VALUES ($1, $2, ${cols.map((_,i)=>`$${i+3}`).join(',')})
     ON CONFLICT (client_id, week_start) DO UPDATE SET
       ${sets.join(',\n')}, updated_at = NOW()`,
    [clientId, week_start, ...cols.map(c => clean[c])]
  )
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/sync/:clientId/:channel
router.post('/:clientId/:channel', async (req, res) => {
  const { clientId, channel } = req.params
  const weeksBack = parseInt(req.body?.weeksBack || 8, 10)
  try {
    const result = await runSync(clientId, channel, weeksBack)
    res.json(result)
  } catch (err) {
    console.error(`[sync] ${clientId}/${channel}`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/sync/:clientId/all  — sync all active channels for one client
router.post('/:clientId/all', async (req, res) => {
  const { clientId } = req.params
  const { rows: conns } = await query(
    `SELECT channel FROM client_connections WHERE client_id=$1 AND is_active=true`,
    [clientId]
  )
  const results = {}
  for (const { channel } of conns) {
    try {
      results[channel] = await runSync(clientId, channel)
    } catch (err) {
      results[channel] = { error: err.message }
    }
  }
  res.json(results)
})

// POST /api/sync/all  — sync every active connection across all clients
router.post('/all', async (req, res) => {
  const { rows: conns } = await query(
    `SELECT client_id, channel FROM client_connections WHERE is_active=true`
  )
  const results = []
  for (const { client_id, channel } of conns) {
    try {
      const r = await runSync(client_id, channel)
      results.push({ client_id, channel, ...r })
    } catch (err) {
      results.push({ client_id, channel, error: err.message })
    }
  }
  res.json({ synced: results.length, results })
})

// GET /api/sync/:clientId/status — last sync times per channel
router.get('/:clientId/status', async (req, res) => {
  const { clientId } = req.params
  const { rows } = await query(
    `SELECT channel, last_synced_at, last_error, is_active
     FROM client_connections WHERE client_id=$1`,
    [clientId]
  )
  res.json(rows)
})

// GET /api/sync/:clientId/history — recent sync run log
router.get('/:clientId/history', async (req, res) => {
  const { clientId } = req.params
  const { rows } = await query(
    `SELECT channel, status, started_at, finished_at, rows_written, error
     FROM sync_runs WHERE client_id=$1
     ORDER BY started_at DESC LIMIT 20`,
    [clientId]
  )
  res.json(rows)
})

module.exports = { router, runSync }
