// ============================================================
// test/briefEngagement.engine.test.js — the consumer-feedback DB join, wired (intel-v8 18b).
//
// (18a) test/briefEngagement.test.js pins the PURE grader on hand-built vote lists:
// given { as_of, signal } events it returns a helpful_rate / label / trend, abstaining
// below the min-vote floor. THIS file proves the SEAM 18b adds — lib/briefEngagementEngine —
// the only module that READS and WRITES brief_feedback (migration 019):
//
//   • recordBriefFeedback   — the CONSUMER write: a reversible upsert keyed (client_id,
//     as_of). A re-vote OVERWRITES in place (never a pile-up), and the returned vote is
//     the one that now stands — what the client UI reflects back.
//   • getClientBriefFeedback — the CONSUMER own-vote read: only ever the caller's own
//     (client_id, as_of) row; signal null when they have not voted that morning.
//   • getPortfolioEngagement — the AGENCY aggregate: every client's votes over a trailing
//     window rolled into a portfolio grade + a per-client board (worst reception first) +
//     a watch list (graded clients landing poorly OR declining).
//
// And the two ROUTE guards that fence the privacy invariant: resolveConsumerScope (the
// write/own-read clientId is the TOKEN's, never a body param — an agency token is refused)
// and resolvePortfolioScope (the aggregate is AGENCY-ONLY — a client token is refused).
//
// Isolated temp SQLite, same idiom as test/briefImpact.integration.test.js: forced
// SQLITE_PATH before requiring ../db, ANTHROPIC_API_KEY deleted so nothing reaches the
// network (engagement narration is pure template by construction anyway).
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force the SQLite backend at an isolated path BEFORE requiring ../db.
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY
const DB_PATH = path.join(os.tmpdir(), `briefengagement_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const {
  recordBriefFeedback, getClientBriefFeedback, getPortfolioEngagement,
  DEFAULT_ENGAGEMENT_DAYS,
} = require('../lib/briefEngagementEngine')
const { narrateBriefEngagement, DEFAULT_MIN_VOTES } = require('../lib/briefEngagement')
const { resolveConsumerScope, resolvePortfolioScope } = require('../routes/ai')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── harness ─────────────────────────────────────────────────────────────────────
let migrated = false
async function ready() { if (migrated) return; await db.migrate(); migrated = true }
async function reset() {
  await ready()
  await db.query('DELETE FROM brief_feedback')   // FK child first
  await db.query('DELETE FROM clients')
}
async function addClient(id, name) {
  await db.query('INSERT INTO clients (id, name) VALUES ($1,$2)', [id, name])
}
// Drive the fixture through the PUBLIC write API so the upsert is exercised on every row.
async function seedVotes(clientId, votes) {
  for (const v of votes) await recordBriefFeedback({ clientId, asOf: v.asOf, signal: v.signal })
}
const PID = process.pid

// ── 1. the consumer write + own-vote read: reversible upsert, token-scoped isolation ──
test('recordBriefFeedback upserts reversibly and getClientBriefFeedback returns only the caller\'s own row', async () => {
  await reset()
  const VOTER = `eng-voter-${PID}`
  const OTHER = `eng-other-${PID}`
  await addClient(VOTER, 'Voter')
  await addClient(OTHER, 'Other')
  const DAY = '2026-06-01'

  // before any vote → signal null (the control paints "not yet voted")
  assert.deepEqual(await getClientBriefFeedback({ clientId: VOTER, asOf: DAY }),
    { as_of: DAY, signal: null }, 'an un-voted morning reads back null')

  // first vote → the write returns the vote that now stands
  assert.deepEqual(await recordBriefFeedback({ clientId: VOTER, asOf: DAY, signal: 'helpful' }),
    { as_of: DAY, signal: 'helpful' }, 'the write echoes the standing vote')
  assert.equal((await getClientBriefFeedback({ clientId: VOTER, asOf: DAY })).signal, 'helpful')

  // re-vote the SAME morning → OVERWRITES in place (reversible), never piles up
  assert.deepEqual(await recordBriefFeedback({ clientId: VOTER, asOf: DAY, signal: 'not_helpful' }),
    { as_of: DAY, signal: 'not_helpful' }, 'a re-vote flips the standing vote')
  assert.equal((await getClientBriefFeedback({ clientId: VOTER, asOf: DAY })).signal, 'not_helpful',
    'the own-read reflects the flipped vote')
  const { rows: cnt } = await db.query(
    'SELECT COUNT(*) AS n FROM brief_feedback WHERE client_id = $1 AND as_of = $2', [VOTER, DAY])
  assert.equal(Number(cnt[0].n), 1, 'one vote per client per morning — the re-vote overwrote, never duplicated')

  // ISOLATION: another client voting the same morning never bleeds into the caller's own read
  await recordBriefFeedback({ clientId: OTHER, asOf: DAY, signal: 'helpful' })
  assert.equal((await getClientBriefFeedback({ clientId: VOTER, asOf: DAY })).signal, 'not_helpful',
    'the own-vote read is scoped to the caller\'s own (client_id, as_of) row')

  // the default-day branch: no asOf → today (UTC), round-trips through its own returned day
  const def = await recordBriefFeedback({ clientId: VOTER, signal: 'helpful' })
  assert.match(def.as_of, /^\d{4}-\d{2}-\d{2}$/, 'an absent as_of resolves to a concrete ISO day')
  assert.equal((await getClientBriefFeedback({ clientId: VOTER, asOf: def.as_of })).signal, 'helpful',
    'the default-day vote reads back on its resolved day')

  // defence-in-depth at the lib boundary: a bad signal / missing client never writes
  await assert.rejects(recordBriefFeedback({ clientId: VOTER, asOf: DAY, signal: 'bogus' }),
    /helpful \| not_helpful/, 'an invalid signal is refused before any write')
  await assert.rejects(recordBriefFeedback({ asOf: DAY, signal: 'helpful' }),
    /clientId is required/, 'a missing clientId is refused before any write')
})

// ── 2. the agency aggregate: portfolio grade + per-client board + watch list ──────────
test('getPortfolioEngagement rolls every client\'s votes into a portfolio grade, a worst-first board, and a poor/declining watch list', async () => {
  await reset()
  const ASOF = '2026-06-01'
  const A = `eng-A-${PID}`, B = `eng-B-${PID}`, C = `eng-C-${PID}`, D = `eng-D-${PID}`
  await addClient(A, 'Alpha'); await addClient(B, 'Bravo'); await addClient(C, 'Charlie'); await addClient(D, 'Delta')

  // A — well received: 4 helpful → rate 1.0, graded, no trend (n<2·minVotes). NOT watched.
  await seedVotes(A, [
    { asOf: '2026-05-10', signal: 'helpful' }, { asOf: '2026-05-11', signal: 'helpful' },
    { asOf: '2026-05-12', signal: 'helpful' }, { asOf: '2026-05-13', signal: 'helpful' },
  ])
  // B — poorly received: 1 helpful + 3 not_helpful → rate 0.25, graded. WATCHED (label).
  await seedVotes(B, [
    { asOf: '2026-05-10', signal: 'helpful' }, { asOf: '2026-05-11', signal: 'not_helpful' },
    { asOf: '2026-05-12', signal: 'not_helpful' }, { asOf: '2026-05-13', signal: 'not_helpful' },
  ])
  // C — too thin: 1 helpful → n=1 < minVotes → insufficient. NOT graded, NOT watched.
  await seedVotes(C, [{ asOf: '2026-05-10', signal: 'helpful' }])
  // D — declining: 3 early helpful + 3 late not_helpful → rate 0.5 (fair), trend declining. WATCHED (trend).
  await seedVotes(D, [
    { asOf: '2026-05-10', signal: 'helpful' }, { asOf: '2026-05-11', signal: 'helpful' },
    { asOf: '2026-05-12', signal: 'helpful' }, { asOf: '2026-05-13', signal: 'not_helpful' },
    { asOf: '2026-05-14', signal: 'not_helpful' }, { asOf: '2026-05-15', signal: 'not_helpful' },
  ])

  const eng = await getPortfolioEngagement({ asOf: ASOF })   // default 90-day window covers all of May

  // portfolio-wide grade over ALL 15 votes: helpful 9, not_helpful 6 → 0.6 → 'fair', graded
  assert.equal(eng.status, 'graded', 'the pooled book clears the min-vote floor')
  assert.equal(eng.helpful, 9); assert.equal(eng.not_helpful, 6); assert.equal(eng.n, 15)
  assert.equal(eng.helpful_rate, 0.6, '9 of 15 helpful')
  assert.equal(eng.label, 'fair')
  assert.equal(eng.requested_min_votes, DEFAULT_MIN_VOTES, 'the abstention floor is echoed for the agency surface')

  // per-client board: worst reception first, ungraded sorts last
  assert.equal(eng.clients_total, 4)
  assert.equal(eng.clients_graded, 3, 'A, B, D graded; C too thin')
  assert.equal(eng.by_client.length, 4)
  assert.equal(eng.by_client[0].client_id, B, 'worst reception (0.25) leads the board')
  assert.equal(eng.by_client[0].name, 'Bravo', 'the client name is joined onto the grade')
  assert.equal(eng.by_client[3].client_id, C, 'the ungraded client sorts last')

  const find = (id) => eng.by_client.find((c) => c.client_id === id)
  assert.equal(find(B).status, 'graded'); assert.equal(find(B).label, 'poorly_received'); assert.equal(find(B).helpful_rate, 0.25)
  assert.equal(find(A).label, 'well_received'); assert.equal(find(A).helpful_rate, 1)
  assert.equal(find(C).status, 'insufficient'); assert.equal(find(C).helpful_rate, null)
  assert.equal(find(D).label, 'fair'); assert.equal(find(D).helpful_rate, 0.5); assert.equal(find(D).trend, 'declining')

  // the early-warning board: graded AND (poorly_received OR declining) → exactly B and D, worst-first
  assert.deepEqual(eng.watch.map((c) => c.client_id), [B, D], 'the watch list names the poor + the fading client')
  for (const w of eng.watch) assert.equal(w.status, 'graded', 'only graded clients ever reach the watch list')

  // the agency hears the rolled-up sentence; the client voice is silent on the aggregate, always
  const agencyNarr = narrateBriefEngagement(eng, { audience: 'agency' })
  assert.match(agencyNarr, /9 of 15/, 'agency narration cites the exact tally')
  assert.match(agencyNarr, /~60%/, 'and the rounded rate')
  assert.equal(narrateBriefEngagement(eng, { audience: 'client' }), '', 'the engagement aggregate is never narrated to a client')
})

// ── 3. the trailing window actually filters: a window with no votes abstains cleanly ──
test('getPortfolioEngagement honours its trailing window — an empty window abstains with an empty board', async () => {
  await reset()
  const A = `eng-W-${PID}`
  await addClient(A, 'Window')
  await seedVotes(A, [
    { asOf: '2026-05-10', signal: 'helpful' }, { asOf: '2026-05-11', signal: 'helpful' },
    { asOf: '2026-05-12', signal: 'helpful' },
  ])

  // anchor the window years before the votes → BETWEEN excludes them all
  const eng = await getPortfolioEngagement({ asOf: '2020-01-01' })
  assert.equal(eng.status, 'insufficient', 'no votes in the window → abstain, never a fabricated rate')
  assert.equal(eng.reason, 'insufficient_history')
  assert.equal(eng.helpful_rate, null)
  assert.equal(eng.clients_total, 0, 'no client appears on the board')
  assert.deepEqual(eng.watch, [], 'and the watch list is empty')
  assert.equal(DEFAULT_ENGAGEMENT_DAYS, 90, 'the default agency window is the wide reception window')
})

// ── 4. the privacy fences the routes apply BEFORE any read/write ──────────────────────
test('the feedback routes are token-scoped: consumer write/own-read is the token\'s clientId only; the aggregate is agency-only', () => {
  // resolveConsumerScope — clientId comes ONLY from the token; an agency token is refused
  assert.deepEqual(resolveConsumerScope({ user: { client_id: 'c1' } }), { clientId: 'c1' },
    'a client token votes/reads as its own client')
  // a body param can NEVER widen or redirect the vote — the token wins, the body is ignored
  assert.deepEqual(resolveConsumerScope({ user: { client_id: 'c1' }, body: { clientId: 'other' } }), { clientId: 'c1' },
    'a forged body clientId cannot redirect the vote off the token')
  assert.equal(resolveConsumerScope({ user: { role: 'agency' } }).status, 403,
    'an agency token has no own-brief to rate → refused')
  assert.equal(resolveConsumerScope({ user: { role: 'client' } }).status, 403,
    'a client token with no client_id is a broken scope → refused')
  assert.equal(resolveConsumerScope({}).status, 403, 'an anonymous request is refused')
  assert.match(resolveConsumerScope({}).error, /client session/, 'with the consumer-session refusal message')

  // resolvePortfolioScope — the aggregate is AGENCY-ONLY (a client token can never read reception)
  assert.deepEqual(resolvePortfolioScope({ user: { role: 'agency' } }), {}, 'agency may read the engagement aggregate')
  assert.equal(resolvePortfolioScope({ user: { role: 'client', client_id: 'c1' } }).status, 403,
    'a client-scoped token is refused the portfolio engagement rollup')
})
