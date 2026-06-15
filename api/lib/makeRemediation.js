'use strict'

// ============================================================================
// lib/makeRemediation.js — Make.com Autonomous Remediation core (cli_framework
// Layer B). Pure, deterministic policy module: identical input → identical
// classification, with zero I/O. The n8n orchestrator owns the hot path
// (webhook intake, retry timers, vendor calls); this module owns the
// *decisions* — taxonomy, classification, retry schedule, notify policy,
// Wilson-score feedback, and Slack message shape — so they can be unit-tested
// in isolation and ported verbatim into the cli_framework repo.
//
// Maps directly to the PRD:
//   classifyFailure  → FR-2 (deterministic classifier)
//   nextRetryDelay   → FR-3 (Tier 0 backoff schedule)
//   validatePayload  → FR-1 (error-handler payload schema)
//   buildTierAlert / buildTier1Digest → FR-8 (Slack notification schema)
//   wilsonFeedback   → FR-9 (Wilson-score feedback)
//
// Session Rule (PRD): "unknown always → Tier 3". Every branch that isn't a
// recognised, safe pattern falls through to Tier 3 (hard stop, human required).
// ============================================================================

const crypto = require('crypto')

// ── Tiers (failure taxonomy) ────────────────────────────────────────────────
const TIER = Object.freeze({
  RETRY:   0, // retry-safe, auto-remediate, no Slack
  DATA:    1, // data/logic, auto-remediate, batched Slack
  AUTH:    2, // auth/credential, attempt refresh, immediate Slack
  UNKNOWN: 3, // unknown, hard stop, no writes, immediate Slack, human required
})

// ── Tier 0 retry backoff (FR-3): attempt 1 immediate, +30s, +2m, +10m ────────
const RETRY_SCHEDULE_MS = Object.freeze([0, 30_000, 120_000, 600_000])
const MAX_RETRIES       = RETRY_SCHEDULE_MS.length

// Error-handler payload schema — the minimum a remediation event must carry
// before any classification can be trusted (FR-1).
const REQUIRED_PAYLOAD_FIELDS = Object.freeze([
  'scenario_id', 'execution_id', 'tenant_id', 'vendor',
])

const RATE_LIMIT_CODES = new Set([429])
const TIMEOUT_CODES    = new Set([502, 503, 504])
const TIMEOUT_MAX_RETRY = 3 // FR-3: retry 3x, then promote to Tier 1

// Per-tier notification policy (FR-8).
const NOTIFY = Object.freeze({
  [TIER.RETRY]:   'none',
  [TIER.DATA]:    'batch',
  [TIER.AUTH]:    'immediate',
  [TIER.UNKNOWN]: 'immediate',
})

// ── Payload validation (FR-1) ────────────────────────────────────────────────

/**
 * Validate an incoming remediation event against the error-handler schema.
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validatePayload(event = {}) {
  const missing = REQUIRED_PAYLOAD_FIELDS.filter(
    f => event[f] == null || event[f] === ''
  )
  return { valid: missing.length === 0, missing }
}

// ── Retry schedule (FR-3) ─────────────────────────────────────────────────────

/**
 * Backoff delay (ms) for a given 0-based retry count, or null when the schedule
 * is exhausted — at which point the caller promotes the failure to Tier 1 and
 * dead-letters it.
 * @param {number} retryCount attempts already completed
 * @returns {number|null}
 */
function nextRetryDelay(retryCount = 0) {
  const n = Number.isFinite(retryCount) ? Math.max(0, Math.trunc(retryCount)) : 0
  if (n >= RETRY_SCHEDULE_MS.length) return null
  return RETRY_SCHEDULE_MS[n]
}

// ── Classifier (FR-2) ──────────────────────────────────────────────────────────

function decision(tier, reason, action, overrides = {}) {
  const autoResolvable = overrides.autoResolvable ?? (tier === TIER.RETRY || tier === TIER.DATA)
  const humanRequired  = overrides.humanRequired  ?? (tier === TIER.UNKNOWN)
  return Object.freeze({
    tier,
    reason,
    action,
    autoResolvable,
    humanRequired,
    notify: NOTIFY[tier],
  })
}

/**
 * Deterministically assign exactly one tier to a failure. Rules are evaluated
 * in the precise order given in PRD FR-2; the trailing ELSE is Tier 3 so any
 * unrecognised failure fails safe to human review.
 *
 * The raw error payload can't express every signal, so deterministic side
 * channels are passed via `ctx` (computed by the caller before classifying):
 *
 * @param {object} event  remediation event (error_code, vendor, …)
 * @param {object} ctx
 * @param {number}  [ctx.retryCount]            attempts already made
 * @param {boolean} [ctx.duplicate]             execution_id already seen/resolved
 * @param {boolean} [ctx.refreshTokenAvailable] a refresh_token exists for the pair
 * @param {boolean} [ctx.signatureValid]        false = HMAC mismatch
 * @param {string[]}[ctx.missingFields]         required fields found absent
 * @param {boolean} [ctx.canonicalIdMissing]    no canonical id on record
 * @param {boolean} [ctx.fieldMapMiss]          field-equivalence lookup failed
 * @param {boolean} [ctx.malformedPayload]      unparseable / schema-violating body
 * @returns {Readonly<{tier:number,reason:string,action:string,autoResolvable:boolean,humanRequired:boolean,notify:string}>}
 */
function classifyFailure(event = {}, ctx = {}) {
  const code       = Number(event.error_code)
  const retryCount = Number(ctx.retryCount) || 0

  // ── Tier 0 — retry safe ──────────────────────────────────────────────────
  if (ctx.duplicate) {
    return decision(TIER.RETRY, 'idempotent_discard', 'discard')
  }
  if (RATE_LIMIT_CODES.has(code)) {
    return decision(TIER.RETRY, 'rate_limit', 'backoff_retry')
  }
  if (TIMEOUT_CODES.has(code)) {
    return retryCount < TIMEOUT_MAX_RETRY
      ? decision(TIER.RETRY, 'transient_timeout', 'backoff_retry')
      : decision(TIER.DATA, 'timeout_exhausted', 'dead_letter') // promote (FR-3)
  }

  // ── Tier 2 — auth / credential ───────────────────────────────────────────
  if (code === 401) {
    return ctx.refreshTokenAvailable
      ? decision(TIER.AUTH, 'auth_expired_refreshable', 'token_refresh', { humanRequired: false })
      : decision(TIER.AUTH, 'auth_expired_manual', 'escalate_auth', { humanRequired: true })
  }
  if (code === 403) {
    return decision(TIER.AUTH, 'auth_forbidden_scope', 'escalate_auth', { humanRequired: true })
  }
  if (ctx.signatureValid === false) {
    return decision(TIER.AUTH, 'webhook_signature_invalid', 'reject_payload', { humanRequired: true })
  }

  // ── Tier 1 — data / logic ────────────────────────────────────────────────
  if (Array.isArray(ctx.missingFields) && ctx.missingFields.length > 0) {
    return decision(TIER.DATA, 'missing_required_field', 'remap_or_dead_letter')
  }
  if (ctx.canonicalIdMissing) {
    return decision(TIER.DATA, 'canonical_id_missing', 'backfill_or_dead_letter')
  }
  if (ctx.fieldMapMiss) {
    return decision(TIER.DATA, 'field_mapping_mismatch', 'remap_or_dead_letter')
  }
  if (ctx.malformedPayload) {
    return decision(TIER.DATA, 'malformed_payload', 'dead_letter')
  }

  // ── Tier 3 — unknown / unclassified (fail-safe default) ──────────────────
  return decision(TIER.UNKNOWN, 'unknown_error', 'hard_stop_escalate')
}

// ── Wilson-score feedback (FR-9) ────────────────────────────────────────────────

// outcome key → confidence delta. `freeze` halts confidence movement for a
// scenario that escalated to Tier 3 until a human clears it.
const WILSON_FEEDBACK = Object.freeze({
  tier0_resolved:            { delta: 0,     freeze: false },
  tier1_remapped_verified:   { delta: +0.05, freeze: false },
  tier1_dead_lettered:       { delta: -0.10, freeze: false },
  tier2_refresh_succeeded:   { delta: 0,     freeze: false },
  tier2_refresh_failed:      { delta: -0.15, freeze: false },
  tier3_escalated:           { delta: 0,     freeze: true  },
})

/**
 * Map a remediation outcome to its Wilson-score effect.
 * @param {string} outcomeKey one of WILSON_FEEDBACK's keys
 * @returns {{ delta: number, freeze: boolean }}
 */
function wilsonFeedback(outcomeKey) {
  return WILSON_FEEDBACK[outcomeKey] || { delta: 0, freeze: false }
}

// ── Payload hashing (FR-6: store hash, never raw payload, for Tier 3) ─────────────

/**
 * Stable SHA-256 hex of a payload. Objects are JSON-serialised with sorted keys
 * so logically-equal payloads hash identically regardless of key order.
 */
function hashPayload(payload) {
  let input
  if (payload == null) input = ''
  else if (typeof payload === 'string') input = payload
  else input = JSON.stringify(payload, Object.keys(flatten(payload)).sort())
  return crypto.createHash('sha256').update(input).digest('hex')
}

// Shallow helper so hashPayload's replacer sees every top-level key (sufficient
// for the flat webhook payloads we hash; deterministic for equal objects).
function flatten(obj) {
  return (obj && typeof obj === 'object') ? obj : {}
}

// ── Slack notification shapes (FR-8) ────────────────────────────────────────────
// Returns alert objects compatible with lib/alertDelivery.sendAlert().

/**
 * Build the immediate Slack alert for a Tier 2 or Tier 3 event. Returns null
 * for Tier 0 (no notification) and Tier 1 (batched separately).
 * @param {number} tier
 * @param {object} r   record-shaped context
 * @returns {object|null}
 */
function buildTierAlert(tier, r = {}) {
  if (tier === TIER.AUTH) {
    return {
      severity: 'critical',
      title: `Auth Failure · ${r.tenant_id || 'unknown'} · ${r.vendor || 'unknown'}`,
      body: [
        `Error: ${r.error_message || r.reason || 'n/a'}`,
        `Token refresh: ${r.token_refresh || 'NOT ATTEMPTED'}`,
        `Circuit breaker: ${r.circuit_breaker_tripped ? 'TRIPPED' : 'CLEAR'}`,
        r.paused_scenarios ? `Scenarios paused: ${r.paused_scenarios}` : null,
      ].filter(Boolean).join('\n'),
      metric: 'tier2_auth',
      value: r.error_code ?? null,
    }
  }
  if (tier === TIER.UNKNOWN) {
    return {
      severity: 'critical',
      title: 'Unknown Failure · Human Required',
      body: [
        `Scenario: ${r.scenario_name || r.scenario_id || 'n/a'}`,
        `Tenant: ${r.tenant_id || 'n/a'}`,
        `Vendor: ${r.vendor || 'n/a'}`,
        `Error: ${r.error_message || 'n/a'}`,
        r.llm_enrichment ? `Claude assessment: ${r.llm_enrichment}` : 'Claude assessment: (none)',
        'All automation halted for this scenario.',
        `Execution ID: ${r.execution_id || 'n/a'}`,
      ].join('\n'),
      metric: 'tier3_unknown',
      value: r.error_code ?? null,
    }
  }
  return null
}

/**
 * Build the Tier 1 batched digest (FR-8) from the events accumulated in a window.
 * Returns null when there is nothing to report.
 * @param {Array<{tenant_id?:string, dead_lettered?:boolean}>} events
 * @returns {object|null}
 */
function buildTier1Digest(events = []) {
  if (!events.length) return null
  const deadLettered = events.filter(e => e.dead_lettered).length
  const tenants = [...new Set(events.map(e => e.tenant_id).filter(Boolean))]
  return {
    severity: 'warning',
    title: 'Make Remediation Summary',
    body: [
      `Auto-handled: ${events.length} failures`,
      `Dead-lettered: ${deadLettered} payloads`,
      `Tenants affected: ${tenants.length ? tenants.join(', ') : 'none'}`,
      'Action needed: Review operator fix queue',
    ].join('\n'),
    metric: 'tier1_summary',
    value: events.length,
  }
}

module.exports = {
  TIER,
  RETRY_SCHEDULE_MS,
  MAX_RETRIES,
  REQUIRED_PAYLOAD_FIELDS,
  validatePayload,
  nextRetryDelay,
  classifyFailure,
  wilsonFeedback,
  hashPayload,
  buildTierAlert,
  buildTier1Digest,
}
