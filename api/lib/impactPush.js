'use strict'

// ============================================================================
// lib/impactPush.js — the client-facing INFLUENCE seam (intel-v12 B4).
//
// Two PURE concerns, no I/O, no DB, no clock — so they unit-test in isolation
// and compose anywhere:
//
//   • clientImpactView(impact)        → the leak-proof {proven, note} a client
//                                        may see. The choke-point: even if an
//                                        upstream snapshot ever carried agency
//                                        internals (dollars, counts, names,
//                                        confidence, categories, by_client …),
//                                        NOTHING but {proven, note} survives —
//                                        and a note proven to be figure-free.
//
//   • detectImpactMilestone(prev,curr) → the EVENT: did this snapshot just cross
//                                        into a PROVEN track record (proven
//                                        false→true)? Returns the client-safe
//                                        note ONLY when it fires.
//
// Both read evidence_pack.intelligence.impact, the {proven, note} the evidence
// builder already strips to client-safe (evidence.intelligenceDigest →
// intelDigest.safeImpact → narrateImpactLedger(…,{audience:'client'})). This
// module is the SECOND, independent wall: it never trusts that the upstream did
// its job, so a future change upstream can't silently open a leak downstream.
//
// FAIL-SAFE: anything ambiguous collapses to "not proven" / a null note. For a
// client surface, silence is always safer than exposure — a missed celebration
// costs nothing; a leaked figure is a breach. So every guard here errs toward
// withholding, never toward showing.
// ============================================================================

const PROVEN_KEY = 'proven'

function isObj(x) {
  return x != null && typeof x === 'object' && !Array.isArray(x)
}

/**
 * Sanitise a client-facing note. narrateImpactLedger(…,{audience:'client'})
 * already returns a fixed, deliberately vague, figure-free line — but this seam
 * does not depend on that promise holding forever. A note that carries ANY
 * digit, currency mark, or percent sign could be smuggling a portfolio figure,
 * a recovered-dollar amount, or a raw count onto a client surface, so it is
 * rejected outright (collapses to null) rather than trimmed-and-hoped. A
 * non-string or blank note is null too. The result is either a clean,
 * presentable string or null — never a partial.
 *
 * @param {unknown} note
 * @returns {string|null}
 */
function safeNote(note) {
  if (typeof note !== 'string') return null
  const s = note.trim()
  if (!s) return null
  if (/\d/.test(s)) return null        // no figures of any kind (counts, amounts, dates)
  if (/[$€£%]/.test(s)) return null    // no currency or percent marks
  return s
}

/**
 * The ONLY shape a client may ever see for impact: {proven, note}. Defensive by
 * construction — accepts the raw evidence_pack.intelligence.impact snapshot (or
 * literally anything) and strips to exactly two keys. `proven` is a hard boolean;
 * `note` is non-null ONLY when the record is BOTH proven AND carries a clean,
 * figure-free note. Every other key on the input is dropped on the floor.
 *
 * @param {unknown} impact  the (untrusted) impact snapshot
 * @returns {{proven: boolean, note: string|null}}
 */
function clientImpactView(impact) {
  const proven = !!(isObj(impact) && impact[PROVEN_KEY])
  const note   = proven ? safeNote(isObj(impact) ? impact.note : null) : null
  return { proven, note }
}

/**
 * The EVENT. `reached` is true IFF the current snapshot is proven AND the prior
 * one was not (a genuine false→true crossing). A null / missing / non-proven
 * prior counts as "not proven", so a client's FIRST-EVER proven snapshot is
 * itself the milestone (correct: it is the first week we can honestly assert a
 * track record). Once proven, a subsequent proven week does NOT re-fire — the
 * crossing already happened — so wiring this into a weekly pass fires the
 * celebration at most once per genuine crossing, no operator and no dedupe table.
 *
 * The returned note is the client-safe note and is non-null ONLY when the event
 * fires AND a clean note exists; callers gate delivery on (reached && note).
 *
 * @param {unknown} prev  prior period's impact snapshot (or null)
 * @param {unknown} curr  current period's impact snapshot
 * @returns {{reached: boolean, proven: boolean, note: string|null}}
 */
function detectImpactMilestone(prev, curr) {
  const prevView = clientImpactView(prev)
  const currView = clientImpactView(curr)
  const reached  = currView.proven && !prevView.proven
  return { reached, proven: currView.proven, note: reached ? currView.note : null }
}

module.exports = { clientImpactView, detectImpactMilestone, safeNote }
