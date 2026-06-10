const express = require('express')
const { query } = require('../db')
const { requireAgency, scopeClientParam, scopeClientId } = require('../middleware/authz')
const router = express.Router()

// GET /api/clients
// Agency sees every client; a scoped 'client' token sees ONLY its own row (and
// nothing at all if its token carries no client_id). scopeClientId returns the
// caller's hard client id, or null for an agency caller (no confinement). This
// is a FILTER, not a reject — the list endpoint must still answer, just narrowed.
router.get('/', async (req, res) => {
  try {
    if (req.user && req.user.role === 'client') {
      const scopeId = scopeClientId(req)
      if (!scopeId) return res.json([])
      const { rows } = await query(
        `SELECT id, name, location, industry, status, ghl_location_id, hubspot_portal_id,
                contact_email, calendar_url
         FROM clients WHERE id = $1`,
        [scopeId]
      )
      return res.json(rows)
    }
    const { rows } = await query(
      `SELECT id, name, location, industry, status, ghl_location_id, hubspot_portal_id,
              contact_email, calendar_url, am_owner
       FROM clients ORDER BY name`
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/clients  (create/onboard a new client) — agency only
router.post('/', requireAgency, async (req, res) => {
  const { name, location, industry, ghl_location_id, hubspot_portal_id, contact_email, calendar_url, am_owner } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })
  try {
    const { rows } = await query(
      `INSERT INTO clients (name, location, industry, ghl_location_id, hubspot_portal_id, contact_email, calendar_url, am_owner)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (ghl_location_id) DO UPDATE
         SET name = EXCLUDED.name, location = EXCLUDED.location,
             industry = EXCLUDED.industry, hubspot_portal_id = EXCLUDED.hubspot_portal_id,
             contact_email = EXCLUDED.contact_email, calendar_url = EXCLUDED.calendar_url,
             am_owner = EXCLUDED.am_owner
       RETURNING *`,
      [name, location, industry, ghl_location_id || null, hubspot_portal_id || null,
       contact_email || null, calendar_url || null, am_owner || null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/clients/:id — a client may read only its own record
router.get('/:id', scopeClientParam('id'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, location, industry, status, ghl_location_id, hubspot_portal_id,
              contact_email, calendar_url, updated_at
       FROM clients WHERE id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/clients/:id — agency only
router.put('/:id', requireAgency, async (req, res) => {
  const { name, location, industry, status, ghl_location_id, hubspot_portal_id, contact_email, calendar_url, am_owner } = req.body
  try {
    const { rows } = await query(
      `UPDATE clients
          SET name               = COALESCE($2, name),
              location           = COALESCE($3, location),
              industry           = COALESCE($4, industry),
              status             = COALESCE($5, status),
              ghl_location_id    = COALESCE($6, ghl_location_id),
              hubspot_portal_id  = COALESCE($7, hubspot_portal_id),
              contact_email      = COALESCE($8, contact_email),
              calendar_url       = COALESCE($9, calendar_url),
              am_owner           = COALESCE($10, am_owner),
              updated_at         = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [req.params.id, name, location, industry, status, ghl_location_id, hubspot_portal_id,
       contact_email, calendar_url, am_owner]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/clients/:id — agency only
router.delete('/:id', requireAgency, async (req, res) => {
  try {
    await query(`DELETE FROM clients WHERE id = $1`, [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
