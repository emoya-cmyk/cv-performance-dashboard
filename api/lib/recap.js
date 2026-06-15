'use strict'

// ============================================================
// lib/recap.js — orchestrate + persist ONE grounded recap per (client, week).
//
//   buildEvidencePack (deterministic numbers)
//        → generateRecapText (narrate-only LLM + grounding verifier + fallback)
//        → upsert into ai_recaps  (idempotent on client_id, week_start)
//
// Idempotent by design: re-running a week overwrites in place via the
// PRIMARY KEY (client_id, week_start) ON CONFLICT arbiter, so the Monday job
// and a manual "regenerate" both converge on a single row. Never throws on the
// AI path — generateRecapText already degrades to a deterministic template.
// ============================================================

const { query }             = require('../db')
const { buildEvidencePack } = require('./evidence')
const { generateRecapText } = require('./ai')
const { buildContinuity }   = require('./memoryContext')
const { weekStartOf }       = require('./rollup')

// Most recently COMPLETED ISO week (last Monday). weekStartOf(today) is the
// current, incomplete week, so step back 7 days first. Mirrors evidence.js.
function defaultWeekStart() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 7)
  return weekStartOf(d.toISOString().slice(0, 10))
}

const safeParse = (s) => { try { return JSON.parse(s) } catch { return {} } }

// evidence_pack reads back as a parsed object on Postgres (JSONB) but a string
// on SQLite (TEXT); grounded as boolean vs 0/1. Normalise both.
function normalizeRecapRow(row) {
  if (!row) return null
  return {
    client_id:     row.client_id,
    week_start:    row.week_start,
    model:         row.model,
    recap_text:    row.recap_text,
    grounded:      !!row.grounded,
    evidence_pack: typeof row.evidence_pack === 'string'
      ? safeParse(row.evidence_pack)
      : (row.evidence_pack || {}),
    created_at:    row.created_at,
    updated_at:    row.updated_at,
  }
}

/**
 * Build, narrate, verify and persist a recap for one client week.
 * @param {string} clientId
 * @param {string} [weekStart] Monday 'YYYY-MM-DD'; defaults to last completed week.
 * @returns {Promise<{client_id,week_start,model,recap_text,grounded,evidence_pack}>}
 */
async function generateRecap(clientId, weekStart) {
  const ws   = weekStart || defaultWeekStart()
  const pack = await buildEvidencePack(clientId, ws)

  // Memory OS Phase 4: capture this week's highlights and recall prior ones so
  // the narration can draw a through-line. Additive, STRING-only, non-throwing —
  // it leaves the grounding allow-set and the fail-safe recap path untouched, and
  // the output verifier still rejects any stale number the model might echo.
  const { continuity } = await buildContinuity(clientId, pack, { scope: { role: 'agency' } })
  if (continuity.length) pack.continuity = continuity

  const { text, model, grounded } = await generateRecapText(pack)

  await query(
    `INSERT INTO ai_recaps
       (client_id, week_start, model, evidence_pack, recap_text, grounded, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (client_id, week_start) DO UPDATE SET
       model         = EXCLUDED.model,
       evidence_pack = EXCLUDED.evidence_pack,
       recap_text    = EXCLUDED.recap_text,
       grounded      = EXCLUDED.grounded,
       updated_at    = CURRENT_TIMESTAMP`,
    // 1/0 for the BOOLEAN(pg)/INTEGER(sqlite) column; JSON string for JSONB/TEXT —
    // same cross-backend idiom as routes/connections.js.
    [clientId, ws, model, JSON.stringify(pack), text, grounded ? 1 : 0]
  )

  return { client_id: clientId, week_start: ws, model, recap_text: text, grounded, evidence_pack: pack }
}

// Read a stored recap without (re)generating. Returns null if none exists yet.
async function getRecap(clientId, weekStart) {
  const ws = weekStart || defaultWeekStart()
  const { rows } = await query(
    `SELECT * FROM ai_recaps WHERE client_id = $1 AND week_start = $2`,
    [clientId, ws]
  )
  return normalizeRecapRow(rows[0])
}

// Return the stored recap if present, else generate + persist one. Used by the
// in-app card route and the digest so the LLM is only called once per week.
async function getOrGenerateRecap(clientId, weekStart) {
  const existing = await getRecap(clientId, weekStart)
  if (existing && existing.recap_text) return existing
  return generateRecap(clientId, weekStart)
}

module.exports = { generateRecap, getRecap, getOrGenerateRecap, defaultWeekStart }
