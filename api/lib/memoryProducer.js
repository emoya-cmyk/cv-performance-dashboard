'use strict'

// ── Memory OS — Phase 2: first real producer ──────────────────────────────────
//
// Turns the intelligence layer's transient weekly computation into durable,
// queryable memory. The deterministic highlights in an evidence pack (what
// moved ≥ the threshold, week over week) are exactly the kind of observation
// worth remembering across sessions — so we persist them as scoped 'derived'
// memories. A later recall can re-ground them against the CURRENT pack: a
// highlight that no longer holds is still recalled (it informs context) but is
// flagged non-assertable by the grounding layer.
//
// Additive: reuses evidence.buildEvidencePack and memory.remember. The pack can
// be injected (for tests / to reuse a pack already built upstream) instead of
// rebuilt.

const { remember }          = require('./memory')
const { buildEvidencePack } = require('./evidence')

// Render a highlight into a single grounded sentence. Every number it contains
// (pct_change, current, previous) is a leaf of the pack, so it grounds against
// that pack by construction.
function highlightSentence(h) {
  const pct = Math.abs(Number(h.pct_change))
  return `${h.label} ${h.direction} ${pct}% week over week (${h.current} vs ${h.previous})`
}

// Capture a client's weekly highlights as memories. Returns the written ids.
//   captureHighlights(clientId, { weekStart, pack, scope, ttlDays })
// - pack: optional injected evidence pack; otherwise built for (clientId, weekStart).
// - scope: defaults to the trusted agency producer (writes are client-scoped).
// On an empty book (no data) nothing is written.
async function captureHighlights(clientId, opts = {}) {
  const pack = opts.pack || await buildEvidencePack(clientId, opts.weekStart)
  if (!pack || !pack.meta || !pack.meta.has_data) return []

  const scope   = opts.scope || { role: 'agency' }
  const ttlDays = opts.ttlDays === undefined ? 90 : opts.ttlDays
  const ref     = pack.period ? `week:${pack.period.week_start}` : null

  const written = []
  for (const h of pack.highlights || []) {
    const { id } = await remember(scope, {
      client_id:    clientId,
      kind:         'highlight',
      content:      highlightSentence(h),
      source:       'derived',
      evidence_ref: ref,
      ttlDays,
    })
    written.push(id)
  }
  return written
}

module.exports = { captureHighlights, highlightSentence }
