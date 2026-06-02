// ============================================================
// test/ai.askscope.test.js — the /api/ai/ask client-scope boundary.
//
// resolveAskScope is the route-layer half of intel-v6: it turns the
// authenticated token (req.user, set by requireAuth) into the HARD client id
// that lib/ask.js then binds into every query. The guarantees proven here:
//   • an agency token may see the whole book, or narrow to one real client;
//   • narrowing to an unknown client 404s (no silent whole-book fallthrough);
//   • EVERY other token is pinned to its OWN client_id — a forged body.clientId
//     aimed at a different tenant is ignored (the load-bearing no-leak case);
//   • a non-agency token with no client_id is refused (least privilege), never
//     defaulted to the whole book.
//
// Pure branching over req.user/req.body plus one clients-table existence check,
// so an isolated temp SQLite DB is all it needs — no HTTP, no network, no JWT.
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db
// (transitively, via ../routes/ai). Mirrors test/ai.test.js.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `askscope_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { resolveAskScope } = require('../routes/ai')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// Two real clients so "another tenant" in the leak test is a genuine id.
const SELF  = `scope-self-${process.pid}`
const OTHER = `scope-other-${process.pid}`
let seeded = false
async function seed() {
  if (seeded) return
  await db.migrate()
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [SELF,  'Self Co'])
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [OTHER, 'Other Co'])
  seeded = true
}
const req = (user, body = {}) => ({ user, body })

// ── agency: the only role that may cross clients ──────────────────────────────
test('agency token with no clientId sees the whole book (null scope)', async () => {
  await seed()
  assert.deepEqual(await resolveAskScope(req({ role: 'agency' })), { scopeClientId: null })
})

test('agency token may narrow to a real client', async () => {
  await seed()
  assert.deepEqual(
    await resolveAskScope(req({ role: 'agency' }, { clientId: OTHER })),
    { scopeClientId: OTHER }
  )
})

test('agency narrowing to an unknown client 404s — no whole-book fallthrough', async () => {
  await seed()
  const s = await resolveAskScope(req({ role: 'agency' }, { clientId: 'nope-not-a-real-id' }))
  assert.equal(s.status, 404)
  assert.equal(s.scopeClientId, undefined)   // refused, NOT silently widened to null
})

// ── client (and every non-agency role): hard-pinned to its own id ─────────────
test('client token is pinned to its own client_id', async () => {
  await seed()
  assert.deepEqual(
    await resolveAskScope(req({ role: 'client', client_id: SELF })),
    { scopeClientId: SELF }
  )
})

test('client token IGNORES a body.clientId aimed at another tenant (no cross-tenant leak)', async () => {
  await seed()
  // The forged clientId is a REAL other client — the only thing stopping the leak
  // is that resolveAskScope never reads body.clientId for a non-agency token.
  const s = await resolveAskScope(req({ role: 'client', client_id: SELF }, { clientId: OTHER }))
  assert.deepEqual(s, { scopeClientId: SELF })
})

test('a non-agency token with no client_id is refused, never widened to the book', async () => {
  await seed()
  const s = await resolveAskScope(req({ role: 'client', client_id: null }))
  assert.equal(s.status, 403)
  assert.equal(s.scopeClientId, undefined)
})

test('an unknown/empty role cannot widen — falls under the non-agency pin/refuse rule', async () => {
  await seed()
  // unknown role WITH a client_id → pinned to it (cannot see the book)
  assert.deepEqual(
    await resolveAskScope(req({ role: 'weird', client_id: SELF })),
    { scopeClientId: SELF }
  )
  // unknown role WITHOUT a client_id → refused
  assert.equal((await resolveAskScope(req({ role: 'weird' }))).status, 403)
  // no user object at all → refused (defends a mis-wired route)
  assert.equal((await resolveAskScope({ body: { clientId: OTHER } })).status, 403)
})
