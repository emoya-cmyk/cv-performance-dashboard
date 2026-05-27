'use strict'

/**
 * Supermetrics webhook receiver.
 * POST /api/webhooks/supermetrics
 *
 * Receives scheduled data pushes from Supermetrics.
 * Verified via x-supermetrics-secret header or x-wh-signature.
 */

const express = require('express')
const crypto  = require('crypto')
const { query } = require('../../db')
const { broadcast } = require('../realtime')
const router  = express.Router()

const SUPERMETRICS_SECRET = process.env.SUPERMETRICS_WEBHOOK_SECRET || ''

function verifySignature(req) {
  if (!SUPERMETRICS_SECRET) return true
  const secret = req.headers['x-supermetrics-secret'] || req.headers['x-wh-signature'] || ''
  return secret === SUPERMETRICS_SECRET
}

router.post('/', async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'invalid secret' })
  }

  const payload = req.body
  console.log('[webhook/supermetrics] received payload for', payload?.client_id || 'unknown client')

  try {
    if (!payload?.client_id) {
      return res.status(400).json({ error: 'client_id required in payload' })
    }

    const { rows } = await query(
      `SELECT id FROM clients WHERE id = $1`,
      [payload.client_id]
    )
    if (!rows.length) return res.status(404).json({ error: 'client not found' })

    // Broadcast refresh signal
    broadcast('supermetrics_sync', {
      clientId: payload.client_id,
      source:   payload.source || 'unknown',
      ts:       new Date().toISOString(),
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[webhook/supermetrics] error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
