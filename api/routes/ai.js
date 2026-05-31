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
//   POST /api/ai/ask   { question }
//        Natural-language portfolio queries. The question is parsed into a typed,
//        whitelisted query-spec, compiled to parameterised SQL (never text→SQL),
//        executed for deterministic numbers, then optionally narrated under the
//        same grounding verifier as the recap. See lib/ask.js for the full model.
//
// Mounted behind requireAuth in server.js, so every handler runs authenticated.
// The recap layer never throws on the AI path (it degrades to a deterministic
// template), so 5xx here only ever means a DB/transport fault.
// ============================================================

const express = require('express')
const { query } = require('../db')
const { weekStartOf } = require('../lib/rollup')
const { generateRecap, getOrGenerateRecap } = require('../lib/recap')
const { runAsk } = require('../lib/ask')

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
// Body: { question: string }. Returns the deterministic rows plus a grounded
// one-line answer. runAsk tags failures with a .code we map to honest statuses:
//   NO_AI          → 503  (no ANTHROPIC_API_KEY configured)
//   EMPTY          → 400  (blank question)
//   UNPARSEABLE    → 422  (couldn't map the question onto the query schema)
//   PARSE_TRANSPORT→ 502  (the language model was unreachable)
const ASK_STATUS = { NO_AI: 503, EMPTY: 400, UNPARSEABLE: 422, PARSE_TRANSPORT: 502 }

router.post('/ask', async (req, res) => {
  const question = req.body?.question
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' })
  }

  try {
    const result = await runAsk(question)
    res.json(result)
  } catch (err) {
    const status = ASK_STATUS[err.code]
    if (status) {
      return res.status(status).json({ error: err.message, code: err.code })
    }
    console.error('[ai] POST ask error', err.message)
    res.status(500).json({ error: 'Failed to answer question' })
  }
})

module.exports = router
