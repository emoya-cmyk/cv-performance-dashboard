'use strict'

// ============================================================
// lib/briefDelivery.js — is the Morning Brief's narration FAILING right now?
//
// THE GAP THIS CLOSES
// -------------------
// [[briefQuality]] (10) gave the Morning Brief the self-grade it never had: across the
// recent history, how often did narration speak in its own words versus fall back to the
// grounded template? That is a STANDING grade — a picture of the window. But a grade is a
// PULL: it tells the truth only to whoever opens the panel and reads it. The failure mode
// it was built to catch — narration silently degrading to the template because a key
// expired, a provider went dark, or the model started two-timing its own grounding — is
// exactly the kind of thing nobody is watching for at 7am. The system can know its own
// narration has collapsed and still say nothing, because knowing and ALERTING are
// different acts. Every other self-grading layer in this family eventually raises its hand
// — the pulse sensors flag, the forecast grades, coverage gaps surface as insights — but
// the narration grade just sat in a card. This module is the hand-raise: it turns the
// standing grade into a DELIVERY verdict — ok / degraded / stalled — that an agency-only
// surface and the weekly digest can act on without anyone staring at the panel. The tool
// tells you its own voice is failing.
//
// WHY A SECOND MODULE, NOT A FIELD ON THE GRADE
// ---------------------------------------------
// briefQuality answers "how has narration been?" — a measurement. This answers "should I
// be alarmed, and what do I DO?" — a judgment plus a remedy. The two must not be welded:
// the measurement is audience-split, four-decimal, opinion-free, and it powers the panel's
// numbers truthfully whether or not anything is wrong. The judgment is thresholded, terse,
// and prescriptive, and it must stay SILENT when nothing is wrong (an alert that fires on
// healthy is noise that trains people to ignore it). Keeping the verdict in its own pure
// module lets the thresholds move, the remedy copy evolve, and the alarm logic get tested
// to the edge — all without touching the honest grade underneath.
//
// PER-STREAM, WORST-OF — THE STREAK HAS TO MEAN SOMETHING
// ------------------------------------------------------
// The agency and client briefs are INDEPENDENT narration streams (separate ai_briefs
// rows, one of each per morning). A stall in either is a real failure: if the client
// briefs go template while the agency brief is fine, clients are quietly getting the
// form. So we assess each audience bucket on its OWN, where streak_fellback is a run of
// consecutive DAILY briefs (the stream writes ~once a morning) and therefore reads as
// "days the narrator has been down." The portfolio verdict is the WORST of the two
// streams — the agency is alarmed if EITHER voice is failing — and the driving stream's
// figures populate the headline. Assessing the interleaved `overall` bucket instead would
// blur the streak across audiences and turn "3 mornings down" into a meaningless count.
//
// QUIET IS NOT DEGRADED — THE GATE briefQuality ALREADY DREW
// ---------------------------------------------------------
// A calm morning uses the template by DESIGN (briefQuality's narratable gate), so a bucket
// with narratable:0 has nothing failing and scores 'ok' (reason 'quiet'), never 'degraded'.
// We never invent a denominator: coverage and streak come straight off the bucket, which
// already counted only narratable briefs. quiet ≠ stalled, and an empty history is 'ok'
// (reason 'no-data'), because you cannot fail to narrate briefs that do not exist.
//
// AGENCY-ONLY, BY CONSTRUCTION
// ----------------------------
// narrateBriefDelivery returns '' for a client audience, exactly like narrateBriefHealth —
// the existence of a narration monitor, its thresholds, its provider-debugging remedy, are
// internal operations the client must never see. The no-leak discipline lives in the
// module, not in each caller's memory.
//
// PURE: a briefQuality summary in, a verdict out. No DB, no clock-of-now, no network, no
// LLM, no mutation, never throws. Reads only fields already on the summary's buckets, so it
// stays trivially testable on plain literals — like the rest of the pulse family.
// ============================================================

const round = (x, dp) => {
  const f = 10 ** dp
  return Math.round(x * f) / f
}
const str = (x) => (x == null ? '' : String(x))
const isNum = (x) => Number.isFinite(x)

// Alarm thresholds. All overridable via opts so a caller can band tighter/looser without a
// code change — every figure the verdict reports is still raw, so the bands are display, not
// truth. Streaks count consecutive most-recent narratable fallbacks WITHIN one audience
// stream (briefQuality already computed them per bucket, skipping quiet mornings).
const BRIEF_DELIVERY_THRESHOLDS = {
  stallStreak: 3,     // ≥ this many briefs in a row fell back ⇒ 'stalled' (critical)
  degradeStreak: 2,   // ≥ this many in a row fell back ⇒ at least 'degraded' (warning)
  coverageFloor: 0.5, // coverage below this over a real sample ⇒ at least 'degraded'
  minSample: 4,       // …but only once this many narratable briefs exist (no tiny-n panic)
}

// Status severity ladder — used to pick the WORSE of two streams and to map to the insight
// severity vocabulary the rest of the engine speaks.
const STATUS_RANK = { ok: 0, degraded: 1, stalled: 2 }
const STATUS_SEVERITY = { ok: 'info', degraded: 'warning', stalled: 'critical' }

const audienceLabel = (audience) => (audience === 'agency' ? 'portfolio' : 'client')

function resolveThresholds(opts = {}) {
  const t = BRIEF_DELIVERY_THRESHOLDS
  const posInt = (v, dflt) => (Number.isInteger(v) && v >= 1 ? v : dflt)
  const frac = (v, dflt) => (isNum(v) && v > 0 && v <= 1 ? v : dflt)
  return {
    stallStreak: posInt(opts.stallStreak, t.stallStreak),
    degradeStreak: posInt(opts.degradeStreak, t.degradeStreak),
    coverageFloor: frac(opts.coverageFloor, t.coverageFloor),
    minSample: posInt(opts.minSample, t.minSample),
  }
}

// Assess ONE audience bucket (briefQuality's by_audience.client | .agency shape) on its own
// terms. Returns a stream signal — never alarms on quiet/empty, so the only way to 'degraded'
// or 'stalled' is a genuine run of fallbacks or a real-sample coverage collapse.
function assessStream(bucket, audience, th) {
  const base = {
    audience,
    status: 'ok',
    severity: 'info',
    alert: false,
    reason: 'ok',
    streak: 0,
    coverage: null,
    narratable: 0,
    narrated: 0,
    fellback: 0,
    latest_as_of: null,
  }
  if (!bucket || !bucket.total) return { ...base, reason: 'no-data' }
  if (!bucket.narratable) return { ...base, reason: 'quiet' }

  const streak = Number.isInteger(bucket.streak_fellback) ? bucket.streak_fellback : 0
  const coverage = isNum(bucket.coverage) ? bucket.coverage : null
  const narratable = bucket.narratable
  const filled = {
    ...base,
    streak,
    coverage,
    narratable,
    narrated: bucket.narrated || 0,
    fellback: bucket.fellback || 0,
    latest_as_of: bucket.latest ? str(bucket.latest.as_of) : null,
  }

  let status = 'ok'
  let reason = 'ok'
  if (streak >= th.stallStreak) {
    status = 'stalled'; reason = 'stalled-streak'
  } else if (streak >= th.degradeStreak) {
    status = 'degraded'; reason = 'degraded-streak'
  } else if (coverage != null && coverage < th.coverageFloor && narratable >= th.minSample) {
    status = 'degraded'; reason = 'low-coverage'
  }

  return {
    ...filled,
    status,
    reason,
    severity: STATUS_SEVERITY[status],
    alert: status !== 'ok',
  }
}

// Pick the stream that should drive the portfolio verdict: worse status first, then the
// longer fallback streak, then the lower coverage, then a stable audience tie-break (agency
// before client) so the result is deterministic on any input.
function worseStream(a, b) {
  if (STATUS_RANK[b.status] !== STATUS_RANK[a.status]) {
    return STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a
  }
  if (b.streak !== a.streak) return b.streak > a.streak ? b : a
  const ca = a.coverage == null ? Infinity : a.coverage
  const cb = b.coverage == null ? Infinity : b.coverage
  if (ca !== cb) return cb < ca ? b : a
  return a.audience === 'agency' ? a : b
}

// The terse self-heal step — what to DO, by severity. Pure copy; no numbers, so it never
// disagrees with the figures. Same remedy whichever reason tripped: a fallback run and a
// coverage collapse both point at the narration model.
function remedyFor(status) {
  if (status === 'stalled') {
    return 'Check the narration model now — an expired API key, a rate limit, or a provider outage — then regenerate.'
  }
  return 'Worth a look at the narration model before the fallback becomes the habit.'
}

// The grounded reassurance every delivery alert carries: narration degrading NEVER means
// the numbers degraded. That orthogonality (coverage ⊥ grounded) is briefQuality's whole
// point, restated where it matters most — at the moment we're sounding an alarm.
const GROUNDED_TAIL = ' Every number stayed grounded throughout.'

// The full agency description of the driving stream's failure — straight off its figures,
// so the prose can never contradict the verdict it explains. Empty for an ok stream.
function describe(stream) {
  if (!stream || stream.status === 'ok') return ''
  const where = audienceLabel(stream.audience)
  const recent = stream.latest_as_of ? ` (most recent ${stream.latest_as_of})` : ''
  if (stream.reason === 'low-coverage') {
    const pct = stream.coverage == null ? 0 : round(stream.coverage * 100, 0)
    const noun = stream.narratable === 1 ? 'brief' : 'briefs'
    return `The ${where} morning narrator wrote only ${pct}% of the last ${stream.narratable} ${noun} worth narrating — the rest used the safe template${recent}.`
  }
  // stalled-streak / degraded-streak: a run of consecutive fallbacks.
  const verb = stream.status === 'stalled' ? 'has fallen back to the safe template' : 'fell back to the safe template'
  const times = stream.streak === 1 ? 'once' : `${stream.streak} times running`
  return `The ${where} morning brief ${verb} ${times}${recent}.`
}

/**
 * assessBriefDelivery(summary, opts)
 *   summary : the object summarizeBriefQuality(rows) returns — needs .by_audience.client and
 *             .by_audience.agency buckets. Anything else (null, array, missing buckets) is
 *             treated as no-data and yields a clean 'ok' verdict; this never throws.
 *   opts    : { stallStreak=3, degradeStreak=2, coverageFloor=0.5, minSample=4 } — alarm bands.
 *
 * Returns (never throws):
 *   {
 *     status,        // 'ok' | 'degraded' | 'stalled' — the WORSE of the two audience streams
 *     severity,      // 'info' | 'warning' | 'critical'
 *     alert,         // status !== 'ok' — the single boolean a surface gates its banner on
 *     reason,        // 'no-data' | 'quiet' | 'ok' | 'degraded-streak' | 'stalled-streak' | 'low-coverage'
 *     streak,        // driving stream's consecutive-fallback run
 *     coverage,      // driving stream's coverage (0..1) | null
 *     narratable,    // driving stream's narratable count
 *     latest_as_of,  // driving stream's most-recent narratable as_of | null
 *     audience,      // 'client' | 'agency' | null — which stream drove the verdict
 *     action,        // terse self-heal step | null when ok
 *     streams: { client:<streamSignal>, agency:<streamSignal> },  // both, for the panel split
 *   }
 *
 * A 'quiet' or 'no-data' history is 'ok' with alert:false — you cannot fail to narrate what
 * was never worth narrating. The verdict is deterministic on any input ordering because the
 * buckets it reads are already deterministically built.
 */
function assessBriefDelivery(summary, opts = {}) {
  const th = resolveThresholds(opts)
  const ba = (summary && typeof summary === 'object' && summary.by_audience) || {}
  const client = assessStream(ba.client, 'client', th)
  const agency = assessStream(ba.agency, 'agency', th)

  const driver = worseStream(client, agency)
  const alert = driver.status !== 'ok'

  return {
    status: driver.status,
    severity: driver.severity,
    alert,
    reason: alert ? driver.reason : (client.reason === 'no-data' && agency.reason === 'no-data' ? 'no-data' : (client.narratable || agency.narratable ? 'ok' : 'quiet')),
    streak: driver.streak,
    coverage: driver.coverage,
    narratable: driver.narratable,
    latest_as_of: driver.latest_as_of,
    audience: alert ? driver.audience : null,
    action: alert ? remedyFor(driver.status) : null,
    streams: { client, agency },
  }
}

/**
 * narrateBriefDelivery(signal, opts) — ONE agency sentence raising (or staying silent on)
 * the delivery alarm. AGENCY-ONLY by construction: '' for opts.audience === 'client'. '' for
 * an ok/empty verdict — a healthy or quiet narrator has nothing to announce. Otherwise:
 * description (off the driving stream's figures) + the self-heal step + the grounded
 * reassurance, in one line fit for both the panel banner and a digest row.
 *   opts : { audience }
 */
function narrateBriefDelivery(signal, opts = {}) {
  if (opts.audience === 'client') return ''
  if (!signal || !signal.alert) return ''
  const body = describe(signal.streams ? worseStream(signal.streams.client, signal.streams.agency) : signal)
  if (!body) return ''
  const action = signal.action ? ` ${signal.action}` : ''
  return `${body}${action}${GROUNDED_TAIL}`
}

module.exports = {
  assessBriefDelivery,
  narrateBriefDelivery,
  BRIEF_DELIVERY_THRESHOLDS,
}
