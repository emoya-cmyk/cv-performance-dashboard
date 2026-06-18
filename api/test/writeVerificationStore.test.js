'use strict'

// Integration tests for lib/writeVerificationStore against an isolated SQLite
// database (Spec A): the append-only correctness log, the per-(tenant, endpoint)
// accumulator, the read API — and a leak-proof multi-tenant isolation check, as
// required for any new tenant-scoped surface.

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

// Pin an isolated SQLite file BEFORE requiring db (db.js picks SQLite when
// DATABASE_URL is unset and honors SQLITE_PATH).
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `wv_store_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { recordWriteVerification, getCorrectnessStats } = require('../lib/writeVerificationStore')

before(async () => { await db.migrate() })
after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

const rec = (over = {}) => recordWriteVerification({
  query: db.query,
  tenantId: 't1',
  endpoint: 'ghl:contact.upsert',
  persisted: true,
  intended: { email: 'A@X.com' },
  readBack: { email: 'a@x.com' },
  ...over,
})

// ── classification on write ─────────────────────────────────────────────────

test('records each correctness outcome and logs mismatch fields', async () => {
  const ok = await rec()
  assert.equal(ok.outcome, 'VERIFIED_CORRECT')

  const wrong = await rec({ readBack: { email: 'someone-else@x.com' } })
  assert.equal(wrong.outcome, 'PERSISTED_INCORRECT')
  assert.deepEqual(wrong.mismatchFields, ['email'])

  const unverified = await rec({ readBack: undefined })
  assert.equal(unverified.outcome, 'PERSISTED_UNVERIFIED')
  assert.equal(unverified.readBackAvailable, false)

  const failed = await rec({ persisted: false })
  assert.equal(failed.outcome, 'FAILED')

  // The log row exists and stored the mismatch detail.
  const { rows } = await db.query(
    `SELECT outcome, mismatch_fields FROM write_verification_log WHERE outcome = 'PERSISTED_INCORRECT'`)
  assert.ok(rows.length >= 1)
  assert.match(rows[0].mismatch_fields, /email/)
})

// ── per-(tenant, endpoint) accumulation ─────────────────────────────────────

test('stats accumulate per (tenant, endpoint) with rate + wilson lower bound', async () => {
  const ep = 'hubspot:deal.update'
  for (let i = 0; i < 9; i++) await rec({ endpoint: ep }) // 9 VERIFIED_CORRECT
  await rec({ endpoint: ep, readBack: { email: 'no@x.com' } }) // 1 PERSISTED_INCORRECT

  const stats = await getCorrectnessStats({ query: db.query, tenantId: 't1' })
  const row = stats.find(s => s.endpoint === ep)
  assert.ok(row, 'endpoint row present')
  assert.equal(row.total, 10)
  assert.equal(row.verified_correct, 9)
  assert.equal(row.persisted_incorrect, 1)
  assert.equal(row.verified_rate, 0.9)
  // Wilson lower bound is strictly below the 0.9 point estimate.
  assert.ok(row.wilson_lower > 0 && row.wilson_lower < 0.9, `wilson_lower=${row.wilson_lower}`)
})

// ── multi-tenant isolation (leak-proof) ─────────────────────────────────────

test('correctness stats never leak across tenants', async () => {
  const ep = 'shared:endpoint'
  await rec({ tenantId: 'tenant-A', endpoint: ep }) // A: 1 correct
  await rec({ tenantId: 'tenant-B', endpoint: ep, persisted: false }) // B: 1 failed
  await rec({ tenantId: 'tenant-B', endpoint: ep, persisted: false }) // B: 1 failed

  const a = await getCorrectnessStats({ query: db.query, tenantId: 'tenant-A' })
  const b = await getCorrectnessStats({ query: db.query, tenantId: 'tenant-B' })

  // A sees only its own (1 correct, 0 failed); B sees only its own (0 correct, 2 failed).
  assert.equal(a.length, 1)
  assert.equal(a[0].verified_correct, 1)
  assert.equal(a[0].failed, 0)
  assert.equal(a[0].total, 1)

  const bRow = b.find(s => s.endpoint === ep)
  assert.equal(bRow.failed, 2)
  assert.equal(bRow.verified_correct, 0)

  // A's scoped query must contain no tenant-B rows at all.
  assert.ok(a.every(s => s.tenant_id === 'tenant-A'))
})
