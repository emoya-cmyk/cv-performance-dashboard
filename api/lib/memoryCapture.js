'use strict'

// ── Memory OS — Phase 6: autonomous capture sweep ─────────────────────────────
//
// Phase 4 captured a client's highlights as a side effect of generating that
// client's recap. This decouples capture from narration: a scheduled sweep walks
// every client and remembers this week's highlights directly, so the store stays
// populated even for clients whose recap wasn't (re)generated. The memory loop
// no longer depends on someone reading a recap.
//
// Per-client failure isolation: one client's bad pack never sinks the sweep
// (mirrors the connection watchdog / insights sweeps). Pure-ish and injectable —
// pass `clients` and/or `packFor` for deterministic tests.

const database = require('../db')
const { buildEvidencePack } = require('./evidence')
const { captureHighlights } = require('./memoryProducer')

// Capture highlights for every client. Returns { clients, captured, failed }.
//   opts.clients   — array of client ids (else SELECT id FROM clients)
//   opts.packFor   — async (clientId) => pack (else buildEvidencePack)
//   opts.weekStart — passed to buildEvidencePack when packFor is not given
//   opts.scope     — engine scope for the writes (default agency producer)
async function captureAllClients(opts = {}) {
  const scope   = opts.scope || { role: 'agency' }
  const packFor = opts.packFor || ((id) => buildEvidencePack(id, opts.weekStart))

  let clients = opts.clients
  if (!Array.isArray(clients)) {
    const { rows } = await database.query(`SELECT id FROM clients`)
    clients = rows.map((r) => r.id)
  }

  const summary = { clients: 0, captured: 0, failed: 0 }
  for (const id of clients) {
    try {
      const pack = await packFor(id)
      const ids  = await captureHighlights(id, { pack, scope })
      summary.clients  += 1
      summary.captured += ids.length
    } catch {
      summary.failed += 1   // isolate — never let one client sink the sweep
    }
  }
  return summary
}

module.exports = { captureAllClients }
