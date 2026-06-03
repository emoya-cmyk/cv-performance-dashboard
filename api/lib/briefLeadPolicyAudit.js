'use strict'

// ============================================================
// lib/briefLeadPolicyAudit.js — the auditor: did the governor's own corrections
// actually HOLD, or is it re-fixing the same wheel every morning?
//
// THE GAP THIS CLOSES
// -------------------
// The lead-policy autonomy stack now SENSES and ACTS without a human in the path:
//   • [[briefLeadPolicy]]        TUNES the front page (a bounded per-lane nudge).
//   • [[briefLeadPolicyHealth]]  WATCHES that loop and hands back a stability verdict.
//   • [[briefLeadPolicyGovernor]] ACTS on the verdict — surgically neutralising only the
//                                 lanes that thrashed, idempotent, reversible, bounded.
// But the governor acts every morning and never checks its OWN track record. If the
// learner keeps re-learning the same wobble — re-tuning a lane back up, the governor
// neutralising it again, the lane oscillating again, morning after morning — the safe
// corrective is firing on schedule and yet NOTHING is converging. The governor's daily
// 'corrected' looks like success; only the SEQUENCE of governor decisions shows the
// stalemate: a meta-instability the safe per-lane reset cannot, by construction, resolve.
//
// This module is the AUDITOR. It reads a HISTORY of governor decisions and asks the
// question the governor cannot ask itself: are my corrections STICKING? Per lane it
// classifies the outcome of the governor's interventions over time —
//   • recurring     — neutralised on a standing run of consecutive mornings: the
//                     corrective is being fought; the loop is churning, not healing.
//   • resolved      — corrected earlier in the window, but NOT this morning: it took,
//                     the lane graduated back to riding on its own.
//   • intermittent  — corrected more than once, with gaps; a wobble, not yet chronic.
//   • one_off       — a single fresh correction; nothing to conclude yet.
// and rolls them to a single posture: churning / effective / quiet / abstained.
//
// THE SELF-IMPROVING HOOK
// -----------------------
// When a lane is `recurring`, the morning neutralise is demonstrably not enough — the
// audit recommends ESCALATION (action 'escalate', naming the lanes): raise that lane to a
// stronger intervention than the daily reset — pin it with a cooldown, or surface it for a
// human — instead of re-applying the same safe corrective tomorrow and the day after. This
// is the LEARN/ADJUST half of the loop the governor (ACT) and the watcher (SENSE) opened:
// the governor made accountable to its own outcomes, deciding when its safe move has run
// out of road. The escalation is a RECOMMENDATION surfaced to the agency, never auto-armed
// here — widening the intervention's blast radius past a bounded reset is a judgement call.
//
// INTERNAL CALIBRATION — NEVER CLIENT-FACING
// ------------------------------------------
// How well our own auto-corrector is converging is the most internal telemetry in the
// stack — agency machinery, the same family as [[briefLeadPolicyGovernor]]'s reset and
// [[briefLeadPolicyHealth]]'s verdict. narrateLeadPolicyGovernanceAudit speaks only to the
// agency; its client branch is hard-wired to '' so the no-leak discipline lives in the
// module, not in a surface that has to remember it.
//
// PURE: a history of governor results in, an audit out. No DB, no clock-of-now, no network,
// no LLM, no mutation of the inputs, never throws. Trivially testable on plain literals —
// exactly like the rest of the family.
// ============================================================

// How many of the most-recent governor decisions to weigh. A correction's track record is
// a recent question, but the audit must see the AFTERMATH of a reset (did it resolve?), so
// it remembers a touch longer than the health window — room for a recurring run AND a
// resolution to both fall inside one window.
const DEFAULT_WINDOW = 8
// Consecutive mornings a lane must be corrected before the run reads as `recurring`. 3 = the
// governor reset it, the wobble came back, it reset again, it came back, it reset a third
// time — a standing stalemate, not a one-morning re-fix. Mirrors the health module's run shape.
const DEFAULT_RECURRING_RUNS = 3
// Fewest usable governor decisions before we will say anything at all. One morning is not a
// track record; below this the audit abstains — the abstention floor the whole family lives by.
const DEFAULT_MIN_HISTORY = 2
// Which intervention ACTIONS count as an active correction for recurrence. Only 'neutralize'
// changes an applied weight; 'hold_at_bound' and 'respect_floor' are advisory non-actions the
// governor logs but does not act on, so a lane held at a bound every morning is not "churning"
// — it is correctly pinned. Recurrence is a question about the one move that mutates the loop.
const DEFAULT_CORRECTING_ACTIONS = ['neutralize']

// ── tiny pure guards (same idioms as the rest of the family) ─────────────────
const str = (x) => (x == null ? '' : String(x))
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)

// humanizeLane('worth_a_look') → 'worth a look'. Underscore→space, lowercased — the lane
// vocabulary read aloud mid-sentence in the agency narration.
function humanizeLane(lane) {
  return str(lane).replace(/_/g, ' ').trim().toLowerCase()
}

// Join a short list of phrases with serial commas: [a]→'a', [a,b]→'a and b',
// [a,b,c]→'a, b and c'. Deterministic; used only for the agency one-liner.
function joinList(xs) {
  const a = xs.filter(Boolean)
  if (a.length <= 1) return a[0] || ''
  if (a.length === 2) return `${a[0]} and ${a[1]}`
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`
}

// Normalise one history element to { as_of, gov } or null if unusable. Accepts a bare
// governLeadPolicy() result (has .interventions + .status), a { as_of, governance } wrapper,
// or { as_of, ...governorResult }. A governor result carries no as_of of its own, so as_of is
// best-effort: present only when the caller wrapped the morning with one.
function normGov(s) {
  if (!s || typeof s !== 'object') return null
  if (s.governance && typeof s.governance === 'object' && Array.isArray(s.governance.interventions) && typeof s.governance.status === 'string') {
    return { as_of: s.as_of != null ? str(s.as_of) : (s.governance.as_of != null ? str(s.governance.as_of) : null), gov: s.governance }
  }
  if (Array.isArray(s.interventions) && typeof s.status === 'string') {
    return { as_of: s.as_of != null ? str(s.as_of) : null, gov: s }
  }
  return null
}

// The set of lanes a morning CORRECTED (an intervention whose action is in correctingActions),
// mapped to that action. Advisory-only interventions (hold_at_bound / respect_floor) are not
// corrections and never land here. Tolerant of a malformed interventions array.
function correctionsOf(gov, correcting) {
  const out = {}
  const xs = Array.isArray(gov.interventions) ? gov.interventions : []
  for (const it of xs) {
    if (it && typeof it === 'object' && typeof it.lane === 'string' && correcting.includes(it.action)) {
      out[it.lane] = it.action
    }
  }
  return out
}

// Length of the trailing run of `true` (from the newest morning backward) in a boolean series.
function trailingTrue(bools) {
  let run = 0
  for (let i = bools.length - 1; i >= 0; i--) { if (bools[i]) run++; else break }
  return run
}

// Longest run of `true` anywhere in a boolean series — the "for N mornings" context figure.
function maxTrueRun(bools) {
  let max = 0, run = 0
  for (const b of bools) { if (b) { run++; if (run > max) max = run } else run = 0 }
  return max
}

/**
 * auditLeadPolicyGovernance(history, opts) — read a HISTORY of governLeadPolicy results and
 * judge whether the governor's own corrections are CONVERGING. Pure; never throws.
 *   history : ordered OLDEST→NEWEST array. Each element is a governLeadPolicy() result, a
 *             { as_of, governance } wrapper, or { as_of, ...governorResult }. Unusable skipped.
 *   opts    : { window, recurringRuns, minHistory, correctingActions }
 *
 * Returns:
 *   { status:'churning'|'effective'|'quiet'|'abstained',
 *     recommendation:{ action:'escalate'|'none', lanes:[...] },
 *     as_of, window_used, history_len,
 *     lanes:{ [lane]:{ outcome:'recurring'|'resolved'|'intermittent'|'one_off',
 *                      corrections, current_run, max_run, last_action, series:[bool,...] } },
 *     counts:{ recurring, resolved, intermittent, one_off,
 *              corrected_mornings, advisory_mornings, quiet_mornings },
 *     audit_reason }
 *   • 'abstained' — fewer than minHistory usable decisions; no track record to read.
 *   • 'quiet'     — usable history, but the governor never corrected across the window: it had
 *                   nothing to heal. The healthy quiet, NOT a failure.
 *   • 'effective' — corrections happened and none are recurring: the safe move is taking hold.
 *   • 'churning'  — ≥1 lane recurring: the corrective keeps firing on the same lane → escalate.
 *   status precedence (most→least urgent): churning → effective → quiet → abstained.
 */
function auditLeadPolicyGovernance(history, opts = {}) {
  const window = posInt(opts.window, DEFAULT_WINDOW)
  const recurringRuns = posInt(opts.recurringRuns, DEFAULT_RECURRING_RUNS)
  const minHistory = posInt(opts.minHistory, DEFAULT_MIN_HISTORY)
  const correcting = Array.isArray(opts.correctingActions) && opts.correctingActions.length
    ? opts.correctingActions.map(str)
    : DEFAULT_CORRECTING_ACTIONS.slice()

  const usable = (Array.isArray(history) ? history : []).map(normGov).filter(Boolean)

  if (usable.length < minHistory) {
    return {
      status: 'abstained',
      recommendation: { action: 'none', lanes: [] },
      as_of: usable.length ? usable[usable.length - 1].as_of : null,
      window_used: usable.length,
      history_len: usable.length,
      lanes: {},
      counts: { recurring: 0, resolved: 0, intermittent: 0, one_off: 0, corrected_mornings: 0, advisory_mornings: 0, quiet_mornings: 0 },
      audit_reason: 'abstained:thin_history',
    }
  }

  // Weigh the most-recent `window` decisions only — a correction's track record is recent.
  const win = usable.slice(-window)
  const newest = win[win.length - 1]

  // Per-morning correction maps, plus the morning-type tallies the roll-up quotes.
  const perMorning = win.map(m => correctionsOf(m.gov, correcting))
  let corrected_mornings = 0, advisory_mornings = 0, quiet_mornings = 0
  for (let i = 0; i < win.length; i++) {
    const hadCorrection = Object.keys(perMorning[i]).length > 0
    const hadAnyIntervention = Array.isArray(win[i].gov.interventions) && win[i].gov.interventions.length > 0
    if (hadCorrection) corrected_mornings++
    else if (hadAnyIntervention) advisory_mornings++ // logged a hold / floor-respect, changed no weight
    else quiet_mornings++                            // clean or abstained morning — nothing to do
  }

  // Union of lanes ever CORRECTED in the window, in first-seen (oldest→newest) order for
  // determinism. A lane that only ever drew advisory non-actions never enters the audit —
  // there is no correction to judge the durability of.
  const laneKeys = []
  const seen = new Set()
  for (const m of perMorning) {
    for (const k of Object.keys(m)) { if (!seen.has(k)) { seen.add(k); laneKeys.push(k) } }
  }

  const lanes = {}
  const counts = { recurring: 0, resolved: 0, intermittent: 0, one_off: 0, corrected_mornings, advisory_mornings, quiet_mornings }

  for (const laneKey of laneKeys) {
    const series = perMorning.map(m => Object.prototype.hasOwnProperty.call(m, laneKey))
    const corrections = series.filter(Boolean).length
    const current_run = trailingTrue(series)
    const max_run = maxTrueRun(series)
    // The action of this lane's MOST RECENT correction (scan newest→oldest).
    let last_action = null
    for (let i = perMorning.length - 1; i >= 0; i--) {
      if (Object.prototype.hasOwnProperty.call(perMorning[i], laneKey)) { last_action = perMorning[i][laneKey]; break }
    }

    // Outcome — a total, ordered classification of how this lane's corrections played out.
    let outcome
    if (current_run >= recurringRuns) outcome = 'recurring'      // a standing stalemate right now
    else if (current_run === 0) outcome = 'resolved'            // corrected earlier, settled since
    else if (corrections === 1) outcome = 'one_off'            // one fresh correction (run === 1)
    else outcome = 'intermittent'                              // more than once, gappy, not chronic

    counts[outcome]++
    lanes[laneKey] = { outcome, corrections, current_run, max_run, last_action, series }
  }

  // Roll-up posture — the most urgent finding wins. A recurring lane is the one event worth
  // raising; otherwise corrections that took read 'effective'; no corrections at all read 'quiet'.
  const recurringLanes = laneKeys.filter(k => lanes[k].outcome === 'recurring')
  let status, audit_reason
  if (recurringLanes.length > 0) {
    status = 'churning'; audit_reason = `churning:${recurringLanes.join(',')}`
  } else if (corrected_mornings > 0) {
    status = 'effective'; audit_reason = 'effective'
  } else {
    status = 'quiet'; audit_reason = 'quiet'
  }

  // The self-improving hook: escalate ONLY the lanes whose safe corrective is not holding.
  const recommendation = recurringLanes.length > 0
    ? { action: 'escalate', lanes: recurringLanes.slice() }
    : { action: 'none', lanes: [] }

  return {
    status,
    recommendation,
    as_of: newest.as_of,
    window_used: win.length,
    history_len: usable.length,
    lanes,
    counts,
    audit_reason,
  }
}

/**
 * shouldEscalateGovernance(audit) — the one self-improving hook a caller consults to learn
 * whether the governor's safe per-lane reset has run out of road and a stronger intervention
 * (or a human) is warranted. True ONLY when the audit found a recurring lane. Pure.
 */
function shouldEscalateGovernance(audit) {
  return !!(audit && audit.recommendation && audit.recommendation.action === 'escalate')
}

/**
 * narrateLeadPolicyGovernanceAudit(audit, opts) — ONE agency-only sentence about whether the
 * governor's corrections are holding. Deterministic; names only the lanes that are recurring, so
 * it can never overclaim.
 *   CLIENT : '' always — how our auto-corrector is converging is internal calibration.
 *   AGENCY : speaks ONLY when the loop is churning (a correction keeps coming back); silent ('')
 *            for effective, quiet, and abstained — a corrective that takes is not news.
 */
function narrateLeadPolicyGovernanceAudit(audit, opts = {}) {
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  if (audience === 'client') return ''
  if (!audit || audit.status !== 'churning' || !audit.lanes) return ''

  const recurring = Object.keys(audit.lanes).filter(k => audit.lanes[k].outcome === 'recurring')
  const names = joinList(recurring.map(humanizeLane))
  if (!names) return ''
  // The "for N mornings" figure is the longest standing run among the recurring lanes.
  let n = 0
  for (const k of recurring) n = Math.max(n, audit.lanes[k].current_run)
  return `Our lead-selection auto-tuner has had to reset ${names} ${n} ${n === 1 ? 'morning' : 'mornings'} running — the model keeps re-learning the same wobble; time to pin it or take a closer look.`
}

module.exports = {
  auditLeadPolicyGovernance,
  shouldEscalateGovernance,
  narrateLeadPolicyGovernanceAudit,
  humanizeLane,
  DEFAULT_WINDOW,
  DEFAULT_RECURRING_RUNS,
  DEFAULT_MIN_HISTORY,
  DEFAULT_CORRECTING_ACTIONS,
}
