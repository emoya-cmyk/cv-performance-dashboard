'use strict'

// Tests for lib/adviceAnswer.js — the grounded "what should I do?" answer behind the
// Ask box. The contract under test:
//   • adviceAnswer takes an ALREADY-DECORATED, ALREADY-RANKED client feed (the route's
//     attachEscalations(attachEfficacyNotes(feed, table), table) output) and reshapes
//     it into a focused to-do list — it NEVER re-prioritizes (feed order is preserved)
//     and NEVER invents text (every action string is copied verbatim from the finding);
//   • audience picks the wording of an ESCALATED action: agency reads recommended_action
//     .text (with the ops clause), client reads the softened escalation.client_text;
//     a NON-escalated action is identical for both (already client-safe since v3);
//   • the efficacy note (a play's own pooled rate, peer-free) rides through verbatim
//     for both audiences;
//   • honesty bands carry: empty/:nothing-actionable feed → 'all_clear' (a real
//     "you're caught up", not a dressed-up number), a non-array → 'none' (quiet no-op);
//   • the cap is visible — count = surfaced, total = available — never silent;
//   • narrateAdvice turns a verdict into ONE plain sentence, counting act-now items
//     straight off the verdict so it can never disagree with the cards;
//   • PURE: inputs (even frozen) are never mutated, and it never throws.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { adviceAnswer, narrateAdvice, DEFAULT_LIMIT } = require('../lib/adviceAnswer')

// ── builders: shape decorated feed findings exactly as the engine emits them ─────────
// a plain (non-escalated) adverse finding — recommended_action is already client-safe
const finding = (over = {}) => ({
  id: 1,
  kind: 'trend',
  metric: 'leads',
  severity: 'warning',
  status: 'open',
  title: 'Leads trending down',
  recommended_action: {
    text: 'raise budget or broaden targeting on the top-performing campaigns',
    urgency: 'plan',
  },
  ...over,
})

// the escalation.js shape: recommended_action REVISED (escalated:true + ops clause in
// .text), with the structured escalation HOISTED to the finding top-level — the
// client_text is the softened, peer-free, stat-free variant.
const CLIENT_TEXT =
  'We’re changing our approach here — the usual fix hasn’t been moving the needle, so your team is taking a different angle.'
const escalatedFinding = (over = {}) =>
  finding({
    id: 2,
    severity: 'critical',
    recommended_action: {
      text:
        'pause the weakest campaigns and move that budget into the best returners. ' +
        "We're escalating: this play has cleared the problem only 20% of the time (1 of 5).",
      urgency: 'act_now',
      escalated: true,
    },
    escalation: {
      reason: 'play_ineffective',
      pct: 20,
      successes: 1,
      n: 5,
      band: 'low',
      from_urgency: 'plan',
      to_urgency: 'act_now',
      client_text: CLIENT_TEXT,
    },
    ...over,
  })

const EFF_NOTE = { text: 'This play has cleared the problem 80% of the time (8 of 10).', pct: 80, successes: 8, n: 10, median_days: 3, band: 'high' }

// ── selection + shaping ──────────────────────────────────────────────────────────────
test('adviceAnswer: actionable verdict preserves feed order and copies advice verbatim', () => {
  const feed = [
    finding({ id: 10, severity: 'critical', recommended_action: { text: 'cap the overspend', urgency: 'act_now' } }),
    finding({ id: 11, recommended_action: { text: 'trim the high-cost keywords', urgency: 'plan' } }),
  ]
  const v = adviceAnswer(feed, { audience: 'agency' })
  assert.equal(v.status, 'actionable')
  assert.equal(v.audience, 'agency')
  assert.equal(v.count, 2)
  assert.equal(v.total, 2)
  assert.deepEqual(v.actions.map((a) => a.id), [10, 11])          // order preserved, not re-ranked
  assert.equal(v.actions[0].action, 'cap the overspend')          // copied verbatim
  assert.equal(v.actions[0].urgency, 'act_now')
  assert.equal(v.actions[0].title, 'Leads trending down')
  assert.equal(v.actions[1].action, 'trim the high-cost keywords')
})

test('adviceAnswer: carries the efficacy note object through verbatim, both audiences', () => {
  const feed = [finding({ efficacy_note: EFF_NOTE })]
  for (const audience of ['agency', 'client']) {
    const v = adviceAnswer(feed, { audience })
    assert.deepEqual(v.actions[0].efficacy_note, EFF_NOTE)        // peer-free pooled rate is client-safe
  }
})

test('adviceAnswer: a finding with no usable advice is dropped (not surfaced blank)', () => {
  const feed = [
    finding({ id: 1, recommended_action: null }),
    finding({ id: 2, recommended_action: { text: '', urgency: 'plan' } }),
    finding({ id: 3, recommended_action: { text: 'do the thing', urgency: 'plan' } }),
  ]
  const v = adviceAnswer(feed, { audience: 'agency' })
  assert.equal(v.total, 1)
  assert.deepEqual(v.actions.map((a) => a.id), [3])
})

// ── audience wording: the ONLY surface-specific behavior ─────────────────────────────
test('adviceAnswer: AGENCY reads the raw revised text of an escalated play', () => {
  const v = adviceAnswer([escalatedFinding()], { audience: 'agency' })
  assert.equal(v.actions[0].escalated, true)
  assert.equal(v.actions[0].action, escalatedFinding().recommended_action.text)  // ops clause included
  assert.match(v.actions[0].action, /escalating/)
})

test('adviceAnswer: CLIENT reads the softened client_text of an escalated play — never the failure stat', () => {
  const v = adviceAnswer([escalatedFinding()], { audience: 'client' })
  assert.equal(v.actions[0].escalated, true)
  assert.equal(v.actions[0].action, CLIENT_TEXT)
  assert.doesNotMatch(v.actions[0].action, /escalating|of 5|20%/)               // no ops language, no stat
  assert.notEqual(v.actions[0].action, escalatedFinding().recommended_action.text)
})

test('adviceAnswer: a NON-escalated action is identical for both audiences (already client-safe)', () => {
  const feed = [finding()]
  const ag = adviceAnswer(feed, { audience: 'agency' }).actions[0].action
  const cl = adviceAnswer(feed, { audience: 'client' }).actions[0].action
  assert.equal(ag, cl)
  assert.equal(ag, finding().recommended_action.text)
  assert.equal(adviceAnswer(feed, { audience: 'client' }).actions[0].escalated, false)
})

// ── the cap is visible, never silent ─────────────────────────────────────────────────
test('adviceAnswer: caps to limit but reports the true total', () => {
  const feed = Array.from({ length: 8 }, (_, i) => finding({ id: i + 1 }))
  const v = adviceAnswer(feed, { audience: 'agency', limit: 3 })
  assert.equal(v.count, 3)
  assert.equal(v.total, 8)
  assert.deepEqual(v.actions.map((a) => a.id), [1, 2, 3])
})

test('adviceAnswer: default limit is a focused top-N', () => {
  const feed = Array.from({ length: DEFAULT_LIMIT + 4 }, (_, i) => finding({ id: i + 1 }))
  const v = adviceAnswer(feed, { audience: 'agency' })          // no limit passed
  assert.equal(v.count, DEFAULT_LIMIT)
  assert.equal(v.total, DEFAULT_LIMIT + 4)
})

// ── honesty bands ────────────────────────────────────────────────────────────────────
test('adviceAnswer: an empty (or nothing-actionable) feed → all_clear, never a fake action', () => {
  for (const feed of [[], [finding({ recommended_action: null })]]) {
    const v = adviceAnswer(feed, { audience: 'client' })
    assert.equal(v.status, 'all_clear')
    assert.equal(v.count, 0)
    assert.equal(v.total, 0)
    assert.deepEqual(v.actions, [])
  }
})

test('adviceAnswer: a non-array → a quiet status:none, never null or throw', () => {
  for (const bad of [undefined, null, {}, 'nope', 42]) {
    const v = adviceAnswer(bad, { audience: 'agency' })
    assert.equal(v.status, 'none')
    assert.equal(v.count, 0)
    assert.deepEqual(v.actions, [])
  }
})

test('adviceAnswer: audience defaults to agency when unspecified', () => {
  const v = adviceAnswer([escalatedFinding()])
  assert.equal(v.audience, 'agency')
  assert.match(v.actions[0].action, /escalating/)               // agency wording
})

// ── narrateAdvice: one grounded sentence, counts straight off the verdict ─────────────
test('narrateAdvice: actionable with an act-now item names the immediate count', () => {
  const v = adviceAnswer([escalatedFinding(), finding({ id: 3 })], { audience: 'agency' })
  assert.equal(
    narrateAdvice(v),
    '2 recommended actions to focus on — 1 needs immediate attention.',
  )
})

test('narrateAdvice: actionable with no act-now item omits the immediate clause', () => {
  const v = adviceAnswer([finding({ id: 1 }), finding({ id: 2 })], { audience: 'agency' })  // both 'plan'
  assert.equal(narrateAdvice(v), '2 recommended actions to focus on.')
})

test('narrateAdvice: singular phrasing for a single action', () => {
  const v = adviceAnswer([escalatedFinding()], { audience: 'agency' })   // one act_now
  assert.equal(narrateAdvice(v), '1 recommended action to focus on — 1 needs immediate attention.')
})

test('narrateAdvice: all_clear tone differs by audience', () => {
  const cl = adviceAnswer([], { audience: 'client' })
  const ag = adviceAnswer([], { audience: 'agency' })
  assert.equal(narrateAdvice(cl), "You're all caught up — no open issues need your attention right now.")
  assert.equal(narrateAdvice(ag), 'All clear — no open issues need attention for this client right now.')
})

test('narrateAdvice: none and null/undefined verdicts narrate to empty string', () => {
  assert.equal(narrateAdvice(adviceAnswer(null)), '')
  assert.equal(narrateAdvice(null), '')
  assert.equal(narrateAdvice(undefined), '')
})

// ── purity ────────────────────────────────────────────────────────────────────────────
test('adviceAnswer: does not mutate the feed or its findings (frozen input is safe)', () => {
  const feed = Object.freeze([Object.freeze(escalatedFinding()), Object.freeze(finding({ id: 3 }))])
  const v = adviceAnswer(feed, { audience: 'client' })           // frozen → throws if it writes
  assert.equal(v.status, 'actionable')
  assert.equal(v.count, 2)
  assert.equal(v.actions[0].action, CLIENT_TEXT)                 // client wording, original untouched
})
