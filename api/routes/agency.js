const express = require('express')
const { query } = require('../db')
const router = express.Router()

const AGENCY_DEFAULTS = { agency_name: '10X Performance', accent_hex: '#e53935', logo_url: null, contact_email: null, calendar_url: null }

// GET /api/agency/settings — public (client view + shared report need it)
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await query('SELECT agency_name, accent_hex, logo_url, contact_email, calendar_url FROM agency_settings WHERE id = 1')
    res.json(rows[0] || AGENCY_DEFAULTS)
  } catch (err) {
    console.error('[agency] GET settings', err.message)
    res.json(AGENCY_DEFAULTS)
  }
})

// PUT /api/agency/settings — agency auth required (caller mounts with requireAuth)
router.put('/settings', async (req, res) => {
  const { agency_name, accent_hex, logo_url, contact_email, calendar_url } = req.body
  if (!agency_name?.trim()) return res.status(400).json({ error: 'agency_name is required' })
  if (accent_hex && !/^#[0-9a-fA-F]{6}$/.test(accent_hex))
    return res.status(400).json({ error: 'accent_hex must be a 6-digit hex colour e.g. #e53935' })
  try {
    const { rows } = await query(
      `INSERT INTO agency_settings (id, agency_name, accent_hex, logo_url, contact_email, calendar_url, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         agency_name   = EXCLUDED.agency_name,
         accent_hex    = EXCLUDED.accent_hex,
         logo_url      = EXCLUDED.logo_url,
         contact_email = EXCLUDED.contact_email,
         calendar_url  = EXCLUDED.calendar_url,
         updated_at    = now()
       RETURNING agency_name, accent_hex, logo_url, contact_email, calendar_url`,
      [agency_name.trim(), accent_hex || '#e53935', logo_url?.trim() || null,
       contact_email?.trim() || null, calendar_url?.trim() || null]
    )
    res.json(rows[0])
  } catch (err) {
    console.error('[agency] PUT settings', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
