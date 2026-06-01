'use strict'

// ============================================================
// lib/outcomes.js — recovery classification at expiry (PURE).
//
// The engine auto-expires a finding (expireStale) the moment its condition stops
// holding — the spike normalised, the dark channel started reporting again, the trend
// reversed. But "stopped holding" hides TWO opposite stories:
//   • RECOVERED — the adverse condition cleared in the right direction. The metric
//     climbed back to its baseline; the dark channel reconnected. The finding did its
//     job and the problem is GONE. This is a win.
//   • LAPSED — the finding simply aged out of the feed with no evidence the underlying
//     problem improved (data we can no longer compare, a one-off we never saw resolve).
//
// Until now both became 'expired', and the precision loop (deriveAndPersistPrecision)
// reads EVERY expiry as "ignored." So a correct, useful finding whose problem then got
// FIXED is counted AGAINST that finding kind's confidence — exactly backwards. It both
// slanders accurate detectors and suppresses the kinds that work. This module draws the
// line, grounded in arithmetic, so 3b can stop punishing wins (and instead RECORD them)
// and 3c can surface "here's what we fixed" to all three audiences.
//
// classifyRecovery(finding, probe, opts) is the whole brain. The caller (the engine, at
// expiry time) supplies a `probe`: the current-sweep snapshot of the finding's SUBJECT —
//   • metric symptom → { current, baseline }  (that metric now + its baseline)
//   • coverage_gap   → { fresh }              (is the channel reporting again?)
// The module never reads a DB, clock, or network and never mutates its inputs — finding
// + probe in, a verdict out. No probe, or a probe that can't prove recovery → a safe
// 'lapsed'. We never FABRICATE a win: absence of proof is not recovery.
//
// Recovery gates:
//   • symptom (anomaly | trend, carrying a metric): RECOVERED when the metric has
//     returned to within `recoverFrac` of its baseline — i.e. the relative gap
//     |current − baseline| / baseline has shrunk to ≤ (1 − recoverFrac). recoverFrac=0.9
//     ⇒ the metric must sit within 10% of baseline. Direction-AGNOSTIC on purpose: a
//     drop that climbed back AND a spike that settled are both "normalised." Needs a
//     positive, finite baseline and a finite current, or there is no gap to measure →
//     lapsed ('unmeasurable').
//   • coverage_gap: RECOVERED when probe.fresh === true — the channel is delivering data
//     again. Nothing else about a connection counts as recovery.
//   • everything else (forecast / pacing / benchmark / data_health, or a symptom with no
//     metric, or an unknown kind) → lapsed. We only assert recovery for conditions we
//     can re-measure cleanly.
//
// PURE: mirrors correlate.js / attribution.js — no side effects; the caller stamps the
// result. A finding with no recovery signal classifies exactly as the system behaved
// before this layer existed (it expires) — it just won't be mislabelled a win.
// ============================================================

const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }

// Symptom kinds whose move we can re-measure against a baseline. Same set correlate.js
// treats as symptoms — anomaly (sudden) and trend (sustained) are OBSERVED metric
// deliveries; forecast/pacing/benchmark are projections/relatives with no single
// "did it come back" reading, so we never assert recovery for them here.
const RECOVERABLE_SYMPTOM_KINDS = new Set(['anomaly', 'trend'])

// Float-safe inclusive boundary. `1 - 0.9` is 0.09999999999999998 in IEEE-754, so an
// exact 10%-gap (0.1) would wrongly miss `<=` by a hair. A tiny epsilon makes the
// threshold inclusive and stable without widening it observably.
const EPS = 1e-9

function lapsed(finding, reason) {
  return {
    outcome:     'lapsed',
    recovered:   false,
    kind:        finding && finding.kind != null ? String(finding.kind) : null,
    metric:      finding && finding.metric != null ? String(finding.metric) : null,
    baseline:    null,
    current:     null,
    recoveryPct: null,
    reason:      reason || 'no_recovery_signal',
  }
}

// classifyRecovery(finding, probe, opts)
//   finding : the about-to-expire finding ({ kind, metric, direction, evidence }).
//   probe   : current-sweep snapshot of its subject —
//               symptom      → { current, baseline }
//               coverage_gap → { fresh }
//   opts    : { recoverFrac = 0.9 } — how close to baseline counts as "back."
//
// Returns { outcome, recovered, kind, metric, baseline, current, recoveryPct, reason }.
// 'recovered' is a WIN the caller can stop counting as ignored and can show as "fixed";
// 'lapsed' is the neutral aging-out that preserves today's behaviour.
function classifyRecovery(finding, probe, opts = {}) {
  if (!finding || typeof finding !== 'object') return lapsed(finding, 'no_finding')
  const kind = String(finding.kind || '')
  const p = probe && typeof probe === 'object' ? probe : null

  // ── connection came back ──────────────────────────────────────────────
  if (kind === 'coverage_gap') {
    if (p && p.fresh === true) {
      return {
        outcome:     'recovered',
        recovered:   true,
        kind,
        metric:      finding.metric != null ? String(finding.metric) : null,
        baseline:    null,
        current:     null,
        recoveryPct: null,
        reason:      'channel_reconnected',
      }
    }
    return lapsed(finding, p ? 'channel_still_dark' : 'no_recovery_signal')
  }

  // ── metric returned to baseline ───────────────────────────────────────
  if (RECOVERABLE_SYMPTOM_KINDS.has(kind) && finding.metric) {
    if (!p) return lapsed(finding, 'no_recovery_signal')
    const baseline = num(p.baseline, null)
    const current  = num(p.current, null)
    if (baseline == null || current == null || baseline <= 0) {
      return lapsed(finding, 'unmeasurable')
    }
    const recoverFrac = num(opts.recoverFrac, 0.9)
    const gap = Math.abs(current - baseline) / baseline       // relative distance to normal
    const recovered = gap <= (1 - recoverFrac) + EPS
    const recoveryPct = Math.round((current / baseline) * 100) // ~100 ⇒ back at baseline
    return {
      outcome:     recovered ? 'recovered' : 'lapsed',
      recovered,
      kind,
      metric:      String(finding.metric),
      baseline,
      current,
      recoveryPct,
      reason:      recovered ? 'metric_returned_to_baseline' : 'still_off_baseline',
    }
  }

  // ── nothing we re-measure (forecast / pacing / benchmark / data_health / unknown) ──
  return lapsed(finding, 'kind_not_recoverable')
}

module.exports = { classifyRecovery, RECOVERABLE_SYMPTOM_KINDS }
