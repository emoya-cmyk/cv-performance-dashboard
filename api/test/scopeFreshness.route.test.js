// ============================================================
// test/scopeFreshness.route.test.js — intel-v13 C4 (step b): the engine half
// behind POST /api/ai/ask/scope-freshness (lib/scopeNarrative.runScopeFreshness).
//
// runScopeFreshness is the CHEAP "did MY data change?" probe the live-refresh gate
// calls on every global SSE tick. It runs ONE GROUP BY metric_key aggregate over
// exactly the tenant-scoped, date/channel-filtered rows the scope-insight reads,
// and folds it (via lib/scopeFreshness, step a) into an opaque { version, freshAt }
// token. Three layers, no HTTP:
//
//   1. FAKE-QUERY — inject a fake `query` that captures the SQL + params, proving:
//      the aggregate shape, the compiler's exact WHERE order, the metric_key
//      restriction = the union of metricKeyDeps over the picked metrics, the 400s
//      (bad/again missing dateRange, start>end, unknown channel key — none of which
//      ever reach SQL), the leak invariant (a body client-dim filter is dropped;
//      the token is a pure function of the aggregate and carries no tenant id), and
//      that the response is EXACTLY { version, freshAt }.
//
//   2. REAL SQLITE — seed fact_metric on an isolated temp DB (mirrors
//      query.golden.test.js) and drive runScopeFreshness through the real db.query,
//      proving: a populated scope tokenises (non-empty); a brand-new row MOVES the
//      token; an in-place ≥$0.01 correction MOVES it; a sub-cent correction does
//      NOT; another client's rows NEVER move SELF's token; the date window and the
//      channel filter genuinely scope the reading; and the metric_key restriction
//      makes a spend change invisible to a revenue-only probe.
//
//   3. ROUTE COMPOSE — drive the route's exact two stages, resolveAskScope →
//      runScopeFreshness (the POST /ask/scope-freshness handler body minus only the
//      Express/JSON transport), proving the CLIENT-surface leak-proof contract
//      end-to-end: a client token's freshness reading is its OWN even when the body
//      forges clientId AND a client-dim filter at a real peer (it equals a clean
//      self-probe, never the peer's); that same forged clientId yields the PEER's
//      token ONLY for an agency role (the pin is real and role-gated); an agency
//      token with no clientId reads the whole book; a client token with no
//      client_id is refused 403 and never probes the book; and the client payload
//      is EXACTLY { version, freshAt } — no agency-only field rides it.
//
// Runs entirely on SQLite — no Postgres, no network. Run with:  node --test (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db (transitively,
// via ../lib/scopeNarrative → ../semantic/compile → ../db). Mirrors query.golden.test.js.
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `scopefresh_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db             = require('../db')
const facts          = require('../lib/facts')
const { channelId }  = require('../semantic/registry')
const { runScopeFreshness } = require('../lib/scopeNarrative')
const scopeFreshness = require('../lib/scopeFreshness')
const { resolveAskScope }   = require('../routes/ai')   // Layer 3: the route's tenancy gate (resolve→probe)

after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

const WIN = { start: '2026-05-01', end: '2026-05-31' }

// ──────────────────────────────────────────────────────────────────────────
// Layer 1 — fake `query`: SQL/param shape, restriction, 400s, leak invariant
// ──────────────────────────────────────────────────────────────────────────

// A fake query that records every (sql, params) and returns canned rows. The
// freshness path injects its `query`, so this needs no DB at all.
function fakeQuery(rows = []) {
  const calls = []
  const q = async (sql, params) => { calls.push({ sql, params }); return { rows } }
  q.calls = calls
  return q
}
const scope = (id) => ({ scopeClientId: id, role: id ? 'client' : 'agency' })

test('fake: aggregate shape + compiler WHERE order + full-set metric_key union', async () => {
  const q = fakeQuery([])
  await runScopeFreshness({ dateRange: WIN }, q, scope('7'))

  assert.equal(q.calls.length, 1)
  const { sql, params } = q.calls[0]

  // the cheap aggregate, by metric_key, with the portable date cast.
  assert.match(sql, /FROM fact_metric/)
  assert.match(sql, /GROUP BY metric_key/)
  assert.match(sql, /COUNT\(\*\) AS rows/)
  assert.match(sql, /CAST\(MAX\(date\) AS TEXT\) AS max_date/)
  assert.match(sql, /SUM\(metric_value\) AS sum_value/)

  // WHERE order mirrors the compiler exactly: client_id → date>= → date<= → metric_key.
  // metrics defaulted to the full six → metric_key union (in first-appearance order).
  assert.deepEqual(params, [
    '7', '2026-05-01', '2026-05-31',
    'revenue', 'leads', 'spend', 'closed_won', 'raw_leads',
  ])
  // client_id predicate precedes the window which precedes the metric_key set.
  assert.ok(sql.indexOf('client_id') < sql.indexOf('date >='))
  assert.ok(sql.indexOf('date <=') < sql.indexOf('metric_key IN'))
})

test('fake: a metric subset restricts the metric_key set to its deps only', async () => {
  const onlyRevenue = fakeQuery([])
  await runScopeFreshness({ dateRange: WIN, metrics: ['revenue'] }, onlyRevenue, scope('7'))
  assert.deepEqual(onlyRevenue.calls[0].params.slice(3), ['revenue'])

  // roas is a ratio → its base keys are revenue + spend (NOT a 'roas' column).
  const roas = fakeQuery([])
  await runScopeFreshness({ dateRange: WIN, metrics: ['roas'] }, roas, scope('7'))
  assert.deepEqual(roas.calls[0].params.slice(3), ['revenue', 'spend'])

  // close_rate → closed_won / raw_leads.
  const closeRate = fakeQuery([])
  await runScopeFreshness({ dateRange: WIN, metrics: ['close_rate'] }, closeRate, scope('7'))
  assert.deepEqual(closeRate.calls[0].params.slice(3), ['closed_won', 'raw_leads'])
})

test('fake: agency scope (null) emits NO client_id predicate — whole book', async () => {
  const q = fakeQuery([])
  await runScopeFreshness({ dateRange: WIN }, q, scope(null))
  const { sql, params } = q.calls[0]
  assert.ok(!/client_id/.test(sql), 'portfolio probe must not bind a client_id')
  assert.equal(params[0], '2026-05-01')   // window is first when unscoped
  assert.equal(params[1], '2026-05-31')
})

test('fake: a channel filter adds an intersected channel_id IN, after dates, before metric_key', async () => {
  const q = fakeQuery([])
  await runScopeFreshness(
    { dateRange: WIN, filters: [{ dim: 'channel', op: 'in', values: ['google_ads', 'meta'] }] },
    q, scope('7'))
  const { sql, params } = q.calls[0]
  assert.match(sql, /channel_id IN/)
  // client_id(1) → date>=(1) → date<=(1) → channel_id(2) → metric_key(5)
  assert.equal(params[0], '7')
  assert.equal(params[1], '2026-05-01')
  assert.equal(params[2], '2026-05-31')
  assert.equal(params[3], channelId('google_ads'))
  assert.equal(params[4], channelId('meta'))
  assert.deepEqual(params.slice(5), ['revenue', 'leads', 'spend', 'closed_won', 'raw_leads'])
  assert.ok(sql.indexOf('date <=') < sql.indexOf('channel_id IN'))
  assert.ok(sql.indexOf('channel_id IN') < sql.indexOf('metric_key IN'))
})

test('fake: a body client-dim filter is DROPPED — cannot narrow into a tenant (leak invariant)', async () => {
  const q = fakeQuery([])
  await runScopeFreshness(
    { dateRange: WIN, filters: [{ dim: 'client', op: 'in', values: ['999'] }] },
    q, scope('7'))
  const { sql, params } = q.calls[0]
  assert.ok(!params.includes('999'), 'a forged client filter must never reach SQL')
  assert.equal(params[0], '7')                  // only the scope's OWN client is bound
  assert.ok(!/channel_id/.test(sql), 'client-dim filter dropped → no channel predicate left')
})

test('fake: bad dateRange / start>end / unknown channel → 400 and NO query', async () => {
  const bad = [
    {},                                                       // missing dateRange
    { dateRange: { start: '2026-05-01' } },                   // missing end
    { dateRange: { start: '2026-05-01', end: '2026/05/31' } }, // malformed end
    { dateRange: { start: 'May', end: '2026-05-31' } },        // malformed start
    { dateRange: { start: '2026-05-31', end: '2026-05-01' } }, // start after end
    { dateRange: WIN, filters: [{ dim: 'channel', op: 'in', values: ['not_a_channel'] }] }, // unknown channel
  ]
  for (const input of bad) {
    const q = fakeQuery([])
    await assert.rejects(() => runScopeFreshness(input, q, scope('7')), (e) => e.status === 400)
    assert.equal(q.calls.length, 0, 'a 400 must short-circuit before any SQL runs')
  }
})

test('fake: response is EXACTLY { version, freshAt }; empty scope → sf1:empty', async () => {
  const empty = await runScopeFreshness({ dateRange: WIN }, fakeQuery([]), scope('7'))
  assert.deepEqual(Object.keys(empty).sort(), ['freshAt', 'version'])
  assert.equal(empty.version, scopeFreshness.EMPTY_TOKEN)
  assert.ok(!Number.isNaN(Date.parse(empty.freshAt)), 'freshAt is an ISO timestamp')
})

test('fake: the token is a PURE function of the aggregate — carries no tenant identity', async () => {
  const rows = [{ metric_key: 'revenue', rows: 3, max_date: '2026-05-15', sum_value: 10000 }]
  const a = await runScopeFreshness({ dateRange: WIN }, fakeQuery(rows), scope('7'))
  // matches the step-a fold byte-for-byte → nothing but the aggregate is baked in.
  assert.equal(a.version, scopeFreshness.versionFromAggregate(rows))
  assert.match(a.version, /^sf1:/)
  // SAME aggregate under a DIFFERENT tenant scope → SAME token (no client id mixed in).
  const b = await runScopeFreshness({ dateRange: WIN }, fakeQuery(rows), scope('999'))
  assert.equal(b.version, a.version)
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 2 — real SQLite: change-detection + scoping + tenant isolation
// ──────────────────────────────────────────────────────────────────────────

const FACT_UPSERT = `
  INSERT INTO fact_metric (client_id, date, channel_id, entity_id, metric_key, metric_value)
  VALUES ($1,$2,$3,$4,$5,$6)
  ON CONFLICT (client_id, date, channel_id, COALESCE(entity_id,0), metric_key)
  DO UPDATE SET metric_value = EXCLUDED.metric_value`

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }
const dbQuery = (sql, params) => db.query(sql, params)

async function insertAccountFacts(clientId, list) {
  for (const f of list) {
    await db.query(FACT_UPSERT, [clientId, f.date, facts.channelId(f.channel), null, f.metric_key, f.value])
  }
}
let seq = 0
async function freshClient(name) {
  const id = `sf-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}
// Probe a client's May window (optionally overriding metrics / filters / dateRange).
async function probe(clientId, input = {}) {
  const out = await runScopeFreshness({ dateRange: WIN, ...input }, dbQuery, { scopeClientId: clientId, role: 'client' })
  return out.version
}

test('db: a populated scope tokenises; an empty scope is sf1:empty', async () => {
  await ready()
  const c = await freshClient('Fresh Co')
  await insertAccountFacts(c, [
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 },
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'spend',   value: 1000 },
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'leads',   value: 40 },
  ])
  const t = await probe(c)
  assert.match(t, /^sf1:/)
  assert.notEqual(t, scopeFreshness.EMPTY_TOKEN)

  const empty = await freshClient('Empty Co')
  assert.equal(await probe(empty), scopeFreshness.EMPTY_TOKEN)
})

test('db: a brand-new row MOVES the token (data landed → shouldRefresh)', async () => {
  await ready()
  const c = await freshClient('Lands Co')
  await insertAccountFacts(c, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 }])
  const t1 = await probe(c)
  await insertAccountFacts(c, [{ date: '2026-05-20', channel: 'google_ads', metric_key: 'revenue', value: 1500 }])
  const t2 = await probe(c)
  assert.notEqual(t1, t2)
  assert.ok(scopeFreshness.shouldRefresh(t1, t2))
})

test('db: an in-place ≥$0.01 correction MOVES the token; a sub-cent change does NOT', async () => {
  await ready()
  // ≥ a cent → moves
  const c1 = await freshClient('Cent Co')
  await insertAccountFacts(c1, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'spend', value: 1000.00 }])
  const a1 = await probe(c1)
  await insertAccountFacts(c1, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'spend', value: 1000.01 }]) // same grain → UPSERT in place
  const a2 = await probe(c1)
  assert.notEqual(a1, a2)
  assert.ok(scopeFreshness.shouldRefresh(a1, a2))

  // sub-cent jitter → identical (quantised to cents, immune to float noise)
  const c2 = await freshClient('Jitter Co')
  await insertAccountFacts(c2, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'spend', value: 1000.00 }])
  const b1 = await probe(c2)
  await insertAccountFacts(c2, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'spend', value: 1000.004 }])
  const b2 = await probe(c2)
  assert.equal(b1, b2)
  assert.ok(!scopeFreshness.shouldRefresh(b1, b2))
})

test("db: another client's rows NEVER move SELF's token (tenant isolation)", async () => {
  await ready()
  const self = await freshClient('Self Co')
  await insertAccountFacts(self, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 }])
  const t1 = await probe(self)

  const other = await freshClient('Other Co')
  await insertAccountFacts(other, [
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 99999 },
    { date: '2026-05-25', channel: 'meta',       metric_key: 'revenue', value: 88888 },
  ])
  const t2 = await probe(self)
  assert.equal(t1, t2, "SELF's token is blind to OTHER's data")
})

test('db: the date window genuinely scopes the reading', async () => {
  await ready()
  const c = await freshClient('Window Co')
  await insertAccountFacts(c, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 }])
  const tIn = await probe(c)
  // a June row is OUTSIDE the May window → invisible to the May probe.
  await insertAccountFacts(c, [{ date: '2026-06-10', channel: 'google_ads', metric_key: 'revenue', value: 7000 }])
  assert.equal(tIn, await probe(c))
  // widening the window to include June DOES change the reading.
  const tJune = await probe(c, { dateRange: { start: '2026-05-01', end: '2026-06-30' } })
  assert.notEqual(tIn, tJune)
})

test('db: a channel filter genuinely scopes the reading', async () => {
  await ready()
  const c = await freshClient('Channel Co')
  await insertAccountFacts(c, [
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 },
    { date: '2026-05-10', channel: 'meta',       metric_key: 'revenue', value: 3000 },
  ])
  const tAll = await probe(c)
  const tG   = await probe(c, { filters: [{ dim: 'channel', op: 'in', values: ['google_ads'] }] })
  const tM   = await probe(c, { filters: [{ dim: 'channel', op: 'in', values: ['meta'] }] })
  assert.notEqual(tG, tM)    // distinct per-channel slices
  assert.notEqual(tAll, tG)  // the all-channel reading differs from the google-only slice
})

test('db: the metric_key restriction makes a spend change invisible to a revenue-only probe', async () => {
  await ready()
  const c = await freshClient('Metric Co')
  await insertAccountFacts(c, [
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 },
    { date: '2026-05-10', channel: 'google_ads', metric_key: 'spend',   value: 1000 },
  ])
  const tRev   = await probe(c, { metrics: ['revenue'] })
  const tSpend = await probe(c, { metrics: ['spend'] })
  assert.notEqual(tRev, tSpend)

  // bump spend in place — a revenue-only probe (metric_key IN ('revenue')) cannot see it…
  await insertAccountFacts(c, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'spend', value: 2000 }])
  assert.equal(tRev, await probe(c, { metrics: ['revenue'] }))
  // …but a spend probe does.
  assert.notEqual(tSpend, await probe(c, { metrics: ['spend'] }))
})

// ──────────────────────────────────────────────────────────────────────────
// Layer 3 — route compose: resolveAskScope → runScopeFreshness, the client
// surface's leak-proof contract end-to-end (the route minus HTTP transport).
// The POST /ask/scope-freshness handler is exactly: resolve tenancy from the
// TOKEN, bail on its error status, else probe the resolved aggregate. We drive
// those two stages with forged bodies and prove a client token can never read a
// peer — not via body.clientId, not via a client-dim filter — while an agency
// token's narrowing still works and is the ONLY way the same forged id resolves
// to the peer. ai.askscope.test.js proves stage 1 in isolation and Layer 1/2
// prove stage 2; this composes them as the live route does.
// ──────────────────────────────────────────────────────────────────────────

async function routeFreshness(req) {
  const scope = await resolveAskScope(req)
  if (scope.error) return { error: scope.error, status: scope.status }
  return runScopeFreshness(req.body || {}, dbQuery, {
    scopeClientId: scope.scopeClientId,
    role: req.user?.role || null,
  })
}
const asReq = (user, body = {}) => ({ user, body })

test('route: a client token probes its OWN scope even when the body forges clientId at a real peer', async () => {
  await ready()
  const self  = await freshClient('L3 Self')
  const other = await freshClient('L3 Other')
  await insertAccountFacts(self,  [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 }])
  await insertAccountFacts(other, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 9999 }])
  const out = await routeFreshness(asReq({ role: 'client', client_id: self }, { dateRange: WIN, clientId: other }))
  assert.equal(out.version, await probe(self))       // its OWN reading…
  assert.notEqual(out.version, await probe(other))   // …never the peer's
})

test('route: a forged client-dim FILTER cannot cross tenants either (defence-in-depth compose)', async () => {
  await ready()
  const self  = await freshClient('L3 Self2')
  const other = await freshClient('L3 Other2')
  await insertAccountFacts(self,  [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 4200 }])
  await insertAccountFacts(other, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 8800 }])
  const out = await routeFreshness(asReq(
    { role: 'client', client_id: self },
    { dateRange: WIN, clientId: other, filters: [{ dim: 'client', op: 'in', values: [other] }] },
  ))
  assert.equal(out.version, await probe(self))       // the route pins, the engine drops the filter — both gates hold
})

test('route: the SAME forged clientId yields the PEER token only for an AGENCY role (pin is real + role-gated)', async () => {
  await ready()
  const self  = await freshClient('L3 Self3')
  const other = await freshClient('L3 Other3')
  await insertAccountFacts(self,  [{ date: '2026-05-12', channel: 'meta', metric_key: 'revenue', value: 1234 }])
  await insertAccountFacts(other, [{ date: '2026-05-12', channel: 'meta', metric_key: 'revenue', value: 7777 }])
  const agencyNarrowed = await routeFreshness(asReq({ role: 'agency' }, { dateRange: WIN, clientId: other }))
  assert.equal(agencyNarrowed.version, await probe(other))    // agency MAY narrow to the named peer…
  const clientPinned = await routeFreshness(asReq({ role: 'client', client_id: self }, { dateRange: WIN, clientId: other }))
  assert.equal(clientPinned.version, await probe(self))       // …a client token with the identical body cannot
  assert.notEqual(agencyNarrowed.version, clientPinned.version)
})

test('route: an agency token with no clientId probes the WHOLE BOOK (≠ any one client, ≠ empty)', async () => {
  await ready()
  const a = await freshClient('L3 Book A')
  const b = await freshClient('L3 Book B')
  await insertAccountFacts(a, [{ date: '2026-05-05', channel: 'google_ads', metric_key: 'revenue', value: 3000 }])
  await insertAccountFacts(b, [{ date: '2026-05-06', channel: 'meta',       metric_key: 'revenue', value: 6000 }])
  const book = await routeFreshness(asReq({ role: 'agency' }, { dateRange: WIN }))
  assert.equal(book.version, await probe(null))               // null scope = the whole book, same instant
  assert.notEqual(book.version, await probe(a))               // strictly more than any single client
  assert.notEqual(book.version, scopeFreshness.EMPTY_TOKEN)
})

test('route: a client token with NO client_id is refused 403 and never probes the book', async () => {
  await ready()
  const out = await routeFreshness(asReq({ role: 'client', client_id: null }, { dateRange: WIN }))
  assert.equal(out.status, 403)
  assert.ok(!('version' in out), 'a refused scope must return before any probe runs')
})

test('route: the client freshness payload is EXACTLY { version, freshAt } — no agency-only field rides it', async () => {
  await ready()
  const self = await freshClient('L3 Shape')
  await insertAccountFacts(self, [{ date: '2026-05-10', channel: 'google_ads', metric_key: 'revenue', value: 5000 }])
  const out = await routeFreshness(asReq({ role: 'client', client_id: self }, { dateRange: WIN, clientId: 'whatever' }))
  assert.deepEqual(Object.keys(out).sort(), ['freshAt', 'version'])
  assert.match(out.version, /^sf\d+:/)
  assert.ok(!Number.isNaN(Date.parse(out.freshAt)))
})
