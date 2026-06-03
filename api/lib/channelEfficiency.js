'use strict'

// ============================================================
// lib/channelEfficiency.js — cross-channel budget-reallocation intelligence (PURE).
//
// Every layer that came before is DIAGNOSTIC: it tells you what a number did and whether to
// worry about it. None of them ever say the one thing an account lead actually has to decide
// at the start of the month — "given what each channel is really costing me per result, where
// should the next dollar go?" A client can be healthy, on-pace, and perfectly emphasised and
// STILL be quietly overspending on a channel whose cost-per-outcome is climbing while a cheaper
// channel sits starved. That money is lost silently, every month, and no diagnostic catches it
// because each channel looks fine against ITSELF. This module is the first PRESCRIPTIVE layer:
// it compares channels against EACH OTHER on realized cost-per-outcome and answers, "is there a
// defensible budget shift on the table right now, and if so, from where to where?"
//
// The model is deliberately the legible one: realized, observational cost-per-outcome.
//   cpo = spend / outcomes   (blended over the window — the actual dollars it took per result)
// A channel whose per-window cpo RISES as its spend rises is showing diminishing returns
// ('saturating' — a pull candidate); one whose cpo FALLS as spend rises has headroom
// ('easing' — a push candidate); flat or untellable is 'steady'. The trend is a plain Pearson
// correlation between window spend and window cpo, and it is only ever trusted when spend
// actually VARIED (a spend coefficient-of-variation gate) — you cannot infer a returns curve
// from a flat spend line, so we don't pretend to.
//
// HONESTY BY CONSTRUCTION — this is observational, not a controlled experiment, so it never
// promises a causal lift. The only number it states as fact is the CURRENT cost-per-outcome
// GAP between two channels (target X% cheaper per result than source, true today). Any forward
// claim is explicitly flagged `hypothesis:true` with an `assumes` clause ("the target holds its
// current efficiency as budget moves to it") and framed as a SMALL TEST shift, never a wholesale
// move. A proposal must clear three gates at once — a minimum efficiency gap, adequate sample on
// BOTH channels, and a minimum confidence — or the module abstains to a quiet 'hold' (enough data,
// no defensible move) or 'insufficient' (not enough channels/data). Abstaining is the default.
//
// AGENCY-grade as a single best proposal (the one move most worth testing across a client's
// channels). It is computed from ONE client's own channels and leaks nothing cross-tenant — but
// unlike pacing's per-client verdict it is NOT shown to clients: a "move money off Facebook"
// recommendation is an internal media-buying decision, not a client-facing scoreboard line, so
// narrateReallocation returns '' for a client audience UNCONDITIONALLY (matching the leak-proof
// posture of the brief tower, 19d–23d). The structured verdict rides no client pack.
//
// PURE: numbers in, verdict out. No DB, no clock, no network, no LLM, no mutation of inputs
// (matching pacing.js / trajectory.js / health.js). Fewer than two adequately-sampled channels,
// a gap below threshold, low confidence, or garbage → a quiet no-op verdict, never a throw.
// ============================================================

const MIN_WINDOWS    = 3     // a channel needs ≥ this many spend+outcome windows to be assessable
const TARGET_WINDOWS = 6     // windows at which sample-confidence saturates to 1.0
const MIN_SPEND      = 100   // below this total measured spend a channel is immaterial → insufficient
const MIN_OUTCOMES   = 3     // below this many total outcomes the cpo is too noisy → insufficient
const MIN_SPEND_CV   = 0.10  // spend must vary ≥10% (std/mean) before a returns TREND is inferred
const TREND_THRESH   = 0.40  // |Pearson r| of spend↔cpo at/above this names saturating vs easing
const MIN_GAP        = 0.15  // target must be ≥15% cheaper per outcome than source to propose a move
const MIN_CONFIDENCE = 0.40  // both channels must clear this sample-confidence to propose a move
const TEST_FRACTION  = 0.10  // a proposal suggests TESTING a shift of ~this share of source budget
const EPSILON        = 1e-9

// channel id → human label for agency narration (override via opts.labels). Internal channel
// keys mirror facts.js CHANNEL_ID; anything unknown narrates by its raw key, never crashes.
const CHANNEL_LABEL = {
  google_ads: 'Google Ads',
  meta:       'Facebook/Meta',
  lsa:        'Local Services Ads',
  gbp:        'Google Business Profile',
  ga4:        'Website',
  organic:    'Organic',
}

const clamp  = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)
const num    = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const nonneg = (n) => (n < 0 ? 0 : n)
const round0 = (x) => Math.round(x)
const round2 = (x) => Math.round(x * 100) / 100
const round3 = (x) => Math.round(x * 1000) / 1000

// Pearson correlation of two equal-length series; null when either has no variance (a flat
// line cannot correlate). Guards keep it from ever dividing by ~0.
function pearson(xs, ys) {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
  let mx = 0, my = 0
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i] }
  mx /= n; my /= n
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my
    cov += dx * dy; vx += dx * dx; vy += dy * dy
  }
  if (vx <= EPSILON || vy <= EPSILON) return null
  return clamp(cov / Math.sqrt(vx * vy), -1, 1)
}

// coefficient of variation (population std ÷ mean) of a strictly-positive series; 0 when flat.
function coeffVar(xs) {
  const n = xs.length
  if (n < 2) return 0
  let m = 0
  for (let i = 0; i < n; i++) m += xs[i]
  m /= n
  if (m <= EPSILON) return 0
  let v = 0
  for (let i = 0; i < n; i++) { const d = xs[i] - m; v += d * d }
  return Math.sqrt(v / n) / m
}

// A channel that can't be assessed (too few windows, too little spend, too few outcomes): a
// quiet verdict carrying whatever facts we have, so it renders as "not enough to judge" and is
// never eligible to be a reallocation source or target.
function insufficientVerdict(channel, spend, outcomes, windows) {
  const s = nonneg(round0(num(spend, 0)))
  const o = nonneg(round0(num(outcomes, 0)))
  return {
    channel: channel != null ? channel : null,
    spend: s, outcomes: o,
    cpo: o > 0 ? round2(s / o) : null,
    avg_spend: windows > 0 ? round0(s / windows) : null,
    windows: windows || 0,
    share_of_spend: null,
    trend: 'insufficient', trend_r: null, spend_cv: null,
    confidence: 0,
    status: 'insufficient',
    reason: 'not enough spend/outcome history to judge channel efficiency',
  }
}

// ── assess EACH channel's own cost-per-outcome and returns trend ───────────────────
// channels: [{ channel, points: [{ spend, outcomes }, ...] }]
//   channel : a stable key ('google_ads' | 'meta' | 'lsa' | ...) echoed back and used for labels
//   points  : per-window observations, oldest→newest; a window counts only when BOTH spend > 0
//             and outcomes > 0 (a cpo is undefined otherwise) — other windows are ignored, never
//             throw. `outcomes` is whatever countable result the caller attributes to the channel
//             (leads, booked jobs, calls); the module is outcome-agnostic.
// opts: { minWindows, minSpend, minOutcomes, minSpendCv, trendThresh, targetWindows } — all the
//   constants above are overridable (mainly for tests).
// Returns one verdict per input channel (input order preserved):
//   channel, spend, outcomes                  : totals over valid windows (non-negative, rounded)
//   cpo            : blended cost per outcome = spend / outcomes (2dp; LOWER is better)
//   avg_spend      : mean spend per valid window (rounded) — the base for a suggested test shift
//   windows        : count of valid windows used
//   share_of_spend : this channel's measured spend ÷ all channels' measured spend (2dp)
//   trend          : 'saturating' (cpo rises with spend) | 'easing' (cpo falls with spend) |
//                    'flat' (no reliable returns slope) | 'insufficient' (not assessable)
//   trend_r        : Pearson r of window spend ↔ window cpo (2dp), or null when not inferred
//   spend_cv       : coefficient of variation of window spend (2dp), or null when not assessable
//   confidence     : sample adequacy = min(windows / targetWindows, 1) (2dp)
//   status         : 'pull_candidate' (saturating) | 'push_candidate' (easing) |
//                    'steady' (flat) | 'insufficient'
//   reason         : one plain-English line
function assessChannelEfficiency(channels, opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {}
  const minWindows  = Math.max(2, Math.trunc(num(opts.minWindows, MIN_WINDOWS)))
  const minSpend    = nonneg(num(opts.minSpend, MIN_SPEND))
  const minOutcomes = nonneg(num(opts.minOutcomes, MIN_OUTCOMES))
  const minSpendCv  = nonneg(num(opts.minSpendCv, MIN_SPEND_CV))
  const trendThresh = clamp(num(opts.trendThresh, TREND_THRESH), 0, 1)
  const targetWin   = Math.max(minWindows, Math.trunc(num(opts.targetWindows, TARGET_WINDOWS)))

  const list = Array.isArray(channels) ? channels : []
  const verdicts = []

  // First pass: per-channel cpo/trend; collect measured spend for the share denominator.
  let portfolioSpend = 0
  for (const c of list) {
    const channel = c && c.channel != null ? c.channel : null
    const points = c && Array.isArray(c.points) ? c.points : []
    const spends = [], cpos = []
    let totalSpend = 0, totalOutcomes = 0
    for (const p of points) {
      const sp = num(p && p.spend, NaN)
      const ou = num(p && p.outcomes, NaN)
      if (!Number.isFinite(sp) || !Number.isFinite(ou) || sp <= 0 || ou <= 0) continue
      spends.push(sp); cpos.push(sp / ou)
      totalSpend += sp; totalOutcomes += ou
    }
    const windows = spends.length

    if (windows < minWindows || totalSpend < minSpend || totalOutcomes < minOutcomes) {
      verdicts.push(insufficientVerdict(channel, totalSpend, totalOutcomes, windows))
      continue
    }

    portfolioSpend += totalSpend
    const cpo = totalSpend / totalOutcomes
    const cv  = coeffVar(spends)

    let trend = 'flat', trendR = null
    if (cv >= minSpendCv) {
      const r = pearson(spends, cpos)
      if (r != null) {
        trendR = r
        if (r >= trendThresh)       trend = 'saturating'
        else if (r <= -trendThresh) trend = 'easing'
        else                        trend = 'flat'
      }
    }

    const confidence = round2(clamp(windows / targetWin, 0, 1))
    const status =
      trend === 'saturating' ? 'pull_candidate' :
      trend === 'easing'     ? 'push_candidate' : 'steady'
    const reason =
      trend === 'saturating' ? 'cost per outcome rises as spend rises — diminishing returns' :
      trend === 'easing'     ? 'cost per outcome falls as spend rises — room to grow' :
      'cost per outcome shows no reliable returns slope'

    verdicts.push({
      channel,
      spend: round0(totalSpend), outcomes: round0(totalOutcomes),
      cpo: round2(cpo),
      avg_spend: round0(totalSpend / windows),
      windows,
      share_of_spend: null,       // filled in the second pass once the denominator is known
      trend, trend_r: trendR == null ? null : round2(trendR),
      spend_cv: round2(cv),
      confidence,
      status,
      reason,
    })
  }

  // Second pass: share-of-(measured)-spend across the assessable channels.
  if (portfolioSpend > EPSILON) {
    for (const v of verdicts) {
      if (v.status === 'insufficient') continue
      v.share_of_spend = round2(v.spend / portfolioSpend)
    }
  }
  return verdicts
}

// ── rank the single best reallocation move across a client's channels ──────────────
// verdicts: the array from assessChannelEfficiency (or the same shape). Picks the most
// defensible PULL source (a saturating channel, else the priciest assessable one) and PUSH
// target (an easing channel, else the cheapest assessable one), then GATES the pair:
//   • source must be strictly pricier than target, by ≥ minGap (relative cpo gap), AND
//   • both must clear minConfidence sample-confidence.
// opts: { minGap, minConfidence, testFraction } — overridable.
// Returns a stable-shaped object, ALWAYS:
//   status 'reallocate'  → a defensible test move:
//     { status, from, to, from_cpo, to_cpo, gap_pct, saved_per_outcome,
//       from_trend, to_trend, strength, suggested_shift, test_fraction,
//       confidence, hypothesis:true, assumes, reason }
//   status 'hold'        → ≥2 assessable channels but no move clears the gates (reason says why)
//   status 'insufficient'→ fewer than 2 assessable channels (nothing to compare)
// gap_pct and saved_per_outcome are CURRENT FACTS (today's cost gap). The move itself is the only
// forward claim and is flagged hypothesis:true. Pure: same verdicts → same proposal, inputs intact.
function rankReallocation(verdicts, opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {}
  const minGap        = clamp(num(opts.minGap, MIN_GAP), 0, 1)
  const minConfidence = clamp(num(opts.minConfidence, MIN_CONFIDENCE), 0, 1)
  const testFraction  = clamp(num(opts.testFraction, TEST_FRACTION), 0, 1)

  const list = Array.isArray(verdicts) ? verdicts : []
  const adequate = list.filter(v => v && v.status !== 'insufficient' && Number.isFinite(v.cpo))

  if (adequate.length < 2) {
    return { status: 'insufficient', from: null, to: null,
      reason: 'need at least two channels with adequate spend/outcome history to compare' }
  }

  // PULL source: prefer a channel showing diminishing returns; tie-break / fallback on highest cpo.
  const saturating = adequate.filter(v => v.trend === 'saturating')
  const from = (saturating.length ? saturating : adequate)
    .slice().sort((a, b) => b.cpo - a.cpo)[0]

  // PUSH target: prefer a channel with headroom; tie-break / fallback on lowest cpo. Never itself.
  const rest = adequate.filter(v => v.channel !== from.channel)
  const easing = rest.filter(v => v.trend === 'easing')
  const to = (easing.length ? easing : rest)
    .slice().sort((a, b) => a.cpo - b.cpo)[0]

  if (!to || to.channel === from.channel) {
    return { status: 'hold', from: from.channel, to: null,
      reason: 'only one channel has adequate history — no counterpart to shift toward' }
  }

  const gapPct = from.cpo > EPSILON ? (from.cpo - to.cpo) / from.cpo : 0
  const conf   = Math.min(from.confidence, to.confidence)

  if (from.cpo <= to.cpo || gapPct < minGap) {
    return { status: 'hold', from: from.channel, to: to.channel,
      gap_pct: round2(gapPct),
      reason: 'channels are within a comparable cost per outcome — no defensible shift' }
  }
  if (conf < minConfidence) {
    return { status: 'hold', from: from.channel, to: to.channel,
      gap_pct: round2(gapPct), confidence: round2(conf),
      reason: 'efficiency gap exists but sample confidence is too low to act on' }
  }

  // corroboration: do the two TRENDS agree with the level gap, or is it level-only?
  const corroborators = (from.trend === 'saturating' ? 1 : 0) + (to.trend === 'easing' ? 1 : 0)
  const strength = corroborators === 2 ? 'strong' : corroborators === 1 ? 'moderate' : 'tentative'
  const corrFactor = corroborators === 2 ? 1.0 : corroborators === 1 ? 0.85 : 0.7

  return {
    status: 'reallocate',
    from: from.channel, to: to.channel,
    from_cpo: from.cpo, to_cpo: to.cpo,
    gap_pct: round2(gapPct),
    saved_per_outcome: round2(from.cpo - to.cpo),   // current-fact $/outcome the target is cheaper
    from_trend: from.trend, to_trend: to.trend,
    strength,
    suggested_shift: round0(num(from.avg_spend, 0) * testFraction),   // a TEST slice of source budget
    test_fraction: round2(testFraction),
    confidence: round2(conf * corrFactor),
    hypothesis: true,
    assumes: 'the target channel holds its current cost per outcome as budget moves to it',
    reason: 'target turns out results at a materially lower cost per outcome than the source',
  }
}

// ── one-call convenience for the engine: assess then rank ──────────────────────────
function analyzeReallocation(channels, opts = {}) {
  const assessed = assessChannelEfficiency(channels, opts)
  return { channels: assessed, proposal: rankReallocation(assessed, opts) }
}

// ── plain-English for the AGENCY only; '' for clients UNCONDITIONALLY ──────────────
// A reallocation is an internal media-buying call, not a client scoreboard line — so a client
// audience always gets '' (leak-proof, like the brief tower). The agency hears a sentence ONLY
// when there is an actionable move (status 'reallocate'); 'hold'/'insufficient' narrate to ''
// because there is nothing to do. Identifier-free: no internal trend/status tokens, just budget
// language a media buyer reads at a glance.
function narrateReallocation(proposal, opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {}
  if (opts.audience === 'client') return ''                      // clients never hear this — ever
  if (!proposal || proposal.status !== 'reallocate') return ''   // nothing actionable → silent

  const labels = (opts.labels && typeof opts.labels === 'object') ? opts.labels : {}
  const label  = (k) => labels[k] || CHANNEL_LABEL[k] || String(k || 'a channel')
  const ol     = (opts.outcomeLabel ? String(opts.outcomeLabel) : 'lead').toLowerCase()
  const from   = label(proposal.from)
  const to     = label(proposal.to)
  const pct    = Math.round(num(proposal.test_fraction, TEST_FRACTION) * 100)
  const gapPct = Math.round(num(proposal.gap_pct, 0) * 100)

  if (proposal.strength === 'strong') {
    return `${from}'s cost per ${ol} has been climbing the more you spend into it, while ${to} is ` +
      `holding a lower cost per ${ol} — consider testing a shift of about ${pct}% of ${from} ` +
      `budget toward ${to} and watch whether ${to} holds its cost as it scales.`
  }
  return `${to} is currently turning out ${ol}s at about ${gapPct}% lower cost than ${from} — ` +
    `worth testing a modest shift of budget from ${from} toward ${to}, keeping an eye on ` +
    `whether ${to} holds that cost as it takes more spend.`
}

// ── compact actionable rails for the engine/UI; null unless there is a move ─────────
function reallocationRails(proposal) {
  if (!proposal || proposal.status !== 'reallocate') return null
  return {
    from: proposal.from, to: proposal.to,
    from_cpo: proposal.from_cpo, to_cpo: proposal.to_cpo,
    suggested_shift: proposal.suggested_shift,
    test_fraction: proposal.test_fraction,
    strength: proposal.strength,
  }
}

module.exports = {
  assessChannelEfficiency,
  rankReallocation,
  analyzeReallocation,
  narrateReallocation,
  reallocationRails,
  pearson,
  coeffVar,
  // constants (exported for tests + any consumer that wants the same thresholds)
  MIN_WINDOWS,
  TARGET_WINDOWS,
  MIN_SPEND,
  MIN_OUTCOMES,
  MIN_SPEND_CV,
  TREND_THRESH,
  MIN_GAP,
  MIN_CONFIDENCE,
  TEST_FRACTION,
  CHANNEL_LABEL,
}
