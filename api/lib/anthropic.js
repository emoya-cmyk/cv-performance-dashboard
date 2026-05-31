'use strict'

// ============================================================
// lib/anthropic.js — one tiny shared Anthropic Messages client.
//
// Raw axios (no SDK dependency, matching connectors/*.js and lib/ai.js) so that
// EVERY caller — the weekly-recap narration and the Sprint-2 ask pipeline
// (question→spec parse, and result narration) — builds the request the same
// way: same URL, same version header, the same "omit temperature on Opus 4.7"
// rule, and the same 30s timeout. Centralising it here means those invariants
// can't drift between callers.
//
// Returns the concatenated text of the response (trimmed). Throws on transport
// or API error — callers decide how to degrade.
// ============================================================

const axios = require('axios')

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERS = '2023-06-01'
const DEFAULT_MODEL  = process.env.AI_MODEL || 'claude-haiku-4-5'

// Opus 4.7 removed temperature/top_p/top_k (sending them → 400). Omit temp there.
const isOpus47 = (model) => /opus-4-7/.test(model || '')

/**
 * One Messages API round-trip.
 * @param {object} o
 * @param {string} o.system            system prompt (cached as the stable prefix)
 * @param {Array}  o.messages          [{ role:'user', content:'…' }, …]
 * @param {string} [o.model]           defaults to AI_MODEL or claude-haiku-4-5
 * @param {number} [o.maxTokens=600]
 * @param {number} [o.temperature=0.2] ignored on Opus 4.7
 * @returns {Promise<string>} concatenated text blocks, trimmed
 */
async function callMessages({ system, messages, model = DEFAULT_MODEL, maxTokens = 600, temperature = 0.2 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    // Static instructions are the cacheable prefix; volatile content goes in the
    // user turn so the system block stays byte-stable across calls.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  }
  if (!isOpus47(model) && temperature != null) body.temperature = temperature

  const { data } = await axios.post(ANTHROPIC_URL, body, {
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERS,
      'content-type':      'application/json',
    },
    timeout: 30000,
  })

  return (data?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
}

module.exports = { callMessages, DEFAULT_MODEL, ANTHROPIC_URL, ANTHROPIC_VERS, isOpus47 }
