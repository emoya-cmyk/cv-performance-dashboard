'use strict'

// ============================================================================
// lib/makeRemediationSweeps.js — scheduled sweeps + DB writers for the Make.com
// remediation system. The decision logic lives in lib/makeRemediation.js (pure);
// this module is the I/O half (DB reads/writes, Slack fan-out) that the
// scheduler/cron drives. Each sweep is isolated and best-effort: a failure here
// must never disturb the other autonomy sweeps.
//
//   runTier1Digest        → FR-8 Tier 1 batched 30-min Slack summary
//   runDeadLetterRetention→ FR-4 30-day minimum retention (only prunes RESOLVED)
//   recordConfidence      → FR-9 apply Wilson-score delta to the scenario store
// ============================================================================

const { buildTier1Digest, applyConfidence } = require('./makeRemediation')

/**
 * Tier 1 batched Slack digest (FR-8). Summarises every Tier 1 event not yet
 * reported, sends one Slack message, and marks those events notified so each is
 * summarised exactly once. No-op (no Slack) when the window is empty.
 *
 * @param {{ query: Function, sendAlert: Function }} deps
 * @returns {Promise<{ events: number, sent: boolean }>}
 */
async function runTier1Digest({ query, sendAlert }) {
  const { rows } = await query(
    `SELECT id, tenant_id, dead_lettered
       FROM make_remediation_log
      WHERE failure_tier = 1 AND (batched_notified = 0 OR batched_notified IS NULL)`
  )
  if (!rows.length) return { events: 0, sent: false }

  const alert = buildTier1Digest(rows.map(r => ({
    tenant_id: r.tenant_id,
    dead_lettered: r.dead_lettered === 1 || r.dead_lettered === true,
  })))

  let sent = false
  if (alert) {
    try { await sendAlert(alert); sent = true }
    catch (err) { console.error('[make-sweep] tier1 digest slack error:', err.message) }
  }

  // Mark notified regardless of Slack success — the events are still recorded in
  // the DB and a transient Slack outage must not replay the whole backlog later.
  const ids = rows.map(r => r.id)
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
  await query(
    `UPDATE make_remediation_log SET batched_notified = 1 WHERE id IN (${placeholders})`,
    ids
  )
  return { events: rows.length, sent }
}

/**
 * Dead-letter retention sweep (FR-4). Enforces the 30-day MINIMUM by pruning
 * only items that have been RESOLVED and are older than the retention window.
 * Open (unresolved) items are never discarded — they remain recoverable forever.
 *
 * @param {{ query: Function, retentionDays?: number, now?: Date }} deps
 * @returns {Promise<{ pruned: number, cutoff: string }>}
 */
async function runDeadLetterRetention({ query, retentionDays = 30, now = new Date() }) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const { rowCount } = await query(
    `DELETE FROM make_dead_letter WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < $1`,
    [cutoff]
  )
  return { pruned: rowCount || 0, cutoff }
}

/**
 * Apply a Wilson-score outcome to a scenario's confidence (FR-9). Reads the
 * current value (default 0.5), applies the delta with freeze semantics, and
 * upserts. Best-effort: never throws into the caller's remediation flow.
 *
 * @param {{ query: Function, scenarioId: string, outcomeKey: string, now?: Date }} deps
 * @returns {Promise<{ confidence: number, frozen: boolean }|null>}
 */
async function recordConfidence({ query, scenarioId, outcomeKey, now = new Date() }) {
  if (!scenarioId) return null
  try {
    const { rows } = await query(
      `SELECT confidence, frozen FROM make_scenario_confidence WHERE scenario_id = $1`,
      [scenarioId]
    )
    const current = rows[0]
    const frozen  = current ? (current.frozen === 1 || current.frozen === true) : false
    const next    = applyConfidence(current ? Number(current.confidence) : 0.5, outcomeKey, frozen)

    await query(
      `INSERT INTO make_scenario_confidence (scenario_id, confidence, frozen, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scenario_id) DO UPDATE
         SET confidence = $2, frozen = $3, updated_at = $4`,
      [scenarioId, next.confidence, next.frozen ? 1 : 0, now.toISOString()]
    )
    return next
  } catch (err) {
    console.error('[make-sweep] recordConfidence error:', err.message)
    return null
  }
}

module.exports = { runTier1Digest, runDeadLetterRetention, recordConfidence }
