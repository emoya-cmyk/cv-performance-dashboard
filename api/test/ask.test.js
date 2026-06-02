// ============================================================
// test/ask.test.js — Sprint 2: natural-language "ask your data".
//
// What's proven here, all without a network call:
//   1. VALIDATION GATE — validateSpec defaults sane fields, clamps limit, and
//      REJECTS anything off the whitelist (metric / group_by / time_range / month).
//   2. SAFE COMPILER — the one free-text field (client_filter) is ALWAYS a bound
//      $N param, never concatenated; an adversarial "…DROP TABLE…" value lands in
//      params, not in the SQL string; limit is inlined only as a bare integer.
//   3. TIME RANGES — resolveTimeRange is pure and exact for an injected `now`.
//   4. NUMBER PARITY — the compiled SQL produces the SAME numbers metricsCore
//      .derive() computes over the identical rows (revenue/leads/jobs/spend exact,
//      roas/cpl/close_rate within float epsilon), so an "ask" answer can never
//      drift from the dashboard.
//   5. runAsk END-TO-END — with a stubbed LLM: a grounded narration is returned;
//      an ungrounded one falls back to the deterministic template; no key →
//      NO_AI; an un-mappable question → UNPARSEABLE after one corrective retry.
//
// axios.post is monkey-patched on the shared module so both LLM hops (spec parse
// and result narration) are offline; the stub branches on a unique marker baked
// into each system prompt. Isolated temp SQLite DB. Run with:  npm test
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Deterministic model string + force the SQLite backend at an isolated path
// BEFORE requiring ../db (mirrors test/ai.test.js).
delete process.env.AI_MODEL
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
const DB_PATH = path.join(os.tmpdir(), `asktest_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

// Stub axios.post before requiring ../lib/ask (which pulls in lib/anthropic →
// axios). The method is overridden on the shared cached module object, and
// callMessages() resolves axios.post at call-time, so every Anthropic hop is
// intercepted. The stub routes by a unique marker in each system prompt.
const axios = require('axios')
let axiosCalls = 0
let onParse    = () => { throw new Error('no parse responder set') }
let onNarrate  = () => { throw new Error('no narrate responder set') }
axios.post = async (url, body) => {
  axiosCalls++
  const sys = body.system[0].text
  if (sys.includes('TRANSLATE_TO_QUERY_SPEC')) return reply(onParse())
  if (sys.includes('NARRATE_RESULT'))          return reply(onNarrate())
  throw new Error('unexpected system prompt: ' + sys.slice(0, 40))
}
const reply = (text) => ({ data: { content: [{ type: 'text', text }] } })

const db = require('../db')
const { AGG, derive } = require('../lib/metricsCore')
const {
  runAsk, runExplain, validateSpec, compileQuery, resolveTimeRange, SpecError,
} = require('../lib/ask')
// The PURE follow-up core is exhaustively proven in test/followups.test.js; here we
// only assert runAsk WIRES it correctly — the right spec + the right scope/comparison
// flags — by deep-comparing the response against the module's own output.
const { suggestFollowups } = require('../lib/followups')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// A fixed clock for every time-aware assertion: Sat 2026-05-30.
const NOW = new Date('2026-05-30T00:00:00Z')

// ── seed a small portfolio ONCE (all_time aggregates == this portfolio) ───────
const WEEK_A = '2026-05-04'   // both Mondays
const WEEK_B = '2026-05-11'

let migrated = false
let seq = 0
async function freshClient(name) {
  const id = `ask-${process.pid}-${++seq}`
  await db.query(`INSERT INTO clients (id, name) VALUES ($1,$2)`, [id, name])
  return id
}
// rev = projected_revenue; spend split ads+lsa; leads = raw_leads; jobs = closed_won.
async function seedWeek(clientId, weekStart, { rev, ads, lsa = 0, leads, jobs }) {
  await db.query(
    `INSERT INTO weekly_reports
       (client_id, week_start, ads_spend, lsa_spend, meta_spend, ads_roas,
        ads_leads, meta_leads, gbp_calls, ga4_sessions,
        raw_leads, closed_won, projected_revenue)
     VALUES ($1,$2,$3,$4,0,0,0,0,0,0,$5,$6,$7)`,
    [clientId, weekStart, ads, lsa, leads, jobs, rev]
  )
}

let portfolio = null
async function ensurePortfolio() {
  if (!migrated) { await db.migrate(); migrated = true }
  if (portfolio) return portfolio

  const acme  = await freshClient('Acme')
  const beta  = await freshClient('Beta')
  const gamma = await freshClient('Gamma')

  // Totals: revenue 38,000 · spend 6,500 · leads 200 · jobs 20
  //         roas 5.846… · cpl 32.5 · close_rate 10
  // Per client: Acme 22,000 · Beta 13,000 · Gamma 3,000
  // Per week:   WEEK_A 18,000 · WEEK_B 20,000
  await seedWeek(acme,  WEEK_A, { rev: 10000, ads: 1500, lsa: 500, leads: 50, jobs: 5 })
  await seedWeek(acme,  WEEK_B, { rev: 12000, ads: 2000,           leads: 60, jobs: 6 })
  await seedWeek(beta,  WEEK_A, { rev:  8000, ads: 1000,           leads: 40, jobs: 4 })
  await seedWeek(beta,  WEEK_B, { rev:  5000, ads: 1000,           leads: 30, jobs: 3 })
  await seedWeek(gamma, WEEK_B, { rev:  3000, ads:  500,           leads: 20, jobs: 2 })

  portfolio = { acme, beta, gamma }
  return portfolio
}

// Compile (SQLite backend) + execute a spec, returning coerced rows.
async function execSpec(partial, now = NOW) {
  const spec = validateSpec(partial)
  const compiled = compileQuery(spec, now, false)   // isPg = false
  const { rows } = await db.query(compiled.sql, compiled.params)
  const out = rows.map(r => compiled.grouping === 'none'
    ? { value: Number(r.value) }
    : { bucket: r.bucket, value: Number(r.value) })
  return { spec, compiled, rows: out }
}

// ── 1. VALIDATION GATE ────────────────────────────────────────────────────────
test('validateSpec fills defaults and normalises', () => {
  assert.deepEqual(validateSpec({ metric: 'revenue' }), {
    metric: 'revenue', group_by: 'none', time_range: 'last_week',
    order: 'desc', limit: 5, client_filter: null,
  })
  // order + client_filter trimming
  const s = validateSpec({ metric: 'roas', order: 'asc', client_filter: '  Acme Roofing  ' })
  assert.equal(s.order, 'asc')
  assert.equal(s.client_filter, 'Acme Roofing')
  // anything but "asc" → "desc"
  assert.equal(validateSpec({ metric: 'revenue', order: 'sideways' }).order, 'desc')
  // empty client_filter → null
  assert.equal(validateSpec({ metric: 'revenue', client_filter: '   ' }).client_filter, null)
})

test('validateSpec clamps + coerces limit', () => {
  assert.equal(validateSpec({ metric: 'revenue', limit: 100 }).limit, 50)
  assert.equal(validateSpec({ metric: 'revenue', limit: 0 }).limit, 1)
  assert.equal(validateSpec({ metric: 'revenue', limit: -3 }).limit, 1)
  assert.equal(validateSpec({ metric: 'revenue', limit: '7' }).limit, 7)   // int-ish string
  assert.equal(validateSpec({ metric: 'revenue', limit: 'abc' }).limit, 5) // garbage → default
  assert.equal(validateSpec({ metric: 'revenue' }).limit, 5)
})

test('validateSpec rejects everything off the whitelist', () => {
  assert.throws(() => validateSpec({ metric: 'bananas' }), SpecError)
  assert.throws(() => validateSpec(null), SpecError)
  assert.throws(() => validateSpec({ metric: 'revenue', group_by: 'galaxy' }), SpecError)
  assert.throws(() => validateSpec({ metric: 'revenue', time_range: 'since_dawn' }), SpecError)
  // time_range "month" requires a well-formed month
  assert.throws(() => validateSpec({ metric: 'revenue', time_range: 'month' }), SpecError)
  assert.throws(() => validateSpec({ metric: 'revenue', time_range: 'month', month: '2026-13' }), SpecError)
  assert.equal(validateSpec({ metric: 'revenue', time_range: 'month', month: '2026-05' }).month, '2026-05')
})

// ── 2. SAFE COMPILER (the security property) ──────────────────────────────────
test('client_filter is bound, never concatenated — injection lands in params', () => {
  const evil = "Acme'; DROP TABLE clients;--"
  const { sql, params } = compileQuery(
    validateSpec({ metric: 'revenue', time_range: 'all_time', client_filter: evil }),
    NOW, false
  )
  // The dangerous string is a bound parameter, not part of the SQL text.
  assert.equal(params[0], evil)
  assert.ok(sql.includes('LOWER(c.name) = LOWER($1)'))
  assert.ok(!sql.includes('DROP'), 'SQL must not contain the injected payload')
  assert.ok(!sql.includes('Acme'), 'the value must never be interpolated')
  assert.ok(sql.includes('JOIN clients c'), 'client_filter forces the clients join')
  // every placeholder has a matching param and vice-versa
  const placeholders = (sql.match(/\$\d+/g) || []).length
  assert.equal(placeholders, params.length)
})

test('limit is inlined as a bare integer, not a parameter', () => {
  const { sql, params } = compileQuery(
    validateSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time', limit: 3 }),
    NOW, false
  )
  assert.ok(sql.includes('LIMIT 3'))
  assert.ok(!/LIMIT \$/.test(sql), 'limit must not be a bound param')
  assert.ok(!params.includes(3))
  assert.ok(sql.includes('GROUP BY c.id, c.name'))
})

test('group_by none emits no GROUP BY and no join when unfiltered', () => {
  const { sql } = compileQuery(validateSpec({ metric: 'leads', time_range: 'all_time' }), NOW, false)
  assert.ok(!sql.includes('GROUP BY'))
  assert.ok(!sql.includes('JOIN clients'))
})

// ── 2b. ENFORCED CLIENT SCOPE (the /my-dashboard boundary) ────────────────────
// compileQuery's 4th arg pins every row to one server-trusted client id. These
// prove the three guarantees that make the ask layer safe to expose per-client:
// the scope is ALWAYS applied, cross-client grouping can't leak, and the LLM's
// free-text client_filter can't redirect the scope — while the unscoped agency
// path stays byte-identical.

test('scoped compile always binds wr.client_id, regardless of spec', () => {
  const { sql, params } = compileQuery(
    validateSpec({ metric: 'revenue', time_range: 'all_time' }),
    NOW, false, 'client-42'
  )
  // all_time has no time predicate, so the scope is the only WHERE term.
  assert.ok(sql.includes('WHERE wr.client_id = $1'), sql)
  assert.deepEqual(params, ['client-42'])
})

test('scoped compile neutralises group_by:client — no cross-client buckets or names', () => {
  const { sql, params, columns, grouping } = compileQuery(
    validateSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time', limit: 50 }),
    NOW, false, 'client-7'
  )
  assert.equal(grouping, 'none')
  assert.deepEqual(columns, ['value'])
  assert.ok(!sql.includes('c.name'),       'must never SELECT another client name')
  assert.ok(!sql.includes('JOIN clients'), 'no clients join when scoped')
  assert.ok(!sql.includes('GROUP BY'),     'a single client has no inter-client grouping')
  assert.ok(!/LIMIT/.test(sql),            'no ranking LIMIT when collapsed to one total')
  assert.ok(sql.includes('wr.client_id = $1'))
  assert.deepEqual(params, ['client-7'])
})

test('scoped compile ignores the LLM client_filter — it cannot redirect scope', () => {
  const { sql, params } = compileQuery(
    validateSpec({ metric: 'revenue', time_range: 'all_time', client_filter: 'Some Other Client' }),
    NOW, false, 'client-9'
  )
  assert.ok(!sql.includes('LOWER(c.name)'),        'the free-text name filter is dropped when scoped')
  assert.ok(!params.includes('Some Other Client'), 'and never bound')
  assert.deepEqual(params, ['client-9'])              // only the enforced scope
})

test('scoped compile keeps the enforced id first, then binds the time range in order', () => {
  const { sql, params } = compileQuery(
    validateSpec({ metric: 'revenue', time_range: 'last_week' }),
    NOW, false, 'client-3'
  )
  // client_id is $1 (pushed first), the week boundary is $2.
  assert.ok(sql.includes('wr.client_id = $1'))
  assert.ok(sql.includes('wr.week_start = $2'))
  assert.deepEqual(params, ['client-3', '2026-05-18'])
  const placeholders = (sql.match(/\$\d+/g) || []).length
  assert.equal(placeholders, params.length)
})

test("scoped compile still allows a client's own week trend (no clients join)", () => {
  const { sql, params, columns, grouping } = compileQuery(
    validateSpec({ metric: 'revenue', group_by: 'week', time_range: 'all_time' }),
    NOW, false, 'client-5'
  )
  assert.equal(grouping, 'week')
  assert.deepEqual(columns, ['bucket', 'value'])
  assert.ok(sql.includes('wr.client_id = $1'))
  assert.ok(!sql.includes('JOIN clients'), 'week bucket comes from wr.week_start, no name needed')
  assert.deepEqual(params, ['client-5'])
})

test('UNSCOPED compile is unchanged — agency path keeps client grouping + join + no client_id', () => {
  // Regression guard: the 4th-arg addition must not perturb the whole-book path.
  const { sql, params } = compileQuery(
    validateSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time', limit: 3 }),
    NOW, false   // no scope arg
  )
  assert.ok(!sql.includes('wr.client_id ='), 'no enforced scope when unscoped')
  assert.ok(sql.includes('c.name AS bucket'))
  assert.ok(sql.includes('JOIN clients c'))
  assert.ok(sql.includes('GROUP BY c.id, c.name'))
  assert.ok(sql.includes('LIMIT 3'))
  assert.equal(params.length, 0)   // all_time + no filter → no bound params
})

test('scoped execution pins real rows to the one client and never leaks peers', async () => {
  const { acme, beta } = await ensurePortfolio()

  // Acme's own all-time revenue, scoped — equals Acme's total (22,000), not the book.
  const aCompiled = compileQuery(
    validateSpec({ metric: 'revenue', time_range: 'all_time' }), NOW, false, acme
  )
  const aRes = await db.query(aCompiled.sql, aCompiled.params)
  assert.equal(aRes.rows.length, 1)
  assert.equal(Number(aRes.rows[0].value), 22000)

  // Even when the question asks to RANK clients, a Beta-scoped compile collapses
  // to Beta's single total (13,000) — Acme/Gamma can't appear in the result.
  const bCompiled = compileQuery(
    validateSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time' }), NOW, false, beta
  )
  assert.equal(bCompiled.grouping, 'none')
  const bRes = await db.query(bCompiled.sql, bCompiled.params)
  assert.equal(bRes.rows.length, 1)
  assert.equal(Number(bRes.rows[0].value), 13000)
  assert.equal(bRes.rows[0].bucket, undefined)   // no client-name column at all
})

// ── 3. TIME RANGES (pure, injected now = 2026-05-30) ──────────────────────────
test('resolveTimeRange computes exact windows for a fixed now', () => {
  const vals = (spec) => resolveTimeRange(spec, NOW).wheres.map(w => w.value)

  const lw = resolveTimeRange({ time_range: 'last_week' }, NOW)
  assert.deepEqual(lw.wheres.map(w => w.value), ['2026-05-18'])   // Monday of the prior week
  assert.equal(lw.label, 'the week of 2026-05-18')

  assert.deepEqual(vals({ time_range: 'this_month' }),  ['2026-05-01', '2026-05-30'])
  assert.deepEqual(vals({ time_range: 'last_month' }),  ['2026-04-01', '2026-04-30'])
  assert.deepEqual(vals({ time_range: 'this_year' }),   ['2026-01-01', '2026-05-30'])
  assert.deepEqual(vals({ time_range: 'month', month: '2026-02' }), ['2026-02-01', '2026-02-28'])
  assert.deepEqual(vals({ time_range: 'last_4_weeks' }), ['2026-04-27', '2026-05-18'])
  assert.deepEqual(resolveTimeRange({ time_range: 'all_time' }, NOW).wheres, [])
})

// ── 4. NUMBER PARITY vs metricsCore.derive() ──────────────────────────────────
test('compiled aggregates equal derive() over the same rows', async () => {
  await ensurePortfolio()

  // derive() over the whole portfolio (no WHERE → one aggregate row).
  const { rows } = await db.query(`SELECT ${AGG} FROM weekly_reports`)
  const d = derive(rows[0])

  const rev   = await execSpec({ metric: 'revenue',    time_range: 'all_time' })
  const leads = await execSpec({ metric: 'leads',      time_range: 'all_time' })
  const jobs  = await execSpec({ metric: 'jobs',       time_range: 'all_time' })
  const spend = await execSpec({ metric: 'spend',      time_range: 'all_time' })
  const roas  = await execSpec({ metric: 'roas',       time_range: 'all_time' })
  const cpl   = await execSpec({ metric: 'cpl',        time_range: 'all_time' })
  const close = await execSpec({ metric: 'close_rate', time_range: 'all_time' })

  // Exact for the additive metrics …
  assert.equal(rev.rows[0].value,   d.total_revenue); assert.equal(rev.rows[0].value, 38000)
  assert.equal(leads.rows[0].value, d.total_leads);   assert.equal(leads.rows[0].value, 200)
  assert.equal(jobs.rows[0].value,  d.total_closed);  assert.equal(jobs.rows[0].value, 20)
  assert.equal(spend.rows[0].value, d.total_spend);   assert.equal(spend.rows[0].value, 6500)
  // … and within float epsilon for the ratios (forced real division on SQLite).
  assert.ok(Math.abs(roas.rows[0].value  - d.roas)       < 1e-9, `roas ${roas.rows[0].value} vs ${d.roas}`)
  assert.ok(Math.abs(cpl.rows[0].value   - d.cpl)        < 1e-9, `cpl ${cpl.rows[0].value} vs ${d.cpl}`)
  assert.ok(Math.abs(close.rows[0].value - d.close_rate) < 1e-9, `close ${close.rows[0].value} vs ${d.close_rate}`)
  assert.equal(cpl.rows[0].value, 32.5)
  assert.equal(close.rows[0].value, 10)
  // guards the integer-division trap: 38000/6500 must be 5.846…, not 5
  assert.ok(roas.rows[0].value > 5.8 && roas.rows[0].value < 5.9)
})

test('group_by client ranks correctly and honours order + limit', async () => {
  await ensurePortfolio()

  const desc = await execSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time' })
  assert.deepEqual(desc.rows, [
    { bucket: 'Acme', value: 22000 },
    { bucket: 'Beta', value: 13000 },
    { bucket: 'Gamma', value: 3000 },
  ])

  const asc = await execSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time', order: 'asc' })
  assert.deepEqual(asc.rows.map(r => r.bucket), ['Gamma', 'Beta', 'Acme'])

  const top2 = await execSpec({ metric: 'revenue', group_by: 'client', time_range: 'all_time', limit: 2 })
  assert.deepEqual(top2.rows.map(r => r.bucket), ['Acme', 'Beta'])
})

test('group_by week returns a chronological trend', async () => {
  await ensurePortfolio()
  const wk = await execSpec({ metric: 'revenue', group_by: 'week', time_range: 'all_time' })
  assert.deepEqual(wk.rows, [
    { bucket: '2026-05-04', value: 18000 },
    { bucket: '2026-05-11', value: 20000 },
  ])
})

// ── 5. runAsk END-TO-END (stubbed LLM) ────────────────────────────────────────
test('runAsk returns a grounded narration when the model stays on the numbers', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'client', time_range: 'all_time', order: 'desc', limit: 5 })
  onNarrate = () => 'Acme led revenue at $22,000 across all clients.'

  const res = await runAsk('which client made the most money?')
  assert.equal(res.spec.metric, 'revenue')
  assert.equal(res.spec.group_by, 'client')
  assert.deepEqual(res.rows[0], { bucket: 'Acme', value: 22000, display: '$22,000' })
  assert.equal(res.meta.time_label, 'all time')
  assert.equal(res.narrated, true)
  assert.equal(res.answer, 'Acme led revenue at $22,000 across all clients.')
  assert.equal(axiosCalls, 2)   // one parse hop + one narrate hop

  delete process.env.ANTHROPIC_API_KEY
})

test('runAsk discards an ungrounded narration and serves the template', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'client', time_range: 'all_time' })
  onNarrate = () => 'Revenue hit $999,999 across the board.'   // invented → ungrounded

  const res = await runAsk('rank my clients by revenue')
  assert.equal(res.narrated, false)
  assert.equal(res.answer, res.template)          // fell back to deterministic text
  assert.ok(!res.answer.includes('999'))          // hallucination never survives
  assert.ok(res.answer.includes('Acme'))          // real leader is named
  assert.ok(res.answer.includes('$22,000'))

  delete process.env.ANTHROPIC_API_KEY
})

test('runAsk with no API key fails fast as NO_AI, no network', async () => {
  await ensurePortfolio()
  delete process.env.ANTHROPIC_API_KEY
  axiosCalls = 0
  onParse = () => { throw new Error('should not be called') }

  await assert.rejects(runAsk('anything at all'), (e) => e.code === 'NO_AI')
  assert.equal(axiosCalls, 0)
})

test('runAsk surfaces UNPARSEABLE after one corrective retry', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  axiosCalls = 0
  onParse = () => JSON.stringify({ metric: 'bananas' })   // never validates, both attempts

  await assert.rejects(runAsk('what is the meaning of life?'), (e) => e.code === 'UNPARSEABLE')
  assert.equal(axiosCalls, 2)   // first attempt + one feedback retry, then give up

  delete process.env.ANTHROPIC_API_KEY
})

// ── 6. PERIOD-OVER-PERIOD COMPARISON (intel-v6 2b) ────────────────────────────
// A single overall figure (group_by none) over a COMPLETE, equal-length range
// also carries a baseline from the period immediately before it. A second fixed
// clock puts "last week" on WEEK_B (the seeded 20,000 total) and its baseline on
// WEEK_A (18,000), so the delta math is exact: +2,000 = +11.1%, an improvement for
// the up-good revenue metric. The baseline comes from the SAME compile+query path,
// never the LLM, and its numbers are folded into the grounding allow-list so a
// comparison-aware narration can survive the verifier.
const NOW2 = new Date('2026-05-20T00:00:00Z')   // Wed; current week's Monday = 2026-05-18

test('runAsk attaches an exact period-over-period comparison to a single figure', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  onNarrate = () => 'Revenue was $20,000, up 11.1% from $18,000 the prior week.'

  const res = await runAsk('how much revenue last week?', { now: NOW2 })
  assert.deepEqual(res.rows[0], { value: 20000, display: '$20,000' })   // WEEK_B is the primary

  const c = res.meta.comparison
  assert.ok(c, 'a comparable single figure must carry a comparison')
  assert.equal(c.label, 'the prior week')
  assert.equal(c.baseline_value, 18000)        // WEEK_A baseline, via the scoped compile seam
  assert.equal(c.baseline_display, '$18,000')
  assert.equal(c.delta, 2000)
  assert.equal(c.delta_display, '$2,000')
  assert.ok(Math.abs(c.pct_change - (2000 / 18000) * 100) < 1e-9)
  assert.equal(c.pct_display, '11.1%')
  assert.equal(c.direction, 'up')
  assert.equal(c.improved, true)

  delete process.env.ANTHROPIC_API_KEY
})

test('the deterministic template always states the comparison clause', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  onNarrate = () => 'totally ungrounded $999,999 nonsense'   // force fallback to the template

  const res = await runAsk('revenue last week', { now: NOW2 })
  assert.equal(res.narrated, false)
  assert.equal(res.answer, res.template)
  assert.equal(
    res.template,
    'Revenue for the week of 2026-05-11 was $20,000 — up 11.1% vs the prior week ($18,000).'
  )
  assert.ok(!res.answer.includes('999'))   // the hallucination never survives

  delete process.env.ANTHROPIC_API_KEY
})

test('a narration that cites the baseline + %-change stays grounded', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  onNarrate = () => 'Revenue reached $20,000 last week, up 11.1% from $18,000 the week before.'

  const res = await runAsk('revenue last week', { now: NOW2 })
  // every figure the narrator used — 20,000 / 11.1 / 18,000 — is in the allow-list,
  // so the comparison-aware narration survives the grounding gate.
  assert.equal(res.narrated, true)
  assert.ok(res.answer.includes('11.1%'))
  assert.ok(res.answer.includes('$18,000'))

  delete process.env.ANTHROPIC_API_KEY
})

test('no comparison for a grouped (non-single-figure) query', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'client', time_range: 'last_week' })
  onNarrate = () => 'Acme led at $12,000.'

  const res = await runAsk('top clients last week', { now: NOW2 })
  assert.equal(res.meta.group_by, 'client')
  assert.equal(res.meta.comparison, null)   // a ranking has no single baseline

  delete process.env.ANTHROPIC_API_KEY
})

test('no comparison for an open-ended range (all_time / this_month)', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onNarrate = () => 'Revenue total noted.'

  onParse = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'all_time' })
  const all = await runAsk('total revenue ever', { now: NOW2 })
  assert.equal(all.meta.comparison, null)

  onParse = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'this_month' })
  const tm = await runAsk('revenue this month', { now: NOW2 })
  assert.equal(tm.meta.comparison, null)

  delete process.env.ANTHROPIC_API_KEY
})

// ── 7. CONVERSATIONAL FOLLOW-UPS (intel-v6 4b) ────────────────────────────────
// runAsk turns every answer into a branch point: it attaches `followups`, the
// parser-stable next-question chips for the spec it just answered. These tests own
// the WIRING that followups.test.js can't see — that runAsk hands the module the
// answered spec, threads hasComparison from meta.comparison, and (critically) only
// permits the cross-client "which clients" pivot for an unscoped agency caller.

test('runAsk attaches follow-up chips faithful to the pure module (unscoped agency)', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  onNarrate = () => 'Revenue was $20,000, up 11.1% from $18,000 the prior week.'

  const res = await runAsk('how much revenue last week?', { now: NOW2 })   // no scope → whole book
  assert.ok(Array.isArray(res.followups) && res.followups.length >= 1, 'followups attached')
  for (const f of res.followups) {
    assert.equal(typeof f.question, 'string'); assert.ok(f.question.length > 0)
    assert.ok(typeof f.label === 'string' && f.label.length > 0)
    assert.ok(['metric', 'time', 'trend', 'clients', 'total'].includes(f.kind), `known kind: ${f.kind}`)
    assert.ok(!/\bwhy\b/i.test(f.question), 'no unparseable "why" chip')
  }
  // the response carries EXACTLY what the pure module derives from the answered spec,
  // with hasComparison/allowClientBreakdown threaded from meta.comparison + (null) scope.
  assert.deepEqual(
    res.followups,
    suggestFollowups(res.spec, { hasComparison: !!res.meta.comparison, allowClientBreakdown: true })
  )
  // this single figure carried a comparison, and the whole-book view may rank clients.
  assert.ok(res.meta.comparison, 'WEEK_B vs WEEK_A is a real delta')
  assert.ok(res.followups.some((f) => f.kind === 'clients'), 'agency gets a "By client" pivot')

  delete process.env.ANTHROPIC_API_KEY
})

test('a client-scoped ask never offers a cross-client follow-up', async () => {
  const { acme } = await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  onNarrate = () => 'Revenue was $12,000 last week, up from $10,000.'

  const res = await runAsk('how much revenue last week?', { now: NOW2, scopeClientId: acme })
  assert.ok(res.followups.length >= 1, 'a scoped caller still gets useful drill-downs')
  for (const f of res.followups) {
    assert.notEqual(f.kind, 'clients')
    assert.ok(!/which clients/i.test(f.question), 'no cross-client question on a scoped surface')
  }
  // faithful to the module with allowClientBreakdown:false — the scope boundary, threaded.
  assert.deepEqual(
    res.followups,
    suggestFollowups(res.spec, { hasComparison: !!res.meta.comparison, allowClientBreakdown: false })
  )

  delete process.env.ANTHROPIC_API_KEY
})

// ── 8. GROUNDED "WHY DID IT CHANGE?" (intel-v6 5: entity attribution) ─────────
// runExplain decomposes an UNSCOPED single additive figure's period-over-period
// move into EXACT per-client contributions — no LLM, pure DB arithmetic through the
// SAME compile path runAsk uses, so no number can drift from the answer. Under NOW2,
// revenue "last week" is WEEK_B (20,000) vs the WEEK_A baseline (18,000): Δ +2,000
// decomposes exactly into Acme +2,000, Beta −3,000, Gamma +3,000 (Σ = +2,000). The
// STRONG property proven here: the two biggest |moves| TIE at 3,000 (Beta down, Gamma
// up), so the "lead" must be chosen by ALIGNMENT with the rise (Gamma) — never by raw
// magnitude, which would wrongly crown the tie-broken-first Beta. Every emitted display
// string is grounded by construction (read straight from the breakdown, formatted here).

test('runExplain decomposes a moved single additive figure into exact per-client contributions', async () => {
  await ensurePortfolio()
  // No LLM hop — runExplain is pure DB arithmetic. No API key, no axios responders set.
  const r = await runExplain({ metric: 'revenue', group_by: 'none', time_range: 'last_week' }, { now: NOW2 })

  assert.ok(r, 'an eligible figure that moved is explainable')
  assert.equal(r.moved, true)
  assert.equal(r.metric, 'revenue')
  assert.equal(r.label, 'Revenue')
  assert.equal(r.unit, 'money')
  assert.equal(r.window_label, 'the week of 2026-05-11')   // WEEK_B, the primary window
  assert.equal(r.baseline_label, 'the prior week')          // WEEK_A baseline
  assert.equal(r.direction, 'up')
  assert.equal(r.total_from, 18000)
  assert.equal(r.total_to, 20000)
  assert.equal(r.total_delta, 2000)
  assert.equal(r.total_delta_display, '+$2,000')
  assert.equal(r.pct, 11.1)

  // lead = the most-ALIGNED client, not the biggest |move|. Beta and Gamma both moved
  // $3,000, but Beta moved DOWN (a cushion) and Gamma UP (the driver) — so the lead is
  // Gamma. This is the discriminating case for share-by-alignment over raw magnitude.
  assert.equal(r.lead.key, 'Gamma')
  assert.equal(r.lead.delta, 3000)
  assert.equal(r.lead.delta_display, '+$3,000')
  assert.equal(r.lead.share_pct, 150)

  // contributors ranked by |delta| desc, ties broken by label asc → Beta, Gamma, Acme.
  assert.deepEqual(r.contributors.map((c) => c.key), ['Beta', 'Gamma', 'Acme'])
  assert.deepEqual(r.contributors.map((c) => c.delta), [-3000, 3000, 2000])
  assert.deepEqual(r.contributors.map((c) => c.delta_display), ['−$3,000', '+$3,000', '+$2,000'])  // U+2212 minus
  // signed shares sum to exactly 1 (Beta −1.5 + Gamma +1.5 + Acme +1.0).
  assert.ok(Math.abs(r.contributors.reduce((s, c) => s + c.share, 0) - 1) < 1e-9)

  // every client is named (3 ≤ limit 5), so nothing folds into others / unattributed.
  assert.equal(r.others, null)
  assert.equal(r.unattributed, null)

  // the grounded one-liner reads from the breakdown verbatim — no invented number.
  assert.equal(
    r.narration,
    'Revenue rose $2,000 (+11.1%). Gamma drove the most — +$3,000 (150% of the change); Beta −$3,000, Acme +$2,000.'
  )
})

test('runExplain returns null for every non-decomposable shape', async () => {
  const { acme } = await ensurePortfolio()

  // a RATIO metric — roas/cpl/close_rate are NOT additive over clients (that "why" is
  // the driver decomposition, attribution.js), so there is no exact per-client split.
  assert.equal(
    await runExplain({ metric: 'roas', group_by: 'none', time_range: 'last_week' }, { now: NOW2 }), null)
  // already GROUPED — a ranking is not a single figure to attribute.
  assert.equal(
    await runExplain({ metric: 'revenue', group_by: 'client', time_range: 'last_week' }, { now: NOW2 }), null)
  // OPEN-ENDED range — no honest equal-length prior window to compare against.
  assert.equal(
    await runExplain({ metric: 'revenue', group_by: 'none', time_range: 'all_time' }, { now: NOW2 }), null)
  // a SCOPED (single-client) caller — a per-client view has no cross-client "who".
  assert.equal(
    await runExplain({ metric: 'revenue', group_by: 'none', time_range: 'last_week' }, { now: NOW2, scopeClientId: acme }), null)
})

// meta.explainable is the SERVER-SIDE predicate the UI reads to decide whether to
// offer the "Why?" chip — so the client never re-derives the eligibility rules. It
// must be true for EXACTLY the shape runExplain can decompose, and false otherwise.
test('runAsk flags meta.explainable for exactly the decomposable shape', async () => {
  await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onNarrate = () => 'ok'

  // YES — an unscoped additive single figure that moved vs its prior week.
  onParse = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  const yes = await runAsk('revenue last week', { now: NOW2 })
  assert.ok(yes.meta.comparison, 'precondition: it carried a period-over-period comparison')
  assert.equal(yes.meta.explainable, true)

  // NO — grouped (a ranking, not one figure): comparison is null, so explainable false.
  onParse = () => JSON.stringify({ metric: 'revenue', group_by: 'client', time_range: 'last_week' })
  assert.equal((await runAsk('top clients last week', { now: NOW2 })).meta.explainable, false)

  // NO — a ratio metric. It DOES carry a comparison (a single roas figure vs the prior
  // week), but it isn't additive over clients, so the additive gate keeps the chip off.
  onParse = () => JSON.stringify({ metric: 'roas', group_by: 'none', time_range: 'last_week' })
  const ratio = await runAsk('roas last week', { now: NOW2 })
  assert.ok(ratio.meta.comparison, 'a ratio single figure still carries a comparison')
  assert.equal(ratio.meta.explainable, false)

  // NO — an open-ended range carries no comparison at all.
  onParse = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'all_time' })
  assert.equal((await runAsk('revenue all time', { now: NOW2 })).meta.explainable, false)

  delete process.env.ANTHROPIC_API_KEY
})

test('a client-scoped single figure is never flagged explainable', async () => {
  const { acme } = await ensurePortfolio()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  onParse   = () => JSON.stringify({ metric: 'revenue', group_by: 'none', time_range: 'last_week' })
  onNarrate = () => 'ok'

  // The figure moved (Acme 12,000 vs 10,000) and the metric is additive, but a per-
  // client surface has no cross-client "who" to attribute to — so the chip stays off.
  const res = await runAsk('how much revenue last week?', { now: NOW2, scopeClientId: acme })
  assert.ok(res.meta.comparison, 'it still carries its own period-over-period comparison')
  assert.equal(res.meta.explainable, false)

  delete process.env.ANTHROPIC_API_KEY
})
