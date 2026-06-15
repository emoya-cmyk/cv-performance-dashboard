// ============================================================
// test/memory.grounding.test.js — Memory OS Phase 2 grounding layer
// (lib/memoryGrounding.js). A recalled memory may inform retrieval, but it can
// only be ASSERTED when its numbers trace to the evidence pack.
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
const DB_PATH = path.join(os.tmpdir(), `memory_ground_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db  = require('../db')
const mem = require('../lib/memory')
const { groundClaims, recallGrounded } = require('../lib/memoryGrounding')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

// A minimal evidence pack: collectAllowedNumbers() recurses every numeric leaf,
// so 800 and 25 below are the only "allowed" magnitudes.
const PACK = { metrics: { revenue: { current: 800, pct_change: 25 } }, meta: { has_data: true } }

// ── groundClaims (pure) ─────────────────────────────────────────────────────
test('a claim whose numbers trace to the pack is assertable', () => {
  const [c] = groundClaims([{ content: 'revenue was 800 this week' }], PACK)
  assert.equal(c.assertable, true)
  assert.deepEqual(c.offending, [])
})

test('a claim with an untraceable number is not assertable but is still returned', () => {
  const [c] = groundClaims([{ content: 'revenue was 950 this week' }], PACK)
  assert.equal(c.assertable, false)
  assert.ok(c.offending.length >= 1)
  assert.equal(c.content, 'revenue was 950 this week') // not filtered out
})

test('a number-free claim is grounded by construction', () => {
  const [c] = groundClaims([{ content: 'prefers the weekly rollup parity test' }], PACK)
  assert.equal(c.assertable, true)
})

test('without a pack, groundedness is unknown (null), not assumed', () => {
  const [c] = groundClaims([{ content: 'revenue was 800' }], null)
  assert.equal(c.assertable, null)
})

test('groundClaims does not mutate its inputs', () => {
  const input = Object.freeze({ content: 'revenue was 800' })
  const [c] = groundClaims([input], PACK)
  assert.equal(c.assertable, true)          // would throw if it mutated the frozen input
  assert.equal('assertable' in input, false)
})

// ── recallGrounded (integration) ────────────────────────────────────────────
test('recallGrounded annotates recalled memories and keeps the unassertable ones', async () => {
  await ready()
  const scope = { role: 'agency' }
  await mem.remember(scope, { client_id: 'rg-1', kind: 'k', content: 'revenue was 800', source: 'fact' })
  await mem.remember(scope, { client_id: 'rg-1', kind: 'k', content: 'revenue was 950', source: 'ai' })

  const out = await recallGrounded(scope, { clientId: 'rg-1' }, { pack: PACK })
  assert.equal(out.length, 2) // both returned (both inform retrieval)
  const ok  = out.find(m => m.content === 'revenue was 800')
  const bad = out.find(m => m.content === 'revenue was 950')
  assert.equal(ok.assertable, true)
  assert.equal(bad.assertable, false)
})

test('recallGrounded without a pack falls back to plain recall (assertable null)', async () => {
  await ready()
  await mem.remember({ role: 'agency' }, { client_id: 'rg-2', kind: 'k', content: 'note', source: 'user' })
  const out = await recallGrounded({ role: 'agency' }, { clientId: 'rg-2' })
  assert.equal(out.length, 1)
  assert.equal(out[0].assertable, null)
})
