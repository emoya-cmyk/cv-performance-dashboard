'use strict'

// ============================================================
// lib/briefImpact.js — did the morning headline earn its place?
//
// THE GAP THIS CLOSES
// -------------------
// The brief family already grades two things about ITSELF. [[briefQuality]] asks
// "did the AI WRITE the brief, or fall back to the safe template?" — narration
// MECHANICS, read off `model`. [[briefDelivery]] asks "did a fresh brief actually
// LAND each morning?" — delivery RELIABILITY. Both judge the brief as an artifact:
// was it authored, was it shipped. Neither asks the only question a reader silently
// asks every single morning — "the one thing you put at the TOP today, was it worth
// my attention, or had it evaporated by tomorrow?" That is EDITORIAL PRECISION: of
// all the mornings we led with X, how often did X actually hold up. A brief can be
// richly narrated AND reliably delivered AND still cry wolf every day. This module
// is that missing self-audit. It reads the brief HISTORY the engine already persists
// (the ai_briefs table) and grades each morning's LEAD — the client brief's `focus`,
// the portfolio brief's `headline` — against whether the flagged condition PERSISTED
// over the following mornings. The brief grading its own front page, with no human
// input and no model.
//
// WHY NOT JUST REUSE pulseAccuracy?
// ---------------------------------
// [[pulseAccuracy]] grades the raw SENSOR: it replays dayPulse over a numeric series
// and asks whether the detector's mid-week firing predicted the completed week. That
// is the detector's own shape, on numbers no reader ever saw. briefImpact grades the
// PUBLISHED EDITORIAL CHOICE — the single lead we actually printed at the top of the
// brief a human read that morning — against what that exact metric/scope went on to
// do. Same family discipline (replay history, abstain when thin), different subject:
// the front page, not the sensor. The label band is deliberately a THIRD vocabulary —
// earned / fair / overcalled — disjoint from reliabilityLabel (reliable/mixed/noisy)
// and accuracyLabel (proven/developing/learning), so a surface can never confuse
// "this signal persists" with "this signal predicts the week" with "our headline was
// worth printing."
//
// ONE LEAD, ITS FOLLOW-THROUGH, ONE VERDICT
// -----------------------------------------
// A morning's lead carries a POLARITY: an adverse lead flags a problem (leads down,
// spend spiking), a favorable lead flags a win (a tailwind worth celebrating). The
// follow-through is the SAME scope+metric's dayPulse verdict on each subsequent
// morning — exactly the shape getClientPulse / getPortfolioPulse already produce, so
// the caller (the wiring layer) joins them with no new statistics path. A follow-up
//   • CONFIRMS  — still firing, SAME polarity → the lead was real, it held up.
//   • REFUTES   — back to normal, OR firing the OPPOSITE way → the lead evaporated.
//   • NO-DATA   — the sensor couldn't speak (insufficient history) → excluded, never
//                 counted for or against; a young metric is abstained on, not punished.
// Over the confirm window a lead is a HIT when a majority of its usable follow-ups
// confirm, a MISS when they don't, and UNKNOWN when too few follow-ups carried data
// to judge — the same fair-by-abstention rule the rest of the family lives by.
//
// FAIR + HONEST BY ABSTENTION
// ---------------------------
// Zero observations → status:'insufficient' reason 'insufficient_history'. Some, but
// fewer than `minSample` RESOLVED leads (hits+misses) → 'insufficient_sample' (a hit
// rate off one or two front pages is not a track record — the same discipline as
// pulseAccuracy's minFires). Every return path still reports the raw tally, so "it
// resolved three, I want four" stays visible rather than hidden behind a null.
//
// SELF-IMPROVING: the hit rate is measured fresh from the brief corpus every run, so
// it sharpens automatically as more mornings close — the empirical signal a later
// layer can tune lead SELECTION on (lead with the lanes that have earned it), exactly
// as pulseTuning consumes pulseAccuracy. This is the MEASURE half of that loop.
//
// PURE: paired observations in, a grade out. No DB, no clock-of-now, no network, no
// LLM, no mutation, never throws. Every verdict is read off fields already on each
// observation, so it stays trivially testable on plain literals — exactly like the
// rest of the pulse/brief family. The narrate helper is agency-rich and only ever
// REINFORCES a strong record to a client, so the no-leak discipline (editorial
// self-grading is internal calibration) is enforced in the module, not left to each
// surface to remember.
// ============================================================

// Confirm window: how many of the following mornings count toward "did it hold up."
// Three is long enough to tell a real trend from a one-day blip, short enough that a
// lead resolves within the same week it was printed. Clamped to ≥1.
const DEFAULT_CONFIRM_WINDOW = 3
// Minimum follow-ups carrying data before a lead is gradeable at all (else 'unknown').
const DEFAULT_MIN_FOLLOW = 1
// Share of usable follow-ups that must confirm for a HIT. 0.5 = a simple majority held.
const DEFAULT_CONFIRM_FLOOR = 0.5
// Minimum RESOLVED leads (hits+misses) before a hit RATE is a track record, not a fluke
// — mirrors pulseAccuracy.minFires / briefDelivery.minSample so the abstention floor is
// the same shape across the self-grading family.
const DEFAULT_MIN_SAMPLE = 4

const str = (x) => (x == null ? '' : String(x))
const round = (x, dp) => {
  const f = 10 ** dp
  return Math.round(x * f) / f
}
const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many)
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
const inUnit = (v, d) => (Number.isFinite(v) && v > 0 && v <= 1 ? v : d)

// impactLabel(rate) — the plain band for a lead HIT RATE in [0,1]. A THIRD vocabulary,
// chosen to share no word with reliabilityLabel or accuracyLabel so the three grades
// never blur on a shared surface:
//   earned ≥0.70 · fair 0.40–0.69 · overcalled <0.40 · null (un-graded) → null.
function impactLabel(rate) {
  if (rate == null || !Number.isFinite(rate)) return null
  if (rate >= 0.7) return 'earned'
  if (rate >= 0.4) return 'fair'
  return 'overcalled'
}

// Normalize ONE follow-up verdict to 'confirm' | 'refute' | 'nodata', given the lead's
// adverse polarity. Accepts both a dayPulse-native { status, adverse } and a terse
// { signal:boolean, adverse } so the caller can hand whichever it already has. Anything
// unreadable is 'nodata' — it can never be PROVEN to confirm or refute, so it stays out
// of the judgement entirely (abstain, don't punish).
function followState(f, leadAdverse) {
  if (!f || typeof f !== 'object') return 'nodata'
  let signalled
  if (typeof f.status === 'string') {
    if (f.status === 'insufficient') return 'nodata'
    signalled = f.status === 'signal'
  } else if (typeof f.signal === 'boolean') {
    signalled = f.signal
  } else {
    return 'nodata' // neither shape present → not gradeable
  }
  if (!signalled) return 'refute' // reverted to normal
  // Still firing — confirms only if the SAME polarity as the lead; a flip refutes.
  return !!f.adverse === !!leadAdverse ? 'confirm' : 'refute'
}

/**
 * classifyLeadOutcome(observation, opts) — grade ONE published lead against its
 * follow-through. Pure; never throws.
 *   observation : { adverse:boolean, followups:[ {status|signal, adverse}, ... ] }
 *                 `adverse` is the lead's polarity (true = flagged a problem, false =
 *                 flagged a win). `followups` are the SAME scope+metric verdicts on the
 *                 subsequent mornings, chronological (oldest follow-up first).
 *   opts : { window=3, minFollow=1, confirmFloor=0.5 } — forwarded by summarizeBriefImpact.
 *
 * Returns { outcome:'hit'|'miss'|'unknown', usable, confirms, window }
 *   • usable  — follow-ups within the window that carried data (confirm + refute).
 *   • confirms— of those, how many held the lead up.
 *   • 'unknown' when usable < minFollow (too little follow-through to judge);
 *     'hit' when confirms/usable ≥ confirmFloor; 'miss' otherwise.
 */
function classifyLeadOutcome(observation, opts = {}) {
  const window = posInt(opts.window, DEFAULT_CONFIRM_WINDOW)
  const minFollow = posInt(opts.minFollow, DEFAULT_MIN_FOLLOW)
  const confirmFloor = inUnit(opts.confirmFloor, DEFAULT_CONFIRM_FLOOR)
  const leadAdverse = !!(observation && observation.adverse)
  const raw = observation && Array.isArray(observation.followups) ? observation.followups : []

  let usable = 0
  let confirms = 0
  for (let i = 0; i < raw.length && i < window; i++) {
    const s = followState(raw[i], leadAdverse)
    if (s === 'nodata') continue
    usable++
    if (s === 'confirm') confirms++
  }

  let outcome
  if (usable < minFollow) outcome = 'unknown'
  else outcome = confirms / usable >= confirmFloor ? 'hit' : 'miss'
  return { outcome, usable, confirms, window }
}

// An empty rollup bucket — the shape every level (overall, by_lane[k], by_audience[k])
// shares, so a surface renders them uniformly.
function emptyBucket() {
  return { sample: 0, judged: 0, hits: 0, misses: 0, unknown: 0, hit_rate: null, label: null }
}
// Fold one classified observation into a bucket (mutates + returns it).
function addToBucket(b, outcome) {
  b.sample++
  if (outcome === 'hit') b.hits++
  else if (outcome === 'miss') b.misses++
  else b.unknown++
  return b
}
// Finalize a bucket's derived fields once all observations are folded in.
function sealBucket(b) {
  b.judged = b.hits + b.misses
  b.hit_rate = b.judged > 0 ? round(b.hits / b.judged, 4) : null
  b.label = impactLabel(b.hit_rate)
  return b
}

/**
 * summarizeBriefImpact(observations, opts)
 *   observations : paired { lead, follow-through } records the wiring layer built by
 *                  joining each persisted brief's LEAD to that scope+metric's later
 *                  verdicts. Each:
 *                    { audience:'client'|'agency', lane:<string|null>,
 *                      adverse:boolean, followups:[ {status|signal, adverse}, ... ] }
 *                  audience/lane drive the rollups; adverse/followups drive the grade.
 *   opts : { window=3, minFollow=1, confirmFloor=0.5, minSample=4 }
 *
 * Returns (never throws):
 *   { status:'graded'|'insufficient', reason, window, min_sample,
 *     sample, judged, hits, misses, unknown, hit_rate, label,
 *     by_lane: { [lane]: <bucket> }, by_audience: { client:<bucket>, agency:<bucket> } }
 *   • 'insufficient' — 'insufficient_history' (no observations) or 'insufficient_sample'
 *     (some, but < minSample resolved leads); hit_rate/label null on those paths, with
 *     the raw tally still reported.
 *   • <bucket> = { sample, judged, hits, misses, unknown, hit_rate, label } — label is
 *     null until a bucket has a resolved lead; raw counts are always present so a thin
 *     lane is visible as thin, never dressed up by a lonely label.
 *   Invariant: hits + misses + unknown === sample (per bucket and overall).
 */
function summarizeBriefImpact(observations, opts = {}) {
  const window = posInt(opts.window, DEFAULT_CONFIRM_WINDOW)
  const minFollow = posInt(opts.minFollow, DEFAULT_MIN_FOLLOW)
  const confirmFloor = inUnit(opts.confirmFloor, DEFAULT_CONFIRM_FLOOR)
  const minSample = posInt(opts.minSample, DEFAULT_MIN_SAMPLE)
  const classifyOpts = { window, minFollow, confirmFloor }

  const list = Array.isArray(observations) ? observations.filter(Boolean) : []

  const overall = emptyBucket()
  const byLane = {}
  const byAudience = { client: emptyBucket(), agency: emptyBucket() }

  for (const obs of list) {
    const { outcome } = classifyLeadOutcome(obs, classifyOpts)
    addToBucket(overall, outcome)

    const laneKey = str(obs.lane) || 'unspecified'
    if (!byLane[laneKey]) byLane[laneKey] = emptyBucket()
    addToBucket(byLane[laneKey], outcome)

    const audKey = str(obs.audience) === 'agency' ? 'agency' : 'client'
    addToBucket(byAudience[audKey], outcome)
  }

  sealBucket(overall)
  for (const k of Object.keys(byLane)) sealBucket(byLane[k])
  sealBucket(byAudience.client)
  sealBucket(byAudience.agency)

  const base = {
    window,
    min_sample: minSample,
    sample: overall.sample,
    judged: overall.judged,
    hits: overall.hits,
    misses: overall.misses,
    unknown: overall.unknown,
    hit_rate: overall.hit_rate,
    by_lane: byLane,
    by_audience: byAudience,
  }

  if (overall.sample === 0) {
    return { status: 'insufficient', reason: 'insufficient_history', ...base, label: null }
  }
  if (overall.judged < minSample) {
    return { status: 'insufficient', reason: 'insufficient_sample', ...base, label: null }
  }
  return { status: 'graded', reason: 'graded', ...base, label: overall.label }
}

/**
 * narrateBriefImpact(impact, opts) — ONE grounded sentence about how well the brief's
 * own front page has earned its place. Deterministic, no LLM: every figure (hits,
 * judged, %) is copied straight off the grade, so it can never disagree with the score.
 * Returns '' for an un-graded / missing grade, exactly as the sibling narrators fall
 * silent when there is nothing trustworthy to say.
 *   AGENCY  : full record, any band —
 *     earned     → "Our morning leads have earned their place 8 of 10 times recently (~80%) — well-aimed."
 *     overcalled → "Our morning leads held up 2 of 9 times recently (~22%) — we're overcalling; tighten lead selection."
 *   CLIENT  : only ever REINFORCES a strong record; a fair/overcalled record stays
 *             silent (we never volunteer to a client that our own front page is weak).
 *   opts : { audience, scopeLabel='Our morning leads' }
 */
function narrateBriefImpact(impact, opts = {}) {
  if (!impact || impact.status !== 'graded' || impact.hit_rate == null) return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  const pct = Math.round(impact.hit_rate * 100)

  if (audience === 'client') {
    return impact.label === 'earned'
      ? "When we lead your morning brief with something, it has usually held up."
      : ''
  }

  const scope = opts.scopeLabel || 'Our morning leads'
  const noun = plural(impact.judged, 'time', 'times')
  const phrase =
    impact.label === 'earned' ? 'well-aimed' :
    impact.label === 'fair' ? 'a fair record' :
    "we're overcalling; tighten lead selection"
  const verb = impact.label === 'overcalled' ? 'held up' : 'earned their place'
  return `${scope} have ${verb} ${impact.hits} of ${impact.judged} ${noun} recently (~${pct}%) — ${phrase}.`
}

module.exports = {
  summarizeBriefImpact,
  classifyLeadOutcome,
  narrateBriefImpact,
  impactLabel,
  followState,
  DEFAULT_CONFIRM_WINDOW,
  DEFAULT_MIN_FOLLOW,
  DEFAULT_CONFIRM_FLOOR,
  DEFAULT_MIN_SAMPLE,
}
