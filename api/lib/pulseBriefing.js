'use strict'

const { rankPulseSignals } = require('./pulseTriage')
const { applyLeadPolicy } = require('./briefLeadPolicy')

// ============================================================
// lib/pulseBriefing.js — intel-v7 (7): the morning's ONE thing, synthesised.
//
// THE GAP THIS CLOSES
// -------------------
// Layers 1–6 turned each flow metric into a rich, self-grading signal: it detects
// (dayPulse), explains itself (diagnoseComposite), grades its own consistency
// (pulseReliability) and predictive precision (pulseAccuracy), gets folded into a
// reliability-weighted action lane (pulseTriage), and even retunes its own firing band
// (tunePulseThresholds). That is a LOT of true, earned detail. The failure mode is no
// longer "we can't tell what's wrong" — it's "there are nine chips on the screen and a
// human still has to decide what the morning is actually ABOUT." Every prior layer ADDED
// surface area. This layer SUBTRACTS it: it reads the same numbers the triage already
// produced and answers one question — "if you do exactly one thing today, do this, and
// here's how much to trust that call." Synthesis, not another sensor.
//
// WHY IT COMPOSES ON rankPulseSignals AND NEVER RE-RANKS
// ------------------------------------------------------
// The "one thing" is, by construction, the top row of the SAME reliability-weighted feed
// the agency already acts from: rankPulseSignals(roster, { adverseOnly:true })[0] — i.e.
// getPortfolioPulse's own `act_today[0]`. The briefing does not invent a parallel notion
// of "most important"; it would be incoherent for the headline to disagree with the list
// beneath it. So this module calls the exact same [[pulseTriage]] entry point and reads
// position 0. As that loop re-weights itself (a sensor that keeps panning out climbs),
// the headline re-aims itself too — zero operator input. The only thing added on top is
// FRAMING: a portfolio-level count, a one-word posture, and a confidence read on the
// day's call. No new metric number is fabricated — the headline reuses the signal's own
// triage sentence verbatim; the briefing only counts what is already on the roster.
//
// THE ONE BOUNDED EXCEPTION — a learned lead nudge (intel-v7 13b)
// ----------------------------------------------------------------
// Both summarize fns take an optional opts.leadPolicy. With NONE — the live getXPulse hot
// path always passes none — the feed is rankPulseSignals untouched and everything above
// holds verbatim. When the generated morning brief ([[brief]]) supplies a *tuned*
// [[briefLeadPolicy]] — the system having learned from its OWN front-page track record
// (briefImpact) which triage lanes earn the top slot and which keep overcalling —
// applyLeadPolicyToFeed may nudge WHICH adverse row leads, inside a hard safety envelope: it
// can only swap a near-tie with an immediately-preceding DEMOTED lane, never leap a rank, and
// can NEVER push a lower lane above a higher-ranked act_now (which deriveLeadPolicy floors to
// weight ≥ 1). Counts, posture, and the confidence read are permutation-invariant, so they
// never move — only the headline/focus re-aims. The geometric-spacing proof lives on
// applyLeadPolicyToFeed; an abstained/idle/absent policy is a STABLE NO-OP by construction.
//
// THE CONFIDENCE READ — the system grading its own briefing
// ---------------------------------------------------------
// The capstone is the tool reporting how much to trust TODAY's call: what share of the
// morning's action items come from sensors that have actually earned credibility
// (accuracy 'proven' or reliability 'reliable') versus ones still building a record. A
// book where four of five alerts are proven reads 'high'; one leaning on brand-new
// sensors reads 'building — treat as directional'. That meta-honesty is the point: an
// operator should know when the dashboard is sure and when it is guessing.
//
// TWO AUDIENCES, ONE MODULE (mirrors narrateTriage)
// -------------------------------------------------
// summarizePortfolioPulse(roster) → AGENCY synthesis: names clients, keeps machinery,
//   rides GET /pulse. summarizeClientPulse(signals) → a single client's own pulse in one
//   calm sentence: client-toned, names no peers, and carries ONLY client-visible fields
//   (label/direction/delta_pct/lane) — never z, baseline, or any tuning_* machinery — so
//   it rides the client egress ([[clientSafePulse]] / the 6d contract) untouched.
//
// PURE + TOTAL: no Date, no randomness, no I/O; never mutates input; tolerant of empty /
// missing fields (a roster that is [] or undefined yields a calm 'quiet' briefing).
// ============================================================

// CREDIBILITY split — read off the labels getClientPulse already attached; no recompute,
// no new threshold. A signal is "credible" today if EITHER earned axis has cleared its
// own high bar: its early-warnings proved out (accuracy_label 'proven', precision ≥0.7)
// OR its firings have been consistent (reliability_label 'reliable', ≥0.7). "graded" = it
// has ANY track record on either axis — the line between measured-and-unproven and simply
// too-new-to-judge.
function isCredible(s) {
  return !!s && (s.accuracy_label === 'proven' || s.reliability_label === 'reliable')
}
function isGraded(s) {
  return !!s && (s.accuracy_label != null || s.reliability_label != null)
}

// Portfolio confidence label from the proven/graded mix across TODAY's action items.
// Monotone in proven_share; graded_share only rescues 'building' → 'moderate' (a book
// that is mostly graded-but-middling is more trustworthy than one that is mostly new).
function confidenceLabel(provenShare, gradedShare, n) {
  if (n === 0) return 'n/a'
  if (provenShare >= 0.5) return 'high'
  if (provenShare >= 0.25 || gradedShare >= 0.5) return 'moderate'
  return 'building'
}

const CONFIDENCE_NOTE = {
  high:     "Most of today's alerts come from sensors with a proven track record — this read is well-grounded.",
  moderate: "Today's alerts mix proven and still-maturing sensors — solid, but confirm the unproven ones.",
  building: "Today's alerts lean on sensors still building a track record — treat as directional and verify before big moves.",
  'n/a':    'Nothing flagged to act on today.',
}

// Short lane tag for the supporting-cast line — the action word, not the full sentence.
const LANE_TAG = {
  act_now:      'act now',
  verify:       'verify',
  worth_a_look: 'worth a look',
  monitor:      'monitor',
  tailwind:     'tailwind',
}

function plural(n, one, many) { return n === 1 ? one : many }
function lc(label) { return String(label == null ? 'this metric' : label).toLowerCase() }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100 }

// "7 alerts across 4 clients" · "3 alerts on Acme" · "One alert"
function countPhrase(adverse, clients, onlyName) {
  if (adverse <= 0) return 'No alerts'
  if (adverse === 1) return 'One alert'
  if (clients === 1 && onlyName) return `${adverse} alerts on ${onlyName}`
  return `${adverse} alerts across ${clients} ${plural(clients, 'client', 'clients')}`
}

// Defensive only: every adverse signal carries a triage_reason, but never throw if one
// is malformed — compose a grounded sentence from the raw fields instead.
function composeAgencyFallback(s) {
  const label = s.label || 'This metric'
  const crit  = s.severity === 'critical'
  const lane  = s.lane
  const tail  = lane === 'act_now' || lane === 'verify' ? 'act today' : 'worth a look'
  return `${label} is ${crit ? 'critical' : 'slipping'} — ${tail}.`
}
function composeClientFallback(s) {
  return `Your ${lc(s.label)} ${s.direction === 'down' ? 'needs a look' : 'is worth a look'} this week.`
}

// ── intel-v7 (13b): the ONE authorized, bounded re-rank of the lead slot ──────────────
// A learned lead policy ([[briefLeadPolicy]].deriveLeadPolicy) is the TUNE half of the
// brief's editorial-precision loop: from our OWN front-page track record (briefImpact) it
// learns which triage lanes have earned the top slot and which keep overcalling, expressed
// as a bounded per-lane weight. applyLeadPolicyToFeed lets that learning nudge — and ONLY
// nudge — which adverse row becomes the headline/focus. It is a STABLE NO-OP unless the
// policy is actually 'tuned' (an abstained/idle/absent policy, or a feed of <2 rows, returns
// the input unchanged), so the live getXPulse hot path (which passes no policy) stays
// byte-identical to rankPulseSignals; only the generated morning brief ([[brief]]) ever
// supplies a policy.
//
// HOW THE NUDGE STAYS BOUNDED (why this can't reorder the board). We encode each candidate's
// CURRENT triage rank as a geometric score base = decay**i with decay = 1/maxWeight (maxWeight
// = the SAME upper bound the policy's weights top out at), then hand it to applyLeadPolicy,
// which scales base by the lane weight. That exact spacing IS the safety proof: a maximally-
// PROMOTED follower at rank i+1 scores decay**(i+1)·maxW = decay**i — a dead TIE with its
// neutral predecessor at rank i — and applyLeadPolicy's sort is stable, so the incumbent keeps
// the slot. A follower can climb ONLY past an immediate predecessor the policy DEMOTED (weight
// < 1): a true near-tie swap, never a leap over a neutral rank, never a two-step climb. And
// because act_now is safety-FLOORED to weight ≥ 1 in deriveLeadPolicy, no lower-ranked lane can
// ever pass a higher-ranked act_now (decay**j·maxW = decay**(j-1) ≤ decay**i for any j > i) —
// the policy can re-aim the lead but can NEVER bury an emergency. We pass protectLanes:[]
// precisely because that floor already delivers the safety guarantee; a global act_now pin
// (applyLeadPolicy's default) would override triage's own severity×reliability order and
// re-introduce the noisy-critical-cries-wolf failure the triage layer exists to prevent.
function applyLeadPolicyToFeed(act, leadPolicy) {
  if (!leadPolicy || leadPolicy.status !== 'tuned' || act.length < 2) return act
  const bMax  = leadPolicy.bounds && Number(leadPolicy.bounds.max)
  const maxW  = Number.isFinite(bMax) && bMax > 1 ? bMax : 1.2
  const decay = 1 / maxW
  const scored = act.map((r, i) => ({ ...r, __lead: decay ** i }))
  const ranked = applyLeadPolicy(scored, leadPolicy, { scoreKey: '__lead', protectLanes: [] })
  // Strip the scratch + applyLeadPolicy bookkeeping fields so each row stays byte-identical to
  // the raw roster row it came from (no __lead / base_score / lead_weight leaks downstream).
  return ranked.map(({ __lead, base_score, lead_weight, ...row }) => row)
}

// summarizePortfolioPulse(roster) — AGENCY briefing over the whole-book pulse roster (the
// `roster` field of getPortfolioPulse: every firing, tailwinds included). Derives the
// action feed with the SAME [[pulseTriage]] ranking the roster's own act_today uses, so
// briefing.headline === act_today[0] by construction. Returns synthesis: a one-word
// posture, a grounded headline sentence, up to three supporting rows, and a confidence
// read on the day's call. Keeps machinery (names clients, headline row carries tuning) —
// agency-only, GET /pulse.
function summarizePortfolioPulse(roster, opts = {}) {
  const rows = Array.isArray(roster) ? roster : []
  const act = rankPulseSignals(rows, { adverseOnly: true }) // identical to getPortfolioPulse's act_today
  const led = applyLeadPolicyToFeed(act, opts.leadPolicy)   // 13b: bounded learned lead nudge (NO-OP unless tuned)
  const tailwinds = rows.filter((r) => r && !r.adverse).length

  const adverse = act.length
  const clients = new Set(act.map((r) => String(r && r.client_id != null ? r.client_id : ''))).size
  const actNow  = act.filter((r) => r.lane === 'act_now').length
  const credible = act.filter(isCredible).length
  const graded   = act.filter(isGraded).length
  const provenShare = adverse ? credible / adverse : 0
  const gradedShare = adverse ? graded / adverse : 0

  const posture = adverse === 0 ? 'steady' : (actNow > 0 ? 'act' : 'watch')
  const cLabel  = confidenceLabel(provenShare, gradedShare, adverse)
  const confidence = {
    proven_share: round2(provenShare),
    graded_share: round2(gradedShare),
    label: cLabel,
    note: CONFIDENCE_NOTE[cLabel],
  }
  const counts = {
    adverse,
    clients,
    act_now: actNow,
    tailwinds,
    proven: credible,
    learning: Math.max(0, adverse - graded),
  }

  if (adverse === 0) {
    const headline_text = tailwinds > 0
      ? `All clear to act on — ${tailwinds} ${plural(tailwinds, 'metric is', 'metrics are')} pacing ahead across the book, and nothing needs attention today.`
      : "Quiet across the book — every client's flow metrics are sitting inside their usual band today."
    return { status: 'quiet', posture, counts, headline: null, headline_text, also: [], also_text: '', confidence }
  }

  const headline = led[0]
  const name     = headline.client_name || 'a client'
  const onlyName = clients === 1 ? (headline.client_name || null) : null
  const lead     = countPhrase(adverse, clients, onlyName)
  const reason   = headline.triage_reason || composeAgencyFallback(headline)

  let headline_text
  if (adverse === 1) {
    headline_text = `${lead} today, on ${name}: ${reason}`
  } else if (clients === 1) {
    headline_text = `${lead} today. First up: ${reason}`
  } else {
    headline_text = `${lead} today. First up, ${name}: ${reason}`
  }

  const also = led.slice(1, 4)
  const also_text = also.length
    ? `Next: ${also.map((r) => `${r.client_name || 'a client'} — ${lc(r.label)} (${LANE_TAG[r.lane] || 'review'})`).join(', ')}.`
    : ''

  return { status: 'briefing', posture, counts, headline, headline_text, also, also_text, confidence }
}

// summarizeClientPulse(signals) — a SINGLE client's own pulse in one calm sentence. Same
// ranking, but client-toned and machinery-free: names no peers, reuses the signal's own
// client-toned triage sentence (narrateTriage's client branch reads only lane + label, so
// it can carry no machinery), and `focus` exposes ONLY client-visible fields. No z,
// baseline, or tuning_* ever appears — it rides the client egress untouched.
function summarizeClientPulse(signals, opts = {}) {
  const rows = Array.isArray(signals) ? signals : []
  const act = rankPulseSignals(rows, { adverseOnly: true })
  const led = applyLeadPolicyToFeed(act, opts.leadPolicy)   // 13b: bounded learned lead nudge (NO-OP unless tuned)
  const tailwinds = rows.filter((r) => r && !r.adverse).length

  const adverse = act.length
  const actNow  = act.filter((r) => r.lane === 'act_now').length
  const posture = adverse === 0 ? 'steady' : (actNow > 0 ? 'act' : 'watch')

  if (adverse === 0) {
    const headline_text = tailwinds > 0
      ? "You're pacing ahead this week — nice momentum, and nothing needs your attention right now."
      : 'All steady this week — nothing needs your attention right now.'
    return { status: 'quiet', posture, headline_text, focus: null, also_count: 0 }
  }

  const top = led[0]
  const also_count = adverse - 1
  const core = top.triage_client_reason || composeClientFallback(top)
  const tail = also_count > 0
    ? ` We're also keeping an eye on ${also_count} other ${plural(also_count, 'metric', 'metrics')}.`
    : ''
  const headline_text = `${core}${tail}`
  const focus = {
    metric:    top.metric,
    label:     top.label,
    direction: top.direction,
    delta_pct: top.delta_pct,
    lane:      top.lane,
  }
  return { status: 'briefing', posture, headline_text, focus, also_count }
}

module.exports = {
  summarizePortfolioPulse,
  summarizeClientPulse,
  // exported for unit tests of the thresholds / splits
  isCredible,
  isGraded,
  confidenceLabel,
}
