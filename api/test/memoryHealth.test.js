// ============================================================
// test/memoryHealth.test.js — Memory OS Phase 5 health assessment
// (lib/memoryHealth). Pure verdict + the DB stats gatherer.
//
// Runs on an isolated temp SQLite DB. Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `memory_health_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { gatherMemoryStats, assessMemory, DEFAULTS } = require('../lib/memoryHealth')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

const ago   = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
const ahead = (n) => new Date(Date.now() + n * 86_400_000).toISOString()

async function seed({ content, forgotten_at = null, expires_at = null }) {
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO agent_memory (client_id, kind, content, source, authority, confidence, created_at, updated_at, expires_at, forgotten_at)
     VALUES (NULL,'k',$1,'user',4,1,$2,$2,$3,$4)`,
    [content, now, expires_at, forgotten_at])
}

// ── assessMemory (pure) ─────────────────────────────────────────────────────
test('a small or empty store is healthy and needs no action', () => {
  assert.deepEqual(
    pick(assessMemory({ total: 0, live: 0, dead: 0 })),
    { status: 'healthy', recommended_action: 'none' })
  // Below the action floor even with some dead rows.
  assert.deepEqual(
    pick(assessMemory({ total: 5, live: 2, dead: 3 })),
    { status: 'healthy', recommended_action: 'none' })
})

test('dead bloat past the warn/crit ratio recommends compaction', () => {
  // 30% dead, above warn (25%), below crit (50%).
  assert.deepEqual(pick(assessMemory({ total: 100, live: 70, dead: 30 })),
    { status: 'degraded', recommended_action: 'compact' })
  // 60% dead → critical.
  assert.deepEqual(pick(assessMemory({ total: 100, live: 40, dead: 60 })),
    { status: 'critical', recommended_action: 'compact' })
})

test('runaway LIVE growth is escalated, never auto-deleted', () => {
  const v = assessMemory({ total: 60000, live: 60000, dead: 0 }, { liveCap: 50000 })
  assert.equal(v.status, 'critical')
  assert.equal(v.recommended_action, 'escalate') // NOT compact/delete
})

test('no verdict ever recommends an action that could touch live memory', () => {
  // Across a sweep of shapes, the only mutating recommendation is "compact"
  // (dead-only); live problems are only ever "escalate".
  for (const [total, live] of [[0, 0], [100, 70], [100, 40], [60000, 60000], [25, 24]]) {
    const v = assessMemory({ total, live, dead: total - live }, { liveCap: 50000 })
    assert.ok(['none', 'compact', 'escalate'].includes(v.recommended_action))
    if (v.recommended_action === 'escalate') assert.ok(v.status === 'critical')
  }
})

test('thresholds are overridable', () => {
  const v = assessMemory({ total: 100, live: 90, dead: 10 }, { warnDeadRatio: 0.05 })
  assert.equal(v.recommended_action, 'compact') // 10% now exceeds the lowered warn
})

// ── gatherMemoryStats (DB) ──────────────────────────────────────────────────
test('gatherMemoryStats counts live vs dead correctly', async () => {
  await ready()
  await db.query('DELETE FROM agent_memory')
  await seed({ content: 'live a' })
  await seed({ content: 'live b', expires_at: ahead(10) })
  await seed({ content: 'dead forgotten', forgotten_at: ago(1) })
  await seed({ content: 'dead expired',   expires_at: ago(1) })

  const s = await gatherMemoryStats({})
  assert.equal(s.total, 4)
  assert.equal(s.live, 2)
  assert.equal(s.dead, 2)
})

test('DEFAULTS are documented and sane', () => {
  assert.ok(DEFAULTS.warnDeadRatio < DEFAULTS.critDeadRatio)
  assert.ok(DEFAULTS.minTotal > 0 && DEFAULTS.liveCap > 0)
})

function pick(v) { return { status: v.status, recommended_action: v.recommended_action } }
