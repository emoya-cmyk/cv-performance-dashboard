'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  buildClientBriefPack,
  buildPortfolioBriefPack,
  templateClientBrief,
  templatePortfolioBrief,
} = require('../lib/pulseBrief')

// Reuse the SHIPPED grounding verifier — the brief packs are designed so that
// every number a template (or, later, the LLM) emits traces to a pack leaf.
const { verifyGrounding, collectAllowedNumbers } = require('../lib/ai')

// ── fixtures ──────────────────────────────────────────────────────────────────

// CLIENT — firing focus + worsening streak + an overnight resolved win. The
// focus signal carries agency-only machinery (z/baseline/reliability/accuracy/
// tuning) that MUST NOT survive into the client pack; a second non-focus signal
// ("Calls") must not leak either.
function clientFiring() {
  return {
    as_of: '2026-06-02',
    window: 7,
    lookback_days: 30,
    signals: [
      {
        metric: 'revenue', label: 'Revenue', direction: 'down', delta_pct: -24.3,
        lane: 'worth_a_look', priority: 2,
        continuity_client_note: "We've been tracking this for 3 days, and it hasn't turned around yet.",
        // agency-only machinery — must be stripped from the client pack:
        z: -2.1, baseline: 1000, severity: 'warning',
        reliability: 0.8, reliability_label: 'reliable',
        accuracy_label: 'proven', tuning_note: 'sensor widened', tuning: { sensitivity: 1.2 },
      },
      {
        metric: 'calls', label: 'Calls', direction: 'down', delta_pct: -12, lane: 'monitor',
        continuity_client_note: 'This is new this morning.',
      },
    ],
    briefing: {
      status: 'briefing', posture: 'watch',
      headline_text: "Your revenue is worth a look this week. We're also keeping an eye on 1 other metric.",
      focus: { metric: 'revenue', label: 'Revenue', direction: 'down', delta_pct: -24.3, lane: 'worth_a_look' },
      also_count: 1,
    },
    continuity: {
      focus: { metric: 'revenue', label: 'Revenue', status: 'persisting', streak: 3, streak_capped: false, since_back: 2, trend: 'worsening' },
      resolved: [{ metric: 'leads', label: 'Leads' }],
      new_count: 1, persisting_count: 1, escalating_count: 1,
      resolved_note: 'Resolved since yesterday: leads.',
      resolved_client_note: 'Good news — your leads alert from yesterday has settled back into your normal range.',
    },
  }
}

// PORTFOLIO — firing book. The headline row and headline_text both carry
// machinery (z/severity/triage_reason) that must NOT reach the pack; confidence
// shares (proven_share/graded_share) must be dropped too.
function portfolioFiring() {
  return {
    as_of: '2026-06-02', window: 7, lookback_days: 30,
    roster: [], act_today: [],
    briefing: {
      status: 'briefing', posture: 'act',
      counts: { adverse: 7, clients: 4, act_now: 2, tailwinds: 5, proven: 4, learning: 1 },
      headline: {
        client_id: 'c1', client_name: 'Acme', metric: 'revenue', label: 'Revenue',
        direction: 'down', delta_pct: -32, lane: 'act_now',
        z: -2.4, severity: 'critical',
        triage_reason: 'Revenue is critical — 32% below baseline (z -2.4) — act today.',
      },
      headline_text: "7 alerts across 4 clients today. First up, Acme: Revenue is critical — 32% below baseline (z -2.4) — act today.",
      also: [
        { client_id: 'c2', client_name: 'Beta', label: 'Leads', lane: 'verify' },
        { client_id: 'c3', client_name: 'Gamma', label: 'Jobs', lane: 'worth_a_look' },
      ],
      also_text: 'Next: Beta — leads (verify), Gamma — jobs (worth a look).',
      confidence: {
        proven_share: 0.57, graded_share: 0.86, label: 'high',
        note: "Most of today's alerts come from sensors with a proven track record — this read is well-grounded.",
      },
    },
    continuity: {
      new_count: 3, persisting_count: 2, escalating_count: 1, resolved_count: 1,
      resolved: [{ client_id: 'c9', client_name: 'Delta', metric: 'calls', label: 'Calls' }],
      clients_new: 2, clients_escalating: 1, clients_resolved: 1,
      note: '3 new this morning · 2 ongoing (1 worsening) · 1 resolved since yesterday',
    },
  }
}

// ── 1. CLIENT pack exactness ─────────────────────────────────────────────────
test('buildClientBriefPack — exact pack from a firing pulse', () => {
  const pack = buildClientBriefPack(clientFiring())
  assert.deepStrictEqual(pack, {
    audience: 'client',
    as_of: '2026-06-02',
    period: { label: '2026-06-02', week_start: '2026-06-02', week_end: '2026-06-02' },
    posture: 'watch',
    status: 'briefing',
    meta: { quiet: false, has_focus: true, has_resolved: true },
    focus: { metric: 'revenue', label: 'Revenue', direction: 'down', delta_pct: -24.3, lane: 'worth_a_look' },
    also_count: 1,
    memory: {
      new_count: 1, persisting_count: 1, escalating_count: 1, resolved_count: 1,
      focus_status: 'persisting', streak: 3, since_back: 2, streak_capped: false, trend: 'worsening',
    },
    resolved: [{ metric: 'leads', label: 'Leads' }],
    engine_notes: {
      headline: "Your revenue is worth a look this week. We're also keeping an eye on 1 other metric.",
      focus_streak: "We've been tracking this for 3 days, and it hasn't turned around yet.",
      resolved: 'Good news — your leads alert from yesterday has settled back into your normal range.',
    },
  })
})

// ── 2. PORTFOLIO pack exactness ──────────────────────────────────────────────
test('buildPortfolioBriefPack — exact pack from a firing pulse (machinery stripped)', () => {
  const pack = buildPortfolioBriefPack(portfolioFiring())
  assert.deepStrictEqual(pack, {
    audience: 'agency',
    as_of: '2026-06-02',
    period: { label: '2026-06-02', week_start: '2026-06-02', week_end: '2026-06-02' },
    posture: 'act',
    status: 'briefing',
    meta: { quiet: false, has_action: true, has_resolved: true },
    counts: { adverse: 7, clients: 4, act_now: 2, tailwinds: 5, proven: 4, learning: 1 },
    headline: { client_name: 'Acme', metric: 'revenue', label: 'Revenue', lane: 'act_now', direction: 'down', delta_pct: -32 },
    also: [
      { client_name: 'Beta', label: 'Leads', lane: 'verify' },
      { client_name: 'Gamma', label: 'Jobs', lane: 'worth_a_look' },
    ],
    memory: { new_count: 3, persisting_count: 2, escalating_count: 1, resolved_count: 1, clients_new: 2, clients_escalating: 1, clients_resolved: 1 },
    confidence: { label: 'high', note: "Most of today's alerts come from sensors with a proven track record — this read is well-grounded." },
    engine_notes: {
      headline: null,
      also: 'Next: Beta — leads (verify), Gamma — jobs (worth a look).',
      continuity: '3 new this morning · 2 ongoing (1 worsening) · 1 resolved since yesterday',
      confidence: "Most of today's alerts come from sensors with a proven track record — this read is well-grounded.",
    },
  })
})

// ── 3. CLIENT template grounding ─────────────────────────────────────────────
test('templateClientBrief — firing+streak+resolved is fully grounded', () => {
  const pack = buildClientBriefPack(clientFiring())
  const text = templateClientBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\./)
  assert.match(text, /24\.3% below your usual pace/)
  assert.match(text, /tracking this for 3 days/)
  assert.match(text, /settled back into your normal range/)
})

test('templateClientBrief — quiet morning, no numbers, grounded', () => {
  const pulse = {
    as_of: '2026-06-02', signals: [],
    briefing: { status: 'quiet', posture: 'steady', headline_text: 'All steady this week — nothing needs your attention right now.', focus: null, also_count: 0 },
    continuity: { focus: null, resolved: [], new_count: 0, persisting_count: 0, escalating_count: 0 },
  }
  const pack = buildClientBriefPack(pulse)
  assert.equal(pack.meta.quiet, true)
  const text = templateClientBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\. All steady this week/)
})

test('templateClientBrief — quiet morning with an overnight win still grounds the resolved count', () => {
  const pulse = {
    as_of: '2026-06-02', signals: [],
    briefing: { status: 'quiet', posture: 'steady', headline_text: 'All steady this week — nothing needs your attention right now.', focus: null, also_count: 0 },
    continuity: {
      focus: null,
      resolved: [{ metric: 'calls', label: 'Calls' }, { metric: 'leads', label: 'Leads' }],
      new_count: 0, persisting_count: 0, escalating_count: 0,
      resolved_client_note: "Good news — 2 of yesterday's alerts have already settled back to normal.",
    },
  }
  const pack = buildClientBriefPack(pulse)
  assert.equal(pack.memory.resolved_count, 2)
  const text = templateClientBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /2 of yesterday's alerts/)
})

// ── 4. PORTFOLIO template grounding ──────────────────────────────────────────
test('templatePortfolioBrief — firing book is fully grounded', () => {
  const pack = buildPortfolioBriefPack(portfolioFiring())
  const text = templatePortfolioBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\. 7 alerts across 4 clients to act on this morning, 2 of them act-now\./)
  assert.match(text, /First up, Acme — revenue, running about 32% below pace\./)
  assert.match(text, /3 new this morning · 2 ongoing \(1 worsening\) · 1 resolved since yesterday\./)
  assert.match(text, /5 metrics are pacing ahead across the book/)
  assert.match(text, /well-grounded/)
})

test('templatePortfolioBrief — single-alert lead path grounds act_now + delta', () => {
  const pulse = {
    as_of: '2026-06-02', roster: [], act_today: [],
    briefing: {
      status: 'briefing', posture: 'act',
      counts: { adverse: 1, clients: 1, act_now: 1, tailwinds: 0, proven: 1, learning: 0 },
      headline: { client_name: 'Acme', metric: 'leads', label: 'Leads', direction: 'down', delta_pct: -18, lane: 'act_now' },
      headline_text: 'machinery we do not carry',
      also: [], also_text: '',
      confidence: { proven_share: 1, graded_share: 1, label: 'high', note: 'Proven sensor.' },
    },
    continuity: { new_count: 1, persisting_count: 0, escalating_count: 0, resolved_count: 0, resolved: [], clients_new: 1, clients_escalating: 0, clients_resolved: 0 },
  }
  const pack = buildPortfolioBriefPack(pulse)
  const text = templatePortfolioBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\. One alert to act on this morning, 1 of them act-now\./)
  assert.match(text, /running about 18% below pace/)
  assert.doesNotMatch(text, /On the bright side/) // tailwinds: 0 → clause suppressed
})

test('templatePortfolioBrief — quiet book, only the tailwinds count, grounded', () => {
  const pulse = {
    as_of: '2026-06-02', roster: [], act_today: [],
    briefing: {
      status: 'quiet', posture: 'steady',
      counts: { adverse: 0, clients: 0, act_now: 0, tailwinds: 5, proven: 0, learning: 0 },
      headline: null,
      headline_text: 'All clear to act on — 5 metrics are pacing ahead across the book, and nothing needs attention today.',
      also: [], also_text: '',
      confidence: { proven_share: 0, graded_share: 0, label: 'n/a', note: 'Nothing flagged to act on today.' },
    },
    continuity: { new_count: 0, persisting_count: 0, escalating_count: 0, resolved_count: 0, resolved: [], clients_new: 0, clients_escalating: 0, clients_resolved: 0 },
  }
  const pack = buildPortfolioBriefPack(pulse)
  assert.equal(pack.meta.quiet, true)
  assert.equal(pack.engine_notes.headline, pulse.briefing.headline_text)
  const text = templatePortfolioBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\. All clear to act on/)
  assert.doesNotMatch(text, /Nothing flagged/) // confidence label 'n/a' → suppressed
})

test('templatePortfolioBrief — quiet book with an overnight resolved win', () => {
  const pulse = {
    as_of: '2026-06-02', roster: [], act_today: [],
    briefing: {
      status: 'quiet', posture: 'steady',
      counts: { adverse: 0, clients: 0, act_now: 0, tailwinds: 5, proven: 0, learning: 0 },
      headline: null,
      headline_text: 'All clear to act on — 5 metrics are pacing ahead across the book, and nothing needs attention today.',
      also: [], also_text: '',
      confidence: { proven_share: 0, graded_share: 0, label: 'n/a', note: 'Nothing flagged to act on today.' },
    },
    continuity: {
      new_count: 0, persisting_count: 0, escalating_count: 0, resolved_count: 1,
      resolved: [{ client_id: 'c9', client_name: 'Delta', metric: 'calls', label: 'Calls' }],
      clients_new: 0, clients_escalating: 0, clients_resolved: 1,
      note: '1 resolved since yesterday',
    },
  }
  const pack = buildPortfolioBriefPack(pulse)
  const text = templatePortfolioBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /1 resolved since yesterday\./)
})

// ── 5. CLIENT-SAFETY — no agency machinery in the client pack ────────────────
test('buildClientBriefPack — client pack carries no agency machinery or peer metric', () => {
  const json = JSON.stringify(buildClientBriefPack(clientFiring()))
  for (const bad of ['tuning', 'baseline', 'reliability', 'accuracy', 'sensitivity', 'priority', 'severity', '"z"', 'client_name', 'client_id', 'Calls', 'calls']) {
    assert.ok(!json.includes(bad), `client pack leaked "${bad}": ${json}`)
  }
})

test('buildPortfolioBriefPack — agency pack drops per-signal machinery and confidence shares', () => {
  const json = JSON.stringify(buildPortfolioBriefPack(portfolioFiring()))
  for (const bad of ['triage_reason', 'baseline', 'severity', 'proven_share', 'graded_share', '"z"', '-2.4']) {
    assert.ok(!json.includes(bad), `portfolio pack leaked "${bad}": ${json}`)
  }
})

// ── 6. NULL / empty inputs degrade to calm, grounded packs ───────────────────
test('buildClientBriefPack(null) — calm empty pack, grounded template', () => {
  const pack = buildClientBriefPack(null)
  assert.deepStrictEqual(pack, {
    audience: 'client', as_of: null, period: null, posture: null, status: null,
    meta: { quiet: true, has_focus: false, has_resolved: false },
    focus: null, also_count: 0,
    memory: { new_count: 0, persisting_count: 0, escalating_count: 0, resolved_count: 0, focus_status: null, streak: null, since_back: null, streak_capped: false, trend: null },
    resolved: [],
    engine_notes: { headline: null, focus_streak: null, resolved: null },
  })
  const text = templateClientBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\./)
})

test('buildPortfolioBriefPack(null) — calm empty pack, grounded template', () => {
  const pack = buildPortfolioBriefPack(null)
  assert.deepStrictEqual(pack, {
    audience: 'agency', as_of: null, period: null, posture: null, status: null,
    meta: { quiet: true, has_action: false, has_resolved: false },
    counts: { adverse: 0, clients: 0, act_now: 0, tailwinds: 0, proven: 0, learning: 0 },
    headline: null, also: [],
    memory: { new_count: 0, persisting_count: 0, escalating_count: 0, resolved_count: 0, clients_new: 0, clients_escalating: 0, clients_resolved: 0 },
    confidence: { label: null, note: null },
    engine_notes: { headline: null, also: null, continuity: null, confidence: null },
  })
  const text = templatePortfolioBrief(pack)
  assert.equal(verifyGrounding(text, pack).grounded, true, text)
  assert.match(text, /^Good morning\./)
})

// ── 7. ENGINE-FAITHFULNESS — the pack surfaces the engine's own strings ──────
test('client pack reuses the engine voice verbatim (no re-derivation)', () => {
  const pulse = clientFiring()
  const pack = buildClientBriefPack(pulse)
  assert.equal(pack.engine_notes.headline, pulse.briefing.headline_text)
  assert.equal(pack.engine_notes.resolved, pulse.continuity.resolved_client_note)
  const focusSig = pulse.signals.find(s => s.metric === pack.focus.metric)
  assert.equal(pack.engine_notes.focus_streak, focusSig.continuity_client_note)
})

test('portfolio pack reuses the engine voice verbatim (no re-derivation)', () => {
  const pulse = portfolioFiring()
  const pack = buildPortfolioBriefPack(pulse)
  assert.equal(pack.engine_notes.continuity, pulse.continuity.note)
  assert.equal(pack.engine_notes.also, pulse.briefing.also_text)
  assert.equal(pack.engine_notes.confidence, pulse.briefing.confidence.note)
})

// ── 8. NUMBER-COVERAGE — every number in a reused engine string is a pack leaf
test('client engine notes are number-covered by the pack', () => {
  const pack = buildClientBriefPack(clientFiring())
  const allowed = collectAllowedNumbers(pack)
  for (const note of [pack.engine_notes.headline, pack.engine_notes.focus_streak, pack.engine_notes.resolved]) {
    assert.equal(verifyGrounding(note, pack, allowed).grounded, true, `ungrounded note: ${note}`)
  }
})

test('portfolio engine notes (continuity + also) are number-covered by the pack', () => {
  const pack = buildPortfolioBriefPack(portfolioFiring())
  const allowed = collectAllowedNumbers(pack)
  for (const note of [pack.engine_notes.continuity, pack.engine_notes.also]) {
    assert.equal(verifyGrounding(note, pack, allowed).grounded, true, `ungrounded note: ${note}`)
  }
})
