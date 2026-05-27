// CRUD for client_connections (API credentials per channel)
const express   = require('express')
const { query } = require('../db')

const router = express.Router()

// Lazily load connectors — they may not all be implemented
function getConnector(channel) {
  const map = {
    google_ads: '../connectors/googleAds',
    meta:       '../connectors/meta',
    ghl:        '../connectors/ghl',
    gbp:        '../connectors/gbp',
    ga4:        '../connectors/ga4',
    lsa:        '../connectors/lsa',
  }
  if (!map[channel]) return null
  try { return require(map[channel]) } catch { return null }
}

// GET /api/connections/:clientId — all connections for a client
router.get('/:clientId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT channel, is_active, last_synced_at, last_error, updated_at
       FROM client_connections WHERE client_id = $1`,
      [req.params.clientId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/connections/:clientId/:channel — save credentials
router.put('/:clientId/:channel', async (req, res) => {
  const { clientId, channel } = req.params
  const { credentials = {}, is_active = true } = req.body

  const KNOWN_CHANNELS = ['google_ads', 'meta', 'ghl', 'gbp', 'ga4', 'lsa']
  if (!KNOWN_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `Unknown channel: ${channel}` })
  }

  try {
    await query(
      `INSERT INTO client_connections (client_id, channel, credentials, is_active, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (client_id, channel) DO UPDATE SET
         credentials = $3,
         is_active   = $4,
         last_error  = NULL,
         updated_at  = CURRENT_TIMESTAMP`,
      [clientId, channel, JSON.stringify(credentials), is_active ? 1 : 0]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/connections/:clientId/:channel/test — validate credentials live
router.post('/:clientId/:channel/test', async (req, res) => {
  const { clientId, channel } = req.params
  const connector = getConnector(channel)
  if (!connector) return res.status(400).json({ error: `Channel ${channel} test not implemented` })

  try {
    let creds = req.body?.credentials
    if (!creds) {
      const { rows } = await query(
        `SELECT credentials FROM client_connections WHERE client_id = $1 AND channel = $2`,
        [clientId, channel]
      )
      if (!rows.length) return res.status(404).json({ error: 'No credentials saved yet' })
      creds = typeof rows[0].credentials === 'string'
        ? JSON.parse(rows[0].credentials)
        : rows[0].credentials
    }

    const result = await connector.testConnection(creds)
    res.json(result)
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

// GET /api/connections/schema/:channel — field definitions for the UI form
router.get('/schema/:channel', async (req, res) => {
  const connector = getConnector(req.params.channel)
  if (!connector) return res.status(404).json({ error: 'Unknown channel' })
  res.json({
    required_fields: connector.REQUIRED_FIELDS || [],
    field_labels:    connector.FIELD_LABELS || {},
  })
})

// DELETE /api/connections/:clientId/:channel — remove credentials
router.delete('/:clientId/:channel', async (req, res) => {
  try {
    await query(
      `DELETE FROM client_connections WHERE client_id = $1 AND channel = $2`,
      [req.params.clientId, req.params.channel]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
