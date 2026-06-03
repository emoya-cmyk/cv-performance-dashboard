// ============================================================
// test/channelEfficiency.test.js — "where should the next ad dollar go?"
//
// lib/channelEfficiency.js compares a client's channels against EACH OTHER on realized
// cost-per-outcome (cpo = spend ÷ outcomes), reads a returns TREND from the spend↔cpo
// correlation (saturating / easing / flat) but only when spend actually varied, and then
// proposes the single most defensible budget shift — gated by a minimum efficiency gap,
// adequate sample on both channels, and minimum confidence, else it abstains to 'hold' or
// 'insufficient'. These tests hand-trace the cpo, the trend, and the per-channel status;
// pin the three insufficiency gates and the two flat paths (no cpo variance vs. spend too
// flat to infer a curve); prove the ranker picks the right from→to and respects every gate;
// and prove the leak posture — narration is '' for a client UNCONDITIONALLY and '' whenever
// there is nothing to act on, identifier-free for the agency. Pure: same numbers → same
// verdict, inputs never mutated (asserted under Object.freeze). No DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  assessChannelEfficiency, rankReallocation, analyzeReallocation,
  narrateReallocation, reallocationRails, pearson, coeffVar,
  MIN_WINDOWS, TARGET_WINDOWS, MIN_SPEND, MIN_OUTCOMES, MIN_SPEND_CV,
  TREND_THRESH, MIN_GAP, MIN_CONFIDENCE, TEST_FRACTION, CHANNEL_LABEL,
} = require('../lib/channelEfficiency')

// build a channel from [spend, outcomes] pairs (oldest→newest)
const ch = (channel, pairs) => ({ channel, points: pairs.map(([spend, outcomes]) => ({ spend, outcomes })) })

const byChannel = (verdicts) => Object.fromEntries(verdicts.map(v => [v.channel, v]))
const round2 = (x) => Math.round(x * 100) / 100

// internal vocabulary that must NEVER surface in agency narration (plain budget language only)
const FORBIDDEN_NARRATION = /saturat|easing|\bcpo\b|pull_candidate|push_candidate|reallocat|gap_pct|hypothesis|insufficient|steady|google_ads/i

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) }
  return o
}

// ---- pearson / coeffVar unit guards ------------------------------------------------

test('pearson: perfect +1, perfect −1, flat → null', () => {
  assert.equal(round2(pearson([1, 2, 3, 4], [2, 4, 6, 8])), 1)      // perfectly positive
  assert.equal(round2(pearson([1, 2, 3, 4], [8, 6, 4, 2])), -1)     // perfectly negative
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null)                 // y flat → no correlation
  assert.equal(pearson([5, 5, 5], [1, 2, 3]), null)                 // x flat → no correlation
  assert.equal(pearson([1], [1]), null)                             // n < 2
})

test('coeffVar: flat series → 0, varied series → positive', () => {
  assert.equal(coeffVar([100, 100, 100]), 0)
  assert.equal(round2(coeffVar([100, 200, 300, 400])), 0.45)        // std 111.8 / mean 250
  assert.ok(coeffVar([10, 90]) > 0)
})

// ---- the three insufficiency gates: a quiet, un-rankable no-op ----------------------

test('assess: fewer than MIN_WINDOWS valid windows → insufficient', () => {
  const [v] = assessChannelEfficiency([ch('google_ads', [[200, 10], [200, 10]])])  // 2 < 3
  assert.equal(v.status, 'insufficient')
  assert.equal(v.trend, 'insufficient')
  assert.equal(v.confidence, 0)
  assert.equal(v.windows, 2)
})

test('assess: too little total spend → insufficient (immaterial channel)', () => {
  const [v] = assessChannelEfficiency([ch('meta', [[10, 1], [10, 1], [10, 1]])])   // $30 < $100
  assert.equal(v.status, 'insufficient')
  assert.equal(v.spend, 30)
})

test('assess: too few total outcomes (via opts floor) → insufficient', () => {
  const [v] = assessChannelEfficiency([ch('lsa', [[200, 2], [200, 2], [200, 2]])], { minOutcomes: 10 })
  assert.equal(v.status, 'insufficient')   // 6 outcomes < 10
})

test('assess: a window with zero spend or zero outcomes is ignored, never counted', () => {
  // only 3 of 5 windows are valid (cpo-defined); the other two are silently dropped
  const [v] = assessChannelEfficiency([ch('google_ads',
    [[100, 10], [0, 5], [200, 20], [150, 0], [300, 30]])])
  assert.equal(v.windows, 3)
  assert.equal(v.spend, 600)               // 100 + 200 + 300
  assert.equal(v.outcomes, 60)
})

// ---- trend detection, hand-traced --------------------------------------------------

test('assess: cpo climbing as spend climbs → saturating / pull_candidate', () => {
  const [v] = assessChannelEfficiency([ch('google_ads',
    [[100, 10], [200, 16], [300, 20], [400, 24]])])  // cpo 10, 12.5, 15, 16.67 — rising
  assert.equal(v.trend, 'saturating')
  assert.equal(v.status, 'pull_candidate')
  assert.equal(v.cpo, 14.29)               // blended 1000 / 70
  assert.equal(v.windows, 4)
  assert.equal(v.confidence, 0.67)         // 4 / 6
  assert.equal(v.spend_cv, 0.45)
  assert.ok(v.trend_r > 0.9, `expected strong positive r, got ${v.trend_r}`)
  assert.equal(v.avg_spend, 250)
})

test('assess: cpo falling as spend climbs → easing / push_candidate', () => {
  const [v] = assessChannelEfficiency([ch('meta',
    [[100, 5], [200, 13], [300, 25], [400, 40]])])   // cpo 20, 15.4, 12, 10 — falling
  assert.equal(v.trend, 'easing')
  assert.equal(v.status, 'push_candidate')
  assert.ok(v.trend_r < -0.9, `expected strong negative r, got ${v.trend_r}`)
})

test('assess: spend varies but cpo is constant → flat / steady (cpo-variance guard)', () => {
  const [v] = assessChannelEfficiency([ch('lsa', [[100, 10], [200, 20], [300, 30]])])  // cpo 10 flat
  assert.equal(v.trend, 'flat')
  assert.equal(v.status, 'steady')
  assert.equal(v.trend_r, null)            // no cpo variance → correlation undefined, not faked
  assert.equal(v.cpo, 10)
})

test('assess: spend too flat to infer a curve → flat, trend withheld (CV gate)', () => {
  // spend barely moves (cv ≈ 0.008 < 0.10) even though cpo swings — we must NOT claim a trend
  const [v] = assessChannelEfficiency([ch('google_ads', [[100, 10], [101, 5], [99, 20]])])
  assert.equal(v.trend, 'flat')
  assert.equal(v.trend_r, null)            // gated by CV — no returns slope asserted from flat spend
  assert.equal(v.status, 'steady')
})

// ---- share-of-spend + ordering -----------------------------------------------------

test('assess: share_of_spend is measured-spend share across assessable channels; order preserved', () => {
  const vs = assessChannelEfficiency([
    ch('google_ads', [[100, 10], [200, 20], [300, 30]]),   // spend 600
    ch('meta',       [[600, 30], [600, 30], [600, 30]]),   // spend 1800
  ])
  assert.deepEqual(vs.map(v => v.channel), ['google_ads', 'meta'])  // input order intact
  const by = byChannel(vs)
  assert.equal(by.google_ads.share_of_spend, 0.25)         // 600 / 2400
  assert.equal(by.meta.share_of_spend, 0.75)               // 1800 / 2400
})

// ---- ranking: the single best move, every gate respected ---------------------------

// a saturating, expensive source vs an easing, cheap target → a strong, defensible shift
const STRONG_PAIR = [
  ch('google_ads', [[100, 8], [200, 12], [300, 15], [400, 16]]),   // cpo rising, blended 19.61
  ch('meta',       [[100, 8], [200, 18], [300, 30], [400, 44]]),   // cpo falling, blended 10.0
]

test('rank: saturating-expensive → easing-cheap is a strong reallocation', () => {
  const { proposal } = analyzeReallocation(STRONG_PAIR)
  assert.equal(proposal.status, 'reallocate')
  assert.equal(proposal.from, 'google_ads')
  assert.equal(proposal.to, 'meta')
  assert.equal(proposal.from_cpo, 19.61)
  assert.equal(proposal.to_cpo, 10)
  assert.equal(proposal.gap_pct, 0.49)                 // (19.61 − 10) / 19.61
  assert.equal(proposal.saved_per_outcome, 9.61)
  assert.equal(proposal.strength, 'strong')            // both trends corroborate the level gap
  assert.equal(proposal.suggested_shift, 25)           // 10% of avg source spend (250)
  assert.equal(proposal.test_fraction, 0.1)
  assert.equal(proposal.hypothesis, true)              // forward claim flagged, never asserted as fact
  assert.ok(/holds its current cost per outcome/.test(proposal.assumes))
})

test('rank: efficiency gap below threshold → hold (no defensible shift)', () => {
  const proposal = rankReallocation(assessChannelEfficiency([
    ch('google_ads', [[100, 10], [200, 20], [300, 30]]),   // cpo 10 flat
    ch('meta',       [[90, 10], [180, 20], [270, 30]]),    // cpo 9 flat → gap only 10%
  ]))
  assert.equal(proposal.status, 'hold')
  assert.equal(proposal.from, 'google_ads')
  assert.equal(proposal.to, 'meta')
  assert.ok(/comparable cost/.test(proposal.reason))
})

test('rank: gap exists but confidence too low → hold (sample-confidence gate)', () => {
  const proposal = rankReallocation(assessChannelEfficiency(STRONG_PAIR), { minConfidence: 0.9 })
  assert.equal(proposal.status, 'hold')
  assert.ok(/confidence/.test(proposal.reason))
})

test('rank: fewer than two assessable channels → insufficient', () => {
  const proposal = rankReallocation(assessChannelEfficiency([
    ch('google_ads', [[100, 8], [200, 12], [300, 15], [400, 16]]),  // assessable
    ch('meta',       [[10, 1], [10, 1]]),                           // insufficient
  ]))
  assert.equal(proposal.status, 'insufficient')
  assert.equal(proposal.to, null)
})

// ---- narration: leak posture + plain language --------------------------------------

test('narrate: a client NEVER hears a reallocation — empty string unconditionally', () => {
  const { proposal } = analyzeReallocation(STRONG_PAIR)
  assert.equal(proposal.status, 'reallocate')                       // there IS a move…
  assert.equal(narrateReallocation(proposal, { audience: 'client' }), '')  // …but the client is silent
})

test('narrate: hold / insufficient / null narrate to empty string even for the agency', () => {
  assert.equal(narrateReallocation({ status: 'hold' }), '')
  assert.equal(narrateReallocation({ status: 'insufficient' }), '')
  assert.equal(narrateReallocation(null), '')
  assert.equal(narrateReallocation(undefined, { audience: 'agency' }), '')
})

test('narrate: agency hears a strong move in plain budget language, identifier-free', () => {
  const { proposal } = analyzeReallocation(STRONG_PAIR)
  const s = narrateReallocation(proposal, { audience: 'agency' })
  assert.ok(s.includes('Google Ads') && s.includes('Facebook/Meta'))  // labels, not raw keys
  assert.ok(/\d+%/.test(s))                                           // a concrete test-shift size
  assert.ok(!FORBIDDEN_NARRATION.test(s), `leaked internal vocab: ${s}`)
})

test('narrate: a level-only gap narrates the moderate/tentative wording, identifier-free', () => {
  // both channels flat (steady) but a real 50% level gap → tentative move, "lower cost" wording
  const proposal = rankReallocation(assessChannelEfficiency([
    ch('google_ads', [[100, 5], [200, 10], [300, 15]]),    // cpo 20 flat
    ch('meta',       [[100, 10], [200, 20], [300, 30]]),   // cpo 10 flat
  ]))
  assert.equal(proposal.status, 'reallocate')
  assert.equal(proposal.strength, 'tentative')
  const s = narrateReallocation(proposal, { audience: 'agency' })
  assert.ok(/lower cost/.test(s))
  assert.ok(/50%/.test(s))                                 // the current-fact gap, stated plainly
  assert.ok(!FORBIDDEN_NARRATION.test(s), `leaked internal vocab: ${s}`)
})

test('narrate: a custom outcome label flows into the sentence', () => {
  const { proposal } = analyzeReallocation(STRONG_PAIR)
  const s = narrateReallocation(proposal, { audience: 'agency', outcomeLabel: 'booked job' })
  assert.ok(/booked job/.test(s))
})

// ---- rails ------------------------------------------------------------------------

test('reallocationRails: actionable only when there is a move; null otherwise', () => {
  const { proposal } = analyzeReallocation(STRONG_PAIR)
  const rails = reallocationRails(proposal)
  assert.deepEqual(rails, {
    from: 'google_ads', to: 'meta', from_cpo: 19.61, to_cpo: 10,
    suggested_shift: 25, test_fraction: 0.1, strength: 'strong',
  })
  assert.equal(reallocationRails({ status: 'hold' }), null)
  assert.equal(reallocationRails(null), null)
})

// ---- purity + robustness -----------------------------------------------------------

test('assess/analyze: inputs are never mutated (asserted under Object.freeze)', () => {
  const frozen = deepFreeze([
    ch('google_ads', [[100, 8], [200, 12], [300, 15], [400, 16]]),
    ch('meta',       [[100, 8], [200, 18], [300, 30], [400, 44]]),
  ])
  const out = analyzeReallocation(frozen)               // must not throw on frozen inputs
  assert.equal(out.channels.length, 2)
  assert.equal(out.proposal.status, 'reallocate')
  assert.equal(frozen.length, 2)                        // original untouched
})

test('assess/rank/narrate/rails: garbage in → quiet no-op out, never a throw', () => {
  for (const bad of [null, undefined, {}, 'nope', 42, [{}], [{ channel: 'x', points: 'no' }],
                     [{ channel: 'y', points: [{ spend: 'a', outcomes: null }, { spend: Infinity, outcomes: -1 }] }]]) {
    const vs = assessChannelEfficiency(bad)
    assert.ok(Array.isArray(vs))
    const p = rankReallocation(vs)
    assert.ok(p && typeof p.status === 'string')
    assert.equal(narrateReallocation(p), '')
    assert.equal(reallocationRails(p), null)
  }
  // rank on raw garbage too
  assert.equal(rankReallocation(null).status, 'insufficient')
  assert.equal(rankReallocation('x').status, 'insufficient')
})

test('exported constants carry the documented defaults', () => {
  assert.equal(MIN_WINDOWS, 3)
  assert.equal(TARGET_WINDOWS, 6)
  assert.equal(MIN_SPEND, 100)
  assert.equal(MIN_OUTCOMES, 3)
  assert.equal(MIN_SPEND_CV, 0.10)
  assert.equal(TREND_THRESH, 0.40)
  assert.equal(MIN_GAP, 0.15)
  assert.equal(MIN_CONFIDENCE, 0.40)
  assert.equal(TEST_FRACTION, 0.10)
  assert.equal(CHANNEL_LABEL.google_ads, 'Google Ads')
})
