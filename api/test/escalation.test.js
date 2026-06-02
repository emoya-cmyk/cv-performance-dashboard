'use strict'

// Tests for lib/escalation.js — the ACT half of the efficacy loop. efficacy.js
// LEARNS, per play archetype, how often the recommended play actually clears the
// problem; escalation.js is the first organ that lets that learning CHANGE the
// recommended action. These tests pin the conservatism that makes wiring it in
// (2b) safe: every record that hasn't EARNED the override is a pure no-op that
// returns the base action by the SAME reference and never mutates an input. The
// one escalate path — band 'low' on n ≥ ESCALATE_MIN_N decided outcomes — bumps
// urgency exactly one lane (capped), appends a grounded clause whose every number
// comes from the record, and carries a peer-free client_text. Same node:test
// house style as efficacy.test.js / outcomes.test.js.

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  reviseAction, shouldEscalate, bumpUrgency,
  ESCALATE_MIN_N, URGENCY_ORDER,
} = require('../lib/escalation')

const { EFF_LOW } = require('../lib/efficacy')

// A proven-ineffective record: deep evidence (n ≥ 5), low shrunk efficacy.
const lowRec    = (over = {}) => ({ play: 'trend::leads', kind: 'trend', metric: 'leads', n: 7, successes: 1, failures: 6, efficacy: 0.18, band: 'low', ...over })
// A proven-effective record: same depth, high efficacy — must never escalate.
const highRec   = (over = {}) => ({ play: 'trend::leads', kind: 'trend', metric: 'leads', n: 9, successes: 8, failures: 1, efficacy: 0.82, band: 'high', ...over })
// A middling record — n is deep enough but efficacy sits above EFF_LOW.
const medRec    = (over = {}) => ({ play: 'trend::leads', kind: 'trend', metric: 'leads', n: 8, successes: 4, failures: 4, efficacy: 0.5,  band: 'medium', ...over })
// Base recommendation as recommendedAction() emits it (extra fields ride along).
const baseAct   = (over = {}) => ({ text: 'Pull the usual lever.', urgency: 'plan', kind: 'trend', metric: 'leads', ...over })

// ── exported constants: the thresholds the whole module turns on ──────────────
test('constants: ESCALATE_MIN_N is 5 (one above efficacyNote NOTE_MIN_N) and the lanes ascend', () => {
  assert.equal(ESCALATE_MIN_N, 5)
  assert.deepEqual(URGENCY_ORDER, ['monitor', 'plan', 'act_now'])
})

// ── bumpUrgency: one lane up, capped, junk → coolest ──────────────────────────
test('bumpUrgency: each lane bumps to the next, act_now is the ceiling', () => {
  assert.equal(bumpUrgency('monitor'), 'plan')
  assert.equal(bumpUrgency('plan'),    'act_now')
  assert.equal(bumpUrgency('act_now'), 'act_now')   // capped — never past the top
})

test('bumpUrgency: unknown / blank urgency is treated as the coolest lane → plan', () => {
  assert.equal(bumpUrgency('zzz'), 'plan')
  assert.equal(bumpUrgency(''),    'plan')
  assert.equal(bumpUrgency(undefined), 'plan')
  assert.equal(bumpUrgency(null), 'plan')
})

// ── shouldEscalate: the gate — PROVEN failure only ────────────────────────────
test('shouldEscalate: true only when n ≥ ESCALATE_MIN_N AND efficacy < EFF_LOW', () => {
  assert.equal(shouldEscalate(lowRec()), true)                       // n=7, eff=0.18 < 0.40
  assert.equal(shouldEscalate(lowRec({ efficacy: EFF_LOW })), false) // exactly at the floor is NOT below it
  assert.equal(shouldEscalate(medRec()), false)                      // eff 0.50 ≥ 0.40
  assert.equal(shouldEscalate(highRec()), false)                     // eff 0.82 ≥ 0.40
})

test('shouldEscalate: thin evidence never escalates, however bad the rate', () => {
  assert.equal(shouldEscalate(lowRec({ n: 4 })), false)              // 4 < ESCALATE_MIN_N(5)
  assert.equal(shouldEscalate(lowRec({ n: ESCALATE_MIN_N })), true)  // exactly 5 is enough
  assert.equal(shouldEscalate(lowRec({ n: 0 })), false)
})

test('shouldEscalate: null / undefined / non-finite n → false (never throws)', () => {
  assert.equal(shouldEscalate(null), false)
  assert.equal(shouldEscalate(undefined), false)
  assert.equal(shouldEscalate({}), false)
  assert.equal(shouldEscalate({ n: 'x', efficacy: 0.1 }), false)
})

test('shouldEscalate: efficacy missing → falls back to record.band === "low"', () => {
  assert.equal(shouldEscalate({ n: 6, band: 'low' }), true)
  assert.equal(shouldEscalate({ n: 6, band: 'medium' }), false)
  assert.equal(shouldEscalate({ n: 6 }), false)                      // no efficacy, no low band
})

test('shouldEscalate: opts override the floor (minN) and the low threshold (lowMax)', () => {
  // Loosen minN: a 3-sample low record now qualifies.
  assert.equal(shouldEscalate(lowRec({ n: 3 }), { minN: 3 }), true)
  // Tighten lowMax: 0.18 still below 0.10? no → false.
  assert.equal(shouldEscalate(lowRec({ efficacy: 0.18 }), { lowMax: 0.10 }), false)
  // Raise lowMax above a medium rate → it now counts as "low enough".
  assert.equal(shouldEscalate(medRec({ efficacy: 0.50 }), { lowMax: 0.60 }), true)
})

// ── reviseAction: no-op gates (the safety guarantee for 2b) ────────────────────
test('reviseAction: null/thin/medium/high record → returns the SAME action reference', () => {
  const a = baseAct()
  assert.equal(reviseAction(a, null),        a)   // no record
  assert.equal(reviseAction(a, undefined),   a)
  assert.equal(reviseAction(a, lowRec({ n: 4 })), a)   // thin — below the bar
  assert.equal(reviseAction(a, medRec()),    a)   // middling efficacy
  assert.equal(reviseAction(a, highRec()),   a)   // proven effective
})

test('reviseAction: null base action is returned untouched (nothing to revise)', () => {
  assert.equal(reviseAction(null, lowRec()), null)
  assert.equal(reviseAction(undefined, lowRec()), undefined)
})

// ── reviseAction: the escalate path ───────────────────────────────────────────
test('reviseAction: proven-ineffective play → NEW object, urgency bumped, clause appended', () => {
  const base = baseAct({ urgency: 'plan' })
  const out  = reviseAction(base, lowRec())

  assert.notEqual(out, base)                       // a new object, never the input
  assert.equal(out.escalated, true)
  assert.equal(out.urgency, 'act_now')             // plan → act_now
  // base advice preserved, grounded clause appended (numbers straight from the record)
  assert.ok(out.text.startsWith('Pull the usual lever.'))
  assert.match(out.text, /only 18% of the time \(1 of 7\)/)
  assert.match(out.text, /escalate and try a different lever/i)
  // carried fields survive the spread
  assert.equal(out.kind, 'trend')
  assert.equal(out.metric, 'leads')
})

test('reviseAction: the escalation object carries the structured facts + softened client_text', () => {
  const out = reviseAction(baseAct({ urgency: 'monitor' }), lowRec())
  assert.deepEqual(out.escalation, {
    reason: 'play_ineffective',
    pct: 18,
    successes: 1,
    n: 7,
    band: 'low',
    from_urgency: 'monitor',
    to_urgency: 'plan',
    client_text: 'We’re changing our approach here — the usual fix hasn’t been moving the needle, so your team is taking a different angle.',
  })
  assert.equal(out.urgency, 'plan')                // monitor → plan
})

test('reviseAction: client_text is peer-free and ops-language-free (client-safe by construction)', () => {
  const ct = reviseAction(baseAct(), lowRec()).escalation.client_text
  assert.doesNotMatch(ct, /escalate/i)             // no internal directive verb
  assert.doesNotMatch(ct, /%|\bof\b/)              // no failure statistic leaks
  assert.doesNotMatch(ct, /strategist|senior|ops/i)
})

test('reviseAction: urgency bump respects the act_now ceiling', () => {
  const out = reviseAction(baseAct({ urgency: 'act_now' }), lowRec())
  assert.equal(out.urgency, 'act_now')             // already hottest — stays
  assert.equal(out.escalation.from_urgency, 'act_now')
  assert.equal(out.escalation.to_urgency, 'act_now')
})

test('reviseAction: unknown base urgency is treated as monitor before the bump', () => {
  const out = reviseAction(baseAct({ urgency: 'whenever' }), lowRec())
  assert.equal(out.escalation.from_urgency, 'monitor')
  assert.equal(out.urgency, 'plan')
})

test('reviseAction: empty/blank base text → clause stands alone (no leading space)', () => {
  const out = reviseAction(baseAct({ text: '   ' }), lowRec())
  assert.ok(out.text.startsWith('This play has cleared the problem'))
  const out2 = reviseAction(baseAct({ text: undefined }), lowRec())
  assert.ok(out2.text.startsWith('This play has cleared the problem'))
})

test('reviseAction: a junk successes count never prints NaN — intOf floors it to 0', () => {
  // n stays valid (must pass the shouldEscalate gate) but successes is junk.
  const out = reviseAction(baseAct(), lowRec({ successes: null, efficacy: 0.05 }))
  assert.doesNotMatch(out.text, /NaN/)
  assert.match(out.text, /\(0 of 7\)/)             // s floored to 0, n preserved
  assert.equal(out.escalation.successes, 0)
  assert.equal(out.escalation.n, 7)
})

test('reviseAction: pct is the record efficacy rounded & clamped to [0,100]', () => {
  assert.equal(reviseAction(baseAct(), lowRec({ efficacy: 0.184 })).escalation.pct, 18)  // rounds
  assert.equal(reviseAction(baseAct(), lowRec({ efficacy: 0.185 })).escalation.pct, 19)  // rounds up
  assert.equal(reviseAction(baseAct(), lowRec({ efficacy: -0.5 })).escalation.pct, 0)    // clamp low
})

test('reviseAction: band defaults to "low" when the record omits it but the rate qualifies', () => {
  const out = reviseAction(baseAct(), { n: 6, successes: 1, efficacy: 0.2 })  // no band field
  assert.equal(out.escalated, true)
  assert.equal(out.escalation.band, 'low')
})

// ── non-mutation: the inputs are never touched ────────────────────────────────
test('reviseAction: never mutates the base action or the record', () => {
  const base = baseAct({ urgency: 'plan' })
  const baseCopy = JSON.parse(JSON.stringify(base))
  const rec  = lowRec()
  const recCopy = JSON.parse(JSON.stringify(rec))

  const out = reviseAction(base, rec)
  assert.notEqual(out, base)
  assert.deepEqual(base, baseCopy)                 // input action untouched
  assert.deepEqual(rec, recCopy)                   // input record untouched
  assert.equal(base.escalated, undefined)          // no field leaked back onto the input
})

// ── totality: degenerate input is a no-op, never a throw ──────────────────────
test('reviseAction: degenerate inputs never throw', () => {
  assert.doesNotThrow(() => reviseAction({}, {}))
  assert.doesNotThrow(() => reviseAction({ text: 5, urgency: 9 }, { n: 'NaN' }))
  assert.doesNotThrow(() => reviseAction(baseAct(), { n: 6, band: 'low' }))   // efficacy absent, band fallback
})
