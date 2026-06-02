'use strict'

// ============================================================
// lib/escalation.js — close the loop: when the LEARNED record says a play
// isn't working, REVISE the recommendation instead of repeating it. (pure)
//
// efficacy.js (the learn half) measures, per play archetype (kind::metric), how
// often the recommended play actually CLEARS the problem. Until now nothing
// consumed that verdict to change WHAT gets recommended — recommendedAction()
// would propose the same lever forever, even one the data has proven fails. This
// module is the ACT half: given a finding's base recommendation and that play's
// measured record, it decides whether the play has accumulated enough FAILURES to
// stop trusting it, and if so ESCALATES — bumps the urgency one lane and rewrites
// the advice from "pull the usual lever" to "the usual lever hasn't been clearing
// this, escalate and change approach." Proven-effective plays and plays without
// enough evidence pass through untouched.
//
// THIS is self-improving in the strong sense the product goal keeps asking for:
// the system's own advice gets better because it noticed its advice wasn't working.
// precision.js learns what a client ATTENDS to (a rank multiplier); efficacy.js
// learns what actually gets FIXED (an annotation); escalation.js is the first organ
// that lets that learning CHANGE the recommended action itself.
//
// Conservative by construction — it only ever overrides on PROVEN failure:
//   • band 'low' (shrunk efficacy < EFF_LOW) AND
//   • n ≥ ESCALATE_MIN_N decided outcomes (a higher bar than efficacyNote's
//     NOTE_MIN_N — changing the directive earns more evidence than annotating it).
// A null / thin / medium / high record is a clean no-op: the base action is
// returned UNCHANGED (same reference), so wiring this in can never alter behavior
// for any play that hasn't earned the override.
//
// PURE: mirrors efficacy.js / precision.js / outcomes.js — no DB, no clock, no
// network, no mutation of inputs; a record in, a (possibly revised) action out.
// Never throws; degenerate input is a no-op. The engine (2b) owns the I/O: it
// builds the efficacy table, looks up each adverse+advised finding's play record,
// and passes (recommended_action, record) here, persisting whatever comes back.
// ============================================================

const { EFF_LOW, NOTE_MIN_N } = require('./efficacy')

// ── tuning constants (the only "magic numbers", all in one place) ────────────
// One above efficacyNote's NOTE_MIN_N(4): boasting a track record is passive, but
// OVERRIDING the standard play changes what the operator does — so it earns a
// deeper decided history before it fires.
const ESCALATE_MIN_N = 5

// The urgency lanes recommendedAction() emits, ascending. Escalation bumps one lane
// up and caps at the top — a proven-ineffective play is more dangerous than its raw
// severity implies (the usual fix won't save it), so it deserves a hotter lane.
const URGENCY_ORDER = ['monitor', 'plan', 'act_now']

// ── tiny helpers ─────────────────────────────────────────────────────────────
const clamp01 = x => Math.min(1, Math.max(0, x))
// Non-negative integer from anything; junk → 0. Keeps a stray null/NaN in a record
// from ever printing "NaN of 5" into client-facing advice.
const intOf = v => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x > 0 ? x : 0 }

// Next urgency lane up, capped at the top. Unknown/blank urgency is treated as the
// coolest lane ('monitor') so the bump still lands on a real value.
function bumpUrgency(u) {
  const i = URGENCY_ORDER.indexOf(u)
  const from = i < 0 ? 0 : i
  return URGENCY_ORDER[Math.min(from + 1, URGENCY_ORDER.length - 1)]
}

// Is this play PROVEN ineffective — low band on deep-enough evidence? Reuses
// efficacy.js's EFF_LOW so "low" means the same thing the ledger and UI already show;
// prefers the record's own `band` string and falls back to recomputing from the
// numeric efficacy (so a record built by an older table without a band still works).
// `opts` lets tests/tuning override the floor (minN) and the low threshold (lowMax).
function shouldEscalate(record, { minN = ESCALATE_MIN_N, lowMax = EFF_LOW } = {}) {
  if (!record) return false
  const n = Math.floor(Number(record.n))
  if (!Number.isFinite(n) || n < minN) return false
  const eff = Number(record.efficacy)
  return Number.isFinite(eff) ? eff < lowMax : record.band === 'low'
}

// ── the one entry point: revise a recommendation in light of its track record ──
// baseAction: the { text, urgency } recommendedAction() produced (any extra fields
//   are preserved). record: the efficacy.js table record for this finding's play, or
//   null. Returns the SAME action object untouched when no escalation is warranted,
//   or a NEW object (inputs never mutated) carrying:
//     • text       — the agency-facing advice, with a grounded escalation clause
//                    appended (every number printed comes straight from the record).
//     • urgency    — bumped one lane (capped at act_now).
//     • escalated  — true.
//     • escalation — structured facts for the surfaces + a softened, peer-free
//                    client_text (the client hears "we're changing approach," never
//                    a failure statistic or internal ops language).
function reviseAction(baseAction, record, opts = {}) {
  if (!baseAction || !shouldEscalate(record, opts)) return baseAction

  const pct      = Math.round(clamp01(Number(record.efficacy)) * 100)
  const n        = intOf(record.n)
  const s        = intOf(record.successes)
  const fromU    = URGENCY_ORDER.includes(baseAction.urgency) ? baseAction.urgency : 'monitor'
  const toU      = bumpUrgency(fromU)

  const baseText = typeof baseAction.text === 'string' ? baseAction.text.trim() : ''
  const clause   = `This play has cleared the problem only ${pct}% of the time (${s} of ${n}) — escalate and try a different lever rather than repeating it.`
  const text      = baseText ? `${baseText} ${clause}` : clause

  return {
    ...baseAction,
    text,
    urgency: toU,
    escalated: true,
    escalation: {
      reason: 'play_ineffective',
      pct, successes: s, n,
      band: record.band || 'low',
      from_urgency: fromU,
      to_urgency: toU,
      // Client-safe variant: honest ("we're changing tack") and reassuring, with NO
      // failure statistic and NO internal ops language ("escalate", "senior strategist").
      // Names no peer; says only that the usual fix underperformed for THIS client.
      client_text: 'We’re changing our approach here — the usual fix hasn’t been moving the needle, so your team is taking a different angle.',
    },
  }
}

module.exports = {
  reviseAction, shouldEscalate, bumpUrgency,
  // constants (exported for tests + any consumer that wants the same thresholds)
  ESCALATE_MIN_N, URGENCY_ORDER,
}
