'use strict'

/**
 * Google OAuth2 consent flow for connecting Google Ads / GA4 / GBP.
 * Routes are PUBLIC (no JWT) — browser redirects, not API calls.
 *
 * GET  /api/auth/google?clientId=...  → redirect to Google consent page
 * GET  /api/auth/google/callback      → exchange code, store tokens, redirect to /connections
 */

const express = require('express')
const crypto  = require('crypto')
const { query } = require('../db')
const router = express.Router()

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const REDIRECT_URI         = process.env.GOOGLE_REDIRECT_URI  || 'http://localhost:3001/api/auth/google/callback'
const FRONTEND_ORIGIN      = process.env.ALLOWED_ORIGIN       || 'http://localhost:5173'

// In-memory state store (good enough for single-instance dev)
const pendingStates = new Map()

router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google OAuth not configured' })
  }

  const { clientId, channel = 'google_ads' } = req.query
  if (!clientId) return res.status(400).json({ error: 'clientId required' })

  const state = crypto.randomUUID()
  pendingStates.set(state, { clientId, channel, ts: Date.now() })

  // Expire states after 10 minutes
  setTimeout(() => pendingStates.delete(state), 600_000)

  const scopes = [
    'https://www.googleapis.com/auth/adwords',
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/business.manage',
    'openid', 'email',
  ].join(' ')

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id',     GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri',  REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope',         scopes)
  url.searchParams.set('access_type',   'offline')
  url.searchParams.set('prompt',        'consent')
  url.searchParams.set('state',         state)

  res.redirect(url.toString())
})

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query

  if (error) {
    return res.redirect(`${FRONTEND_ORIGIN}/connections?error=${encodeURIComponent(error)}`)
  }

  const pending = pendingStates.get(state)
  if (!pending) {
    return res.redirect(`${FRONTEND_ORIGIN}/connections?error=invalid_state`)
  }
  pendingStates.delete(state)

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    })

    const tokens = await tokenRes.json()
    if (tokens.error) throw new Error(tokens.error_description || tokens.error)

    // Store in client_connections
    await query(
      `INSERT INTO client_connections (client_id, channel, credentials, is_active, updated_at)
       VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (client_id, channel) DO UPDATE
         SET credentials = EXCLUDED.credentials,
             is_active   = 1,
             last_error  = NULL,
             updated_at  = CURRENT_TIMESTAMP`,
      [pending.clientId, pending.channel, JSON.stringify(tokens)]
    )

    res.redirect(`${FRONTEND_ORIGIN}/connections?connected=${pending.channel}`)
  } catch (err) {
    console.error('[oauth] callback error', err.message)
    res.redirect(`${FRONTEND_ORIGIN}/connections?error=${encodeURIComponent(err.message)}`)
  }
})

module.exports = router
