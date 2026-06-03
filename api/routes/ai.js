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
//   GET  /api/ai/brief/:clientId[?as_of=YYYY-MM-DD]
//   POST /api/ai/brief/:clientId[?as_of=YYYY-MM-DD]
//        The daily analog of the recap: a client's grounded "morning brief" over
//        one day's pulse. GET is generated-on-miss (once per client-day); POST
//        force-regenerates. See lib/brief.js + lib/pulseBrief.js.
//
//   GET  /api/ai/brief[?as_of=YYYY-MM-DD]
//   POST /api/ai/brief[?as_of=YYYY-MM-DD]
//        The agency portfolio morning brief (the whole book's pulse). AGENCY-ONLY
//        — the prose names other clients — so a client-scoped token is refused.
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
const {
  generateClientBrief, generatePortfolioBrief,
  getOrGenerateClientBrief, getOrGeneratePortfolioBrief,
} = require('../lib/brief')
const { runAsk, runSuggestions, runExplain } = require('../lib/ask')

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

// A brief is keyed on a single calendar DAY (the pulse's as_of), not a week — so
// unlike resolveWeek there is NO Monday snap. Returns:
//   { asOf: 'YYYY-MM-DD' }  when a valid date was given,
//   { asOf: undefined }     when absent (brief layer defaults to today, UTC),
//   { error: '…' }          when present but malformed.
function resolveAsOf(raw) {
  if (raw == null || raw === '') return { asOf: undefined }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    return { error: 'as_of must be an ISO date (YYYY-MM-DD)' }
  }
  return { asOf: String(raw) }
}

// The portfolio brief is narrated prose that NAMES other clients (headline +
// "also" lines), so — unlike the openly-readable raw GET /pulse roster — only an
// explicit agency token may ever read it; any client-scoped token is refused.
// Mirrors the allow-list posture of resolveAskScope (agency role is the gate).
function resolvePortfolioScope(req) {
  const user = req.user || {}
  if (user.role === 'agency') return {}
  return { error: 'not authorized for the portfolio brief', status: 403 }
}

// Recaps FK-reference clients(id); generating one for an unknown client would
// trip the foreign key at insert time. Check up front so we can 404 cleanly.
async function clientExists(clientId) {
  const { rows } = await query(`SELECT id FROM clients WHERE id = $1`, [clientId])
  return rows.length > 0
}

// Derive the HARD client boundary for an ask from the authenticated token —
// never from a body param a caller could forge to widen their own view. The
// posture is an allow-list: only an explicit `agency` role may ever see across
// clients; every other token is pinned to its own client_id or refused.
//   agency role → may optionally narrow to one client via clientId (body for the
//                 POST ask, query for the GET suggestions; must exist → 404);
//                 absent → the whole book (null scope).
//   any other   → hard-pinned to its own token client_id; the body's clientId is
//                 ignored. No client_id on a non-agency token is a broken account
//                 that can't be safely scoped → 403.
// lib/ask.js re-enforces this id at compile time, so even a spec that tries to
// group_by:'client' or names a different client collapses to the scoped total —
// this route check and that compile check are defence-in-depth for each other.
async function resolveAskScope(req) {
  const user = req.user || {}
  if (user.role === 'agency') {
    const wanted = req.body?.clientId ?? req.query?.clientId
    if (wanted != null && wanted !== '') {
      if (!(await clientExists(wanted))) return { error: 'client not found', status: 404 }
      return { scopeClientId: wanted }
    }
    return { scopeClientId: null }  // whole book
  }
  if (user.client_id) return { scopeClientId: user.client_id }
  return { error: 'not authorized for portfolio queries', status: 403 }
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

// ── GET /api/ai/brief/:clientId ───────────────────────────────────────────────
// A client's grounded morning brief for one day, generated-on-miss
// (getOrGenerateClientBrief → the LLM is called at most once per client-day).
// Idempotent and cheap on repeat hits. ?as_of=YYYY-MM-DD selects the day; absent
// → today (UTC). This is what the in-app client brief card hits.
router.get('/brief/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const brief = await getOrGenerateClientBrief(clientId, asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] GET brief error', err.message)
    res.status(500).json({ error: 'Failed to load brief' })
  }
})

// ── POST /api/ai/brief/:clientId ──────────────────────────────────────────────
// Force a fresh client brief and overwrite the stored row — the "Regenerate"
// button. Always re-narrates + re-verifies. Accepts ?as_of=… or { as_of } in body.
router.post('/brief/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { asOf, error } = resolveAsOf(req.query.as_of ?? req.body?.as_of)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const brief = await generateClientBrief(clientId, asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] POST brief error', err.message)
    res.status(500).json({ error: 'Failed to generate brief' })
  }
})

// ── GET /api/ai/brief ─────────────────────────────────────────────────────────
// The agency portfolio morning brief, generated-on-miss. AGENCY-ONLY: the prose
// names other clients, so a client-scoped token is refused (resolvePortfolioScope).
// ?as_of=YYYY-MM-DD selects the day; absent → today (UTC).
router.get('/brief', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })

  try {
    const brief = await getOrGeneratePortfolioBrief(asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] GET portfolio brief error', err.message)
    res.status(500).json({ error: 'Failed to load brief' })
  }
})

// ── POST /api/ai/brief ────────────────────────────────────────────────────────
// Force-regenerate the agency portfolio brief and overwrite the stored row.
// AGENCY-ONLY. Accepts ?as_of=… or { as_of } in the body.
router.post('/brief', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of ?? req.body?.as_of)
  if (error) return res.status(400).json({ error })

  try {
    const brief = await generatePortfolioBrief(asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] POST portfolio brief error', err.message)
    res.status(500).json({ error: 'Failed to generate brief' })
  }
})

// ── POST /api/ai/ask ──────────────────────────────────────────────────────────
// Body: { question: string, clientId?: string }. Returns the deterministic rows
// plus a grounded one-line answer, scoped to whatever the caller is allowed to
// see (resolveAskScope): a client token only ever sees its own data; an agency
// token sees the whole book, or one client when it passes clientId. runAsk tags
// failures with a .code we map to honest statuses:
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
    const scope = await resolveAskScope(req)
    if (scope.error) return res.status(scope.status).json({ error: scope.error })

    const result = await runAsk(question, { scopeClientId: scope.scopeClientId })
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

// ── POST /api/ai/ask/explain ──────────────────────────────────────────────────
// Body: { spec: <the spec runAsk returned>, clientId?: string }. The grounded
// "why did it change?" click-through: given the SAME typed spec a prior /ask
// answer carried, decompose its period-over-period agency move into exact
// per-client contributions (lib/ask.runExplain → lib/contribution). No LLM, pure
// DB arithmetic, so no ANTHROPIC_API_KEY needed. Scoped by the SAME resolveAskScope
// boundary as /ask — a client token only ever explains its own (and runExplain
// returns null for a scoped caller, since a per-client view has no cross-client
// "who"). A spec that isn't decomposable (non-additive metric, already grouped, or
// no comparable prior window) → 422 NOT_EXPLAINABLE; the UI only offers the chip
// when runAsk flagged meta.explainable, so that 422 is the rare race, not the norm.
router.post('/ask/explain', async (req, res) => {
  const spec = req.body?.spec
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return res.status(400).json({ error: 'spec is required' })
  }

  try {
    const scope = await resolveAskScope(req)
    if (scope.error) return res.status(scope.status).json({ error: scope.error })

    const result = await runExplain(spec, { scopeClientId: scope.scopeClientId })
    if (!result) {
      return res.status(422).json({ error: 'this question cannot be broken down by client', code: 'NOT_EXPLAINABLE' })
    }
    res.json(result)
  } catch (err) {
    const status = ASK_STATUS[err.code]
    if (status) {
      return res.status(status).json({ error: err.message, code: err.code })
    }
    console.error('[ai] POST ask/explain error', err.message)
    res.status(500).json({ error: 'Failed to explain change' })
  }
})

// ── GET /api/ai/ask/suggestions[?clientId=…] ──────────────────────────────────
// Dynamic opening chips for the Ask box: the biggest period-over-period movers
// for whatever the caller is allowed to see — the SAME resolveAskScope boundary
// as POST /ask (a client token only ever gets its own movers; an agency token
// gets the whole book, or one client via ?clientId). Pure DB aggregation, NO LLM,
// so it never needs ANTHROPIC_API_KEY. A soft/runtime fault degrades to an empty
// list (HTTP 200) so the box quietly falls back to its static suggestions instead
// of surfacing an error on first paint. The scope authz boundary (403/404) is
// still honoured — only runtime faults degrade.
router.get('/ask/suggestions', async (req, res) => {
  try {
    const scope = await resolveAskScope(req)
    if (scope.error) return res.status(scope.status).json({ error: scope.error })

    const { suggestions, window_label } = await runSuggestions({ scopeClientId: scope.scopeClientId })
    res.json({ suggestions, window_label })
  } catch (err) {
    console.error('[ai] GET ask/suggestions error', err.message)
    res.json({ suggestions: [], window_label: 'vs the prior week' })  // soft-degrade, never 5xx
  }
})

module.exports = router
// Exposed for unit tests — the route's hard client-scope boundary. Attaching it
// to the exported router leaves the express mount (router-as-middleware) intact.
module.exports.resolveAskScope = resolveAskScope
