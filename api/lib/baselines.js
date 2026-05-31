'use strict'

// ============================================================
// lib/baselines.js — self-calibrating statistical baselines for the
// autonomous intelligence layer.
//
// The flat "flag any |Δ| ≥ 15%" rule treats a steady plumber and a spiky
// storm-restoration roofer identically: it cries wolf every week for the
// volatile client and stays silent for the stable one until something is
// already on fire. This module replaces that constant with per-client,
// per-metric baselines, so "unusual" is measured against THAT client's own
// history — the system calibrates itself from the data instead of from a
// hand-tuned number a human has to maintain.
//
// Robust by construction: center = median, spread = MAD (median absolute
// deviation, scaled by 1.4826 to live on the same scale as σ for normal data).
// A single freak week can't inflate the band and hide the NEXT freak week, the
// way mean/σ would. When MAD collapses (lots of ties) we fall back to σ so a
// mostly-flat series still yields a usable band.
//
// Pure functions only — no DB, no Express, no LLM — exactly like metricsCore.js.
// The engine (lib/insights.js) fetches each client's weekly series and feeds it
// here; everything returned is deterministic and unit-tested.
// ============================================================

// ---- tiny numeric helpers (all silently ignore non-finite inputs) ----------

function finite(xs) {
  const out = []
  for (const x of (Array.isArray(xs) ? xs : [])) {
    // A missing observation must be SKIPPED, never counted as 0 — otherwise an
    // absent week drags the baseline down. JS makes this a trap: Number(null),
    // Number('') and Number(false) all coerce to a finite 0, so reject those
    // shapes explicitly before the numeric check. Numeric strings (pg returns
    // NUMERIC as text) still pass through.
    if (x === null || x === undefined || x === '' || typeof x === 'boolean') continue
    const v = Number(x)
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

function mean(xs) {
  const v = finite(xs)
  if (v.length === 0) return 0
  return v.reduce((a, b) => a + b, 0) / v.length
}

// Sample standard deviation (n-1). 0 for fewer than two points.
function stddev(xs) {
  const v = finite(xs)
  if (v.length < 2) return 0
  const m = mean(v)
  const varc = v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1)
  return Math.sqrt(varc)
}

function median(xs) {
  const v = finite(xs).sort((a, b) => a - b)
  if (v.length === 0) return 0
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// Median Absolute Deviation — the robust analogue of σ.
function mad(xs) {
  const v = finite(xs)
  if (v.length === 0) return 0
  const med = median(v)
  return median(v.map(x => Math.abs(x - med)))
}

// 1.4826 makes MAD a consistent estimator of σ for normally-distributed data,
// so a robust z and a classic z share one scale (≈2 = notable, ≈3 = rare).
const MAD_TO_SIGMA = 1.4826

// Full statistical profile of a history window.
function robustStats(xs) {
  const v   = finite(xs)
  const med = median(v)
  const md  = mad(v)
  const sd  = stddev(v)
  // Prefer the robust spread; fall back to σ when MAD is 0 (e.g. a majority of
  // tied values) so a series like [10,10,10,10,40] still has a measurable band.
  const robustStd = md > 0 ? md * MAD_TO_SIGMA : sd
  return { n: v.length, mean: mean(v), std: sd, median: med, mad: md, robustStd }
}

// Robust z of `value` against a baseline `stats`: centred on the median, scaled
// by the robust spread. Returns 0 when there is no spread at all — a perfectly
// flat history simply cannot declare anything anomalous.
function robustZ(value, stats) {
  const v = Number(value)
  if (!Number.isFinite(v) || !stats) return 0
  const denom = stats.robustStd || stats.std
  if (!denom || denom <= 0) return 0
  return (v - stats.median) / denom
}

// Least-squares slope over the series index (0,1,2,…). Units = metric per
// period; sign is the trend direction, magnitude its steepness.
function linregSlope(xs) {
  const v = finite(xs)
  const n = v.length
  if (n < 2) return 0
  const xbar = (n - 1) / 2
  const ybar = mean(v)
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xbar) * (v[i] - ybar)
    den += (i - xbar) * (i - xbar)
  }
  return den === 0 ? 0 : num / den
}

// Exponentially-weighted moving average; recent periods weighted more heavily.
function ewma(xs, alpha = 0.5) {
  const v = finite(xs)
  if (v.length === 0) return 0
  let acc = v[0]
  for (let i = 1; i < v.length; i++) acc = alpha * v[i] + (1 - alpha) * acc
  return acc
}

// Map a z-score to a severity bucket. Defaults: |z| ≥ 3 critical, ≥ 2 warning.
const DEFAULT_WARN = 2
const DEFAULT_CRIT = 3

function classifyZ(z, { warn = DEFAULT_WARN, crit = DEFAULT_CRIT } = {}) {
  const a = Math.abs(Number(z) || 0)
  if (a >= crit) return 'critical'
  if (a >= warn) return 'warning'
  return null
}

function direction(delta) {
  const d = Number(delta) || 0
  if (d > 0) return 'up'
  if (d < 0) return 'down'
  return 'flat'
}

// ---- the one composite the engine calls ------------------------------------
//
// series : chronological (oldest → newest) array of derived-KPI rows, one per
//          period (week).
// metrics: which keys to evaluate (e.g. ['revenue','leads','spend','roas']).
// opts   : { minN=4, warn=2, crit=3 } — minN is the minimum history length,
//          EXCLUDING the latest point, before a z is trustworthy.
//
// For each metric we measure the LATEST period against the band formed by its
// OWN prior history — so an extreme latest week can't widen the band that is
// meant to catch it. We return one record per metric, INCLUDING null-severity
// ones, so callers can tell "evaluated, nothing unusual" from "not evaluated".
function summarizeSeries(series, metrics, opts = {}) {
  const { minN = 4, warn = DEFAULT_WARN, crit = DEFAULT_CRIT } = opts
  const rows = Array.isArray(series) ? series : []
  const keys = Array.isArray(metrics) ? metrics : []
  const out  = []

  for (const metric of keys) {
    const all = rows.map(r => Number(r?.[metric])).filter(Number.isFinite)
    if (all.length === 0) {
      out.push({ metric, severity: null, reason: 'no_data', n: 0 })
      continue
    }

    const latest  = all[all.length - 1]
    const history = all.slice(0, -1)
    const stats   = robustStats(history)
    const slope   = linregSlope(all)
    const smooth  = ewma(all)

    if (history.length < minN) {
      out.push({
        metric, severity: null, reason: 'insufficient_history',
        n: history.length, latest, mean: stats.mean, baseline: stats.median,
        slope, ewma: smooth,
      })
      continue
    }

    const z   = robustZ(latest, stats)
    const sev = classifyZ(z, { warn, crit })
    out.push({
      metric,
      severity:  sev,
      direction: direction(latest - stats.median),
      z,
      latest,
      baseline:  stats.median,
      mean:      stats.mean,
      std:       stats.std,
      robustStd: stats.robustStd,
      n:         history.length,
      slope,
      ewma:      smooth,
      reason:    sev ? 'anomaly' : 'within_band',
    })
  }

  // Most significant first: critical before warning before quiet, then by |z|.
  const rank = { critical: 2, warning: 1 }
  out.sort((a, b) =>
    (rank[b.severity] || 0) - (rank[a.severity] || 0) ||
    (Math.abs(b.z || 0) - Math.abs(a.z || 0)))
  return out
}

module.exports = {
  mean, stddev, median, mad, robustStats, robustZ,
  linregSlope, ewma, classifyZ, direction, summarizeSeries,
  MAD_TO_SIGMA, DEFAULT_WARN, DEFAULT_CRIT,
}
