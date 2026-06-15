'use strict'

// ── Memory OS — Phase 2: grounding layer ──────────────────────────────────────
//
// A recalled memory is a *claim*, not a fact. Before any claim is asserted in
// output it must be verified against the deterministic evidence pack — the SAME
// discipline lib/ai.js applies to AI narration (every number must trace to the
// pack or the sentence is rejected). This layer applies that verifier to
// recalled memories.
//
// Crucially, grounding does NOT filter recall: an unverifiable memory is still
// returned (it may legitimately inform retrieval/ranking) but is flagged
// `assertable: false` so callers never state it as current fact. This realizes
// PRD goal G3.
//
// Additive: reuses memory.recall (Phase 1) and ai.verifyGrounding /
// ai.collectAllowedNumbers (already exported). Nothing here mutates either.

const { recall } = require('./memory')
const { verifyGrounding, collectAllowedNumbers } = require('./ai')

// Annotate each claim with whether its content is grounded in `pack`.
//   • assertable:true  — every number in the content traces to the pack (a
//                        number-free claim is grounded by construction).
//   • assertable:false — at least one number does not trace; `offending` lists them.
//   • assertable:null  — no pack supplied, so groundedness is unknown.
// Pure: returns new objects, never mutates the inputs.
function groundClaims(claims, pack) {
  const list = Array.isArray(claims) ? claims : []
  if (!pack) {
    return list.map(c => ({ ...c, assertable: null, offending: [] }))
  }
  const allowed = collectAllowedNumbers(pack)
  return list.map(c => {
    const { grounded, offending } = verifyGrounding(String(c.content || ''), pack, allowed)
    return { ...c, assertable: grounded, offending }
  })
}

// Recall in-scope memories (Phase 1 semantics: scoped, decayed, ranked) and
// annotate each with groundedness against opts.pack. Without a pack this is
// plain recall with assertable:null.
//
//   recallGrounded(scope, { kind, text, clientId }, { k, pack })
async function recallGrounded(scope, query = {}, opts = {}) {
  const claims = await recall(scope, query, opts)
  return groundClaims(claims, opts.pack || null)
}

module.exports = { groundClaims, recallGrounded }
