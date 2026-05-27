'use strict'

/**
 * GoHighLevel webhook receiver.
 * POST /api/webhooks/ghl
 *
 * GHL sends contact/opportunity events. We map them to our weekly_reports / lead funnel data.
 * Signature verified via HMAC-SHA256 (x-ghl-signature header).
 */

const express  = require('express')
const crypto   = require('crypto')
const { query }  = require('../../db')
const { broadcast } = require('../realtime')
const router   = express.Router()

const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || ''

function verifySignature(req) {
  if (!GHL_WEBHOOK_SECRET) return true  // skip in dev if not configured
  const sig = req.headers['x-ghl-signature'] || ''
  const expected = crypto
    .createHmac('sha256', GHL_WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('hex')
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

router.post('/', async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'invalid signature' })
  }

  const event = req.body
  console.log('[webhook/ghl] received event:', event?.type || 'unknown')

  try {
    // Map GHL location_id → our client_id
    const locationId = event?.location_id || event?.locationId
    if (!locationId) return res.json({ ok: true, skipped: 'no location_id' })

    const { rows } = await query(
      `SELECT id FROM clients WHERE ghl_location_id = $1`,
      [locationId]
    )
    if (!rows.length) return res.json({ ok: true, skipped: 'unknown location' })

    const clientId = rows[0].id

    // Broadcast to SSE clients so the dashboard refreshes
    broadcast('ghl_event', { clientId, type: event.type, ts: new Date().toISOString() })

    res.json({ ok: true })
  } catch (err) {
    console.error('[webhook/ghl] error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
