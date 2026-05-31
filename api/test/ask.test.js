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
  runAsk, validateSpec, compileQuery, resolveTimeRange, SpecError,
} = require('../lib/ask')

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
