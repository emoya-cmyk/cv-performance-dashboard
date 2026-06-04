'use strict'

// ============================================================
// test/impactPush.test.js — the client-facing INFLUENCE seam (intel-v12 B4).
//
// lib/impactPush.js is pure (no I/O, no DB, no clock), so this is a fast unit
// test of the two properties the seam exists to guarantee:
//
//   1. LEAK-PROOF — clientImpactView / detectImpactMilestone are the choke-point
//      between the agency-grade impact ledger and a CLIENT surface (the recap
//      "your wins" line and its email push). No matter what an upstream snapshot
//      carries — recovered dollars, raw counts, per-client attribution, another
//      client's NAME, confidence, categories — only {proven, note} survives, and
//      a note is admitted only when it is provably figure-free. We prove this by
//      feeding a deliberately "fat" agency snapshot and asserting NONE of its
//      internals appear anywhere in the serialized output.
//
//   2. MILESTONE SEMANTICS — the event fires exactly once, on a genuine
//      false→true crossing into a proven track record: true→true does not
//      re-fire (idempotent across a weekly pass), true→false does not fire, and a
//      null/absent prior treats a first-ever proven snapshot AS the milestone.
//
// Mirrors the regex leak-bans in impactLedger.test.js (no digit, no '$', no peer
// name) so the two client seams are proven leak-proof the same way.
// ============================================================

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { clientImpactView, detectImpactMilestone, safeNote } = require('../lib/impactPush')

// The real client-safe line narrateImpactLedger(…,{audience:'client'}) emits when
// proven — figure-free and peer-free by construction. Used as the "clean note".
const CLEAN_NOTE = 'The work behind the scenes has been paying off — and the results are holding up.'

// A deliberately "fat" agency snapshot: a proven record dragging EVERY agency
// internal the seam must strip — gross + risk-adjusted dollars, raw counts, a
// per-client roster carrying a peer NAME, confidence, categories, a headline.
// If any of these survive to a client surface, that is the leak.
const FAT_AGENCY = {
  proven:       true,
  note:         CLEAN_NOTE,
  value:        12345,
  weighted:     9876,
  count:        7,
  client_count: 3,
  confidence:   0.82,
  categories:   ['recovery', 'reallocation'],
  units:        ['dollars', 'count'],
  headline:     { unit: 'dollars', value: 12345, weighted: 9876, count: 7 },
  by_client:    [{ client_id: 'cli_peer_42', client_name: 'Vandelay Industries', count: 5 }],
  ledger:       { by_client: [{ client_name: 'Vandelay Industries' }], by_category: { recovery: { count: 7 } } },
  scope:        'portfolio',
}

// Assert a serialized client payload carries NONE of the agency internals.
function assertNoLeak(obj, label) {
  const s = JSON.stringify(obj)
  assert.equal(/\d/.test(s), false,            `${label}: no digit may ride a client payload`)
  assert.equal(/[$€£%]/.test(s), false,        `${label}: no currency/percent mark may ride a client payload`)
  assert.equal(/Vandelay|peer|client_id|by_client|confidence|weighted|reallocation|headline/i.test(s), false,
    `${label}: no agency-internal token may ride a client payload`)
}

// ── safeNote — the figure-free gate ───────────────────────────────────────────
test('safeNote admits a clean line and rejects anything carrying a figure', () => {
  // clean passes through, trimmed
  assert.equal(safeNote(CLEAN_NOTE), CLEAN_NOTE)
  assert.equal(safeNote(`  ${CLEAN_NOTE}  `), CLEAN_NOTE)

  // any digit / currency / percent → rejected outright (null, never trimmed-and-hoped)
  assert.equal(safeNote('We recovered $4,200 for you'), null)
  assert.equal(safeNote('Up 18% week over week'),       null)
  assert.equal(safeNote('3 wins logged'),               null)
  assert.equal(safeNote('€500 protected'),              null)
  assert.equal(safeNote('£99 saved'),                   null)

  // non-string / blank → null
  assert.equal(safeNote(''),        null)
  assert.equal(safeNote('   '),     null)
  assert.equal(safeNote(null),      null)
  assert.equal(safeNote(undefined), null)
  assert.equal(safeNote(42),        null)
  assert.equal(safeNote({}),        null)
})

// ── clientImpactView — strips to exactly {proven, note} ───────────────────────
test('clientImpactView returns exactly {proven, note} and nothing else', () => {
  const v = clientImpactView({ proven: true, note: CLEAN_NOTE })
  assert.deepEqual(Object.keys(v).sort(), ['note', 'proven'])
  assert.equal(v.proven, true)
  assert.equal(v.note, CLEAN_NOTE)
})

test('clientImpactView strips EVERY agency internal off a fat snapshot', () => {
  const v = clientImpactView(FAT_AGENCY)
  assert.deepEqual(Object.keys(v).sort(), ['note', 'proven'])
  assert.equal(v.proven, true)
  assert.equal(v.note, CLEAN_NOTE)          // the one clean field survives …
  assertNoLeak(v, 'clientImpactView(fat)')  // … and nothing else does
})

test('clientImpactView withholds the note unless the record is proven', () => {
  // unproven → note is null even when a clean note is present (nothing to celebrate yet)
  const unproven = clientImpactView({ proven: false, note: CLEAN_NOTE })
  assert.deepEqual(unproven, { proven: false, note: null })

  // proven but a leaky note → proven stays true, note collapses to null (fail-safe)
  const leakyNote = clientImpactView({ proven: true, note: 'recovered $4,200' })
  assert.deepEqual(leakyNote, { proven: true, note: null })
})

test('clientImpactView is total — never throws on junk input', () => {
  for (const junk of [null, undefined, 0, '', 'nope', [], [1, 2], 42, true, NaN]) {
    const v = clientImpactView(junk)
    assert.deepEqual(Object.keys(v).sort(), ['note', 'proven'])
    assert.equal(v.proven, false)
    assert.equal(v.note, null)
  }
})

// ── detectImpactMilestone — the once-per-crossing event ───────────────────────
test('detectImpactMilestone fires on a genuine false→true crossing', () => {
  const prev = { proven: false, note: '' }
  const curr = { proven: true,  note: CLEAN_NOTE }
  const m = detectImpactMilestone(prev, curr)
  assert.deepEqual(Object.keys(m).sort(), ['note', 'proven', 'reached'])
  assert.equal(m.reached, true)
  assert.equal(m.proven, true)
  assert.equal(m.note, CLEAN_NOTE)
})

test('detectImpactMilestone treats a first-ever proven snapshot (null prior) AS the milestone', () => {
  const m = detectImpactMilestone(null, { proven: true, note: CLEAN_NOTE })
  assert.equal(m.reached, true)
  assert.equal(m.note, CLEAN_NOTE)
})

test('detectImpactMilestone is idempotent — proven→proven does NOT re-fire', () => {
  const proven = { proven: true, note: CLEAN_NOTE }
  const m = detectImpactMilestone(proven, proven)
  assert.equal(m.reached, false)
  assert.equal(m.proven, true)   // still proven (for the steady-state in-app line) …
  assert.equal(m.note, null)     // … but no push note, because nothing crossed
})

test('detectImpactMilestone does not fire on a regression (true→false) or a still-unproven week', () => {
  const regression = detectImpactMilestone({ proven: true, note: CLEAN_NOTE }, { proven: false, note: '' })
  assert.equal(regression.reached, false)
  assert.equal(regression.proven, false)
  assert.equal(regression.note, null)

  const stillUnproven = detectImpactMilestone({ proven: false }, { proven: false })
  assert.equal(stillUnproven.reached, false)
  assert.equal(stillUnproven.note, null)
})

test('detectImpactMilestone fires but stays leak-proof when curr is a fat agency snapshot', () => {
  // null prior + fat-but-proven curr → fires, and the push carries ONLY the clean note
  const m = detectImpactMilestone(null, FAT_AGENCY)
  assert.equal(m.reached, true)
  assert.equal(m.proven, true)
  assert.equal(m.note, CLEAN_NOTE)
  assert.deepEqual(Object.keys(m).sort(), ['note', 'proven', 'reached'])
  assertNoLeak(m, 'detectImpactMilestone(null, fat)')
})

test('detectImpactMilestone withholds the note when a proven crossing has no clean note', () => {
  // proven crossing but the note itself is leaky → reached true, but note withheld;
  // the delivery layer gates on (reached && note), so this silently sends nothing.
  const m = detectImpactMilestone({ proven: false }, { proven: true, note: 'up 20%' })
  assert.equal(m.reached, true)
  assert.equal(m.note, null)
})
