'use strict'

// ── Memory OS — Phase 5: autonomous governor ──────────────────────────────────
//
// The self-HEAL half of the memory governance loop. It runs on a schedule (no
// human in the path), reads the health verdict (lib/memoryHealth.js), applies the
// safe corrective, and returns an audit. Mirrors the repo's other self-healing
// organs (connection watchdog, lead-policy governor): bounded, reversible,
// verify-after, fail-closed.
//
// GUARDRAILS (the load-bearing part — "powerful but contained"):
//   1. NEVER deletes live memory. The only mutating action is compaction, which
//      removes ONLY dead rows (forgotten/expired beyond retention).
//   2. LIVE-COUNT VERIFY-AFTER. It snapshots the live count before and after and
//      flags a guardrail violation (ok:false) if it changed — proving every run
//      touched zero live memory.
//   3. RUNAWAY LIVE GROWTH IS ESCALATED, NOT "FIXED". A live-bloat verdict is
//      flagged for a human; the governor will not delete live rows to make the
//      number look better.
//   4. FAIL CLOSED. Any error → ok:false, no partial claims; it never throws.

const db = require('../db')
const { gatherMemoryStats, assessMemory } = require('./memoryHealth')
const { compact } = require('./memory')

const nowIso = () => new Date().toISOString()

// Run one governance pass. Returns an audit:
//   { ok, status, action_taken, reclaimed, escalated, live_before, live_after, reason }
async function governMemory(opts = {}) {
  const now          = opts.now || nowIso()
  const retentionDays = opts.retentionDays === undefined ? 90 : opts.retentionDays
  const thresholds    = opts.thresholds || {}

  const audit = {
    ok: true, status: 'healthy', action_taken: 'none', reclaimed: 0,
    escalated: false, live_before: null, live_after: null, reason: '',
  }

  try {
    const before  = await gatherMemoryStats({ now })
    const verdict  = assessMemory(before, thresholds)
    audit.live_before = before.live
    audit.status      = verdict.status
    audit.reason      = verdict.reason

    if (verdict.recommended_action === 'compact') {
      // Safe by construction: compact only removes dead rows.
      audit.reclaimed = await compact({ retentionDays, now })
      audit.action_taken = 'compacted'
    } else if (verdict.recommended_action === 'escalate') {
      // Guardrail #3: flag, do NOT auto-delete live memory.
      audit.escalated = true
      audit.action_taken = 'escalated'
    }

    // Guardrail #2: verify-after — live memory must be UNCHANGED by a heal.
    const after = await gatherMemoryStats({ now })
    audit.live_after = after.live
    if (after.live !== before.live) {
      audit.ok = false
      audit.reason = `GUARDRAIL VIOLATION: live memory changed ${before.live} → ${after.live}`
    }
  } catch (err) {
    // Guardrail #4: fail closed.
    audit.ok = false
    audit.action_taken = 'none'
    audit.reason = `governor error: ${err.message}`
  }

  return audit
}

module.exports = { governMemory }
