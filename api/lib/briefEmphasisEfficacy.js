'use strict'

/**
 * briefEmphasisEfficacy — layer 20: did the engagement loop's flexing actually pay off?
 *
 * The stack so far:
 *   - layer 18 (briefEngagement)          captures the reader's 👍/👎 → a portfolio reception grade.
 *   - layer 19 (briefEngagementLearning)  turns that grade into a supporting-cast cap:
 *                                          widen when well-received, tighten when poor/declining.
 *
 * Layer 19 acts on every grade — but with FIXED steps and FIXED bounds, and it never
 * checks whether the flex WORKED. It could widen into a slow decline forever, or tighten
 * when tightening does nothing. That is exactly the gap efficacy.js closed for the
 * action→recovery loop ("recommend the same play forever with no idea whether it helps").
 *
 * This module closes it for the emphasis loop. Given a history of emphasis DECISIONS, each
 * paired with the reception that FOLLOWED, it measures — per direction — whether the bet
 * paid off, against the control of the mornings we held steady:
 *
 *   - WIDEN is played from strength (reception was good). Its bet is "they can absorb more
 *     without disengaging." So a widen SUCCEEDS when reception SUSTAINED — held or rose.
 *   - TIGHTEN is played from weakness (reception cooled). Its bet is "trim to the essentials
 *     and they come back." So a tighten SUCCEEDS only when reception genuinely RECOVERED.
 *   - NEUTRAL mornings are the CONTROL: P(reception improves | we did nothing). The directions
 *     are scored as LIFT over this baseline, so "widening works" means "better than holding."
 *
 * The asymmetry (widen = sustained, tighten = recovered) is deliberate and mirrors the bets
 * layer 19 actually makes; it is not a bug. We do NOT claim causation — this is association:
 * "is our auto-tuning moving with the outcomes we intended?" The agency reads it that way.
 *
 * From that it emits a BOUNDED, learned step-scale per direction — the knob layer 21 would
 * feed back into deriveBriefEmphasis to make layer 19 self-improving:
 *   - temper AGGRESSIVELY (down to 0.5×) on a bet that underperforms the control (point lift),
 *   - endorse only MODESTLY (up to 1.25×) on a bet that beats it with confidence (Wilson lower).
 * Over-serving is the more reversible mistake, so easing off is cheap and leaning in is earned —
 * the same "widening must be EARNED" caution layer 19 already enforces, now at the meta level.
 *
 * House style is borrowed verbatim from efficacy.js / precision.js: Beta-Bernoulli shrinkage
 * toward a data-driven prior (here the control rate), Wilson 95% lower bound for ranking/endorsing,
 * medians for the typical move. The statistics are re-implemented locally so this module stays
 * hermetic and independently testable, exactly like briefEngagementLearning.js.
 *
 * CONTRACT — same as every pure rung in this stack:
 *   - PURE: no DB, no clock, no network, no LLM, no mutation of inputs. Deterministic.
 *   - NEVER THROWS: junk, nulls, NaN, wrong types → honest abstention, never an exception.
 *   - HONEST BY ABSTENTION: thin/absent outcomes → status 'insufficient', no recommendation,
 *     narrator silent. We never manufacture a verdict from noise.
 *   - AGENCY-ONLY: narrateEmphasisEfficacy returns '' for audience:'client' UNCONDITIONALLY.
 *     Per-direction efficacy, control rates, lifts, and step-scales are agency telemetry; the
 *     reader never sees that the brief's breadth is being A/B'd against their own attention.
 *
 * Intended layer-20b feed (NOT built here — this is the pure core): each persisted portfolio
 * brief row already carries engagement_policy (direction + the helpful_rate that drove it,
 * from brief.js:425). Consecutive rows therefore pair a decision with its outcome for free:
 *   observation = { as_of: row[i].as_of, direction: row[i].direction,
 *                   rate_before: row[i].helpful_rate, base_cap: row[i].base_cap,
 *                   rate_after: row[i+1].helpful_rate, n_after: row[i+1].n }
 * No new query, no extra capture — the history is already on disk.
 */

// ── statistics (house style, mirrored from efficacy.js; kept local so the module is hermetic) ──
const PRIOR_WEIGHT = 6 // K — shrink a direction toward the control rate until it has ~6 outcomes
const PRIOR_MEAN = 0.5 // last-resort prior when there is no control and no decided history
const Z = 1.96 // 95% — Wilson lower bound, the conservative (endorse-worthy) estimate
const EFF_LOW = 0.4 // efficacy band edges, shared vocabulary with efficacy.js
const EFF_HIGH = 0.66
const NOTE_MIN_N = 4 // a direction needs >= this many decided outcomes before we narrate or tune it
const MIN_OUTCOME_VOTES = 3 // rate_after must be backed by >= this many votes to count as measured
const NOISE_BAND = 0.05 // reception moves within +/- this are "flat"; absorbs vote-level noise

// ── learned step-scale bounds — asymmetric on purpose (easy to temper, hard to earn a boost) ──
const STEP_SCALE_BASE = 1.0
const STEP_SCALE_MIN = 0.5 // floor: never zero out a direction outright; layer 19 keeps a toehold
const STEP_SCALE_MAX = 1.25 // ceiling: endorse only modestly — over-serving is the cautious side
const LIFT_BAND = 0.05 // a lift inside +/- this is "in line with the control"; no adjustment

const WIDEN = 'widen'
const TIGHTEN = 'tighten'
const NEUTRAL = 'neutral'

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const round3 = (x) => Math.round(x * 1000) / 1000
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

// finite rate in [0,1] or null — never throws on junk.
// CRITICAL: null/undefined/''/non-numeric are MISSING (→ null), never coerced to 0.
// (Number(null) === 0 would otherwise read a missing reception as 0% and classify on noise.)
function numRate(v) {
  let n
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v)
  else return null
  if (!Number.isFinite(n)) return null
  if (n < 0 || n > 1) return null
  return n
}

// non-negative integer count or 0 — tolerant of strings/floats/junk
function countOf(v) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

// Beta-Bernoulli posterior mean: shrink the raw rate toward `prior` with weight K.
function efficacyOf(successes, failures, prior, k) {
  const s = countOf(successes)
  const f = countOf(failures)
  const n = s + f
  const pri = numRate(prior)
  const K = Number.isFinite(k) && k >= 0 ? k : PRIOR_WEIGHT
  const mean = pri == null ? PRIOR_MEAN : pri
  if (n === 0) return round3(mean)
  return round3((s + mean * K) / (n + K))
}

// Wilson score lower bound at 95% — the conservative estimate we require before endorsing.
function wilsonLower(successes, failures) {
  const s = countOf(successes)
  const f = countOf(failures)
  const n = s + f
  if (n === 0) return 0
  const p = s / n
  const z2 = Z * Z
  const denom = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return round3(Math.max(0, (center - margin) / denom))
}

function medianOf(values) {
  const xs = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return round3(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2)
}

function bandOf(efficacy) {
  const e = numRate(efficacy)
  if (e == null) return 'unknown'
  if (e >= EFF_HIGH) return 'high'
  if (e >= EFF_LOW) return 'moderate'
  return 'low'
}

/**
 * classifyEmphasisOutcome(obs) — one decision + its follow-on reception → a scored bet.
 *
 * Returns one of:
 *   { direction:'widen'|'tighten', outcome:'success'|'failure', delta }
 *   { direction:'neutral', outcome:'improved'|'flat', delta }            (the control)
 *   { direction:'pending', outcome:'pending', delta:null }               (not measurable)
 *
 * Pending — never counted — when the direction is unknown, either rate is missing/out of range,
 * or the outcome is backed by fewer than MIN_OUTCOME_VOTES votes. Honest by abstention.
 */
function classifyEmphasisOutcome(obs) {
  if (!isObj(obs)) return { direction: 'pending', outcome: 'pending', delta: null }
  const dir = obs.direction
  const rb = numRate(obs.rate_before)
  const ra = numRate(obs.rate_after)
  const nAfter = countOf(obs.n_after)
  if (rb == null || ra == null || nAfter < MIN_OUTCOME_VOTES) {
    return { direction: 'pending', outcome: 'pending', delta: null }
  }
  const delta = round3(ra - rb)
  if (dir === NEUTRAL) {
    return { direction: NEUTRAL, outcome: delta >= NOISE_BAND ? 'improved' : 'flat', delta }
  }
  if (dir === WIDEN) {
    // played from strength: success = reception SUSTAINED (held or rose).
    return { direction: WIDEN, outcome: delta >= -NOISE_BAND ? 'success' : 'failure', delta }
  }
  if (dir === TIGHTEN) {
    // played from weakness: success = reception genuinely RECOVERED.
    return { direction: TIGHTEN, outcome: delta >= NOISE_BAND ? 'success' : 'failure', delta }
  }
  return { direction: 'pending', outcome: 'pending', delta: null }
}

/**
 * tallyEmphasisEfficacy(observations) — fold a history into per-direction counts + deltas.
 * Returns { widen:{successes,failures,deltas[]}, tighten:{...}, control:{improved, total} }.
 */
function tallyEmphasisEfficacy(observations) {
  const rows = Array.isArray(observations) ? observations : []
  const widen = { successes: 0, failures: 0, deltas: [] }
  const tighten = { successes: 0, failures: 0, deltas: [] }
  const control = { improved: 0, total: 0 }
  for (const obs of rows) {
    const c = classifyEmphasisOutcome(obs)
    if (c.direction === WIDEN) {
      widen.deltas.push(c.delta)
      if (c.outcome === 'success') widen.successes += 1
      else widen.failures += 1
    } else if (c.direction === TIGHTEN) {
      tighten.deltas.push(c.delta)
      if (c.outcome === 'success') tighten.successes += 1
      else tighten.failures += 1
    } else if (c.direction === NEUTRAL) {
      control.total += 1
      if (c.outcome === 'improved') control.improved += 1
    }
  }
  return { widen, tighten, control }
}

// P(reception improved | we held steady) — the baseline a flex must beat. null if no control.
function controlRateOf(control) {
  if (!isObj(control) || countOf(control.total) === 0) return null
  return round3(countOf(control.improved) / countOf(control.total))
}

// The prior each direction shrinks toward: control rate if we have one, else pooled decided
// success rate, else PRIOR_MEAN. Mirrors efficacy.js's baseRateOf fallback chain.
function priorFor(tally) {
  const ctrl = controlRateOf(tally.control)
  if (ctrl != null) return ctrl
  const s = tally.widen.successes + tally.tighten.successes
  const f = tally.widen.failures + tally.tighten.failures
  if (s + f > 0) return round3(s / (s + f))
  return PRIOR_MEAN
}

// One direction's full scorecard against the prior baseline.
function scoreDirection(d, prior, k) {
  const successes = countOf(d.successes)
  const failures = countOf(d.failures)
  const n = successes + failures
  const efficacy = efficacyOf(successes, failures, prior, k)
  const lower = wilsonLower(successes, failures)
  return {
    n,
    successes,
    failures,
    rate: n ? round3(successes / n) : null,
    efficacy,
    lower,
    lift: round3(efficacy - prior), // point lift — used to TEMPER (cheap, reversible)
    lower_lift: round3(lower - prior), // confident lift — required to ENDORSE (earned)
    band: bandOf(efficacy),
    credibility: round3(n / (n + (Number.isFinite(k) && k >= 0 ? k : PRIOR_WEIGHT))),
    median_delta: medianOf(d.deltas), // the typical reception move after this bet
  }
}

/**
 * stepScaleFor(score) — map a direction's performance to a BOUNDED multiplier on layer 19's step.
 *   - thin evidence (n < NOTE_MIN_N) → 1.0 (no change; abstain).
 *   - underperforms the control by more than LIFT_BAND (point lift) → temper toward STEP_SCALE_MIN.
 *   - beats the control by more than LIFT_BAND WITH CONFIDENCE (Wilson lower) → endorse toward MAX.
 *   - otherwise in line with the control → 1.0.
 * Asymmetric by design: tempering uses the point estimate (act early on a losing bet), endorsing
 * demands the conservative lower bound (earn the boost). Always clamped to [0.5, 1.25].
 */
function stepScaleFor(score) {
  if (!isObj(score) || score.n < NOTE_MIN_N) return { scale: STEP_SCALE_BASE, move: 'insufficient' }
  if (score.lift <= -LIFT_BAND) {
    return { scale: round3(clamp(STEP_SCALE_BASE + score.lift, STEP_SCALE_MIN, STEP_SCALE_BASE)), move: 'temper' }
  }
  if (score.lower_lift >= LIFT_BAND) {
    return { scale: round3(clamp(STEP_SCALE_BASE + score.lower_lift, STEP_SCALE_BASE, STEP_SCALE_MAX)), move: 'endorse' }
  }
  return { scale: STEP_SCALE_BASE, move: 'steady' }
}

/**
 * summarizeEmphasisEfficacy(observations, opts) — the full agency-only scorecard.
 *
 * opts: { priorMean?, priorWeight? } — overrides for the shrinkage prior/weight (defaults above).
 *
 * Returns:
 *   {
 *     status: 'graded' | 'insufficient',
 *     control_rate, control_n, prior,
 *     directions: { widen: <score>, tighten: <score> },
 *     recommendation: {
 *       widen_step_scale, tighten_step_scale,
 *       verdict: 'endorsed' | 'tempered' | 'steady' | 'insufficient',
 *       reason: <machine token>,
 *     },
 *     n: <total decided widen+tighten outcomes>,
 *   }
 * status 'insufficient' (with base scales and verdict 'insufficient') when no widen/tighten
 * outcome is measurable — honest abstention, never a fabricated verdict.
 */
function summarizeEmphasisEfficacy(observations, opts) {
  const o = isObj(opts) ? opts : {}
  const k = Number.isFinite(o.priorWeight) && o.priorWeight >= 0 ? o.priorWeight : PRIOR_WEIGHT
  const tally = tallyEmphasisEfficacy(observations)
  const ctrlRate = controlRateOf(tally.control)
  const prior = numRate(o.priorMean) != null ? numRate(o.priorMean) : priorFor(tally)
  const widen = scoreDirection(tally.widen, prior, k)
  const tighten = scoreDirection(tally.tighten, prior, k)
  const total = widen.n + tighten.n

  if (total === 0) {
    return {
      status: 'insufficient',
      control_rate: ctrlRate,
      control_n: countOf(tally.control.total),
      prior,
      directions: { widen, tighten },
      recommendation: {
        widen_step_scale: STEP_SCALE_BASE,
        tighten_step_scale: STEP_SCALE_BASE,
        verdict: 'insufficient',
        reason: 'no_measured_outcomes',
      },
      n: 0,
    }
  }

  const widenStep = stepScaleFor(widen)
  const tightenStep = stepScaleFor(tighten)
  const moves = [widenStep.move, tightenStep.move]
  const anyTemper = moves.includes('temper')
  const anyEndorse = moves.includes('endorse')
  const anySufficient = widen.n >= NOTE_MIN_N || tighten.n >= NOTE_MIN_N

  let verdict
  let reason
  if (!anySufficient) {
    verdict = 'insufficient'
    reason = 'thin_history'
  } else if (anyTemper) {
    verdict = 'tempered'
    // name the direction being eased off, preferring widen (the over-serving risk)
    reason = widenStep.move === 'temper' ? 'widen_overserving' : 'tighten_not_recovering'
  } else if (anyEndorse) {
    verdict = 'endorsed'
    reason = widenStep.move === 'endorse' ? 'widen_sustaining' : 'tighten_recovering'
  } else {
    verdict = 'steady'
    reason = 'in_line_with_control'
  }

  return {
    status: 'graded',
    control_rate: ctrlRate,
    control_n: countOf(tally.control.total),
    prior,
    directions: { widen, tighten },
    recommendation: {
      widen_step_scale: widenStep.scale,
      tighten_step_scale: tightenStep.scale,
      verdict,
      reason,
    },
    n: total,
  }
}

const pct = (x) => `${Math.round(numRate(x) * 100)}%`

/**
 * narrateEmphasisEfficacy(summary, opts) — one plain-English line for the AGENCY.
 *   - audience:'client' → '' UNCONDITIONALLY (the reader never learns their attention is being tuned).
 *   - status !== 'graded', or neither direction has NOTE_MIN_N outcomes → '' (nothing earned saying).
 * Leads with the direction carrying a real verdict, names the lift over the control, and states
 * the loop's response (ease off / lean in / hold) so the agency sees the self-tuning reasoning.
 */
function narrateEmphasisEfficacy(summary, opts) {
  const audience = isObj(opts) && opts.audience ? opts.audience : 'agency'
  if (audience === 'client') return ''
  if (!isObj(summary) || summary.status !== 'graded') return ''

  const directions = isObj(summary.directions) ? summary.directions : null
  const rec = isObj(summary.recommendation) ? summary.recommendation : null
  if (!directions || !rec) return '' // malformed summary → silent, never throw
  const w = isObj(directions.widen) ? directions.widen : { n: 0, successes: 0, efficacy: 0 }
  const t = isObj(directions.tighten) ? directions.tighten : { n: 0, successes: 0, efficacy: 0 }
  const ctrl = numRate(summary.control_rate) != null ? `, vs ${pct(summary.control_rate)} when the brief held steady` : ''

  // pick the direction the verdict is actually about (prefer the one being moved)
  const reason = rec.reason

  if (reason === 'widen_overserving' && w.n >= NOTE_MIN_N) {
    return `Widening hasn't paid off — when the brief carried more, reception sustained only ${pct(w.efficacy)} of the time (${w.successes} of ${w.n})${ctrl}, so the loop is easing off (step ×${rec.widen_step_scale}).`
  }
  if (reason === 'tighten_not_recovering' && t.n >= NOTE_MIN_N) {
    return `Tightening hasn't been recovering reception — only ${pct(t.efficacy)} of trims were followed by a rebound (${t.successes} of ${t.n})${ctrl}, so the loop is easing off (step ×${rec.tighten_step_scale}).`
  }
  if (reason === 'widen_sustaining' && w.n >= NOTE_MIN_N) {
    return `Widening is holding up — reception sustained ${pct(w.efficacy)} of the time when the brief carried more (${w.successes} of ${w.n})${ctrl}, so the loop is leaning in (step ×${rec.widen_step_scale}).`
  }
  if (reason === 'tighten_recovering' && t.n >= NOTE_MIN_N) {
    return `Tightening is working — reception recovered ${pct(t.efficacy)} of the time after a trim (${t.successes} of ${t.n})${ctrl}, so the loop is leaning in (step ×${rec.tighten_step_scale}).`
  }
  if (reason === 'in_line_with_control') {
    return `The reception loop is holding its calibration — widening and tightening are performing in line with holding steady, so the steps are unchanged.`
  }
  return ''
}

module.exports = {
  classifyEmphasisOutcome,
  tallyEmphasisEfficacy,
  controlRateOf,
  summarizeEmphasisEfficacy,
  narrateEmphasisEfficacy,
  // statistics exposed for layer-20b reuse and direct testing
  efficacyOf,
  wilsonLower,
  medianOf,
  bandOf,
  stepScaleFor,
  scoreDirection,
  // constants
  PRIOR_WEIGHT,
  PRIOR_MEAN,
  NOTE_MIN_N,
  MIN_OUTCOME_VOTES,
  NOISE_BAND,
  STEP_SCALE_BASE,
  STEP_SCALE_MIN,
  STEP_SCALE_MAX,
  LIFT_BAND,
  WIDEN,
  TIGHTEN,
  NEUTRAL,
}
