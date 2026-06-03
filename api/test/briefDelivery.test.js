'use strict'

// Tests for lib/briefDelivery.js — the alarm briefQuality's standing grade never raised:
// has the Morning Brief's narration FAILED right now, and what do you do? The contract
// these tests pin:
//   • INPUT is a summarizeBriefQuality summary; OUTPUT is a verdict {status, severity, alert,
//     reason, streak, coverage, narratable, latest_as_of, audience, action, streams}. Pure:
//     summary in, verdict out — never mutates, never throws, deep-equal on repeat;
//   • PER-STREAM, WORST-OF: each audience bucket is assessed on its own (streak = consecutive
//     DAILY fallbacks within that stream), and the portfolio verdict is the WORSE of the two
//     — agency alarmed if EITHER voice fails; the driving stream's figures lead;
//   • QUIET ≠ DEGRADED, EMPTY ≠ FAILURE: narratable:0 ⇒ 'ok'/reason 'quiet', no rows ⇒
//     'ok'/reason 'no-data'. You cannot fail to narrate briefs that were never worth it;
//   • THRESHOLDS: streak ≥ stallStreak(3) ⇒ 'stalled'/critical; ≥ degradeStreak(2) ⇒
//     'degraded'/warning; coverage < coverageFloor(0.5) over ≥ minSample(4) narratable ⇒
//     'degraded'/low-coverage; all overridable via opts; streak outranks coverage;
//   • narrateBriefDelivery: AGENCY-ONLY ('' for client), SILENT on ok, else one line =
//     description (off the driving stream's figures) + self-heal step + the grounded tail
//     (narration failing never means the numbers failed — coverage ⊥ grounded).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { summarizeBriefQuality } = require('../lib/briefQuality')
const {
  assessBriefDelivery,
  narrateBriefDelivery,
  BRIEF_DELIVERY_THRESHOLDS,
} = require('../lib/briefDelivery')

// ── Row builders (same shape briefQuality grades) ───────────────────────────────
// A narratable client brief (has_focus path). A real model id ⇒ narrated; 'template' ⇒ fellback.
function clientRow(as_of, model) {
  return {
    scope_key: 'c1', as_of, audience: 'client', client_id: 'c1', model, grounded: true,
    pack: { audience: 'client', meta: { has_focus: true }, focus: { metric: 'leads' } },
  }
}
// A narratable agency brief (has_action path).
function agencyRow(as_of, model) {
  return {
    scope_key: '__portfolio__', as_of, audience: 'agency', client_id: null, model, grounded: true,
    pack: { audience: 'agency', meta: { has_action: true }, headline: { client: 'Acme' } },
  }
}
// A dead-quiet client morning: nothing worth narrating → template by DESIGN, must NOT count.
function quietClientRow(as_of) {
  return {
    scope_key: 'c1', as_of, audience: 'client', client_id: 'c1', model: 'template', grounded: true,
    pack: { audience: 'client', meta: {} },
  }
}

const OPUS = 'claude-opus-4-7'
const TMPL = 'template'
const summarize = (rows) => summarizeBriefQuality(rows)

// ── Thresholds are the documented defaults ──────────────────────────────────────
test('BRIEF_DELIVERY_THRESHOLDS exports the documented default bands', () => {
  assert.deepEqual(BRIEF_DELIVERY_THRESHOLDS, {
    stallStreak: 3, degradeStreak: 2, coverageFloor: 0.5, minSample: 4,
  })
})

// ── Empty / quiet / healthy all resolve to a silent 'ok' ────────────────────────
test('empty history ⇒ ok / no-data, no alert, narrate silent for both audiences', () => {
  const v = assessBriefDelivery(summarize([]))
  assert.equal(v.status, 'ok')
  assert.equal(v.severity, 'info')
  assert.equal(v.alert, false)
  assert.equal(v.reason, 'no-data')
  assert.equal(v.audience, null)
  assert.equal(v.action, null)
  assert.equal(v.streams.client.reason, 'no-data')
  assert.equal(v.streams.agency.reason, 'no-data')
  assert.equal(narrateBriefDelivery(v, { audience: 'agency' }), '')
  assert.equal(narrateBriefDelivery(v, { audience: 'client' }), '')
})

test('all-narrated history ⇒ ok, no alert, narrate silent', () => {
  const rows = [
    clientRow('2026-05-30', OPUS), agencyRow('2026-05-30', OPUS),
    clientRow('2026-05-31', OPUS), agencyRow('2026-05-31', OPUS),
    clientRow('2026-06-01', OPUS), agencyRow('2026-06-01', OPUS),
  ]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'ok')
  assert.equal(v.alert, false)
  assert.equal(v.reason, 'ok')
  assert.equal(v.streams.client.status, 'ok')
  assert.equal(v.streams.agency.status, 'ok')
  assert.equal(narrateBriefDelivery(v, { audience: 'agency' }), '')
})

test('all-quiet history ⇒ ok / quiet (quiet is never degraded)', () => {
  const rows = [quietClientRow('2026-05-31'), quietClientRow('2026-06-01')]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'ok')
  assert.equal(v.alert, false)
  assert.equal(v.reason, 'quiet')
  assert.equal(v.streams.client.reason, 'quiet')
  assert.equal(narrateBriefDelivery(v, { audience: 'agency' }), '')
})

// ── Stalled: a run of ≥3 fallbacks on one stream ────────────────────────────────
test('agency stream stalled (streak 3) ⇒ stalled / critical, agency-driven', () => {
  const rows = [
    // agency: two narrated, then three straight fallbacks (most recent)
    agencyRow('2026-05-28', OPUS), agencyRow('2026-05-29', OPUS),
    agencyRow('2026-05-30', TMPL), agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', TMPL),
    // client: all narrated → ok
    clientRow('2026-05-30', OPUS), clientRow('2026-05-31', OPUS), clientRow('2026-06-01', OPUS),
  ]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'stalled')
  assert.equal(v.severity, 'critical')
  assert.equal(v.alert, true)
  assert.equal(v.reason, 'stalled-streak')
  assert.equal(v.audience, 'agency')
  assert.equal(v.streak, 3)
  assert.equal(v.latest_as_of, '2026-06-01')
  assert.ok(v.action && /narration model now/i.test(v.action))
  assert.equal(v.streams.client.status, 'ok')

  const agencyLine = narrateBriefDelivery(v, { audience: 'agency' })
  assert.match(agencyLine, /portfolio morning brief has fallen back/i)
  assert.match(agencyLine, /3 times running/)
  assert.match(agencyLine, /most recent 2026-06-01/)
  assert.match(agencyLine, /grounded/i)            // coverage ⊥ grounded, restated at the alarm
  assert.equal(narrateBriefDelivery(v, { audience: 'client' }), '')   // never client-facing
})

// ── Degraded: a run of exactly 2 fallbacks, coverage otherwise healthy ───────────
test('client stream degraded (streak 2, coverage ≥ floor) ⇒ degraded / degraded-streak, client-driven', () => {
  const rows = [
    // client: four narrated then two fallbacks → streak 2, coverage 4/6 ≈ 0.667 (≥ floor)
    clientRow('2026-05-27', OPUS), clientRow('2026-05-28', OPUS),
    clientRow('2026-05-29', OPUS), clientRow('2026-05-30', OPUS),
    clientRow('2026-05-31', TMPL), clientRow('2026-06-01', TMPL),
    // agency: all narrated → ok
    agencyRow('2026-05-31', OPUS), agencyRow('2026-06-01', OPUS),
  ]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'degraded')
  assert.equal(v.severity, 'warning')
  assert.equal(v.alert, true)
  assert.equal(v.reason, 'degraded-streak')   // streak outranks the (untripped) coverage band
  assert.equal(v.audience, 'client')
  assert.equal(v.streak, 2)
  assert.ok(v.action && /before the fallback becomes the habit/i.test(v.action))

  const line = narrateBriefDelivery(v, { audience: 'agency' })
  assert.match(line, /client morning brief fell back/i)
  assert.match(line, /2 times running/)
  assert.match(line, /grounded/i)
})

// ── Low-coverage: no streak (latest narrated) but the sample collapsed ───────────
test('agency low coverage with streak 0 over a real sample ⇒ degraded / low-coverage', () => {
  const rows = [
    // agency: three fallbacks then a narrated latest → streak 0, coverage 1/4 = 0.25
    agencyRow('2026-05-29', TMPL), agencyRow('2026-05-30', TMPL),
    agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', OPUS),
    // client: all narrated → ok
    clientRow('2026-05-31', OPUS), clientRow('2026-06-01', OPUS),
  ]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'degraded')
  assert.equal(v.reason, 'low-coverage')
  assert.equal(v.audience, 'agency')
  assert.equal(v.streak, 0)
  assert.equal(v.narratable, 4)
  assert.equal(v.coverage, 0.25)

  const line = narrateBriefDelivery(v, { audience: 'agency' })
  assert.match(line, /only 25% of the last 4 briefs worth narrating/i)
  assert.match(line, /grounded/i)
})

test('low coverage UNDER the minimum sample is suppressed ⇒ ok (no tiny-n panic)', () => {
  const rows = [
    // agency: only 3 narratable, coverage 1/3 ≈ 0.33 but sample < minSample(4) → ok
    agencyRow('2026-05-30', TMPL), agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', OPUS),
    clientRow('2026-06-01', OPUS),
  ]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'ok')
  assert.equal(v.alert, false)
  assert.equal(v.streams.agency.status, 'ok')
  assert.equal(v.streams.agency.reason, 'ok')
})

// ── Worst-of and tie-break determinism ──────────────────────────────────────────
test('worst-of: agency stalled beats client degraded ⇒ stalled, agency-driven', () => {
  const rows = [
    // agency stalled (streak 3)
    agencyRow('2026-05-30', TMPL), agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', TMPL),
    // client degraded (streak 2, coverage ≥ floor)
    clientRow('2026-05-27', OPUS), clientRow('2026-05-28', OPUS),
    clientRow('2026-05-29', OPUS), clientRow('2026-05-30', OPUS),
    clientRow('2026-05-31', TMPL), clientRow('2026-06-01', TMPL),
  ]
  const v = assessBriefDelivery(summarize(rows))
  assert.equal(v.status, 'stalled')
  assert.equal(v.audience, 'agency')
  assert.equal(v.streams.client.status, 'degraded')
  assert.equal(v.streams.agency.status, 'stalled')
})

test('tie-break: two equal degraded streams resolve to the agency stream', () => {
  const mk = (rowFn) => [
    rowFn('2026-05-27', OPUS), rowFn('2026-05-28', OPUS),
    rowFn('2026-05-29', OPUS), rowFn('2026-05-30', OPUS),
    rowFn('2026-05-31', TMPL), rowFn('2026-06-01', TMPL),
  ]
  const v = assessBriefDelivery(summarize([...mk(clientRow), ...mk(agencyRow)]))
  assert.equal(v.status, 'degraded')
  assert.equal(v.streak, 2)
  assert.equal(v.audience, 'agency')      // equal status+streak+coverage → agency wins, deterministically
  assert.equal(v.streams.client.status, 'degraded')
})

// ── opts re-band the alarm without touching the figures ─────────────────────────
test('opts.stallStreak=2 promotes a streak-2 history to stalled', () => {
  const rows = [
    agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', TMPL),
    clientRow('2026-06-01', OPUS),
  ]
  const dflt = assessBriefDelivery(summarize(rows))
  assert.equal(dflt.status, 'degraded')
  const tight = assessBriefDelivery(summarize(rows), { stallStreak: 2 })
  assert.equal(tight.status, 'stalled')
  assert.equal(tight.severity, 'critical')
})

test('opts can loosen the bands back to ok', () => {
  const rows = [
    // streak 2, coverage 4/6 ≈ 0.667
    agencyRow('2026-05-27', OPUS), agencyRow('2026-05-28', OPUS),
    agencyRow('2026-05-29', OPUS), agencyRow('2026-05-30', OPUS),
    agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', TMPL),
    clientRow('2026-06-01', OPUS),
  ]
  assert.equal(assessBriefDelivery(summarize(rows)).status, 'degraded')
  // raise the streak band past 2 and the coverage floor below 0.667 → nothing trips
  const loose = assessBriefDelivery(summarize(rows), { degradeStreak: 5, coverageFloor: 0.1 })
  assert.equal(loose.status, 'ok')
  assert.equal(loose.alert, false)
})

// ── Defensive: junk in never throws, always a clean ok verdict ──────────────────
test('non-summary / missing-bucket inputs yield a clean ok verdict, never throw', () => {
  for (const bad of [null, undefined, [], {}, { by_audience: {} }, 'nope', 42]) {
    const v = assessBriefDelivery(bad)
    assert.equal(v.status, 'ok')
    assert.equal(v.alert, false)
    assert.equal(v.reason, 'no-data')
    assert.ok(v.streams && v.streams.client && v.streams.agency)
    assert.equal(narrateBriefDelivery(v, { audience: 'agency' }), '')
  }
})

test('narrate is silent on an ok verdict and for a hand-built client call', () => {
  const ok = assessBriefDelivery(summarize([clientRow('2026-06-01', OPUS)]))
  assert.equal(narrateBriefDelivery(ok, { audience: 'agency' }), '')
  // a raw stalled-shaped signal is still '' for a client audience
  const stalledish = { alert: true, status: 'stalled', audience: 'agency', action: 'x',
    streams: { client: { status: 'ok' }, agency: { status: 'stalled', audience: 'agency', reason: 'stalled-streak', streak: 3, coverage: null, narratable: 5, latest_as_of: '2026-06-01' } } }
  assert.equal(narrateBriefDelivery(stalledish, { audience: 'client' }), '')
  assert.match(narrateBriefDelivery(stalledish, { audience: 'agency' }), /grounded/i)
})

// ── Purity: no mutation, deterministic on repeat ────────────────────────────────
test('pure — does not mutate the summary and is deep-equal on repeat', () => {
  const rows = [
    agencyRow('2026-05-30', TMPL), agencyRow('2026-05-31', TMPL), agencyRow('2026-06-01', TMPL),
    clientRow('2026-06-01', OPUS),
  ]
  const summary = summarize(rows)
  const snapshot = JSON.parse(JSON.stringify(summary))
  const a = assessBriefDelivery(summary)
  const b = assessBriefDelivery(summary)
  assert.deepEqual(a, b)
  assert.deepEqual(summary, snapshot)   // input untouched
})
