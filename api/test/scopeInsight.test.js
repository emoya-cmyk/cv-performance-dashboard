'use strict'

// ============================================================================
// test/scopeInsight.test.js — the C3 pure narrator (intel-v13).
//
// scopeInsight.generateScopeInsight NARRATES an already-verified scoped query
// result (current totals, optional prior-period totals, optional by-label
// breakdown) into finding-like cards + window-correct recommendations. It is
// PURE: no DB, no clock, no HTTP, no model. Every figure it prints must trace
// back to an input via formatValue — it never computes a metric, only narrates
// one. These tests pin that contract down hard:
//   · totality        — junk/empty inputs never throw; unknown metrics dropped
//   · severity bands   — adverse ≥30 crit / ≥15 warn / ≥5 info / <5 steady;
//                        favorable NEVER escalates past info (good news ≠ alarm)
//   · polarity         — spend↑ adverse·lever, revenue↑ favorable·keep,
//                        cpl↓ favorable, roas↓ adverse (via isAdverse + improved)
//   · grounded numbers — title/detail/recommendation figures == formatValue(input)
//   · no-compare       — previous absent → info card, no recommendation, prompt
//   · prev-0           — pct_change null → delta-display fallback, never "null%"
//   · limit + ordering — clamp 1..7 (default 6); importance survives truncation
//   · driver clause    — echoes ONLY caller-supplied row.label (leak-safe)
//   · headlines        — no-data / no-compare / all-steady / mixed shapes
// ============================================================================

const test   = require('node:test')
const assert = require('node:assert/strict')

const {
  generateScopeInsight,
  severityFor, topDriverFor, buildHeadline,
  MOVE_MIN_PCT, WARN_PCT, CRIT_PCT, DEFAULT_LIMIT, MAX_LIMIT,
} = require('../lib/scopeInsight')
const { METRICS, formatValue } = require('../lib/ask')

const MINUS = '−' // U+2212, the sign signedDelta() prints for negatives

const byMetric = (res, m) => res.findings.find(f => f.metric === m)

// ── constants are the documented bands ───────────────────────────────────────
test('bands and limits are the documented constants', () => {
  assert.equal(MOVE_MIN_PCT, 5)
  assert.equal(WARN_PCT, 15)
  assert.equal(CRIT_PCT, 30)
  assert.equal(DEFAULT_LIMIT, 6)
  assert.equal(MAX_LIMIT, 7)
})

// ── totality: junk never throws ───────────────────────────────────────────────
test('totality — undefined / empty / junk inputs never throw and degrade cleanly', () => {
  for (const bad of [undefined, null, {}, 42, 'nope', [], true]) {
    const res = generateScopeInsight(bad)
    assert.equal(typeof res.headline, 'string')
    assert.ok(Array.isArray(res.findings))
    assert.equal(res.meta.generated_from, 'scope-narration')
  }
  // fully garbage option bag — wrong types in every slot
  const res = generateScopeInsight({
    current: 'string', previous: 99, drivers: 'x', metrics: 'y', limit: {},
    windowLabel: {}, compareLabel: [],
  })
  assert.equal(res.findings.length, 0)
  assert.equal(res.meta.metrics_considered, 0)
})

test('totality — non-numeric and unknown metric values are dropped', () => {
  const res = generateScopeInsight({
    current: { revenue: 'NaN', leads: null, jobs: undefined, bogus: 100, roas: Infinity },
  })
  assert.equal(res.meta.metrics_considered, 0)
  assert.equal(res.findings.length, 0)
  assert.match(res.headline, /No data in scope/)
})

test('opts.metrics is de-duped and filtered to known metrics', () => {
  const res = generateScopeInsight({
    current:  { revenue: 100, spend: 50 },
    previous: { revenue: 100, spend: 50 },
    metrics:  ['revenue', 'revenue', 'bogus', 'spend'],
  })
  // both held steady, but both were CONSIDERED exactly once
  assert.equal(res.meta.metrics_considered, 2)
  assert.equal(res.meta.steady, 2)
  assert.equal(res.findings.length, 0)
})

// ── severity bands on an ADVERSE metric (spend↑ is bad) ───────────────────────
test('adverse severity bands — 30%+→critical, 15-30%→warning, 5-15%→info, <5%→steady', () => {
  const at = (cur) => byMetric(generateScopeInsight({ current: { spend: cur }, previous: { spend: 100 } }), 'spend')

  assert.equal(at(130).severity, 'critical') // +30% exactly → critical
  assert.equal(at(140).severity, 'critical') // +40%
  assert.equal(at(120).severity, 'warning')  // +20%
  assert.equal(at(115).severity, 'warning')  // +15% exactly → warning
  assert.equal(at(110).severity, 'info')     // +10% adverse but small
  assert.equal(at(105).severity, 'info')     // +5% exactly → still a card

  // < MOVE_MIN_PCT → no card at all, counted as steady
  const small = generateScopeInsight({ current: { spend: 104 }, previous: { spend: 100 } })
  assert.equal(byMetric(small, 'spend'), undefined)
  assert.equal(small.meta.steady, 1)
  assert.equal(small.meta.movers, 0)
})

test('favorable moves NEVER escalate past info — good news must not alarm', () => {
  const res = generateScopeInsight({ current: { revenue: 180000 }, previous: { revenue: 100000 } }) // +80%
  const f = byMetric(res, 'revenue')
  assert.equal(f.severity, 'info')
  assert.equal(f.improved, true)
  assert.equal(f.recommendation.urgency, 'monitor')
})

// ── polarity matrix ───────────────────────────────────────────────────────────
test('polarity — spend↑ adverse+lever, revenue↑ favorable+keep, cpl↓ favorable, roas↓ adverse', () => {
  // spend ↑ → adverse → lever play, plan/act urgency
  const spend = byMetric(generateScopeInsight({ current: { spend: 130 }, previous: { spend: 100 } }), 'spend')
  assert.equal(spend.severity, 'critical')
  assert.match(spend.recommendation.text, /runaway campaign/) // LEVER.spend
  assert.equal(spend.improved, null)                          // spend has no polarity

  // revenue ↑ → favorable → keep play
  const rev = byMetric(generateScopeInsight({ current: { revenue: 140 }, previous: { revenue: 100 } }), 'revenue')
  assert.equal(rev.improved, true)
  assert.match(rev.recommendation.text, /hold the current plan/) // KEEP.revenue

  // cpl ↓ → favorable (lower cost per lead is good)
  const cpl = byMetric(generateScopeInsight({ current: { cpl: 80 }, previous: { cpl: 100 } }), 'cpl')
  assert.equal(cpl.direction, 'down')
  assert.equal(cpl.improved, true)
  assert.equal(cpl.severity, 'info')
  assert.match(cpl.recommendation.text, /lock in/) // KEEP.cpl

  // roas ↓ → adverse (lower return is bad)
  const roas = byMetric(generateScopeInsight({ current: { roas: 2 }, previous: { roas: 4 } }), 'roas')
  assert.equal(roas.direction, 'down')
  assert.equal(roas.improved, false)
  assert.equal(roas.severity, 'critical') // −50%
  assert.match(roas.recommendation.text, /pause the weakest/) // LEVER.roas
})

// ── grounded numbers: every printed figure traces to an input ─────────────────
test('grounded — title / detail / recommendation / evidence all trace to inputs', () => {
  const res = generateScopeInsight({ current: { revenue: 150000 }, previous: { revenue: 100000 } })
  const f = byMetric(res, 'revenue')

  assert.equal(f.title, 'Revenue up 50% to $150,000')
  assert.equal(f.detail, 'Revenue rose 50% from $100,000 vs the prior period to $150,000.')
  assert.equal(f.recommendation.text, 'Revenue is up 50% vs the prior period — hold the current plan and consider raising the goal.')
  assert.equal(f.recommendation.urgency, 'monitor')

  assert.deepEqual(f.evidence, { current: 150000, previous: 100000, delta: 50000, pct_change: 50 })

  // the printed strings are exactly what formatValue would produce
  assert.ok(f.title.includes(formatValue(150000, METRICS.revenue)))
  assert.ok(f.detail.includes(formatValue(100000, METRICS.revenue)))
})

test('grounded — ratio/percent/count units format correctly in narration', () => {
  // roas (ratio, dp2): 3.2 → "3.2×"
  const roas = byMetric(generateScopeInsight({ current: { roas: 3.2 }, previous: { roas: 4 } }), 'roas')
  assert.ok(roas.detail.includes('3.2×'))
  assert.ok(roas.detail.includes('4×'))

  // close_rate (percent, dp1): 33 → "33%"
  const cr = byMetric(generateScopeInsight({ current: { close_rate: 33 }, previous: { close_rate: 50 } }), 'close_rate')
  assert.ok(cr.detail.includes('33%'))
  assert.ok(cr.detail.includes('50%'))

  // leads (count): thousands separator
  const leads = byMetric(generateScopeInsight({ current: { leads: 1234 }, previous: { leads: 1000 } }), 'leads')
  assert.ok(leads.title.includes('1,234'))
})

// ── no-compare path ───────────────────────────────────────────────────────────
test('no-compare — info card, no recommendation, and a "add a comparison" headline', () => {
  const res = generateScopeInsight({ current: { revenue: 50000 } })
  const f = byMetric(res, 'revenue')
  assert.equal(f.severity, 'info')
  assert.equal(f.recommendation, null)
  assert.equal(f.direction, 'up')
  assert.equal(f.title, 'Revenue: $50,000')
  assert.match(f.detail, /No comparable prior-period figure in scope\./)
  assert.equal(res.scope.hasCompare, false)
  assert.equal(res.headline, 'Showing this window. Add a comparison to see what changed and what to do about it.')
  assert.equal(res.meta.with_compare, 0)
})

test('no-compare — a zero current reads as flat, not up', () => {
  const f = byMetric(generateScopeInsight({ current: { revenue: 0 } }), 'revenue')
  assert.equal(f.direction, 'flat')
  assert.equal(f.title, 'Revenue: $0')
})

// ── prev-0: pct_change is null → delta fallback, never "null%" ────────────────
test('prev-0 — null pct_change degrades to a delta display and a warning, never "null%"', () => {
  const res = generateScopeInsight({ current: { spend: 100 }, previous: { spend: 0 } })
  const f = byMetric(res, 'spend')
  assert.equal(f.evidence.pct_change, null)
  assert.equal(f.evidence.delta, 100)
  assert.equal(f.severity, 'warning')              // adverse + unknown magnitude → warning, not critical
  assert.equal(f.title, 'Ad spend up to $100 (from $0)')
  assert.equal(f.detail, 'Ad spend rose $100 from $0 vs the prior period to $100.')
  assert.equal(f.recommendation.urgency, 'plan')
  // the cardinal sin guard: no stray "null" and no "%" anywhere a pct would have gone
  for (const s of [f.title, f.detail, f.recommendation.text]) {
    assert.ok(!s.includes('null'), `must not print "null": ${s}`)
    assert.ok(!s.includes('%'), `no percent when pct_change is null: ${s}`)
  }
})

// ── limit clamp + ordering survives truncation ────────────────────────────────
test('limit clamps to 1..7 and defaults to 6', () => {
  const cur  = { revenue: 200, leads: 200, jobs: 200, spend: 200, roas: 4, cpl: 50, close_rate: 60 }
  const prev = { revenue: 100, leads: 100, jobs: 100, spend: 100, roas: 2, cpl: 100, close_rate: 30 }
  const shown = (limit) => generateScopeInsight({ current: cur, previous: prev, limit }).meta.shown

  assert.equal(shown(undefined), 6)   // default
  assert.equal(shown(99), 7)          // clamp to MAX (all 7 metrics moved)
  assert.equal(shown(0), 1)           // clamp to MIN
  assert.equal(shown(-5), 1)
  assert.equal(shown('3'), 3)         // numeric string parses
  assert.equal(shown(2.7), 2)         // float floors via parseInt
  assert.equal(shown({}), 6)          // unparseable → default
})

test('ordering — truncation keeps the most important findings (severity, then magnitude)', () => {
  const res = generateScopeInsight({
    current:  { spend: 140, roas: 1.3, leads: 75,  cpl: 120, revenue: 150, jobs: 108, close_rate: 27 },
    previous: { spend: 100, roas: 2,   leads: 100, cpl: 100, revenue: 100, jobs: 100, close_rate: 30 },
    limit: 3,
  })
  // movers, ranked: spend +40% crit · roas −35% crit · leads −25% warn · cpl +20% warn
  //                 · close_rate −10% info(adv) · revenue +50% info(fav) · jobs +8% info(fav)
  // top-3 by (severity, |pct|): spend(crit40) > roas(crit35) > leads(warn25)
  assert.equal(res.meta.shown, 3)
  assert.deepEqual(res.findings.map(f => f.metric), ['spend', 'roas', 'leads'])
  assert.equal(res.findings[0].severity, 'critical')
  assert.equal(res.findings[1].severity, 'critical')
  assert.equal(res.findings[2].severity, 'warning')
  // movers counts ALL qualifying moves, shown is the truncated slice
  assert.ok(res.meta.movers >= 6)
  assert.equal(res.meta.shown, 3)
})

// ── driver clause: echoes ONLY caller-supplied labels (leak-safe) ─────────────
test('driver — attaches the top contributor by |delta| and echoes only its label', () => {
  const res = generateScopeInsight({
    current:  { revenue: 150000 },
    previous: { revenue: 100000 },
    drivers: { rows: [
      { label: 'Google Ads', current: { revenue: 90000 }, previous: { revenue: 50000 } }, // +40k
      { label: 'Meta',       current: { revenue: 60000 }, previous: { revenue: 50000 } }, // +10k
    ] },
  })
  const f = byMetric(res, 'revenue')
  assert.equal(f.driver.label, 'Google Ads')
  assert.equal(f.driver.display, '+$40,000')
  assert.ok(f.detail.includes('led by Google Ads (+$40,000)'))
})

test('driver — negative top contributor prints a real minus sign', () => {
  const res = generateScopeInsight({
    current:  { leads: 70 },
    previous: { leads: 115 },
    drivers: { rows: [
      { label: 'Campaign A', current: { leads: 20 }, previous: { leads: 60 } }, // −40
      { label: 'Campaign B', current: { leads: 50 }, previous: { leads: 55 } }, // −5
    ] },
  })
  const f = byMetric(res, 'leads')
  assert.equal(f.driver.label, 'Campaign A')
  assert.equal(f.driver.display, `${MINUS}40`)
  assert.ok(f.detail.includes(`led by Campaign A (${MINUS}40)`))
})

test('driver — null-label rows are skipped; absent drivers add no clause', () => {
  const withNull = generateScopeInsight({
    current:  { revenue: 150000 },
    previous: { revenue: 100000 },
    drivers: { rows: [
      { label: null,   current: { revenue: 99999 }, previous: { revenue: 0 } }, // ignored despite huge delta
      { label: 'Real', current: { revenue: 60000 }, previous: { revenue: 50000 } },
    ] },
  })
  assert.equal(byMetric(withNull, 'revenue').driver.label, 'Real')

  const noDrivers = byMetric(generateScopeInsight({ current: { revenue: 150000 }, previous: { revenue: 100000 } }), 'revenue')
  assert.equal(noDrivers.driver, null)
  assert.ok(!noDrivers.detail.includes('led by'))
})

// ── headline shapes ───────────────────────────────────────────────────────────
test('headline — no data', () => {
  assert.equal(generateScopeInsight({}).headline, 'No data in scope for this window.')
})

test('headline — all steady', () => {
  const res = generateScopeInsight({ current: { revenue: 100, leads: 50 }, previous: { revenue: 100, leads: 50 } })
  assert.equal(res.headline, 'For this window, all tracked metrics held steady vs the prior period.')
})

test('headline — mixed adverse + favorable leads with both, no steady tail', () => {
  const res = generateScopeInsight({ current: { spend: 130, revenue: 140 }, previous: { spend: 100, revenue: 100 } })
  assert.equal(res.headline, 'For this window, ad spend up 30% and revenue up 40% vs the prior period.')
})

test('headline + detail honour a custom window and compare label', () => {
  const res = generateScopeInsight({
    current: { spend: 130 }, previous: { spend: 100 },
    windowLabel: 'Apr 1–30', compareLabel: 'vs Mar',
  })
  assert.ok(res.headline.startsWith('For Apr 1–30, '))
  assert.ok(res.headline.includes('vs Mar'))
  assert.ok(byMetric(res, 'spend').detail.includes('vs Mar'))
  assert.equal(res.scope.windowLabel, 'Apr 1–30')
  assert.equal(res.scope.compareLabel, 'vs Mar')
})

test('headline — steady movers add a parenthetical count', () => {
  // spend moves (critical); revenue + leads hold steady → "(2 held steady)"
  const res = generateScopeInsight({
    current:  { spend: 130, revenue: 100, leads: 50 },
    previous: { spend: 100, revenue: 100, leads: 50 },
  })
  assert.ok(res.headline.includes('(2 held steady)'), res.headline)
})

// ── meta bookkeeping ──────────────────────────────────────────────────────────
test('meta — considered / with_compare / movers / shown / steady are accurate', () => {
  const res = generateScopeInsight({
    current:  { revenue: 150, spend: 130, leads: 50 },        // revenue↑50% spend↑30% leads flat
    previous: { revenue: 100, spend: 100, leads: 50 },
  })
  assert.equal(res.meta.metrics_considered, 3)
  assert.equal(res.meta.with_compare, 3)
  assert.equal(res.meta.movers, 2)
  assert.equal(res.meta.shown, 2)
  assert.equal(res.meta.steady, 1)
})

// ── exported helpers (unit) ───────────────────────────────────────────────────
test('severityFor — favorable always info; adverse banded; null magnitude → warning', () => {
  assert.equal(severityFor(false, 99), 'info')
  assert.equal(severityFor(true, null), 'warning')
  assert.equal(severityFor(true, 4.9), 'info')
  assert.equal(severityFor(true, 5), 'info')
  assert.equal(severityFor(true, 15), 'warning')
  assert.equal(severityFor(true, 29.99), 'warning')
  assert.equal(severityFor(true, 30), 'critical')
})

test('topDriverFor — null/empty drivers return null; otherwise max |delta| wins', () => {
  assert.equal(topDriverFor('revenue', null, METRICS.revenue), null)
  assert.equal(topDriverFor('revenue', { rows: [] }, METRICS.revenue), null)
  const d = topDriverFor('revenue', { rows: [
    { label: 'A', current: { revenue: 90000 }, previous: { revenue: 50000 } },
    { label: 'B', current: { revenue: 70000 }, previous: { revenue: 65000 } },
  ] }, METRICS.revenue)
  assert.equal(d.label, 'A')
  assert.equal(d.delta, 40000)
  assert.equal(d.display, '+$40,000')
})

test('buildHeadline — degenerate inputs are safe', () => {
  assert.equal(
    buildHeadline({ kept: [], steady: 0, withData: 0, withCompare: 0, windowLabel: 'this window', compareLabel: null }),
    'No data in scope for this window.',
  )
  assert.match(
    buildHeadline({ kept: [], steady: 0, withData: 2, withCompare: 0, windowLabel: 'this window', compareLabel: null }),
    /Add a comparison/,
  )
})
