'use strict'

// ============================================================
// lib/cacheAlign.js — prompt-prefix CACHE ALIGNMENT (the second saving).
//
// Not a transform — a call-site DISCIPLINE, captured as one tiny helper so every
// repo assembles prompts the same way. Provider KV/prompt caches (Anthropic,
// OpenAI) bill cached input tokens at a steep discount, but they only hit on a
// byte-IDENTICAL PREFIX. So: put everything STABLE across requests first (system
// policy, schema, tool/function defs, fixed instructions) and byte-invariant, and
// append the VOLATILE per-request payload (the compacted read from compaction.js)
// LAST. The stable prefix then caches once and is reused on every subsequent call.
//
// Pure string assembly: no data is changed, nothing is dropped. The only token
// effect is moving spend from full-price to cached-price. ZERO dependencies.
//
// Usage:
//   const { assemblePrompt } = require('@emoya-cmyk/compaction').cacheAlign
//   const prompt = assemblePrompt({
//     stable:   [systemPolicy, schemaDoc, toolDefs, instructions], // cache prefix
//     volatile: [compact(rows).text],                              // appended last
//   })
// Keep the `stable` array identical (same order, same bytes) across requests for a
// given task; only `volatile` should vary. cachePrefix() returns just the stable
// portion so a caller can assert/hash it for cache-key reasoning.
// ============================================================

const DEFAULT_SEPARATOR = '\n\n'

// Join non-empty string parts with a separator. null/undefined/'' parts are
// dropped so an optional stable section doesn't change the prefix bytes when absent.
function joinParts(parts, separator) {
  return (Array.isArray(parts) ? parts : [parts])
    .filter((p) => typeof p === 'string' && p.length > 0)
    .join(separator)
}

// The stable, cacheable prefix — exactly the bytes a provider cache keys on. Keep
// this identical across requests for the cache to hit.
function cachePrefix(stable, { separator = DEFAULT_SEPARATOR } = {}) {
  return joinParts(stable, separator)
}

// Assemble the full prompt: stable prefix first (cacheable), volatile suffix last.
// Returns the string to send to the model.
function assemblePrompt({ stable = [], volatile = [], separator = DEFAULT_SEPARATOR } = {}) {
  const prefix = cachePrefix(stable, { separator })
  const suffix = joinParts(volatile, separator)
  if (!prefix) return suffix
  if (!suffix) return prefix
  return prefix + separator + suffix
}

module.exports = { assemblePrompt, cachePrefix, DEFAULT_SEPARATOR }
