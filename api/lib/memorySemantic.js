'use strict'

// ── Memory OS — Phase 8: semantic (vector) recall ─────────────────────────────
//
// Adds embedding-ranked recall WITHOUT committing to an embeddings provider. You
// inject an `embed(text) => number[]` (Claude embeddings, a local model, a
// pgvector precompute — your choice); the engine stays provider-agnostic. With
// no embedder it transparently falls back to the keyword filter, so this is a
// pure add-on that never breaks existing behavior.
//
// Ranking blends cosine similarity with the existing decay so a result is BOTH
// semantically close AND fresh — re-ranking a decay-ranked candidate pool rather
// than scanning the whole table.

const { recall } = require('./memory')

// Cosine similarity of two equal-length numeric vectors; 0 on any degeneracy.
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// semanticRecall(scope, queryText, opts)
//   opts.embed         — async (text) => number[]  (omit → keyword fallback)
//   opts.kind/clientId — scope/filter, same as recall()
//   opts.k             — results (default 5)
//   opts.candidatePool — how many decay-ranked rows to re-rank (default 50)
//   opts.blend         — weight on similarity vs decay in [0,1] (default 0.7)
async function semanticRecall(scope, queryText, opts = {}) {
  const k     = Number.isInteger(opts.k) && opts.k > 0 ? opts.k : 5
  const embed = typeof opts.embed === 'function' ? opts.embed : null
  const pool  = await recall(scope, { kind: opts.kind, clientId: opts.clientId },
    { k: opts.candidatePool || 50, now: opts.now })

  // No embedder (or no query) → keyword fallback over the same scoped pool.
  if (!embed || !queryText) {
    if (queryText) {
      const q = String(queryText).toLowerCase()
      return pool.filter((m) => m.content.toLowerCase().includes(q)).slice(0, k)
    }
    return pool.slice(0, k)
  }

  const qv    = await embed(queryText)
  const blend = typeof opts.blend === 'number' ? Math.min(1, Math.max(0, opts.blend)) : 0.7
  const scored = []
  for (const m of pool) {
    const mv  = await embed(m.content)
    const sim = cosine(qv, mv)
    scored.push({
      ...m,
      similarity: Number(sim.toFixed(4)),
      score: Number((blend * sim + (1 - blend) * m.effective_confidence).toFixed(4)),
    })
  }
  return scored
    .sort((a, b) => b.score - a.score || b.effective_confidence - a.effective_confidence || b.id - a.id)
    .slice(0, k)
}

module.exports = { semanticRecall, cosine }
