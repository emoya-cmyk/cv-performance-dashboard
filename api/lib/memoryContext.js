'use strict'

// ── Memory OS — Phase 4: narration continuity ─────────────────────────────────
//
// Closes the loop between the memory layer and the AI recap. For one client week
// it (1) RECALLS the client's recent prior highlight memories so the narration
// can draw a through-line ("the second straight week leads climbed"), then
// (2) CAPTURES this week's highlights so future recaps have continuity in turn.
//
// Grounding is preserved WITHOUT pre-filtering: prior memories are passed only as
// STRING context (note + date), so they add no number to the allow-set the
// verifier derives from the pack (collectAllowedNumbers ignores strings). The
// LLM is therefore free to reference the through-line but can only ever WRITE a
// number that is in the current pack — any stale figure it echoes is rejected by
// the existing grounding verifier (lib/ai.js). Memory is enrichment in, the
// verifier is the guarantee out. Never throws — it must never break the
// already-fail-safe recap path.

const { captureHighlights } = require('./memoryProducer')
const { recall }            = require('./memory')

// Returns { continuity: [{ note, since }], captured }. `continuity` is the prior
// context for narration; `captured` is how many of this week's highlights were
// remembered. Both default empty/0 on any failure.
async function buildContinuity(clientId, pack, opts = {}) {
  const scope       = opts.scope || { role: 'agency' }
  const max         = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 3
  const thisWeekRef = pack && pack.period ? `week:${pack.period.week_start}` : null
  const out = { continuity: [], captured: 0 }

  try {
    // 1) Recall recent prior highlights (exclude THIS week's own, by evidence_ref),
    //    decay-ranked already, as plain string context.
    const prior = await recall(scope, { clientId, kind: 'highlight' }, { k: 12 })
    out.continuity = prior
      .filter(m => m.evidence_ref !== thisWeekRef)
      .slice(0, max)
      .map(m => ({ note: m.content, since: m.updated_at }))   // STRINGS only

    // 2) Capture THIS week's highlights so the loop is self-sustaining.
    const ids = await captureHighlights(clientId, { pack, scope })
    out.captured = ids.length
  } catch {
    // degrade silently — never break the recap path
  }
  return out
}

module.exports = { buildContinuity }
