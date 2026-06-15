'use strict'

// ── Memory OS — embeddings ────────────────────────────────────────────────────
//
// A zero-dependency, deterministic local embedder so semantic recall
// (lib/memorySemantic.js) works OUT OF THE BOX with no external API and no infra.
// It hashes word tokens (FNV-1a) into a fixed-dim count vector — a "hashing bag
// of words". Good enough for coarse semantic grouping and, crucially, free and
// offline.
//
// NOTE — for production-quality semantics, pass a real embedder to semanticRecall
// instead: `{ embed: myEmbed }`. Anthropic does not offer a first-party
// embeddings endpoint (they recommend Voyage AI); OpenAI, Voyage, or a local
// sentence-transformer all drop in as the `embed(text) => number[]` seam. This
// local default is the floor, not the ceiling.

const DIM = 64

// Deterministic FNV-1a hash → bucket index, dependency-free.
function bucket(token) {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % DIM
}

// localEmbed(text) → number[DIM]. Synchronous; semanticRecall awaits it fine.
function localEmbed(text) {
  const v = new Array(DIM).fill(0)
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []
  for (const tok of tokens) v[bucket(tok)] += 1
  return v
}

module.exports = { localEmbed, EMBED_DIM: DIM }
