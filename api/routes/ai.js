'use strict'

// ============================================================
// routes/ai.js — the Grounded-AI HTTP surface.
//
//   GET  /api/ai/recap/:clientId[?week=YYYY-MM-DD]
//        Read the stored recap, generating + persisting it on first access
//        (getOrGenerateRecap → the LLM is called at most once per client-week).
//        This is what the in-app recap card hits.
//
//   POST /api/ai/recap/:clientId[?week=YYYY-MM-DD]   (week may also be in body)
//        Force a fresh recap and overwrite the stored row — the "Regenerate"
//        button. Always re-narrates + re-verifies.
//
//   POST /api/ai/ask
//        Sprint-2 placeholder (constrained natural-language portfolio queries).
//        Returns 501 until that ships, so the route is reserved but honest.
//
// Mounted behind requireAuth in server.js, so every handler runs authenticated.
// The recap layer never throws on the AI path (it degrades to a deterministic
// template), so 5xx here only ever means a DB/transport fault.
// ============================================================

const express = require('express')
const { query } = require('../db')
const { weekStartOf } = require('../lib/rollup')
const { generateRecap, getOrGenerateRecap } = require('../lib/recap')

const router = express.Router()

// Normalise a caller-supplied week to its Monday. Returns:
//   { week: 'YYYY-MM-DD' }  when a valid date was given,
//   { week: undefined }     when absent (recap layer defaults to last week),
//   { error: '…' }          when present but malformed.
function resolveWeek(raw) {
  if (raw == null || raw === '') return { week: undefined }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    return { error: 'week must be an ISO date (YYYY-MM-DD)' }
  }
  return { week: weekStartOf(String(raw)) }  // snap to the Monday of that week
}

// Recaps FK-reference clients(id); generating one for an unknown client would
// trip the foreign key at insert time. Check up front so we can 404 cleanly.
async function clientExists(clientId) {
  const { rows } = await query(`SELECT id FROM clients WHERE id = $1`, [clientId])
  return rows.length > 0
}

// ── GET /api/ai/recap/:clientId ───────────────────────────────────────────────
// Stored recap, generated-on-miss. Idempotent and cheap on repeat hits.
router.get('/recap/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { week, error } = resolveWeek(req.query.week)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const recap = await getOrGenerateRecap(clientId, week)
    res.json(recap)
  } catch (err) {
    console.error('[ai] GET recap error', err.message)
    res.status(500).json({ error: 'Failed to load recap' })
  }
})

// ── POST /api/ai/recap/:clientId ──────────────────────────────────────────────
// Force regenerate + overwrite. Accepts ?week=… or { week } in the body.
router.post('/recap/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { week, error } = resolveWeek(req.query.week ?? req.body?.week)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const recap = await generateRecap(clientId, week)
    res.json(recap)
  } catch (err) {
    console.error('[ai] POST recap error', err.message)
    res.status(500).json({ error: 'Failed to generate recap' })
  }
})

// ── POST /api/ai/ask ──────────────────────────────────────────────────────────
// Reserved for Sprint 2 (text → constrained query-spec → whitelisted SQL →
// narrate). Not wired yet — answer honestly rather than fake a result.
router.post('/ask', (req, res) => {
  res.status(501).json({
    error: 'Natural-language ask is not available yet.',
    detail: 'Conversational portfolio queries ship in Sprint 2.',
  })
})

module.exports = router
