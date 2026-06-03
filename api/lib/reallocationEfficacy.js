'use strict'

// ============================================================
// lib/reallocationEfficacy.js — the reallocation feedback loop (PURE).
//
// Layer 24 (channelEfficiency) is the first PRESCRIPTIVE layer: it looks across a client's
// paid channels and proposes ONE small reversible test — "shift about 10% of Facebook budget
// toward Google Ads, because Google is turning out leads at a materially lower cost per result
// right now, ASSUMING it holds that cost as it scales." It states exactly one fact (today's
// cost-per-outcome gap) and flags the rest `hypothesis:true`. What it never does — what NOTHING
// in the stack does — is look BACK and ask whether those bets actually paid off. So the proposer
// recommends the same kind of move forever with no idea whether its hypothesis ("the cheaper
// channel holds its edge as money moves to it") tends to come true, and the confidence it prints
// is a sample-adequacy number, never a track record. This module is the missing wire: it reads
// past proposals back against what the cost-per-outcome gap DID over the weeks that followed, and
// learns — per confidence band and per channel pair — how often the edge actually persisted, so a
// new proposal can finally carry its own record AND the engine can DAMPEN or EMBOLDEN the
// confidence it assigns based on how those bets have really landed. This is the self-improving the
// product goal keeps asking for, pushed one level past channelEfficiency: 24 proposes; 25 grades
// the proposals and tunes the next one.
//
// MEASURED, never opinion — the same discipline as efficacy.js. A trial becomes a learning SAMPLE
// only once arithmetic can call it. Each trial pairs the proposal AS IT WAS MADE (the decision:
// from/to channel, their cost-per-outcome at decision time, the believed gap, the strength band,
// the confidence assigned) with what REALIZED over the following horizon (the same two channels'
// cost-per-outcome, re-measured after the fact). We grade the realized gap against the decision
// gap:
//   • vindicated → the cheaper channel STAYED meaningfully cheaper: the realized edge held to at
//     least VIND_FRAC of what we predicted (and stayed positive). The bet's hypothesis came true.
//   • refuted    → the edge COLLAPSED or REVERSED: the realized gap fell to zero or flipped (the
//     "to" channel is no longer the better-value place for the dollar). The hypothesis failed.
//   • neutral    → the edge shrank but stayed positive — not a clean win, not a clean loss → it is
//     PENDING, exactly like efficacy.js's resolved-without-proof: NOT counted, never inflates a
//     record. We only learn from trials arithmetic could decide.
//   • unmeasurable → realized cost-per-outcome missing/garbage, or the decision gap can't be
//     anchored → not a sample (a quiet skip, never a throw).
//
// STATISTICS — one house style with efficacy.js / precision.js (no second dialect of "rate at
// small n"): Beta-Bernoulli shrinkage for the point estimate, Wilson lower bound for a defensible
// order, median for the "usually" half of a claim.
//   • hit_rate = (vindicated + priorMean·K)/(n + K). Neutral prior at n=0 (a brand-new band reads
//     as the base rate, never 0/100% off one trial), raw rate as n→∞; priorMean defaults to the
//     pooled base rate across ALL supplied trials, so a sparse band shrinks toward how proposals
//     land OVERALL.
//   • lower = Wilson 95% lower bound — deeper evidence ranks higher (8/10 beats 1/1).
//   • CALIBRATION is the knob the engine actually consumes: compare the shrunk realized hit_rate
//     to the mean confidence we ASSIGNED those trials. Over-confident (hit_rate < confidence) →
//     a factor < 1 that DAMPENS future confidence; under-confident → a factor > 1 (capped) that
//     emboldens it. The factor itself shrinks toward a neutral 1.0 by credibility n/(n+K), so at
//     low evidence it is a behavioral no-op — the loop never lurches on one or two trials.
//
// AGENCY-only, like all of Layer 24. A budget-shift track record is an internal media-buying
// instrument, not a client scoreboard line — there is no client variant of any output here, and
// nothing in this module ever rides a client pack. (Layer 25d will prove that confinement.)
//
// PURE: trials in, a table + a calibration out. No DB, no clock, no network, no LLM, no mutation
// of inputs (mirrors channelEfficiency.js / efficacy.js / precision.js). Degenerate input → an
// empty table and a neutral 1.0 calibration (a no-op the engine can apply blindly). Never throws.
// The engine (25b) owns the I/O: it reconstructs trials by re-slicing fact_metric into the window
// a proposal WOULD have seen and the window that followed, feeds them here, and serves the table.
// ============================================================

// ── tuning constants (the only "magic numbers", all in one place) ────────────
const PRIOR_WEIGHT = 6      // pseudo-count: ~6 decided trials before data outweighs the prior (matches efficacy.js)
const PRIOR_MEAN   = 0.5    // neutral fallback when there is no history to pool a base rate from
const Z            = 1.96   // 95% normal quantile for the Wilson lower bound
const VIND_FRAC    = 0.5    // realized edge must hold ≥ this share of the predicted edge to be 'vindicated'
const HIT_LOW      = 0.40   // hit_rate < 0.40 → "low" band (these bets rarely hold up)
const HIT_HIGH     = 0.66   // hit_rate ≥ 0.66 → "high" band (these bets reliably hold up)
const NOTE_MIN_N   = 4      // reallocationEfficacyNote() stays silent below this many decided trials
const CAL_MIN      = 0.5    // confidence calibration floor — never damp future confidence below half
const CAL_MAX      = 1.2    // confidence calibration ceiling — never inflate beyond +20% (upside is riskier)
const OVERALL_KEY  = '__overall__'   // reserved tally key for the pooled, cross-band record

// ── tiny helpers (shared house style with efficacy.js) ───────────────────────
const clamp   = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const clamp01 = x => clamp(x, 0, 1)
const round3  = x => Math.round(Number(x) * 1000) / 1000

// Non-negative integer tally from anything; junk → 0.
function countOf(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Finite positive cost-per-outcome, else null. A cpo of 0 or negative is not a real cost and must
// not anchor a gap (it would divide the relative gap by ~0).
function cpoOf(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Relative cost-per-outcome gap (from − to)/from: how much cheaper per outcome `to` is than
// `from`, as a share of `from`'s cost. Positive ⇒ `to` is the better-value channel. null when
// `from` is not a real positive cost (nothing to anchor against).
function gapOf(fromCpo, toCpo) {
  const f = cpoOf(fromCpo), t = cpoOf(toCpo)
  if (f == null || t == null) return null
  return (f - t) / f
}

// ── pull the decision / realized halves out of a trial, liberally ─────────────
// Be liberal in what we accept (mirrors efficacy.js reading outcome|status|recovered): a trial may
// carry the proposal under `decision`, `proposal`, or at the top level, and the realized re-measure
// under `realized`, `after`, or `outcome`. Strict in grading, lenient in shape.
function decisionOf(trial) {
  const t = trial || {}
  if (t.decision && typeof t.decision === 'object') return t.decision
  if (t.proposal && typeof t.proposal === 'object') return t.proposal
  return t
}
function realizedOf(trial) {
  const t = trial || {}
  if (t.realized && typeof t.realized === 'object') return t.realized
  if (t.after    && typeof t.after    === 'object') return t.after
  if (t.outcome  && typeof t.outcome  === 'object') return t.outcome
  return null
}

// Strength band a trial was proposed at — the primary axis the calibration learns on, because it
// is what channelEfficiency's confidence multiplier keys off. Unknown/missing → 'unrated' (kept as
// its own bucket; never forced into a real band).
function strengthOf(trial) {
  const d = decisionOf(trial)
  const s = d && d.strength != null ? String(d.strength).toLowerCase().trim() : ''
  return s === 'strong' || s === 'moderate' || s === 'tentative' ? s : 'unrated'
}

// Channel-pair key `from->to`, or null when either side is missing (that trial still counts toward
// the strength band and the overall record — only the per-pair breakdown skips it).
function pairOf(trial) {
  const d = decisionOf(trial)
  const from = d && d.from != null ? String(d.from) : ''
  const to   = d && d.to   != null ? String(d.to)   : ''
  return from && to ? `${from}->${to}` : null
}

// ── grade ONE trial: did the cost-per-outcome edge hold? ──────────────────────
// Returns { label, decision_gap, realized_gap, hold_ratio } where label is
// 'vindicated' | 'refuted' | 'neutral' | 'unmeasurable'. Anchored on the decision gap (the edge we
// believed at proposal time, preferring the recorded cost-per-outcome pair, falling back to the
// stated gap_pct) versus the realized gap (the same edge re-measured after the horizon):
//   • realized_gap ≥ VIND_FRAC × decision_gap AND realized_gap > 0 → vindicated (the edge held)
//   • realized_gap ≤ 0                                             → refuted (edge gone or reversed)
//   • otherwise (0 < realized_gap < VIND_FRAC × decision_gap)      → neutral (shrank but positive)
// hold_ratio = realized_gap / decision_gap is reported for transparency (1.0 = edge fully held).
// Pure and total: any missing/garbage cost-per-outcome, or a non-positive decision gap (we never
// graded a move that wasn't actually a positive-edge proposal), yields 'unmeasurable'.
function classifyTrial(trial, opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {}
  const vindFrac = clamp01(Number.isFinite(opts.vindFrac) ? opts.vindFrac : VIND_FRAC)
  const d = decisionOf(trial)
  const r = realizedOf(trial)

  // decision gap: prefer the recorded cpo pair; fall back to a stated gap_pct.
  let decisionGap = gapOf(d && d.from_cpo, d && d.to_cpo)
  if (decisionGap == null) {
    const g = Number(d && d.gap_pct)
    decisionGap = Number.isFinite(g) ? g : null
  }
  const realizedGap = r ? gapOf(r.from_cpo, r.to_cpo) : null

  if (decisionGap == null || decisionGap <= 0 || realizedGap == null) {
    return { label: 'unmeasurable', decision_gap: decisionGap == null ? null : round3(decisionGap),
      realized_gap: realizedGap == null ? null : round3(realizedGap), hold_ratio: null }
  }

  const holdRatio = realizedGap / decisionGap
  const label =
    (realizedGap > 0 && holdRatio >= vindFrac) ? 'vindicated' :
    (realizedGap <= 0)                          ? 'refuted'    : 'neutral'

  return {
    label,
    decision_gap: round3(decisionGap),
    realized_gap: round3(realizedGap),
    hold_ratio: round3(holdRatio),
  }
}

// ── tally trials into per-band records (+ overall + per-pair) ─────────────────
// Decided trials only (vindicated → success, refuted → failure); neutral & unmeasurable contribute
// nothing. Returns { byStrength: Map, byPair: Map, overall } where each record carries
// { key, vindicated, refuted, n, hold_ratios[], confidences[] }. n is the DECIDED count (the
// denominator that earns an opinion); hold_ratios collects the decided trials' hold ratios and
// confidences the decision-time confidence we assigned them (the calibration's other half).
function tallyTrials(trials, opts = {}) {
  const mk = (key) => ({ key, vindicated: 0, refuted: 0, n: 0, hold_ratios: [], confidences: [] })
  const byStrength = new Map()
  const byPair     = new Map()
  const overall    = mk(OVERALL_KEY)

  for (const trial of (Array.isArray(trials) ? trials : [])) {
    const graded = classifyTrial(trial, opts)
    if (graded.label !== 'vindicated' && graded.label !== 'refuted') continue   // neutral/unmeasurable → pending

    const success = graded.label === 'vindicated'
    const conf = Number((decisionOf(trial) || {}).confidence)
    const bump = (rec) => {
      if (success) rec.vindicated++; else rec.refuted++
      rec.n++
      if (Number.isFinite(graded.hold_ratio)) rec.hold_ratios.push(graded.hold_ratio)
      if (Number.isFinite(conf)) rec.confidences.push(clamp01(conf))
    }

    bump(overall)

    const sKey = strengthOf(trial)
    let s = byStrength.get(sKey); if (!s) { s = mk(sKey); byStrength.set(sKey, s) }
    bump(s)

    const pKey = pairOf(trial)
    if (pKey) { let p = byPair.get(pKey); if (!p) { p = mk(pKey); byPair.set(pKey, p) }; bump(p) }
  }
  return { byStrength, byPair, overall }
}

// Raw vindication rate vindicated/(vindicated+refuted), or null with no decided trials.
function rateOf({ vindicated, refuted } = {}) {
  const v = countOf(vindicated), f = countOf(refuted)
  const n = v + f
  return n ? v / n : null
}

// ── Beta-Bernoulli hit rate (the headline point estimate) ─────────────────────
// Posterior mean of the vindication probability under a Beta(priorMean·K,(1−priorMean)·K) prior:
// (vindicated + priorMean·K)/(n + K). Neutral prior at n=0, raw rate as n→∞. Robust to any input.
function hitRateOf({ vindicated, refuted } = {}, { priorMean = PRIOR_MEAN, priorWeight = PRIOR_WEIGHT } = {}) {
  const v  = countOf(vindicated), f = countOf(refuted)
  const n  = v + f
  const pm = clamp01(Number.isFinite(priorMean) ? priorMean : PRIOR_MEAN)
  const k  = Math.max(0, Number.isFinite(priorWeight) ? priorWeight : PRIOR_WEIGHT)
  if (n + k === 0) return round3(pm)
  return round3(clamp01((v + pm * k) / (n + k)))
}

// ── Wilson score lower bound (the ranking key) ────────────────────────────────
// 95% lower confidence bound on the true vindication probability. Deeper evidence ranks higher;
// n=0 → 0. Same math as efficacy.wilsonLower (one house style). Pure, total, [0,1], rounded.
function wilsonLower({ vindicated, refuted } = {}) {
  const v = countOf(vindicated), f = countOf(refuted)
  const n = v + f
  if (n === 0) return 0
  const p      = v / n
  const z2     = Z * Z
  const denom  = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return round3(clamp01((center - margin) / denom))
}

// Median of a numeric list (ascending; mean of the two middles when even); null for empty.
function medianOf(list) {
  const xs = (Array.isArray(list) ? list : []).filter(d => Number.isFinite(d)).slice().sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

// Arithmetic mean of a numeric list, or null for empty (used for mean assigned confidence).
function meanOf(list) {
  const xs = (Array.isArray(list) ? list : []).filter(d => Number.isFinite(d))
  if (xs.length === 0) return null
  let s = 0; for (const x of xs) s += x
  return s / xs.length
}

// hit_rate → discrete band for the UI (and quick thresholding).
function bandOf(hitRate) {
  const c = Number(hitRate)
  if (!Number.isFinite(c)) return 'medium'
  if (c < HIT_LOW)  return 'low'
  if (c >= HIT_HIGH) return 'high'
  return 'medium'
}

// ── pooled base rate → a data-driven prior mean ───────────────────────────────
// Pool ALL decided trials into one vindication rate, so sparse per-band estimates shrink toward how
// proposals land OVERALL rather than a blind 0.5. Returns { mean, n }; mean null until ≥1 decided.
function baseRateOf(trials, opts = {}) {
  let v = 0, n = 0
  for (const trial of (Array.isArray(trials) ? trials : [])) {
    const label = classifyTrial(trial, opts).label
    if (label !== 'vindicated' && label !== 'refuted') continue
    if (label === 'vindicated') v++
    n++
  }
  return { mean: n ? v / n : null, n }
}

// ── the calibration the ENGINE consumes: a confidence multiplier ──────────────
// Compare the shrunk realized hit_rate to the mean confidence we ASSIGNED those decided trials.
//   rawFactor = hit_rate / mean_confidence  — >1 when we were under-confident, <1 when over.
// Clamp to [CAL_MIN, CAL_MAX], then shrink toward a neutral 1.0 by credibility n/(n+K) so the loop
// never lurches on thin evidence: at n=0 the factor is exactly 1.0 (a behavioral no-op the engine
// can multiply through blindly). Returns a stable-shaped object, ALWAYS.
function calibrationOf(record, { priorWeight = PRIOR_WEIGHT, priorMean = PRIOR_MEAN } = {}) {
  const k   = Math.max(0, Number.isFinite(priorWeight) ? priorWeight : PRIOR_WEIGHT)
  const rec = record || {}
  const n   = countOf(rec.vindicated) + countOf(rec.refuted)
  const hit = hitRateOf(rec, { priorMean, priorWeight: k })
  const meanConf = meanOf(rec.confidences)
  const credibility = n + k > 0 ? n / (n + k) : 0

  // With no assigned-confidence to compare against, we can't calibrate confidence → neutral.
  if (meanConf == null || meanConf <= 0.05) {
    return { factor: 1, hit_rate: hit, mean_confidence: meanConf == null ? null : round3(meanConf),
      n, credibility: round3(credibility), basis: 'insufficient confidence history' }
  }

  const rawFactor = hit / meanConf
  const clamped   = clamp(rawFactor, CAL_MIN, CAL_MAX)
  const shrunk    = 1 + (clamped - 1) * credibility           // → 1.0 as credibility → 0
  const factor    = round3(clamp(shrunk, CAL_MIN, CAL_MAX))
  const basis =
    factor < 0.98 ? 'past bets held up less often than their confidence implied — damping' :
    factor > 1.02 ? 'past bets held up more often than their confidence implied — emboldening' :
    'past bets landed about as confidently as assigned — holding'
  return { factor, hit_rate: hit, mean_confidence: round3(meanConf), n, credibility: round3(credibility), basis }
}

// ── shape one tally record into a served row ──────────────────────────────────
function recordRow(rec, key, prior, k) {
  const hit = hitRateOf(rec, { priorMean: prior, priorWeight: k })
  return {
    key,
    n: rec.n, vindicated: rec.vindicated, refuted: rec.refuted,
    vindication_rate: (() => { const r = rateOf(rec); return r == null ? null : round3(r) })(),
    hit_rate: hit, lower: wilsonLower(rec),
    credibility: round3(rec.n / (rec.n + k)),
    median_hold: (() => { const m = medianOf(rec.hold_ratios); return m == null ? null : round3(m) })(),
    mean_confidence: (() => { const m = meanOf(rec.confidences); return m == null ? null : round3(m) })(),
    band: bandOf(hit),
  }
}

// ── one-call pipeline: trials → graded table + calibration ─────────────────────
// The convenience the orchestrator calls (mirrors efficacy.efficacyTable). Tallies the trials,
// derives each strength band's + channel pair's shrunk hit_rate / Wilson lower bound / median hold
// ratio, builds the OVERALL record, and computes the confidence calibration (from the overall
// record by default — the global knob the engine applies). Returns Maps keyed by strength and pair,
// a ranked strength view, the overall row, the base rate it shrank toward, and the calibration.
// PURE — same trials always yield the same table, order, and factor.
function reallocationEfficacyTable(trials, { priorMean, priorWeight = PRIOR_WEIGHT } = {}) {
  const base  = baseRateOf(trials)
  const prior = Number.isFinite(priorMean) ? priorMean : (base.mean != null ? base.mean : PRIOR_MEAN)
  const k     = Math.max(0, Number.isFinite(priorWeight) ? priorWeight : PRIOR_WEIGHT)
  const { byStrength, byPair, overall } = tallyTrials(trials)

  const strengthTable = new Map()
  for (const [key, rec] of byStrength) strengthTable.set(key, recordRow(rec, key, prior, k))
  const pairTable = new Map()
  for (const [key, rec] of byPair) pairTable.set(key, recordRow(rec, key, prior, k))

  // Ranked strength view: deepest-evidence vindication first; total tie-break → deterministic.
  const ranked = [...strengthTable.values()].sort((a, b) =>
    b.lower - a.lower || b.hit_rate - a.hit_rate || b.n - a.n || a.key.localeCompare(b.key)
  ).map((r, i) => ({ ...r, rank: i + 1 }))
  for (const r of ranked) strengthTable.get(r.key).rank = r.rank

  const overallRow  = recordRow(overall, OVERALL_KEY, prior, k)
  const calibration = calibrationOf(overall, { priorWeight: k, priorMean: prior })

  return {
    byStrength: strengthTable,
    byPair: pairTable,
    ranked,
    overall: overallRow,
    calibration,
    base: { rate: base.mean == null ? null : round3(base.mean), n: base.n, prior: round3(prior) },
  }
}

// ── per-band annotation: a proposal's own track record (AGENCY only) ──────────
// Given a strength band (or a trial to read it from) and a built table, return a short grounded
// sentence the agency surface can append to a live proposal — or null when the band hasn't earned
// enough decided evidence to boast (n < NOTE_MIN_N) or isn't in the table. Every number printed
// comes straight from the record; nothing is recomputed. There is NO client variant — a budget-
// shift track record is an internal instrument (the whole of Layer 24/25 is agency-only).
function reallocationEfficacyNote(bandOrTrial, table, { minN = NOTE_MIN_N } = {}) {
  if (!table) return null
  const key = typeof bandOrTrial === 'string'
    ? (bandOrTrial.toLowerCase().trim() || 'unrated')
    : strengthOf(bandOrTrial)
  const map = table.byStrength instanceof Map ? table.byStrength : (table instanceof Map ? table : null)
  const rec = map ? map.get(key) : null
  if (!rec || countOf(rec.n) < Math.max(1, countOf(minN) || NOTE_MIN_N)) return null
  const pct  = Math.round(clamp01(rec.hit_rate) * 100)
  const hold = rec.median_hold
  const tail = hold != null
    ? (hold >= 0.9 ? ', and the cost edge usually held in full'
      : hold >= VIND_FRAC ? ', with most of the cost edge holding'
      : ', though the edge typically narrowed')
    : ''
  return {
    text: `Budget-shift tests at this confidence have held up ${pct}% of the time (${rec.vindicated} of ${rec.n})${tail}.`,
    pct, vindicated: rec.vindicated, n: rec.n, median_hold: hold, band: rec.band,
  }
}

module.exports = {
  classifyTrial, tallyTrials, rateOf,
  gapOf, cpoOf, strengthOf, pairOf,
  hitRateOf, wilsonLower, medianOf, meanOf, bandOf, baseRateOf,
  calibrationOf, reallocationEfficacyTable, reallocationEfficacyNote,
  // constants (exported for tests + any consumer that wants the same thresholds)
  PRIOR_WEIGHT, PRIOR_MEAN, Z, VIND_FRAC, HIT_LOW, HIT_HIGH, NOTE_MIN_N, CAL_MIN, CAL_MAX, OVERALL_KEY,
}
