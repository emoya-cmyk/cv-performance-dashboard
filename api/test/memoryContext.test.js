// ============================================================
// test/memoryContext.test.js — Memory OS Phase 4 narration continuity
// (lib/memoryContext.buildContinuity). Proves the recap-side loop: capture this
// week's highlights, recall PRIOR weeks' as string-only context, never leak a
// number into the grounding allow-set, and never throw.
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
const DB_PATH = path.join(os.tmpdir(), `memory_ctx_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { buildContinuity } = require('../lib/memoryContext')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

function packFor(weekStart, highlights, has_data = true) {
  return {
    client: { id: 'cli-K', name: 'K' },
    period: { week_start: weekStart, week_end: weekStart, label: weekStart },
    metrics: {}, highlights, meta: { has_data },
  }
}
const W1 = packFor('2026-06-01', [
  { label: 'Revenue', current: 1200, previous: 900, pct_change: 33.3, direction: 'up' },
])
const W2 = packFor('2026-06-08', [
  { label: 'Revenue', current: 1500, previous: 1200, pct_change: 25, direction: 'up' },
])

test('first week: captures highlights, no prior continuity', async () => {
  await ready()
  const r = await buildContinuity('cli-K', W1)
  assert.equal(r.captured, 1)
  assert.deepEqual(r.continuity, [])
})

test('second week: surfaces the prior week as string-only context, excludes this week', async () => {
  await ready()
  // W1 already captured by the test above (shared DB). Now run W2.
  const r = await buildContinuity('cli-K', W2)
  assert.equal(r.captured, 1)
  assert.ok(r.continuity.length >= 1)

  const prior = r.continuity.find(c => /1200 vs 900/.test(c.note))
  assert.ok(prior, 'prior week note should surface')
  // No entry references THIS week's own highlight (1500 vs 1200).
  assert.ok(!r.continuity.some(c => /1500 vs 1200/.test(c.note)))

  // STRING-only: every field is a string, so nothing pollutes the grounding
  // allow-set (which only collects numeric leaves).
  for (const c of r.continuity) {
    assert.equal(typeof c.note, 'string')
    assert.equal(typeof c.since, 'string')
    assert.equal(Object.keys(c).sort().join(','), 'note,since')
  }
})

test('respects the max cap on continuity entries', async () => {
  await ready()
  const r = await buildContinuity('cli-K', packFor('2026-06-15', []), { max: 1 })
  assert.ok(r.continuity.length <= 1)
})

test('an empty book captures nothing and never throws', async () => {
  await ready()
  const r = await buildContinuity('cli-empty', packFor('2026-06-01', [], false))
  assert.deepEqual(r, { continuity: [], captured: 0 })
})
