'use strict'

// ============================================================
// lib/briefEngagement.js — does the Morning Brief actually LAND with the people
// who read it? The dashboard's first consumer-feedback loop.
//
// THE GAP THIS CLOSES
// -------------------
// Layers 10–17 grew the intelligence stack a deep SELF-governance spine: the
// brief grades its own narration health ([[briefQuality]]), its delivery
// ([[briefDelivery]]), its editorial precision ([[briefImpact]]), and a whole
// lead-selection policy tower governs, audits and remediates ITSELF (13→17).
// Every one of those loops is INWARD-facing — the system watching the system.
// Not one of them asks the only question a consumer-facing product ultimately
// lives or dies on: did the human on the other end find the morning brief
// USEFUL? The brief is written, scored, delivered, and self-audited — and then
// it vanishes into an inbox with no signal coming back. A brief can be perfectly
// grounded, narrated in the model's own words, delivered on time, and still be
// landing flat with the client every single morning, and nothing anywhere would
// know. This module opens the missing OUTWARD loop: it reads the lightweight
// vote a client can leave on a morning brief ("was this useful?  👍 / 👎") and
// distils that vote history into one learned reception score — per client, or
// across the whole book — so the agency finally hears whether the product is
// actually working for the people it is built for. It is the "best for
// consumers / self-improving" half of the mandate the inward loops never reach:
// the consumers now teach the system how it is doing.
//
// HONEST BY ABSTENTION — A MINIMUM VOTE COUNT
// -------------------------------------------
// A reception rate off one or two votes is noise dressed as a verdict. So the
// same discipline the rest of this family uses applies here: below `minVotes`
// (default 3) gradeable votes the record is too thin to trust a rate from ⇒
// status:'insufficient', helpful_rate:null — abstain, never guess. The raw tally
// (helpful / not_helpful / n) rides on EVERY return path, even when we abstain,
// so a caller always sees how thin the record is rather than a bare zero. Same
// shape as [[pulseReliability]]'s minFires and [[pulseAccuracy]]'s minFires.
//
// A RECENT-VS-OLDER TREND — ALSO GATED
// ------------------------------------
// A flat lifetime average hides the only movement that matters: is reception
// getting BETTER or WORSE? So once there are enough votes to split honestly
// (≥ 2·minVotes, guaranteeing ≥ minVotes on each side), the history is halved by
// time and the two halves' rates compared; a swing of at least TREND_DELTA names
// it improving or declining, otherwise steady. Below that threshold trend is
// null — never a direction inferred from a couple of points.
//
// AGENCY-ONLY BY CONSTRUCTION — THE CLIENT NEVER SEES THE AGGREGATE
// ----------------------------------------------------------------
// This is the load-bearing privacy invariant. The client CONTRIBUTES the signal
// (their own 👍/👎, reflected straight back to them in the UI as their own vote)
// but must NEVER see the aggregate it rolls up into — a client has no business
// being shown "clients find this useful 60% of the time," and an individual's
// reception rate told back to them is both pointless and faintly accusatory. So
// narrateBriefEngagement returns '' for a client audience UNCONDITIONALLY — not
// "only the positive case" like the reliability/accuracy notes, but nothing at
// all, ever. The engagement aggregate (helpful_rate, sample, label, trend) is an
// agency calibration instrument, full stop. Enforcing that in the module — not
// leaving each surface to remember — is what makes the no-leak test in 18d a
// statement about this function rather than a hope about its callers.
//
// PURE: vote events in, a reception grade out. No DB, no clock-of-now, no
// network, no LLM, no mutation, never throws. It reasons only over fields already
// on each event ({ as_of, signal }), so it stays trivially testable on plain
// literals — exactly like the rest of the brief/pulse family. Scope-agnostic by
// design: hand it ONE client's votes for a per-client read, or every client's
// votes for the portfolio read — it just grades the list it is given.
// ============================================================

// The two signals a vote can carry. Anything else on an event is counted as
// `ignored` (never in the denominator) — a forward-compatible guard so a future
// 'dismissed'/'unsure' signal can't silently corrupt the helpful rate.
const HELPFUL = 'helpful'
const NOT_HELPFUL = 'not_helpful'

// Minimum gradeable votes before a reception rate is trustworthy. Below this the
// record is too thin to grade — abstain (mirrors pulseReliability.minFires and
// pulseAccuracy.minFires: honesty by abstention, never a guess off one or two).
const DEFAULT_MIN_VOTES = 3

// Half-over-half swing in helpful_rate that names a trend. Below it, reception is
// 'steady' — a real shift has to move the rate by at least this much to count as
// improving or declining, so single-vote wobble never reads as a direction.
const TREND_DELTA = 0.15

const str = (x) => (x == null ? '' : String(x))
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const round4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null)
const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many)

// engagementLabel(r) — the plain-language band for a helpful_rate in [0,1].
// well_received ≥ 0.75 · fair 0.50–0.74 · poorly_received < 0.50 · null → null.
// One source of truth for the word the engine attaches and the agency UI renders
// (the client UI renders none of it — see header). Deliberately distinct vocab
// from reliabilityLabel (reliable/mixed/noisy) and accuracyLabel
// (proven/developing/learning) so the three scores never blur together in logs.
function engagementLabel(r) {
  if (r == null || !Number.isFinite(r)) return null
  if (r >= 0.75) return 'well_received'
  if (r >= 0.5) return 'fair'
  return 'poorly_received'
}

const ymdToUTC = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(s))
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
// Inclusive day span between two YYYY-MM-DD strings. Date.UTC is a pure static
// call — deterministic, no clock-of-now — so this stays testable on literals.
function daySpan(from, to) {
  const a = ymdToUTC(from)
  const b = ymdToUTC(to)
  if (a == null || b == null) return null
  return Math.round((b - a) / 86400000) + 1
}

/**
 * summarizeBriefEngagement(events, opts)
 *   events : an array of brief-feedback votes, each { as_of, signal } where signal
 *            is 'helpful' | 'not_helpful' (any other value is counted as `ignored`
 *            and excluded from the rate). Order-independent — sorted internally by
 *            as_of so the result is identical for any input ordering. Pass ONE
 *            client's votes for a per-client read, or all clients' votes for the
 *            portfolio read; the function is scope-agnostic.
 *   opts   : { minVotes=3 } — the abstention floor on gradeable votes. Optional;
 *            validated to a positive integer.
 *
 * Returns a grade (never throws):
 *   { status:'graded'|'insufficient',
 *     total, helpful, not_helpful, ignored, n, min_votes,   // counts, EVERY path
 *     window: { from, to, days },                           // min..max as_of span
 *     helpful_rate,                 // helpful / n (rounded 4) | null when abstaining
 *     label,                        // engagementLabel(helpful_rate) | null
 *     trend,                        // 'improving'|'declining'|'steady' | null (gated)
 *     recent_rate, older_rate,      // the two half-rates the trend compares | null
 *     reason }                      // 'insufficient_history'|'insufficient_votes'|'graded'
 *   • 'insufficient' — no gradeable votes at all (reason 'insufficient_history'),
 *      or fewer than minVotes (reason 'insufficient_votes'); helpful_rate:null.
 *   • 'graded'       — helpful_rate ∈ [0,1], label set; trend set iff n ≥ 2·minVotes.
 *   Invariant: helpful + not_helpful === n, and n + ignored === total, on EVERY path.
 */
function summarizeBriefEngagement(events, opts = {}) {
  const minVotes =
    Number.isInteger(opts.minVotes) && opts.minVotes > 0 ? opts.minVotes : DEFAULT_MIN_VOTES
  const minTrend = 2 * minVotes

  const list = (Array.isArray(events) ? events : []).filter(Boolean)

  // Stable ascending sort by as_of (tie-break signal) so the trend's time-split and
  // the window read off one order, identical for any input ordering.
  const sorted = list
    .slice()
    .sort((a, b) => cmpStr(str(a.as_of), str(b.as_of)) || cmpStr(str(a.signal), str(b.signal)))

  // Single pass for the tally; collect the valid votes in time order for the trend.
  let helpful = 0
  let notHelpful = 0
  let ignored = 0
  const validSignals = [] // 'helpful'|'not_helpful' in as_of order — for the half-split
  for (const e of sorted) {
    if (e.signal === HELPFUL) {
      helpful++
      validSignals.push(HELPFUL)
    } else if (e.signal === NOT_HELPFUL) {
      notHelpful++
      validSignals.push(NOT_HELPFUL)
    } else {
      ignored++
    }
  }
  const n = helpful + notHelpful

  const from = sorted.length ? str(sorted[0].as_of) : null
  const to = sorted.length ? str(sorted[sorted.length - 1].as_of) : null
  const window = { from, to, days: sorted.length ? daySpan(from, to) : 0 }

  // The bookkeeping every return path carries verbatim, so a consumer always sees
  // how thin (or thick) the record is — even when we ultimately abstain.
  const counts = {
    total: sorted.length,
    helpful,
    not_helpful: notHelpful,
    ignored,
    n,
    min_votes: minVotes,
  }
  const abstain = (reason) => ({
    status: 'insufficient',
    ...counts,
    window,
    helpful_rate: null,
    label: null,
    trend: null,
    recent_rate: null,
    older_rate: null,
    reason,
  })

  if (n === 0) return abstain('insufficient_history')
  if (n < minVotes) return abstain('insufficient_votes')

  const helpfulRate = round4(helpful / n)

  // Trend: halve the valid votes by time and compare the two halves' rates. Gated on
  // n ≥ 2·minVotes so each half is guaranteed ≥ minVotes — never a direction off a
  // couple of points. Below the gate, trend stays null (an honest "not enough yet").
  let trend = null
  let recentRate = null
  let olderRate = null
  if (n >= minTrend) {
    const split = Math.floor(n / 2)
    const older = validSignals.slice(0, split)
    const recent = validSignals.slice(split)
    const rateOf = (arr) => arr.filter((s) => s === HELPFUL).length / arr.length
    olderRate = round4(rateOf(older))
    recentRate = round4(rateOf(recent))
    const delta = recentRate - olderRate
    trend = delta >= TREND_DELTA ? 'improving' : delta <= -TREND_DELTA ? 'declining' : 'steady'
  }

  return {
    status: 'graded',
    ...counts,
    window,
    helpful_rate: helpfulRate,
    label: engagementLabel(helpfulRate),
    trend,
    recent_rate: recentRate,
    older_rate: olderRate,
    reason: 'graded',
  }
}

/**
 * narrateBriefEngagement(grade, opts) — ONE grounded agency sentence about a
 * graded reception. AGENCY-ONLY BY CONSTRUCTION: returns '' for
 * opts.audience === 'client' UNCONDITIONALLY (the aggregate is internal
 * calibration; the client sees only their own vote reflected back, never this —
 * see header). Returns '' for an un-graded / missing grade (nothing trustworthy
 * to say). Every figure it cites (helpful, n, the %) is copied straight off the
 * grade, so the sentence can never disagree with the score it explains.
 *   opts : { audience, scopeLabel='Clients' }
 *
 *   well_received   : "Clients found the morning brief useful 17 of 20 times recently (~85%) — well received."
 *   fair            : "Clients found the morning brief useful 11 of 20 times recently (~55%) — a fair reception."
 *   poorly_received : "Clients found the morning brief useful 4 of 20 times recently (~20%) — poorly received; worth a closer look."
 *   + trend clause  : improving → " Reception has been improving lately."; declining → " Heads up — reception has been slipping lately."
 */
function narrateBriefEngagement(grade, opts = {}) {
  if (opts.audience === 'client') return ''
  if (!grade || grade.status !== 'graded' || grade.helpful_rate == null) return ''

  const scope = opts.scopeLabel || 'Clients'
  const pct = Math.round(grade.helpful_rate * 100)
  const noun = plural(grade.n, 'time', 'times')

  const phrase =
    grade.label === 'well_received'
      ? 'well received'
      : grade.label === 'poorly_received'
        ? 'poorly received; worth a closer look'
        : 'a fair reception'

  let s = `${scope} found the morning brief useful ${grade.helpful} of ${grade.n} ${noun} recently (~${pct}%) — ${phrase}.`

  if (grade.trend === 'improving') s += ' Reception has been improving lately.'
  else if (grade.trend === 'declining') s += ' Heads up — reception has been slipping lately.'

  return s
}

module.exports = {
  summarizeBriefEngagement,
  narrateBriefEngagement,
  engagementLabel,
  DEFAULT_MIN_VOTES,
}
