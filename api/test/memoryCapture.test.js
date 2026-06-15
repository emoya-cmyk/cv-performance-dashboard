// ============================================================
// test/memoryCapture.test.js — Memory OS Phase 6 autonomous capture sweep
// (lib/memoryCapture.captureAllClients). Walks clients, captures highlights,
// isolates per-client failures. Pack/clients injected for determinism.
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
const DB_PATH = path.join(os.tmpdir(), `memory_sweep_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { captureAllClients } = require('../lib/memoryCapture')
const { recall } = require('../lib/memory')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

const packFor = (id) => ({
  client: { id, name: id },
  period: { week_start: '2026-06-01', week_end: '2026-06-07', label: 'wk' },
  metrics: {},
  highlights: [{ label: 'Revenue', current: 1000, previous: 800, pct_change: 25, direction: 'up' }],
  meta: { has_data: true },
})

test('captures highlights for each provided client', async () => {
  await ready()
  const summary = await captureAllClients({ clients: ['c1', 'c2'], packFor })
  assert.equal(summary.clients, 2)
  assert.equal(summary.captured, 2)   // one highlight each
  assert.equal(summary.failed, 0)

  const c1 = await recall({ role: 'client', clientId: 'c1' }, { kind: 'highlight' })
  assert.ok(c1.some(m => /Revenue up 25%/.test(m.content)))
})

test('a per-client failure is isolated, the rest still capture', async () => {
  await ready()
  const flaky = (id) => { if (id === 'bad') throw new Error('boom'); return packFor(id) }
  const summary = await captureAllClients({ clients: ['ok1', 'bad', 'ok2'], packFor: flaky })
  assert.equal(summary.failed, 1)
  assert.equal(summary.clients, 2)
  assert.ok(summary.captured >= 2)
})

test('falls back to the clients table when no list is injected', async () => {
  await ready()
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, ['swept', 'Swept Co'])
  const summary = await captureAllClients({ packFor })
  assert.ok(summary.clients >= 1)
  assert.ok((await recall({ role: 'agency' }, { clientId: 'swept', kind: 'highlight' })).length >= 1)
})
