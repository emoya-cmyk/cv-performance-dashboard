'use strict'

// ============================================================
// lib/brief.js — orchestrate + persist ONE grounded "morning brief" per scope/day.
//
//   getClientPulse / getPortfolioPulse        (deterministic daily pulse)
//        → buildClientBriefPack / buildPortfolioBriefPack  (numbers-only pack)
//        → generateBriefText   (narrate-only LLM + grounding verifier + fallback)
//        → upsert into ai_briefs   (idempotent on scope_key, as_of)
//
// The daily analog of lib/recap.js. Where a recap narrates a completed WEEK for
// one client, a brief narrates a single DAY's pulse — for either audience. Two
// audiences share one table:
//   * a client brief   keyed on  scope_key = clientId          (audience 'client')
//   * the portfolio    keyed on  scope_key = '__portfolio__'   (audience 'agency')
// client_id is a reference-only column (NULL for the portfolio brief) and is
// never part of the key, because the portfolio brief has no single client.
//
// Idempotent by design: re-running a day overwrites in place via the
// PRIMARY KEY (scope_key, as_of) ON CONFLICT arbiter, so a morning job and a
// manual "regenerate" both converge on one row. Never throws on the AI path —
// generateBriefText already degrades to a deterministic, grounded template.
// ============================================================

const { query }                                          = require('../db')
const { getClientPulse, getPortfolioPulse }              = require('./insights')
const { buildClientBriefPack, buildPortfolioBriefPack }  = require('./pulseBrief')
const { generateBriefText }                              = require('./ai')

// The portfolio brief spans every client, so it has no client id to key on; it
// lives under this single reserved scope. Exported so the route layer and tests
// reference the one constant instead of re-typing the sentinel.
const PORTFOLIO_KEY = '__portfolio__'

// Calendar day the brief narrates. Today in UTC — byte-identical to the default
// day getClientPulse (via loadDailySeries) and getPortfolioPulse compute when
// asOf is omitted, so a read-without-generate keys on exactly the day a generate
// would have produced. A brief is a single DAY's pulse, so there is no Monday
// snap (that is the recap's week grain, not ours).
function defaultAsOf() {
  return new Date().toISOString().slice(0, 10)
}

const safeParse = (s) => { try { return JSON.parse(s) } catch { return {} } }

// `pack` reads back as a parsed object on Postgres (JSONB) but a JSON string on
// SQLite (TEXT); `grounded` as a boolean vs 0/1. Normalise both so callers get
// one stable shape regardless of backend (mirrors normalizeRecapRow).
function normalizeBriefRow(row) {
  if (!row) return null
  return {
    scope_key:  row.scope_key,
    as_of:      row.as_of,
    audience:   row.audience,
    client_id:  row.client_id,
    model:      row.model,
    brief_text: row.brief_text,
    grounded:   !!row.grounded,
    pack: typeof row.pack === 'string' ? safeParse(row.pack) : (row.pack || {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// One upsert shape for both audiences and both backends. 1/0 for the
// BOOLEAN(pg)/INTEGER(sqlite) `grounded` column; JSON string for the JSONB/TEXT
// `pack` — the same cross-backend idiom as lib/recap.js / routes/connections.js.
async function upsertBrief({ scopeKey, asOf, audience, clientId, model, pack, text, grounded }) {
  await query(
    `INSERT INTO ai_briefs
       (scope_key, as_of, audience, client_id, model, pack, brief_text, grounded, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
     ON CONFLICT (scope_key, as_of) DO UPDATE SET
       audience   = EXCLUDED.audience,
       client_id  = EXCLUDED.client_id,
       model      = EXCLUDED.model,
       pack       = EXCLUDED.pack,
       brief_text = EXCLUDED.brief_text,
       grounded   = EXCLUDED.grounded,
       updated_at = CURRENT_TIMESTAMP`,
    [scopeKey, asOf, audience, clientId, model, JSON.stringify(pack), text, grounded ? 1 : 0]
  )
}

/**
 * Build, narrate, verify and persist a client's morning brief for one day.
 * @param {string} clientId
 * @param {string} [asOf] 'YYYY-MM-DD'; defaults to today (UTC).
 * @returns {Promise<{scope_key,as_of,audience,client_id,model,brief_text,grounded,pack}>}
 */
async function generateClientBrief(clientId, asOf) {
  const day   = asOf || defaultAsOf()
  const pulse = await getClientPulse(clientId, { asOf: day })
  const pack  = buildClientBriefPack(pulse)
  const { text, model, grounded } = await generateBriefText(pack)

  await upsertBrief({
    scopeKey: clientId, asOf: day, audience: 'client', clientId,
    model, pack, text, grounded,
  })

  return {
    scope_key: clientId, as_of: day, audience: 'client', client_id: clientId,
    model, brief_text: text, grounded, pack,
  }
}

/**
 * Build, narrate, verify and persist the agency portfolio morning brief for one day.
 * @param {string} [asOf] 'YYYY-MM-DD'; defaults to today (UTC).
 */
async function generatePortfolioBrief(asOf) {
  const day   = asOf || defaultAsOf()
  const pulse = await getPortfolioPulse({ asOf: day })
  const pack  = buildPortfolioBriefPack(pulse)
  const { text, model, grounded } = await generateBriefText(pack)

  await upsertBrief({
    scopeKey: PORTFOLIO_KEY, asOf: day, audience: 'agency', clientId: null,
    model, pack, text, grounded,
  })

  return {
    scope_key: PORTFOLIO_KEY, as_of: day, audience: 'agency', client_id: null,
    model, brief_text: text, grounded, pack,
  }
}

// Read a stored brief without (re)generating. Returns null if none exists yet.
async function getBrief(scopeKey, asOf) {
  const day = asOf || defaultAsOf()
  const { rows } = await query(
    `SELECT * FROM ai_briefs WHERE scope_key = $1 AND as_of = $2`,
    [scopeKey, day]
  )
  return normalizeBriefRow(rows[0])
}

const getClientBrief    = (clientId, asOf) => getBrief(clientId, asOf)
const getPortfolioBrief = (asOf)           => getBrief(PORTFOLIO_KEY, asOf)

// Return the stored brief if present, else generate + persist one. Used by the
// in-app brief card route so the LLM is called at most once per scope per day.
async function getOrGenerateClientBrief(clientId, asOf) {
  const existing = await getClientBrief(clientId, asOf)
  if (existing && existing.brief_text) return existing
  return generateClientBrief(clientId, asOf)
}

async function getOrGeneratePortfolioBrief(asOf) {
  const existing = await getPortfolioBrief(asOf)
  if (existing && existing.brief_text) return existing
  return generatePortfolioBrief(asOf)
}

module.exports = {
  generateClientBrief,
  generatePortfolioBrief,
  getClientBrief,
  getPortfolioBrief,
  getOrGenerateClientBrief,
  getOrGeneratePortfolioBrief,
  defaultAsOf,
  PORTFOLIO_KEY,
}
