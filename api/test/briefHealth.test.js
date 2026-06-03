// ============================================================
// test/briefHealth.test.js — the narration-health audit, end to end over the DB.
//
// (10a) test/briefQuality.test.js already pins the PURE summarizer on hand-built
// row literals. What it CANNOT see is the seam this layer (10b) adds: real
// ai_briefs rows read back through lib/brief.listRecentBriefs — the inclusive day
// window, the ascending order, the audience/scope filters, and the cross-backend
// normalize (TEXT pack → object, 0/1 grounded → boolean) — then fed into
// summarizeBriefQuality. So this file seeds genuine rows and proves the whole
// DB → normalize → summarize pipeline, plus the two pure route guards the
// /api/ai/brief-health endpoint hangs on: the lenient day clamp (resolveDays) and
// the agency-only gate (resolvePortfolioScope) that keeps the narration machinery
// off every client token.
//
// Isolated temp SQLite (same idiom as test/brief.test.js / test/ai.askscope.test.js):
// no network, no LLM — a 'narrated' row is one we INSERT with a real model id and a
// narratable pack, since generate*Brief with no API key only ever stamps 'template'.
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db (transitively
// via ../lib/brief and ../routes/ai). Mirrors the sibling route/lib tests.
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY        // belt-and-braces: never reach a live model
const DB_PATH = path.join(os.tmpdir(), `briefhealth_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { listRecentBriefs, PORTFOLIO_KEY }       = require('../lib/brief')
const { summarizeBriefQuality, narrateBriefHealth } = require('../lib/briefQuality')
const { resolveDays, resolvePortfolioScope }    = require('../routes/ai')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── seed helpers ──────────────────────────────────────────────────────────────
let migrated = false
async function ready() {
  if (migrated) return
  await db.migrate()
  migrated = true
}
// Each aggregate test truncates first so its counts are deterministic regardless of
// what ran before (node:test runs top-level tests sequentially, so this is safe).
async function reset() {
  await ready()
  await db.query('DELETE FROM ai_briefs')
}
// INSERT one ai_briefs row exactly as upsertBrief would write it: JSON-string pack,
// 1/0 grounded. We bypass generate*Brief on purpose — it can't mint a 'narrated' row
// without a live model — and write the row state we want directly.
async function seed({ scopeKey, asOf, audience, model, pack, grounded = true, clientId = null }) {
  await db.query(
    `INSERT INTO ai_briefs
       (scope_key, as_of, audience, client_id, model, pack, brief_text, grounded, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP)`,
    [scopeKey, asOf, audience, clientId, model, JSON.stringify(pack), 'brief.', grounded ? 1 : 0]
  )
}
// pack shapes whose isNarratable verdict is fixed by construction (mirrors the gate).
const clientNarratable = (focus = 'leads') => ({ audience: 'client', focus, meta: { has_focus: true } })
const clientQuiet      = ()                => ({ audience: 'client', meta: {} })
const agencyNarratable = (h = 'Two clients need a look') => ({ audience: 'agency', headline: h, meta: { has_action: true } })
const agencyQuiet      = ()                => ({ audience: 'agency', meta: {} })

const HAIKU = 'claude-haiku-4-5'
const OPUS  = 'claude-opus-4-7'

// ── resolveDays: lenient tuning knob, clamped to [1,365], never a 400 ───────────
test('resolveDays — absent/blank/garbage default to 30; valid floors and clamps to [1,365]', () => {
  for (const blank of [undefined, null, '', 'abc', NaN, {}, [1, 2]]) {
    assert.equal(resolveDays(blank), 30, `blank ${JSON.stringify(blank)} → 30`)
  }
  assert.equal(resolveDays(0),    1)      // clamps UP, not to the default
  assert.equal(resolveDays(-5),   1)
  assert.equal(resolveDays(1),    1)
  assert.equal(resolveDays(7),    7)
  assert.equal(resolveDays('45'), 45)     // numeric string accepted
  assert.equal(resolveDays(45.9), 45)     // floored, not rounded
  assert.equal(resolveDays(365),  365)
  assert.equal(resolveDays(366),  365)    // clamps DOWN
  assert.equal(resolveDays(99999), 365)
})

// ── resolvePortfolioScope: agency-only gate (the no-leak boundary of the route) ──
test('resolvePortfolioScope — only an agency token passes; every other token is refused 403', () => {
  assert.deepEqual(resolvePortfolioScope({ user: { role: 'agency' } }), {})
  const denied = (req, label) => {
    const s = resolvePortfolioScope(req)
    assert.equal(s.status, 403, `${label} → 403`)
    assert.match(s.error, /not authorized/)
  }
  denied({ user: { role: 'client', client_id: 'real-client' } }, 'client token')
  denied({ user: { role: 'weird' } }, 'unknown role')
  denied({ user: {} },                'role-less token')
  denied({},                          'no user object (mis-wired mount)')
})

// ── listRecentBriefs: inclusive window, both edges in, outside excluded ──────────
test('listRecentBriefs — inclusive [from..to] window, ascending, edges in / outside out', async () => {
  await reset()
  // asOf 2026-05-20, days 5 → from = 2026-05-16. Window inclusive [05-16 .. 05-20].
  for (const d of ['2026-05-15', '2026-05-16', '2026-05-18', '2026-05-20', '2026-05-21']) {
    await seed({ scopeKey: 'C1', asOf: d, audience: 'client', model: HAIKU, pack: clientNarratable() })
  }
  const rows = await listRecentBriefs({ asOf: '2026-05-20', days: 5 })
  assert.deepEqual(
    rows.map((r) => r.as_of),
    ['2026-05-16', '2026-05-18', '2026-05-20'],     // lower & upper edges kept; 05-15/05-21 dropped
  )
})

// ── listRecentBriefs: order tie-break + audience / scopeKey filters ──────────────
test('listRecentBriefs — ascending (as_of, scope_key); audience and scopeKey filters', async () => {
  await reset()
  // Same day, three scopes. ASCII: "A1" < "B1" < "__portfolio__", so that is the order.
  await seed({ scopeKey: 'A1',          asOf: '2026-05-10', audience: 'client', model: HAIKU, pack: clientNarratable() })
  await seed({ scopeKey: 'B1',          asOf: '2026-05-10', audience: 'client', model: HAIKU, pack: clientNarratable() })
  await seed({ scopeKey: PORTFOLIO_KEY, asOf: '2026-05-10', audience: 'agency', model: OPUS,  pack: agencyNarratable() })
  await seed({ scopeKey: 'A1',          asOf: '2026-05-11', audience: 'client', model: HAIKU, pack: clientNarratable() })

  const all = await listRecentBriefs({ asOf: '2026-05-11', days: 30 })
  assert.deepEqual(
    all.map((r) => [r.as_of, r.scope_key]),
    [
      ['2026-05-10', 'A1'],
      ['2026-05-10', 'B1'],
      ['2026-05-10', PORTFOLIO_KEY],
      ['2026-05-11', 'A1'],
    ],
  )
  // audience filter → client rows only (portfolio excluded)
  const clientOnly = await listRecentBriefs({ asOf: '2026-05-11', days: 30, audience: 'client' })
  assert.deepEqual(clientOnly.map((r) => r.scope_key), ['A1', 'B1', 'A1'])
  assert.ok(clientOnly.every((r) => r.audience === 'client'))
  // single-scope filter → just the portfolio row
  const portfolioOnly = await listRecentBriefs({ asOf: '2026-05-11', days: 30, scopeKey: PORTFOLIO_KEY })
  assert.equal(portfolioOnly.length, 1)
  assert.equal(portfolioOnly[0].scope_key, PORTFOLIO_KEY)
  assert.equal(portfolioOnly[0].audience, 'agency')
})

// ── listRecentBriefs: lib-level day clamp + cross-backend normalize ──────────────
test('listRecentBriefs — days clamps to ≥1, parses the pack, coerces grounded to boolean', async () => {
  await reset()
  await seed({ scopeKey: 'C2', asOf: '2026-05-09', audience: 'client', model: HAIKU, pack: clientNarratable('calls') })
  await seed({ scopeKey: 'C2', asOf: '2026-05-08', audience: 'client', model: HAIKU, pack: clientNarratable(), grounded: false })

  // days 0 clamps UP to 1 → window is the single as_of day, not an error and not 30 days.
  const oneDay = await listRecentBriefs({ asOf: '2026-05-09', days: 0 })
  assert.deepEqual(oneDay.map((r) => r.as_of), ['2026-05-09'])

  // normalized shape: pack is a parsed object (not the stored JSON string), grounded a real boolean.
  const [row] = oneDay
  assert.equal(typeof row.pack, 'object')
  assert.equal(row.pack.focus, 'calls')
  assert.equal(row.grounded, true)
  assert.strictEqual(row.grounded, true)   // boolean, never 1

  const both = await listRecentBriefs({ asOf: '2026-05-09', days: 99999 })  // clamps DOWN to 365 internally
  const older = both.find((r) => r.as_of === '2026-05-08')
  assert.strictEqual(older.grounded, false)  // 0 → false, not the integer 0
})

// ── a narratable brief with NO model id is template (fellback), never narrated ───
test('listRecentBriefs + summarize — a narratable row with absent model counts as fellback', async () => {
  await reset()
  await seed({ scopeKey: 'C3', asOf: '2026-05-05', audience: 'client', model: null, pack: clientNarratable() })
  const summary = summarizeBriefQuality(await listRecentBriefs({ asOf: '2026-05-05', days: 7 }))
  assert.equal(summary.overall.narratable, 1)
  assert.equal(summary.overall.narrated, 0)
  assert.equal(summary.overall.fellback, 1)
  assert.equal(summary.overall.coverage, 0)
  assert.equal(summary.overall.health, 'template-only')
  assert.deepEqual(summary.overall.models, { template: 1 })
})

// ── grounded_rate is read off `grounded`, independent of narration ───────────────
test('summarize over real rows — grounded_rate falls below 1 when a row is not grounded', async () => {
  await reset()
  await seed({ scopeKey: 'C4', asOf: '2026-05-01', audience: 'client', model: HAIKU, pack: clientNarratable() })
  await seed({ scopeKey: 'C4', asOf: '2026-05-02', audience: 'client', model: HAIKU, pack: clientNarratable() })
  await seed({ scopeKey: 'C4', asOf: '2026-05-03', audience: 'client', model: HAIKU, pack: clientNarratable(), grounded: false })
  const s = summarizeBriefQuality(await listRecentBriefs({ asOf: '2026-05-03', days: 7 }))
  assert.equal(s.total, 3)
  assert.equal(s.grounded_rate, 0.6667)   // round(2/3, 4)
  assert.equal(s.all_grounded, false)
})

// ── empty window → safe zeros, no throw (the route still 200s on a cold history) ─
test('summarize over an empty window — total 0, no-data health, null grounded_rate', async () => {
  await reset()
  const s = summarizeBriefQuality(await listRecentBriefs({ asOf: '2020-01-01', days: 5 }))
  assert.equal(s.total, 0)
  assert.deepEqual(s.window, { from: null, to: null, days: 0 })
  assert.equal(s.grounded_rate, null)
  assert.equal(s.all_grounded, true)       // vacuously true
  assert.equal(s.overall.health, 'no-data')
})

// ── THE SEAM: a known DB history → listRecentBriefs → summarizeBriefQuality ───────
// A deterministic 7-day client history (3 narrated, 3 fellback, 1 quiet — the latest
// two narratable ones fell back) interleaved with a 4-day portfolio history (3 narrated,
// 1 quiet). Proves every derived figure off real, normalized rows, both buckets, the
// DATA window (min..max as_of, NOT the requested span), and that quiet rows are neither
// counted as failures nor allowed to become "latest".
test('summarize over a real mixed history — buckets, coverage, streak, window, models', async () => {
  await reset()
  // client 'C' — 2026-05-01 .. 05-07
  const C = 'C'
  await seed({ scopeKey: C, asOf: '2026-05-01', audience: 'client', model: HAIKU,      pack: clientNarratable() })   // narrated
  await seed({ scopeKey: C, asOf: '2026-05-02', audience: 'client', model: 'template', pack: clientQuiet() })        // quiet
  await seed({ scopeKey: C, asOf: '2026-05-03', audience: 'client', model: HAIKU,      pack: clientNarratable() })   // narrated
  await seed({ scopeKey: C, asOf: '2026-05-04', audience: 'client', model: 'template', pack: clientNarratable() })   // fellback
  await seed({ scopeKey: C, asOf: '2026-05-05', audience: 'client', model: HAIKU,      pack: clientNarratable() })   // narrated
  await seed({ scopeKey: C, asOf: '2026-05-06', audience: 'client', model: 'template', pack: clientNarratable() })   // fellback
  await seed({ scopeKey: C, asOf: '2026-05-07', audience: 'client', model: 'template', pack: clientNarratable() })   // fellback (latest)
  // portfolio — 2026-05-01 .. 05-04
  const P = PORTFOLIO_KEY
  await seed({ scopeKey: P, asOf: '2026-05-01', audience: 'agency', model: OPUS,       pack: agencyNarratable() })   // narrated
  await seed({ scopeKey: P, asOf: '2026-05-02', audience: 'agency', model: OPUS,       pack: agencyNarratable() })   // narrated
  await seed({ scopeKey: P, asOf: '2026-05-03', audience: 'agency', model: OPUS,       pack: agencyNarratable() })   // narrated
  await seed({ scopeKey: P, asOf: '2026-05-04', audience: 'agency', model: 'template', pack: agencyQuiet() })        // quiet

  // Request a wider window than the data; the summary's window must echo the DATA span.
  const rows = await listRecentBriefs({ asOf: '2026-05-07', days: 10 })
  assert.equal(rows.length, 11)
  const s = summarizeBriefQuality(rows)

  // trust invariant: every seeded row was grounded
  assert.equal(s.total, 11)
  assert.equal(s.grounded_rate, 1)
  assert.equal(s.all_grounded, true)

  // window reflects min..max as_of of the returned rows (NOT the requested 10 days)
  assert.deepEqual(s.window, { from: '2026-05-01', to: '2026-05-07', days: 7 })

  // overall = client(7) + agency(4)
  assert.equal(s.overall.total, 11)
  assert.equal(s.overall.narratable, 9)   // client 6 + agency 3
  assert.equal(s.overall.quiet, 2)        // one each
  assert.equal(s.overall.narrated, 6)     // client 3 + agency 3
  assert.equal(s.overall.fellback, 3)     // client 3 + agency 0
  assert.equal(s.overall.coverage, 0.6667)
  assert.equal(s.overall.health, 'mixed')
  assert.equal(s.overall.streak_fellback, 2)            // 05-07, 05-06 both fellback; 05-05 narrated stops it
  assert.deepEqual(s.overall.latest, { as_of: '2026-05-07', state: 'fellback' })
  assert.deepEqual(s.overall.models, { [HAIKU]: 3, template: 3, [OPUS]: 3 })

  // client bucket
  const c = s.by_audience.client
  assert.equal(c.total, 7)
  assert.equal(c.narratable, 6)
  assert.equal(c.quiet, 1)
  assert.equal(c.narrated, 3)
  assert.equal(c.fellback, 3)
  assert.equal(c.coverage, 0.5)
  assert.equal(c.health, 'mixed')
  assert.equal(c.streak_fellback, 2)
  assert.deepEqual(c.latest, { as_of: '2026-05-07', state: 'fellback' })
  assert.deepEqual(c.models, { [HAIKU]: 3, template: 3 })

  // agency bucket — every narratable brief was written; the quiet 05-04 must NOT be "latest"
  const a = s.by_audience.agency
  assert.equal(a.total, 4)
  assert.equal(a.narratable, 3)
  assert.equal(a.quiet, 1)
  assert.equal(a.narrated, 3)
  assert.equal(a.fellback, 0)
  assert.equal(a.coverage, 1)
  assert.equal(a.health, 'rich')
  assert.equal(a.streak_fellback, 0)
  assert.deepEqual(a.latest, { as_of: '2026-05-03', state: 'narrated' })   // quiet 05-04 skipped
  assert.deepEqual(a.models, { [OPUS]: 3 })

  // the agency narrative the route emits cites these exact figures; the client surface gets ''
  const agencyLine = narrateBriefHealth(a, { audience: 'agency' })
  assert.match(agencyLine, /wrote 3 of 3 morning briefs in its own words/)
  assert.match(agencyLine, /grounded to your verified numbers/)
  assert.equal(narrateBriefHealth(a, { audience: 'client' }), '')   // no-leak, end to end
})
