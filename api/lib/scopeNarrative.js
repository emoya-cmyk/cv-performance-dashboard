'use strict'

// ============================================================
// lib/scopeNarrative.js — the on-demand bridge between a live scope
// (date range + filters + resolved tenancy) and a freshly narrated
// insight. This is what makes the dashboard's insight text + recommendations
// regenerate when a filter or date changes, not just the numbers.
//
// It does TWO reads through the real semantic compiler and nothing else:
//   1. a totals spec  (groupBy: [])        → the scope's current/previous KPIs
//   2. a channel spec (groupBy: ['channel'])→ the drivers behind the move
// then hands both to the pure narrator in ./scopeInsight.
//
// LEAK INVARIANT (intel-v13): drivers are ALWAYS by channel — a global,
// non-tenant-identifying axis that is safe on BOTH the agency portfolio view
// and a per-client / shared-link payload. We never group drivers by client,
// never honour a client-dim filter from the body, and never read a tenant id
// from the request — tenancy is pinned by the resolved `scope.scopeClientId`
// the route computed, never a body param.
// ============================================================

const { runQuerySpec } = require('../semantic/compile')
const { CHANNEL_LABELS, metricKeyDeps, channelId } = require('../semantic/registry')
const { generateScopeInsight } = require('./scopeInsight')
const { diffScopeInsights } = require('./scopeDelta')
const { detectScopeTrends } = require('./scopeTrend')
const { projectScopeTrend } = require('./scopeNowcast')
const { gradeScopeNowcast } = require('./scopeNowcastAccuracy')
const { calibrateNowcastBand } = require('./scopeNowcastBand')
const { calibrateNowcastVoice } = require('./scopeNowcastVoice')
const { corroborateNowcast } = require('./scopeNowcastCorroboration')
const { assessNowcastCoherence } = require('./scopeNowcastCoherence')
const scopeFreshness = require('./scopeFreshness')

// The six KPIs the narrator speaks. Every id here is valid in BOTH the ask
// vocabulary (labels/units/polarity) and the semantic registry (queryable).
const SCOPE_METRICS = ['revenue', 'leads', 'spend', 'roas', 'cpl', 'close_rate']
const MAX_CHANNELS = 12
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Order-preserving, de-duped intersection of the caller's wish list with
// SCOPE_METRICS. Anything outside the allow-list (e.g. a bare `jobs`) is
// dropped; an empty/garbage request falls back to the full set.
function pickMetrics(requested) {
  if (!Array.isArray(requested) || !requested.length) return SCOPE_METRICS.slice()
  const want = new Set(requested)
  const picked = SCOPE_METRICS.filter(m => want.has(m))
  return picked.length ? picked : SCOPE_METRICS.slice()
}

// Tenancy comes ONLY from the resolved scope, never from the body.
//   null  → agency portfolio (all clients)
//   id    → a single client, as a one-element string array
function clientsForScope(scopeClientId) {
  return scopeClientId == null ? 'all' : [String(scopeClientId)]
}

// Keep only well-formed channel filters from the body. Client-dim filters are
// intentionally discarded — honouring one would (a) re-introduce a client axis
// the leak invariant forbids and (b) let a shared link narrow into a tenant it
// was not scoped to.
function channelFiltersFrom(filters) {
  if (!Array.isArray(filters)) return []
  return filters
    .filter(f =>
      f && typeof f === 'object' && f.dim === 'channel' &&
      (f.op == null || f.op === 'in') && Array.isArray(f.values) && f.values.length)
    .map(f => ({ dim: 'channel', op: 'in', values: f.values.slice() }))
}

function buildTotalsSpec({ metrics, dateRange, clients, channelFilters, compareTo }) {
  return {
    metrics,
    dateRange,
    ...(clients === 'all' ? {} : { clients }),
    groupBy: [],
    filters: channelFilters,
    compareTo,
    limit: 1,
  }
}

function buildChannelDriversSpec({ metrics, dateRange, clients, channelFilters, compareTo }) {
  return {
    metrics,
    dateRange,
    ...(clients === 'all' ? {} : { clients }),
    groupBy: ['channel'],
    filters: channelFilters,
    compareTo,
    limit: MAX_CHANNELS,
  }
}

// A human window label derived from the RESOLVED window the compiler returned
// (meta.dateRange), so it always matches the numbers. Bare phrase, no "vs".
function windowLabelFrom(range) {
  if (!range || !range.start || !range.end) return null
  const [sy, sm, sd] = range.start.split('-').map(Number)
  const [ey, em, ed] = range.end.split('-').map(Number)
  if (range.start === range.end) return `${MONTHS[sm - 1]} ${sd}, ${sy}`
  if (sy === ey && sm === em) return `${MONTHS[sm - 1]} ${sd}–${ed}, ${sy}`
  if (sy === ey) return `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}, ${sy}`
  return `${MONTHS[sm - 1]} ${sd}, ${sy} – ${MONTHS[em - 1]} ${ed}, ${ey}`
}

// Compare-clause label. MUST carry the literal "vs " prefix the narrator
// splices verbatim. null when there is no compare window.
function compareLabelFrom(compareTo, compareWindow) {
  if (!compareWindow) return null
  if (compareTo === 'previous_period') return 'vs the prior period'
  if (compareTo === 'previous_year') return 'vs the same period last year'
  const lbl = windowLabelFrom(compareWindow)
  return lbl ? `vs ${lbl}` : 'vs the prior period'
}

// Pull just the scoped metric ids out of a projected row, coercing to finite
// numbers and skipping anything missing/non-numeric.
function pickMetricValues(src, metrics) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const m of metrics) {
    const v = src[m]
    if (v != null && Number.isFinite(Number(v))) out[m] = Number(v)
  }
  return out
}

// Turn channel-breakdown rows into the narrator's drivers shape, labelling by
// the human channel name (never the raw id). Returns null when there is nothing
// to attribute.
function driversFromChannelRows(rows, metrics) {
  if (!Array.isArray(rows) || !rows.length) return null
  const out = []
  for (const r of rows) {
    if (!r || r.channel == null) continue
    out.push({
      label: CHANNEL_LABELS[r.channel] || String(r.channel),
      current: pickMetricValues(r, metrics),
      previous: r._compare ? pickMetricValues(r._compare, metrics) : undefined,
    })
  }
  return out.length ? { dim: 'channel', rows: out } : null
}

// The entry point the route calls. `input` = request body (metrics?, dateRange,
// filters?, compareTo?, since?); `query` = the shared pg query fn; `scope` = the
// route-resolved tenancy ({scopeClientId, role}). Returns the narrator payload
// plus a small `scope_applied` echo and the resolved windows.
//
// intel-v14 D1: when the caller hands us `since` — a compact snapshot
// ([{metric,current}]) of the read they were looking at — we ALSO attach a
// session-relative `delta` block ("since you last looked: revenue +$1,240…"),
// the diff of that prior read against this fresh narration. This is purely
// ADDITIVE: a caller that omits `since` gets a byte-identical response (no
// `delta` key at all). Leak-safe by construction — both sides are the same
// already-tenant-scoped scope-insight surface (drivers attributed only by the
// global CHANNEL axis), and scopeDelta emits no tenant identity. The fresh
// `next` side is tenancy-pinned upstream; `since` is only the subtrahend, so a
// client can at most skew its OWN delta strip, never see another tenant's data.
async function runScopeInsight(input, query, scope) {
  const opts = input && typeof input === 'object' ? input : {}
  const sc = scope && typeof scope === 'object' ? scope : {}

  const metrics = pickMetrics(opts.metrics)
  const dateRange = opts.dateRange
  const clients = clientsForScope(sc.scopeClientId)
  const channelFilters = channelFiltersFrom(opts.filters)
  const compareTo = 'compareTo' in opts ? opts.compareTo : 'previous_period'

  const totals = await runQuerySpec(
    buildTotalsSpec({ metrics, dateRange, clients, channelFilters, compareTo }), query)
  const totalRow = totals.rows[0] || null
  const current = totalRow ? pickMetricValues(totalRow, metrics) : {}
  const previous = totalRow && totalRow._compare ? pickMetricValues(totalRow._compare, metrics) : undefined

  let drivers = null
  if (totalRow) {
    const breakdown = await runQuerySpec(
      buildChannelDriversSpec({ metrics, dateRange, clients, channelFilters, compareTo }), query)
    drivers = driversFromChannelRows(breakdown.rows, metrics)
  }

  const windowLabel = windowLabelFrom(totals.meta.dateRange) || undefined
  const compareLabel = compareLabelFrom(compareTo, totals.meta.compareTo)

  const narration = generateScopeInsight({
    metrics, current, previous, windowLabel, compareLabel, drivers, limit: metrics.length,
  })

  const result = {
    ...narration,
    scope_applied: { role: sc.role || null, clients, metrics },
    window: totals.meta.dateRange,
    compare_window: totals.meta.compareTo,
  }

  // ADDITIVE: only when the caller opted into session-relative narration by
  // sending a `since` snapshot. Absent `since` ⇒ no `delta` key ⇒ byte-identical
  // to every pre-D1 caller. diffScopeInsights is fail-safe (junk/empty `since`
  // degrades to status 'baseline'), so this never throws on a malformed body.
  if (opts.since !== undefined) {
    result.delta = diffScopeInsights(opts.since, narration)
  }

  // ADDITIVE (intel-v14 D2): when the caller sends a non-empty `history` — the
  // PRIOR reads it has buffered this session (oldest→newest, each a compact
  // [{metric,current}] snapshot, the same shape `since` uses) — we append THIS
  // fresh narration as the newest read and look for a metric on a multi-read
  // streak ("revenue has climbed 3 straight updates", "CPL has risen 3 straight
  // updates — worth a look"). A single hop is a blip; a streak is the signal.
  // Purely additive: omit `history` (or send an empty array) ⇒ no `trend` key ⇒
  // byte-identical to every pre-D2 caller. detectScopeTrends is fail-safe (junk /
  // too-short history degrades to status 'insufficient'/'flat', never throws) and
  // leak-safe (emits metric labels + run shape only — no tenant identity; the
  // history entries are the panel's own already-tenant-scoped snapshots and the
  // fresh `narration` is tenancy-pinned upstream, so a client can at most shape
  // its OWN trend strip, never see another tenant's reads).
  if (Array.isArray(opts.history) && opts.history.length) {
    result.trend = detectScopeTrends([...opts.history, narration], opts)
  }

  // ADDITIVE (intel-v14 D3): once a metric is on a confirmed multi-read STREAK
  // (result.trend.status === 'trending'), project where it is heading AT THE
  // CURRENT PACE ("at this pace, revenue reaches ~$13,000 next update"). This
  // rides strictly on top of D2: no streak ⇒ no `trend` ⇒ no `nowcast` key, so
  // a pre-D3 caller's envelope is byte-identical. projectScopeTrend consumes the
  // already-leak-safe trend payload (metric labels + the run's own bare values,
  // no tenant identity) and is itself pure + fail-safe (junk degrades to status
  // 'none', never throws), so this stays leak-safe and cannot break the response.
  if (result.trend && result.trend.status === 'trending') {
    result.nowcast = projectScopeTrend(result.trend, opts)

    // ADDITIVE (intel-v14 D4): grade that projection against itself. We replay the
    // nowcast over the SAME buffered series ([...history, this fresh read]) — for each
    // interior prefix, reproduce the one-step projection that WOULD have been shown and
    // compare it to the read that actually followed — yielding a "within ~X% of actual"
    // confidence beneath the live projection. This rides strictly on top of D3: the key
    // only appears when there is a projected nowcast AND enough buffered reads to grade
    // (≥4), so a caller with a fresh streak but a short buffer gets `nowcast` with NO
    // `accuracy` sub-key — byte-identical to a pre-D4 caller. gradeScopeNowcast is pure,
    // deterministic, fail-safe (junk / too-little history → status 'none', never throws)
    // and leak-safe (it reads the same already-tenant-scoped buffered snapshots and emits
    // only metric labels + bare error statistics — no tenant identity), so it can neither
    // break the response nor widen the blast radius beyond the caller's own reads.
    if (result.nowcast && result.nowcast.status === 'projected') {
      // ADDITIVE (intel-v14 D7): cross-check the projection against a GENUINELY
      // INDEPENDENT lens. D4–D6 grade the nowcast against its OWN past error — a
      // self-backtest that is structurally blind to a regime change (right at a
      // turning point it can speak most confidently exactly when it is most wrong).
      // The honest guard is a second opinion with its own reference frame: the
      // `delta` lens (how the lead metric moved since the caller last looked). It is
      // the only independent witness here — scopeNowcast copies the projection's
      // direction straight from the trend, and the trend's run is by construction the
      // maximal same-direction streak ending at the latest read, so trend, latest
      // in-buffer step, and nowcast all share one trajectory; only delta can diverge.
      // Computed OUTSIDE the graded branch, on purpose: corroboration needs only the
      // projected nowcast + an independent delta lens, NOT a buffer long enough to
      // grade — so a fresh streak with a since-snapshot but a short history is still
      // corroborated. This rides strictly on top of D3 + D1: the `corroboration` key
      // appears ONLY when the lead trajectory was cross-checked against ≥1 independent
      // lens (status 'corroborated'); with no `since` there is no `result.delta`, so
      // the module returns status 'none' and NO key is attached — byte-identical to a
      // pre-D7 caller. It can only add an "aligned" reassurance or a "mixed" caution;
      // it never mutates the headline, the voice, or any number, and never inflates
      // confidence. corroborateNowcast is pure, deterministic, fail-safe (junk →
      // status 'none', never throws) and leak-safe (it consumes the already-leak-safe
      // projection + delta and emits a metric label + direction words + small counts —
      // no tenant identity), so it can neither break the response nor widen the blast
      // radius. The module stays pure: the projection↔delta join lives here in the
      // wiring, exactly as the D4/D5/D6 composes below it.
      const corroboration = corroborateNowcast(result.nowcast, result.delta, opts)
      if (corroboration && corroboration.status === 'corroborated') result.nowcast.corroboration = corroboration

      // ADDITIVE (intel-v14 D8): corroboration (D7) cross-checks the LEAD projection
      // against an independent lens; this asks a different, orthogonal question — does
      // the WHOLE projected basket tell ONE coherent story, or is the headline metric
      // masking trouble underneath it? D1–D7 are every one lead-centric (they reason
      // about the single most-salient projection), so none of them can see the classic
      // vanity-metric trap: revenue projected up and triumphant while, in the same
      // basket, cost per lead is projected up (worsening) and leads projected down. D8
      // reads the FULL projections[] vector and classifies it by POLARITY (the
      // `improving` flag the pace oracle already attached, so a rising cost reads as
      // "worsening" not merely "up"): unified (all metrics improving — the headline is
      // backed by the whole story), deteriorating (all worsening — the weakness is
      // broad), or divergent (both present — name the tension so the headline is read
      // with the cost it hides). Computed OUTSIDE the graded branch alongside D7, on
      // purpose: coherence needs only ≥2 polarity-bearing projections, NOT a buffer long
      // enough to grade, so a fresh multi-metric streak still gets the cross-metric
      // check. The `coherence` key appears ONLY when status 'assessed' (≥2 metrics carry
      // a clean improving boolean); a single-metric nowcast returns status 'none' and NO
      // key is attached — byte-identical to a pre-D8 caller. It can only add a unified
      // reassurance or a divergent/deteriorating caution beside the voice; it never
      // mutates the headline, the voice, the corroboration, or any number, and never
      // inflates confidence. assessNowcastCoherence is pure, deterministic, fail-safe
      // (junk → status 'none', never throws) and leak-safe (it consumes the already-
      // leak-safe projection set and emits metric labels + direction words + small
      // counts — no tenant identity), so it can neither break the response nor widen the
      // blast radius.
      const coherence = assessNowcastCoherence(result.nowcast, opts)
      if (coherence && coherence.status === 'assessed') result.nowcast.coherence = coherence

      const accuracy = gradeScopeNowcast([...opts.history, narration], opts)
      if (accuracy && accuracy.status === 'graded') {
        result.nowcast.accuracy = accuracy

        // ADDITIVE (intel-v14 D5): now that the projection has a MEASURED accuracy,
        // size a calibrated band around each projected value from that metric's OWN
        // sMAPE (pooled-overall fallback) and pin it onto the matching projection as
        // `.band`, so the surface can read "≈ $13,000, likely $12,810–$13,856 (±4%)"
        // instead of implying a precision the backtest never earned. This rides
        // strictly on top of D4: the band is computed only INSIDE the graded branch,
        // so a streak whose buffer is too short to grade (no `accuracy`) carries no
        // `band` either — byte-identical to a pre-D5 caller. calibrateNowcastBand is
        // pure, deterministic, fail-safe (junk → status 'none', never throws) and
        // leak-safe (it consumes the already-leak-safe projection values + accuracy
        // grade and emits metric labels + bare numeric bounds — no tenant identity),
        // so attaching its per-metric output cannot break the response nor leak across
        // tenants. The module stays pure: the projection↔band join lives here in the
        // wiring, exactly as the D4 accuracy attach composed above it.
        const band = calibrateNowcastBand(result.nowcast, accuracy, opts)
        if (band && band.status === 'calibrated' && Array.isArray(band.bands)) {
          const bandByMetric = new Map(band.bands.map(b => [String(b.metric), b]))
          for (const p of result.nowcast.projections) {
            if (!p || p.metric == null) continue
            const b = bandByMetric.get(String(p.metric))
            if (b) p.band = b
          }
        }

        // ADDITIVE (intel-v14 D6): the projection now carries a MEASURED band, so
        // RE-VOICE the most-read line — the headline — at the lead metric's own
        // measured confidence. D3 wrote one fixed, confident headline at projection
        // time, before any backtest existed; D6 caps that confidence by the lead
        // band's sMAPE (halfPct): state the number plainly when the record is tight
        // (firm), keep the "~" and append the earned range when reliable (measured),
        // soften to "roughly" with the ± it has been missing by when shaky
        // (tentative), or name only the direction and refuse the figure when too
        // volatile (withheld). The headline stops over-claiming — it speaks exactly
        // as firmly as its backtest earns. This rides strictly on top of D5: the
        // `voice` key appears ONLY when the lead metric earned a calibrated band
        // (status 'voiced'); a graded streak whose band did not calibrate for the
        // lead metric carries no `voice` — byte-identical to a pre-D6 caller. We do
        // NOT mutate nowcast.headline; the re-voiced sentence rides alongside it as
        // nowcast.voice.headline so the surface chooses, and a pre-D6 reader sees the
        // exact D3 line. calibrateNowcastVoice is pure, deterministic, fail-safe
        // (junk → status 'none', never throws) and leak-safe (it consumes the
        // already-leak-safe projection, grade and band and emits a metric label +
        // bare numbers + confidence phrasing — no tenant identity), so it can neither
        // break the response nor widen the blast radius. The module stays pure: the
        // attach lives here in the wiring, exactly as the D4/D5 composes above it.
        const voice = calibrateNowcastVoice(result.nowcast, accuracy, band, opts)
        if (voice && voice.status === 'voiced') result.nowcast.voice = voice
      }
    }
  }

  return result
}

// ── intel-v13 C4 (step b): the CHEAP per-scope data-version probe ────────────
// runScopeInsight does two grouped reads and a narration; this does ONE tiny
// aggregate over the SAME scoped rows (GROUP BY metric_key → a handful of
// partials) and folds them into an opaque token via lib/scopeFreshness. The FE
// polls this on a live tick, compares the token to its baseline, and only fires
// the expensive re-narration when it MOVED — so a global SSE broadcast (which
// carries no tenant id) costs one cheap query here, not a full re-narrate, for
// the tenants whose data did not actually change.
//
// It mirrors the compiler's WHERE exactly so the token tracks PRECISELY the rows
// the insight would read: same tenancy pin (scope.scopeClientId only, never a
// body param), same current window, same channel-filter INTERSECT semantics, and
// the same metric_key restriction (the union of metricKeyDeps over the picked
// metrics — close_rate → closed_won+raw_leads, roas → revenue+spend, …).
//
// LEAK-SAFE: the response is ONLY { version, freshAt }. The token embeds no
// tenant identity and no peer data (it is a content fingerprint of the caller's
// already-tenant-scoped rows), and is only ever compared against an earlier
// probe of the SAME scope.
const SCOPE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function badScopeRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

// Resolve the body's channel filters to a concrete, INTERSECTED set of integer
// channel_ids — exactly as the semantic compiler does (sequential intersect; an
// unknown channel key is a 400, never a silent empty result). Returns null when
// no channel filter was supplied (→ no channel_id predicate, i.e. all channels).
function resolveChannelIds(channelFilters) {
  let ids = null
  for (const f of channelFilters) {
    const these = f.values.map(v => channelId(v))
    if (these.some(x => x == null)) throw badScopeRequest('filter on channel contains an unknown channel key')
    ids = ids ? ids.filter(x => these.includes(x)) : these
  }
  return ids
}

async function runScopeFreshness(input, query, scope) {
  const opts = input && typeof input === 'object' ? input : {}
  const sc = scope && typeof scope === 'object' ? scope : {}

  // The window is always concrete on this path (the FE only probes once it has a
  // start+end). Validate strictly — a malformed window is a 400, never a silent
  // full-table scan.
  const dr = opts.dateRange
  const start = dr && dr.start
  const end = dr && dr.end
  if (!SCOPE_DATE_RE.test(String(start)) || !SCOPE_DATE_RE.test(String(end))) {
    throw badScopeRequest('dateRange.start and dateRange.end must be YYYY-MM-DD')
  }
  if (start > end) throw badScopeRequest('dateRange.start must be on or before dateRange.end')

  const metrics = pickMetrics(opts.metrics)
  const clients = clientsForScope(sc.scopeClientId)
  const channelIds = resolveChannelIds(channelFiltersFrom(opts.filters))

  // The base metric_keys behind the picked metrics — the SAME union the compiler
  // fetches. pickMetrics never returns empty and every scope metric has deps, so
  // metricKeys is always non-empty (no degenerate `IN ()`).
  const metricKeys = [...new Set(metrics.flatMap(metricKeyDeps))]

  // Build the cheap aggregate with the compiler's positional-param helper, in the
  // compiler's WHERE order: clients → window → channels → metric_keys.
  const params = []
  const P = (v) => { params.push(v); return '$' + params.length }
  const where = []
  if (clients !== 'all') {
    where.push(`client_id IN (${clients.map(c => P(c)).join(', ')})`)
  }
  where.push(`date >= ${P(start)}`)
  where.push(`date <= ${P(end)}`)
  if (channelIds && channelIds.length) {
    where.push(`channel_id IN (${channelIds.map(id => P(id)).join(', ')})`)
  }
  where.push(`metric_key IN (${metricKeys.map(k => P(k)).join(', ')})`)

  // CAST(MAX(date) AS TEXT): fact_metric.date is DATE in Postgres (node-pg hands
  // back a JS Date) but TEXT in SQLite — the cast yields a portable bare
  // 'YYYY-MM-DD' in BOTH drivers, which is what scopeFreshness.normDate expects.
  // COUNT/SUM may arrive as strings under pg; the fold coerces them.
  const sql =
    `SELECT metric_key,
            COUNT(*) AS rows,
            CAST(MAX(date) AS TEXT) AS max_date,
            SUM(metric_value) AS sum_value
       FROM fact_metric
      WHERE ${where.join('\n        AND ')}
      GROUP BY metric_key`

  const result = await query(sql, params)
  const rows = (result && result.rows) || []

  return {
    version: scopeFreshness.versionFromAggregate(rows),
    freshAt: new Date().toISOString(),
  }
}

module.exports = {
  runScopeInsight,
  runScopeFreshness,
  resolveChannelIds,
  SCOPE_METRICS,
  MAX_CHANNELS,
  pickMetrics,
  clientsForScope,
  channelFiltersFrom,
  buildTotalsSpec,
  buildChannelDriversSpec,
  windowLabelFrom,
  compareLabelFrom,
  pickMetricValues,
  driversFromChannelRows,
}
