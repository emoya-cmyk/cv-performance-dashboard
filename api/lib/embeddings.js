'use strict'

// ── Memory OS — embeddings ────────────────────────────────────────────────────
//
// A zero-dependency, deterministic local embedder so semantic recall
// (lib/memorySemantic.js) works OUT OF THE BOX with no external API and no infra.
// It hashes word tokens (FNV-1a) into a fixed-dim count vector — a "hashing bag
// of words". Good enough for coarse semantic grouping and, crucially, free and
// offline.
//
// REAL EMBEDDINGS (opt-in, env-gated): the deterministic embedder is the FLOOR,
// not the ceiling. Set `EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY` to route
// recall through Voyage AI (Anthropic's recommended embeddings partner — Anthropic
// has no first-party embeddings endpoint). With NOTHING set, behaviour is
// byte-identical to before: the local embedder is both the DEFAULT and the
// FALLBACK, and a real-provider failure (no key, timeout, HTTP error, bad shape)
// silently degrades to local rather than throwing into the recall path.
//
//   EMBEDDINGS_PROVIDER  local (default) | voyage
//   VOYAGE_API_KEY       Voyage API key  (required for the voyage provider)
//   EMBEDDINGS_MODEL     Voyage model    (default 'voyage-3.5-lite')
//
// DIMENSION SAFETY: the local embedder is 64-dim; a real model is far larger
// (e.g. Voyage 3.5 → 1024). Stored vectors and the query vector MUST come from
// the SAME embedder, which they always do here because semanticRecall embeds both
// the query and every candidate with the one injected `embed`. cosine() guards a
// length mismatch (returns 0) so two embedders can never be silently compared.
// SWITCHING PROVIDERS therefore requires RE-EMBEDDING any precomputed vectors —
// this engine re-embeds candidate content per query, so no migration is needed
// here, but any future vector store must be rebuilt on a provider change.

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

// ── Real provider: Voyage AI ──────────────────────────────────────────────────
// One embedding round-trip, behind the SAME guards as lib/anthropic.js: raw axios
// (no SDK dependency), a short timeout, and NEVER throw into recall — any failure
// returns null so makeEmbedder can degrade to the deterministic local embedder.
const VOYAGE_URL          = 'https://api.voyageai.com/v1/embeddings'
const DEFAULT_VOYAGE_MODEL = 'voyage-3.5-lite'
const VOYAGE_TIMEOUT_MS   = 10000

// voyageEmbed(text) → Promise<number[]> | Promise<null>. null signals the caller
// to fall back; it never rejects, so it is safe to await in the recall hot path.
async function voyageEmbed(text, { apiKey = process.env.VOYAGE_API_KEY, model = process.env.EMBEDDINGS_MODEL || DEFAULT_VOYAGE_MODEL } = {}) {
  if (!apiKey) return null
  let axios
  try { axios = require('axios') } catch { return null }
  try {
    const { data } = await axios.post(
      VOYAGE_URL,
      { input: String(text || ''), model, input_type: 'document' },
      {
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        timeout: VOYAGE_TIMEOUT_MS,
      },
    )
    const vec = data && data.data && data.data[0] && data.data[0].embedding
    return Array.isArray(vec) && vec.length > 0 ? vec : null
  } catch (err) {
    // Degrade quietly — recall must never break because an embeddings call failed.
    console.error('[embeddings] voyage call failed, falling back to local:', err.message)
    return null
  }
}

// ── Provider selection ────────────────────────────────────────────────────────
// makeEmbedder() returns { embed, name } where `embed(text) => Promise<number[]>`
// is the seam semanticRecall consumes. The default ('local', or any unknown value,
// or a 'voyage' request with no key) yields the deterministic local embedder, so
// behaviour with no env set is unchanged. The 'voyage' provider wraps voyageEmbed
// with a per-call fallback to localEmbed, so a single failed/empty response keeps
// recall working (at local quality for that call) instead of poisoning it with a
// null or a dimension-mismatched vector.
function makeEmbedder({
  provider = process.env.EMBEDDINGS_PROVIDER,
  voyageApiKey = process.env.VOYAGE_API_KEY,
} = {}) {
  const sel = String(provider || 'local').toLowerCase()
  if (sel === 'voyage' && voyageApiKey) {
    const model = process.env.EMBEDDINGS_MODEL || DEFAULT_VOYAGE_MODEL
    const embed = async (text) => {
      const vec = await voyageEmbed(text, { apiKey: voyageApiKey, model })
      return vec || localEmbed(text)
    }
    return { embed, name: `voyage:${model}` }
  }
  return { embed: localEmbed, name: 'local' }
}

module.exports = { localEmbed, voyageEmbed, makeEmbedder, EMBED_DIM: DIM, DEFAULT_VOYAGE_MODEL }
