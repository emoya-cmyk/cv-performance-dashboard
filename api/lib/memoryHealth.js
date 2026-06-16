'use strict'

// ── Memory OS — Phase 5: health assessment ────────────────────────────────────
//
// The self-MONITOR half of the memory governance loop (the governor in
// lib/memoryGovernor.js is the self-HEAL half). Pure, deterministic verdict over
// a snapshot of the store, in the same shape as the repo's other health organs
// (status + recommended_action + reason). Two failure modes, two responses:
//
//   • DEAD BLOAT  — forgotten/expired rows piling up. Fixable autonomously and
//                   SAFELY (compaction only ever removes dead rows) → 'compact'.
//   • LIVE BLOAT  — live rows past a cap (e.g. a runaway producer). NOT fixable
//                   by compaction (those rows are live) and never auto-deletable
//                   → 'escalate' (flag a human; the guardrail is "never delete
//                   live memory to make a number look better").
//
// Below an absolute floor of rows nothing is worth acting on (a tiny store with a
// few dead rows is healthy), so the loop never thrashes on noise.

const db = require('../db')

const nowIso = () => new Date().toISOString()

const DEFAULTS = Object.freeze({
  warnDeadRatio: 0.25,   // dead/total at/above this → degraded
  critDeadRatio: 0.50,   // dead/total at/above this → critical
  minTotal:      20,     // action floor: ignore dead bloat below this many rows
  liveCap:       50000,  // live rows above this → escalate (runaway growth)
})

// One cheap aggregate: total rows, and how many are LIVE (not forgotten, not past
// expiry as of `now`). dead = total − live.
async function gatherMemoryStats({ now = nowIso(), table = 'agent_memory' } = {}) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN forgotten_at IS NULL AND (expires_at IS NULL OR expires_at > $1)
                     THEN 1 ELSE 0 END) AS live
       FROM ${table}`,
    [now],
  )
  const total = Number(rows[0].total) || 0
  const live  = Number(rows[0].live)  || 0
  return { total, live, dead: Math.max(0, total - live) }
}

// Pure verdict. Returns { status, recommended_action, total, live, dead,
// dead_ratio, bounds, reason }. Never recommends an action that could touch a
// live memory — the strongest action over dead bloat is compaction (dead only),
// and live bloat is only ever escalated, never auto-deleted.
function assessMemory(stats = {}, opts = {}) {
  const cfg   = { ...DEFAULTS, ...opts }
  const total = Number(stats.total) || 0
  const live  = Number(stats.live)  || 0
  const dead  = Number.isFinite(stats.dead) ? Number(stats.dead) : Math.max(0, total - live)
  const dead_ratio = total > 0 ? dead / total : 0

  let status = 'healthy'
  let recommended_action = 'none'
  let reason = 'store healthy'

  if (live > cfg.liveCap) {
    status = 'critical'; recommended_action = 'escalate'
    reason = `live memory ${live} exceeds cap ${cfg.liveCap} — runaway growth, human review`
  } else if (total >= cfg.minTotal && dead_ratio >= cfg.critDeadRatio) {
    status = 'critical'; recommended_action = 'compact'
    reason = `dead ratio ${Math.round(dead_ratio * 100)}% — compact`
  } else if (total >= cfg.minTotal && dead_ratio >= cfg.warnDeadRatio) {
    status = 'degraded'; recommended_action = 'compact'
    reason = `dead ratio ${Math.round(dead_ratio * 100)}% elevated — compact`
  } else if (dead > 0) {
    reason = 'a few dead rows, below the action floor'
  }

  return {
    status,
    recommended_action,
    total, live, dead,
    dead_ratio: Number(dead_ratio.toFixed(4)),
    bounds: { liveCap: cfg.liveCap, warnDeadRatio: cfg.warnDeadRatio, critDeadRatio: cfg.critDeadRatio, minTotal: cfg.minTotal },
    reason,
  }
}

module.exports = { gatherMemoryStats, assessMemory, DEFAULTS }
