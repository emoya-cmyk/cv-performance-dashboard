'use strict'

/**
 * HubSpot webhook receiver.
 * POST /api/webhooks/hubspot
 *
 * Signature verified via x-hubspot-signature (v1 SHA-256 HMAC).
 */

const express = require('express')
const crypto  = require('crypto')
const { query } = require('../../db')
const { broadcast } = require('../realtime')
const router  = express.Router()

const HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || ''

function verifySignature(req) {
  if (!HUBSPOT_CLIENT_SECRET) return true
  const sig = req.headers['x-hubspot-signature'] || ''
  const body = req.rawBody?.toString() || ''
  const expected = crypto
    .createHmac('sha256', HUBSPOT_CLIENT_SECRET)
    .update(HUBSPOT_CLIENT_SECRET + body)
    .digest('hex')
  return sig === expected
}

router.post('/', async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'invalid signature' })
  }

  const events = Array.isArray(req.body) ? req.body : [req.body]
  console.log(`[webhook/hubspot] received ${events.length} event(s)`)

  try {
    for (const event of events) {
      const portalId = String(event?.portalId || event?.portal_id || '')
      if (!portalId) continue

      const { rows } = await query(
        `SELECT id FROM clients WHERE hubspot_portal_id = $1`,
        [portalId]
      )
      if (!rows.length) continue

      broadcast('hubspot_event', {
        clientId: rows[0].id,
        type:     event.subscriptionType || 'unknown',
        ts:       new Date().toISOString(),
      })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[webhook/hubspot] error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
