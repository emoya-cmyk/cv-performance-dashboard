// ============================================================
// test/memoryProducer.test.js — Memory OS Phase 2 first producer
// (lib/memoryProducer.js). Turns weekly evidence-pack highlights into durable,
// client-scoped memories, and proves the produce → recall → re-ground loop:
// a highlight grounds against its own pack but is flagged non-assertable when
// re-checked against a later pack where the numbers no longer hold.
//
// The pack is injected so the producer is testable without heavy fixtures (it
// builds the pack from the DB in production).
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
const DB_PATH = path.join(os.tmpdir(), `memory_producer_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { captureHighlights } = require('../lib/memoryProducer')
const { recallGrounded }    = require('../lib/memoryGrounding')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

function packWithHighlights(weekStart, highlights, has_data = true) {
  return {
    client:  { id: 'cli-P', name: 'P' },
    period:  { week_start: weekStart, week_end: weekStart, label: weekStart },
    metrics: {},
    highlights,
    meta:    { has_data },
  }
}

const PACK1 = packWithHighlights('2026-06-01', [
  { label: 'Revenue', current: 1200, previous: 900, pct_change: 33.3,  direction: 'up' },
  { label: 'Leads',   current: 40,   previous: 60,  pct_change: -33.3, direction: 'down' },
])

test('captureHighlights writes one client-scoped memory per highlight', async () => {
  await ready()
  const ids = await captureHighlights('cli-P', { pack: PACK1, scope: { role: 'agency' } })
  assert.equal(ids.length, 2)

  // Readable by the client itself (proves the writes were scoped to its tenant).
  const out = await recallGrounded({ role: 'client', clientId: 'cli-P' }, { kind: 'highlight' }, { pack: PACK1 })
  assert.equal(out.length, 2)
  assert.ok(out.every(m => m.client_id === 'cli-P'))
  assert.ok(out.some(m => /Revenue up 33.3% week over week \(1200 vs 900\)/.test(m.content)))
})

test('a captured highlight is assertable against its own pack', async () => {
  await ready()
  await captureHighlights('cli-self', { pack: PACK1, scope: { role: 'agency' } })
  const out = await recallGrounded({ role: 'agency' }, { clientId: 'cli-self', kind: 'highlight' }, { pack: PACK1 })
  assert.ok(out.length >= 1)
  assert.ok(out.every(m => m.assertable === true)) // numbers all trace to PACK1
})

test('the same highlight is NOT assertable against a later pack where it no longer holds', async () => {
  await ready()
  await captureHighlights('cli-stale', { pack: PACK1, scope: { role: 'agency' } })

  // A new week: revenue is now 500, no trace of last week's 1200/900/33.3.
  const PACK2 = packWithHighlights('2026-06-08', [
    { label: 'Revenue', current: 500, previous: 480, pct_change: 4.2, direction: 'up' },
  ])
  const out = await recallGrounded({ role: 'agency' }, { clientId: 'cli-stale', kind: 'highlight' }, { pack: PACK2 })
  assert.ok(out.length >= 1)
  assert.ok(out.some(m => m.assertable === false)) // stale highlight flagged, still recalled
})

test('an empty book captures nothing', async () => {
  await ready()
  const ids = await captureHighlights('cli-empty', { pack: packWithHighlights('2026-06-01', [], false) })
  assert.deepEqual(ids, [])
})
