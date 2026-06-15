// ============================================================
// test/memory.test.js — unit tests for the Memory OS Phase 1 engine
// (lib/memory.js + migration 030_agent_memory).
//
// Covers the three load-bearing invariants — precedence, decay/eviction, and
// scope shaping — plus dedup, purity, validation, and empty-state safety.
// Tenant ISOLATION (the leak-proof boundary) is proven separately in
// test/memory.isolation.test.js.
//
// Runs entirely on an isolated temp SQLite DB — no Postgres, no network.
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db (Node
// caches the module, so memory.js shares this same connection / temp file).
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `memory_unit_${process.pid}.db`)
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

// Insert a row with explicit timestamps, bypassing remember() — used to
// simulate aged / pre-expired memories without waiting real time.
async function seedRaw({ client_id = null, kind, content, source, confidence = 1,
                         updated_at, expires_at = null }) {
  const auth = mem.AUTHORITY[source]
  const now  = new Date().toISOString()
  await db.query(
    `INSERT INTO agent_memory
       (client_id, kind, content, source, authority, confidence, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [client_id, kind, content, source, auth, confidence, now, updated_at || now, expires_at],
  )
}

// ── basic round-trip ──────────────────────────────────────────────────────────
test('remember then recall round-trips a claim', async () => {
  await ready()
  const { id, deduped } = await mem.remember(AGENCY, {
    client_id: 'rt-1', kind: 'decision', content: 'use weekly rollup parity test', source: 'user',
  })
  assert.ok(id)
  assert.equal(deduped, false)

  const out = await mem.recall(AGENCY, { clientId: 'rt-1' })
  assert.equal(out.length, 1)
  assert.equal(out[0].content, 'use weekly rollup parity test')
  assert.equal(out[0].source, 'user')
  assert.equal(out[0].authority, mem.AUTHORITY.user)
  // Just written → negligible decay (a few ms elapse before recall).
  assert.ok(out[0].effective_confidence <= out[0].confidence)
  assert.ok(out[0].effective_confidence > out[0].confidence - 1e-6)
})

// ── dedup / reinforcement ───────────────────────────────────────────────────
test('repeating a claim reinforces one row (max confidence, no duplicate)', async () => {
  await ready()
  const a = await mem.remember(AGENCY, { client_id: 'dd-1', kind: 'obs', content: 'lead dip on mondays', source: 'ai', confidence: 0.4 })
  const b = await mem.remember(AGENCY, { client_id: 'dd-1', kind: 'obs', content: 'lead dip on mondays', source: 'fact', confidence: 0.9 })
  assert.equal(b.deduped, true)
  assert.equal(a.id, b.id)

  const out = await mem.recall(AGENCY, { clientId: 'dd-1' })
  assert.equal(out.length, 1)
  assert.equal(out[0].confidence, 0.9)              // max kept
  assert.equal(out[0].authority, mem.AUTHORITY.fact) // higher authority carried forward
  assert.equal(out[0].source, 'fact')
})

// ── precedence ────────────────────────────────────────────────────────────────
test('recall ranks higher authority above lower when decayed confidence ties', async () => {
  await ready()
  await mem.remember(AGENCY, { client_id: 'pr-1', kind: 'k', content: 'low-authority note', source: 'history', confidence: 1 })
  await mem.remember(AGENCY, { client_id: 'pr-1', kind: 'k', content: 'policy note',         source: 'policy',  confidence: 1 })

  const out = await mem.recall(AGENCY, { clientId: 'pr-1' })
  assert.equal(out.length, 2)
  assert.equal(out[0].source, 'policy')   // authority breaks the tie
  assert.equal(out[1].source, 'history')
})

// ── decay ──────────────────────────────────────────────────────────────────────
test('decayFactor halves at the half-life and is 1 at age 0', () => {
  assert.equal(mem.decayFactor(0), 1)
  assert.ok(Math.abs(mem.decayFactor(mem.HALF_LIFE_DAYS) - 0.5) < 1e-9)
  assert.ok(mem.decayFactor(mem.HALF_LIFE_DAYS * 2) < mem.decayFactor(mem.HALF_LIFE_DAYS))
})

test('an older memory ranks below a fresh one of equal confidence', async () => {
  await ready()
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString() // 3 half-lives ago
  await seedRaw({ client_id: 'dk-1', kind: 'k', content: 'stale fact', source: 'fact', confidence: 1, updated_at: old })
  await mem.remember(AGENCY, { client_id: 'dk-1', kind: 'k', content: 'fresh fact', source: 'fact', confidence: 1 })

  const out = await mem.recall(AGENCY, { clientId: 'dk-1' })
  assert.equal(out.length, 2)
  assert.equal(out[0].content, 'fresh fact')
  const stale = out.find(m => m.content === 'stale fact')
  assert.ok(stale.effective_confidence < stale.confidence) // decayed below raw
})

// ── eviction: TTL + forget ──────────────────────────────────────────────────
test('an expired memory is not recalled; a future TTL still is', async () => {
  await ready()
  const past = new Date(Date.now() - 1000).toISOString()
  await seedRaw({ client_id: 'tt-1', kind: 'k', content: 'expired', source: 'ai', expires_at: past })
  await mem.remember(AGENCY, { client_id: 'tt-1', kind: 'k', content: 'lives', source: 'ai', ttlDays: 7 })

  const out = await mem.recall(AGENCY, { clientId: 'tt-1' })
  assert.equal(out.length, 1)
  assert.equal(out[0].content, 'lives')
  assert.ok(out[0].expires_at) // TTL recorded
})

test('forget soft-deletes and returns a count; recall no longer sees it', async () => {
  await ready()
  const { id } = await mem.remember(AGENCY, { client_id: 'fg-1', kind: 'k', content: 'forget me', source: 'user' })
  const n = await mem.forget(AGENCY, { id })
  assert.equal(n, 1)
  assert.equal((await mem.recall(AGENCY, { clientId: 'fg-1' })).length, 0)
  // Idempotent: forgetting again affects nothing.
  assert.equal(await mem.forget(AGENCY, { id }), 0)
})

// ── empty-state safety ─────────────────────────────────────────────────────────
test('empty store: recall is [] and forget is 0 with no NaN', async () => {
  await ready()
  const out = await mem.recall(AGENCY, { clientId: 'nobody-here' })
  assert.deepEqual(out, [])
  assert.equal(await mem.forget(AGENCY, { clientId: 'nobody-here' }), 0)
})

// ── purity / determinism ───────────────────────────────────────────────────────
test('remember does not mutate the input claim, and recall is deterministic', async () => {
  await ready()
  const claim = Object.freeze({ client_id: 'pu-1', kind: 'k', content: 'immutable input', source: 'user' })
  await mem.remember(AGENCY, claim) // would throw if it tried to mutate a frozen object
  // Pin the clock so the decay-derived effective_confidence is identical across
  // both reads (otherwise two calls a millisecond apart differ — see opts.now).
  const now = new Date().toISOString()
  const a = await mem.recall(AGENCY, { clientId: 'pu-1' }, { now })
  const b = await mem.recall(AGENCY, { clientId: 'pu-1' }, { now })
  assert.deepEqual(a, b)
})

// ── validation (fail closed) ───────────────────────────────────────────────────
test('invalid scope and unknown source are rejected', async () => {
  await ready()
  await assert.rejects(() => mem.remember({ role: 'nope' }, { kind: 'k', content: 'x', source: 'user' }))
  await assert.rejects(() => mem.remember({ role: 'client' }, { kind: 'k', content: 'x', source: 'user' })) // no clientId
  await assert.rejects(() => mem.remember(AGENCY, { kind: 'k', content: 'x', source: 'made-up' }))
  await assert.rejects(() => mem.remember(AGENCY, { kind: '', content: 'x', source: 'user' }))
})

test('confidence is clamped into [0,1]', async () => {
  await ready()
  await mem.remember(AGENCY, { client_id: 'cc-1', kind: 'k', content: 'too big', source: 'user', confidence: 5 })
  await mem.remember(AGENCY, { client_id: 'cc-1', kind: 'k', content: 'too small', source: 'user', confidence: -3 })
  const out = await mem.recall(AGENCY, { clientId: 'cc-1' })
  const big = out.find(m => m.content === 'too big')
  const small = out.find(m => m.content === 'too small')
  assert.equal(big.confidence, 1)
  assert.equal(small.confidence, 0)
})
