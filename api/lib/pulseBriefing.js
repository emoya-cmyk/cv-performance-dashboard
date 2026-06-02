'use strict'

const { rankPulseSignals } = require('./pulseTriage')

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

// summarizePortfolioPulse(roster) — AGENCY briefing over the whole-book pulse roster (the
// `roster` field of getPortfolioPulse: every firing, tailwinds included). Derives the
// action feed with the SAME [[pulseTriage]] ranking the roster's own act_today uses, so
// briefing.headline === act_today[0] by construction. Returns synthesis: a one-word
// posture, a grounded headline sentence, up to three supporting rows, and a confidence
// read on the day's call. Keeps machinery (names clients, headline row carries tuning) —
// agency-only, GET /pulse.
function summarizePortfolioPulse(roster) {
  const rows = Array.isArray(roster) ? roster : []
  const act = rankPulseSignals(rows, { adverseOnly: true }) // identical to getPortfolioPulse's act_today
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

  const headline = act[0]
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

  const also = act.slice(1, 4)
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
function summarizeClientPulse(signals) {
  const rows = Array.isArray(signals) ? signals : []
  const act = rankPulseSignals(rows, { adverseOnly: true })
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

  const top = act[0]
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
