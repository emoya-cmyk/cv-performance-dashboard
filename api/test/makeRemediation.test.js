'use strict'

// Unit tests for lib/makeRemediation — the deterministic Make.com remediation
// core (PRD cli_framework Layer B). Pure module → pure tests, zero mocking.
// Covers the full FR-2 classification order (including the fail-safe Tier 3
// default), FR-3 backoff, FR-1 validation, FR-9 Wilson feedback, hashing
// determinism, and FR-8 Slack message shapes.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  TIER,
  RETRY_SCHEDULE_MS,
  MAX_RETRIES,
  validatePayload,
  nextRetryDelay,
  classifyFailure,
  wilsonFeedback,
  hashPayload,
  buildTierAlert,
  buildTier1Digest,
} = require('../lib/makeRemediation')

// ── validatePayload (FR-1) ───────────────────────────────────────────────────

test('validatePayload passes a complete error-handler payload', () => {
  const { valid, missing } = validatePayload({
    scenario_id: 's1', execution_id: 'e1', tenant_id: 't1', vendor: 'GHL',
  })
  assert.equal(valid, true)
  assert.deepEqual(missing, [])
})

test('validatePayload flags every absent required field (null and empty alike)', () => {
  const { valid, missing } = validatePayload({ scenario_id: 's1', tenant_id: '' })
  assert.equal(valid, false)
  assert.deepEqual(missing.sort(), ['execution_id', 'tenant_id', 'vendor'].sort())
})

// ── nextRetryDelay (FR-3) ─────────────────────────────────────────────────────

test('nextRetryDelay follows the backoff schedule then exhausts to null', () => {
  assert.equal(nextRetryDelay(0), RETRY_SCHEDULE_MS[0])
  assert.equal(nextRetryDelay(1), 30_000)
  assert.equal(nextRetryDelay(2), 120_000)
  assert.equal(nextRetryDelay(3), 600_000)
  assert.equal(nextRetryDelay(MAX_RETRIES), null) // exhausted → promote/dead-letter
})

test('nextRetryDelay is defensive against bad input', () => {
  assert.equal(nextRetryDelay(-5), RETRY_SCHEDULE_MS[0])
  assert.equal(nextRetryDelay(NaN), RETRY_SCHEDULE_MS[0])
  assert.equal(nextRetryDelay(undefined), RETRY_SCHEDULE_MS[0])
})

// ── classifyFailure — Tier 0 (FR-2) ──────────────────────────────────────────

test('Tier 0: rate limit (429) → backoff retry, no notify', () => {
  const d = classifyFailure({ error_code: 429 })
  assert.equal(d.tier, TIER.RETRY)
  assert.equal(d.reason, 'rate_limit')
  assert.equal(d.action, 'backoff_retry')
  assert.equal(d.notify, 'none')
  assert.equal(d.autoResolvable, true)
})

test('Tier 0: transient timeout retried while attempts remain', () => {
  for (const code of [502, 503, 504]) {
    const d = classifyFailure({ error_code: code }, { retryCount: 0 })
    assert.equal(d.tier, TIER.RETRY, `code ${code}`)
    assert.equal(d.reason, 'transient_timeout')
  }
})

test('Tier 0 → Tier 1: timeout promoted once retries are exhausted', () => {
  const d = classifyFailure({ error_code: 503 }, { retryCount: 3 })
  assert.equal(d.tier, TIER.DATA)
  assert.equal(d.reason, 'timeout_exhausted')
  assert.equal(d.action, 'dead_letter')
})

test('Tier 0: duplicate execution short-circuits to idempotent discard first', () => {
  // duplicate wins even over an auth code — it is the very first rule
  const d = classifyFailure({ error_code: 401 }, { duplicate: true, refreshTokenAvailable: true })
  assert.equal(d.tier, TIER.RETRY)
  assert.equal(d.action, 'discard')
})

// ── classifyFailure — Tier 2 (FR-2) ──────────────────────────────────────────

test('Tier 2: 401 with refresh token → refreshable, no human', () => {
  const d = classifyFailure({ error_code: 401 }, { refreshTokenAvailable: true })
  assert.equal(d.tier, TIER.AUTH)
  assert.equal(d.action, 'token_refresh')
  assert.equal(d.humanRequired, false)
  assert.equal(d.notify, 'immediate')
})

test('Tier 2: 401 without refresh token → manual escalation', () => {
  const d = classifyFailure({ error_code: 401 }, { refreshTokenAvailable: false })
  assert.equal(d.tier, TIER.AUTH)
  assert.equal(d.action, 'escalate_auth')
  assert.equal(d.humanRequired, true)
})

test('Tier 2: 403 forbidden and invalid webhook signature', () => {
  assert.equal(classifyFailure({ error_code: 403 }).reason, 'auth_forbidden_scope')
  const sig = classifyFailure({ error_code: 200 }, { signatureValid: false })
  assert.equal(sig.tier, TIER.AUTH)
  assert.equal(sig.reason, 'webhook_signature_invalid')
})

// ── classifyFailure — Tier 1 (FR-2) ──────────────────────────────────────────

test('Tier 1: missing required field', () => {
  const d = classifyFailure({ error_code: 422 }, { missingFields: ['email'] })
  assert.equal(d.tier, TIER.DATA)
  assert.equal(d.reason, 'missing_required_field')
  assert.equal(d.notify, 'batch')
})

test('Tier 1: canonical id, field-map miss, malformed payload', () => {
  assert.equal(classifyFailure({}, { canonicalIdMissing: true }).reason, 'canonical_id_missing')
  assert.equal(classifyFailure({}, { fieldMapMiss: true }).reason, 'field_mapping_mismatch')
  assert.equal(classifyFailure({}, { malformedPayload: true }).reason, 'malformed_payload')
})

// ── classifyFailure — Tier 3 fail-safe (FR-2 / Session Rule) ──────────────────

test('Tier 3: unrecognised failure fails safe to human review', () => {
  const d = classifyFailure({ error_code: 418, error_message: 'teapot' })
  assert.equal(d.tier, TIER.UNKNOWN)
  assert.equal(d.action, 'hard_stop_escalate')
  assert.equal(d.humanRequired, true)
  assert.equal(d.autoResolvable, false)
  assert.equal(d.notify, 'immediate')
})

test('Tier 3: empty event (no code, no context) defaults to unknown', () => {
  assert.equal(classifyFailure().tier, TIER.UNKNOWN)
  assert.equal(classifyFailure({}, {}).tier, TIER.UNKNOWN)
})

test('classifier is deterministic and pure (same input → same output)', () => {
  const ev = { error_code: 429 }
  const ctx = { retryCount: 0 }
  assert.deepEqual(classifyFailure(ev, ctx), classifyFailure(ev, ctx))
  assert.deepEqual(ev, { error_code: 429 }) // inputs untouched
  assert.deepEqual(ctx, { retryCount: 0 })
})

// ── wilsonFeedback (FR-9) ─────────────────────────────────────────────────────

test('wilsonFeedback maps outcomes to deltas and freeze', () => {
  assert.deepEqual(wilsonFeedback('tier1_remapped_verified'), { delta: 0.05, freeze: false })
  assert.deepEqual(wilsonFeedback('tier1_dead_lettered'), { delta: -0.10, freeze: false })
  assert.deepEqual(wilsonFeedback('tier2_refresh_failed'), { delta: -0.15, freeze: false })
  assert.deepEqual(wilsonFeedback('tier3_escalated'), { delta: 0, freeze: true })
  assert.deepEqual(wilsonFeedback('nonexistent'), { delta: 0, freeze: false })
})

// ── hashPayload (FR-6) ────────────────────────────────────────────────────────

test('hashPayload is stable and key-order independent', () => {
  const a = hashPayload({ a: 1, b: 2 })
  const b = hashPayload({ b: 2, a: 1 })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }))
  assert.equal(hashPayload(null), hashPayload(null))
})

// ── buildTierAlert / buildTier1Digest (FR-8) ──────────────────────────────────

test('buildTierAlert returns null for Tier 0 and Tier 1 (no immediate Slack)', () => {
  assert.equal(buildTierAlert(TIER.RETRY, {}), null)
  assert.equal(buildTierAlert(TIER.DATA, {}), null)
})

test('buildTierAlert Tier 2 alert carries tenant, vendor, breaker state', () => {
  const a = buildTierAlert(TIER.AUTH, {
    tenant_id: 't1', vendor: 'GHL', error_message: 'expired',
    token_refresh: 'ATTEMPT (n8n)', circuit_breaker_tripped: true,
  })
  assert.equal(a.severity, 'critical')
  assert.match(a.title, /Auth Failure · t1 · GHL/)
  assert.match(a.body, /Circuit breaker: TRIPPED/)
})

test('buildTierAlert Tier 3 alert states automation halted + execution id', () => {
  const a = buildTierAlert(TIER.UNKNOWN, {
    scenario_name: 'sync', tenant_id: 't1', vendor: 'HubSpot',
    error_message: 'boom', execution_id: 'e9', llm_enrichment: 'likely schema drift',
  })
  assert.match(a.title, /Human Required/)
  assert.match(a.body, /All automation halted/)
  assert.match(a.body, /Execution ID: e9/)
  assert.match(a.body, /Claude assessment: likely schema drift/)
})

test('buildTier1Digest summarises a window, or returns null when empty', () => {
  assert.equal(buildTier1Digest([]), null)
  const d = buildTier1Digest([
    { tenant_id: 't1', dead_lettered: true },
    { tenant_id: 't2', dead_lettered: false },
    { tenant_id: 't1', dead_lettered: true },
  ])
  assert.match(d.body, /Auto-handled: 3 failures/)
  assert.match(d.body, /Dead-lettered: 2 payloads/)
  assert.match(d.body, /t1, t2/)
})
