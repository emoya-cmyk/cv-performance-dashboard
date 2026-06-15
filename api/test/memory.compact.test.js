// ============================================================
// test/memory.compact.test.js — Memory OS Phase 3 compaction
// (lib/memory.compact). Reclaims long-dead rows; never touches live ones.
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
const DB_PATH = path.join(os.tmpdir(), `memory_compact_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db  = require('../db')
const mem = require('../lib/memory')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
const daysAhead = (n) => new Date(Date.now() + n * 86_400_000).toISOString()

async function seedRaw({ client_id = null, content, forgotten_at = null, expires_at = null }) {
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO agent_memory
       (client_id, kind, content, source, authority, confidence, created_at, updated_at, expires_at, forgotten_at)
     VALUES ($1,'k',$2,'user',4,1,$3,$3,$4,$5)`,
    [client_id, content, now, expires_at, forgotten_at],
  )
}
async function countRows() {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM agent_memory')
  return Number(rows[0].n)
}

test('compact reclaims long-dead rows and never touches live ones', async () => {
  await ready()
  await db.query('DELETE FROM agent_memory')

  await seedRaw({ content: 'live, no ttl' })                              // keep
  await seedRaw({ content: 'live, future ttl', expires_at: daysAhead(30) }) // keep
  await seedRaw({ content: 'forgotten recently', forgotten_at: daysAgo(10) }) // keep (< retention)
  await seedRaw({ content: 'forgotten long ago', forgotten_at: daysAgo(200) }) // reclaim
  await seedRaw({ content: 'expired long ago',  expires_at: daysAgo(200) })    // reclaim

  assert.equal(await countRows(), 5)
  const reclaimed = await mem.compact({ retentionDays: 90 })
  assert.equal(reclaimed, 2)
  assert.equal(await countRows(), 3)

  // The three survivors are exactly the live + recently-forgotten rows.
  const { rows } = await db.query('SELECT content FROM agent_memory ORDER BY content')
  assert.deepEqual(rows.map(r => r.content).sort(),
    ['forgotten recently', 'live, future ttl', 'live, no ttl'])
})

test('compact is idempotent and safe on an empty table', async () => {
  await ready()
  await db.query('DELETE FROM agent_memory')
  assert.equal(await mem.compact(), 0)
  assert.equal(await mem.compact({ retentionDays: 0 }), 0)
})

test('a forgotten memory survives until it is older than the retention window', async () => {
  await ready()
  await db.query('DELETE FROM agent_memory')
  await seedRaw({ content: 'borderline', forgotten_at: daysAgo(30) })
  assert.equal(await mem.compact({ retentionDays: 90 }), 0)  // 30d < 90d → kept
  assert.equal(await mem.compact({ retentionDays: 7 }), 1)   // 30d > 7d  → reclaimed
})
