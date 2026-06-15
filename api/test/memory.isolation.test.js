// ============================================================
// test/memory.isolation.test.js — leak-proof tenant boundary for the Memory OS
// (lib/memory.js).
//
// The single non-negotiable invariant: a 'client' scope can NEVER read, write,
// or forget another tenant's memory — and never sees agency-wide (NULL-scoped)
// memory either. This is the memory-layer counterpart to the REST authz
// boundary (middleware/authz.js) and must hold even when a caller forges a
// cross-tenant id in the query/selector.
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
const DB_PATH = path.join(os.tmpdir(), `memory_iso_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db  = require('../db')
const mem = require('../lib/memory')

after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

const AGENCY = { role: 'agency' }
const A      = { role: 'client', clientId: 'tenant-A' }
const B      = { role: 'client', clientId: 'tenant-B' }

// Seed one memory per tenant plus one agency-wide row. Resets the table first
// so each seed-based test is independent of state left by earlier tests.
async function seedTenants() {
  await ready()
  await db.query('DELETE FROM agent_memory')
  await mem.remember(AGENCY, { client_id: 'tenant-A', kind: 'k', content: 'A secret', source: 'user' })
  await mem.remember(AGENCY, { client_id: 'tenant-B', kind: 'k', content: 'B secret', source: 'user' })
  await mem.remember(AGENCY, { client_id: null,        kind: 'k', content: 'agency-wide note', source: 'policy' })
}

test('a client recall sees only its own tenant — not peers, not agency-wide', async () => {
  await seedTenants()
  const out = await mem.recall(A, {})
  const contents = out.map(m => m.content).sort()
  assert.deepEqual(contents, ['A secret'])
  assert.ok(!contents.includes('B secret'))
  assert.ok(!contents.includes('agency-wide note'))
})

test('a client cannot read a peer by forging query.clientId (clamped to self)', async () => {
  await seedTenants()
  const out = await mem.recall(A, { clientId: 'tenant-B' }) // forged
  assert.deepEqual(out.map(m => m.content), ['A secret']) // clamp wins; no B leak
})

test('a client cannot write into another tenant', async () => {
  await ready()
  await assert.rejects(
    () => mem.remember(A, { client_id: 'tenant-B', kind: 'k', content: 'cross-write', source: 'user' }),
    /another client_id/,
  )
  // And nothing leaked into B.
  const b = await mem.recall(B, {})
  assert.ok(!b.some(m => m.content === 'cross-write'))
})

test('a client write with no explicit id lands on its own tenant', async () => {
  await ready()
  await mem.remember(A, { kind: 'k', content: 'A implicit', source: 'user' })
  const a = await mem.recall(A, {})
  assert.ok(a.some(m => m.content === 'A implicit' && m.client_id === 'tenant-A'))
  const b = await mem.recall(B, {})
  assert.ok(!b.some(m => m.content === 'A implicit'))
})

test('a client forget cannot touch a peer (clamped), even with a forged id', async () => {
  await seedTenants()
  // B's row id, discovered via the agency view.
  const bRow = (await mem.recall(AGENCY, { clientId: 'tenant-B' }))[0]
  assert.equal(bRow.content, 'B secret')

  const n = await mem.forget(A, { id: bRow.id }) // A tries to forget B's memory
  assert.equal(n, 0)                             // clamp → nothing forgotten

  // B still has it.
  const b = await mem.recall(B, {})
  assert.ok(b.some(m => m.content === 'B secret'))
})

test('a client forget without selector wipes only its own rows', async () => {
  await seedTenants()
  const n = await mem.forget(A, {})
  assert.equal(n, 1)                             // only A's single row
  assert.deepEqual((await mem.recall(A, {})).map(m => m.content), [])
  // B and agency-wide untouched.
  assert.ok((await mem.recall(B, {})).some(m => m.content === 'B secret'))
  assert.ok((await mem.recall(AGENCY, { clientId: null })).some(m => m.content === 'agency-wide note'))
})

test('agency sees every tenant and the agency-wide row', async () => {
  await seedTenants()
  const all = (await mem.recall(AGENCY, {})).map(m => m.content)
  assert.ok(all.includes('A secret'))
  assert.ok(all.includes('B secret'))
  assert.ok(all.includes('agency-wide note'))
})
