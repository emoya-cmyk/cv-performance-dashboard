'use strict'

/**
 * Make.com Autonomous Remediation receiver (PRD: cli_framework Layer B).
 * POST /api/webhooks/make-remediation
 *
 * Every Make scenario's universal error handler (FR-1) fires here on failure.
 * This endpoint is the repo-side slice of the system: it validates, classifies
 * (deterministically, via lib/makeRemediation), LOGS FIRST (Session Rule 5),
 * then performs the repo-appropriate remediation side-effects — dead-letter
 * queue writes, circuit-breaker state, conditional Slack — and returns a
 * directive the n8n orchestrator uses to drive the hot path (retries, vendor
 * token refresh, scenario pause).
 *
 * Auth: optional shared-secret gate via MAKE_WEBHOOK_SECRET (constant-time),
 * mirroring the GHL/HubSpot receivers. Skipped when unset (local dev).
 */

const express = require('express')
const crypto  = require('crypto')
const https   = require('https')
const { query } = require('../../db')
const { sendAlert } = require('../../lib/alertDelivery')
const {
  TIER,
  validatePayload,
  classifyFailure,
  nextRetryDelay,
  wilsonFeedback,
  hashPayload,
  buildTierAlert,
} = require('../../lib/makeRemediation')
const { recordConfidence } = require('../../lib/makeRemediationSweeps')

const router = express.Router()

const MAKE_WEBHOOK_SECRET = process.env.MAKE_WEBHOOK_SECRET || ''
const CIRCUIT_TRIP_THRESHOLD = 2 // FR-5: trip on 2nd consecutive auth failure

// Constant-time shared-secret check. Returns true when unset (dev) or matched.
function verifySecret(req) {
  if (!MAKE_WEBHOOK_SECRET) return true
  const got = String(req.headers['x-make-signature'] || '')
  const exp = MAKE_WEBHOOK_SECRET
  if (got.length !== exp.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp))
}

// Build the deterministic side-channel context the classifier needs (FR-2).
function buildContext(event) {
  return {
    retryCount:            Number(event.retry_count) || 0,
    duplicate:             false, // set by the idempotency lookup below
    refreshTokenAvailable: event.refresh_token_available === true,
    signatureValid:        event.signature_valid === false ? false : undefined,
    missingFields:         Array.isArray(event.missing_fields) ? event.missing_fields : [],
    canonicalIdMissing:    event.canonical_id_missing === true,
    fieldMapMiss:          event.field_map_miss === true,
    malformedPayload:      event.malformed_payload === true,
  }
}

router.post('/', async (req, res) => {
  if (!verifySecret(req)) {
    return res.status(401).json({ error: 'invalid signature' })
  }

  const event = req.body || {}

  // FR-1: validate against the error-handler schema before doing anything.
  const { valid, missing } = validatePayload(event)
  if (!valid) {
    return res.status(400).json({ error: 'invalid payload', missing })
  }

  try {
    // Idempotency guard (FR-7: execution_id UNIQUE). A duplicate webhook for an
    // already-recorded execution is a Tier 0 safe discard — no new work.
    const existing = await query(
      `SELECT failure_tier, remediation_outcome FROM make_remediation_log WHERE execution_id = $1`,
      [event.execution_id]
    )
    if (existing.rows.length) {
      return res.json({ ok: true, duplicate: true, tier: 0, action: 'discard' })
    }

    const ctx        = buildContext(event)
    const decision   = classifyFailure(event, ctx)
    const payloadHash = hashPayload(event.raw_payload ?? event)

    // ── LOG FIRST (Session Rule 5): record before any remediation action ─────
    const id = crypto.randomUUID()
    await query(
      `INSERT INTO make_remediation_log
        (id, scenario_id, scenario_name, execution_id, tenant_id, vendor,
         failure_tier, error_code, error_message, error_type, module_name,
         remediation_action, remediation_outcome, auto_resolved, human_required,
         retry_count, raw_payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$15,$16)`,
      [
        id,
        event.scenario_id,
        event.scenario_name || null,
        event.execution_id,
        event.tenant_id,
        event.vendor,
        decision.tier,
        Number.isFinite(Number(event.error_code)) ? Number(event.error_code) : null,
        event.error_message || null,
        event.error_type || null,
        event.module_name || null,
        decision.action,
        decision.autoResolvable ? 1 : 0,
        decision.humanRequired ? 1 : 0,
        ctx.retryCount,
        payloadHash,
      ]
    )

    // ── Act per tier ─────────────────────────────────────────────────────────
    const directive = await remediate({ id, event, ctx, decision, payloadHash })

    return res.json({
      ok: true,
      tier: decision.tier,
      reason: decision.reason,
      action: decision.action,
      ...directive,
    })
  } catch (err) {
    console.error('[webhook/make-remediation] error', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// Per-tier side effects. Returns a directive object for the n8n orchestrator.
async function remediate({ id, event, ctx, decision, payloadHash }) {
  switch (decision.tier) {
    case TIER.RETRY:   return tier0({ id, event, decision, ctx, payloadHash })
    case TIER.DATA:    return tier1({ id, event, decision, payloadHash })
    case TIER.AUTH:    return tier2({ id, event, decision })
    case TIER.UNKNOWN: return tier3({ id, event, decision, payloadHash })
    default:           return {}
  }
}

// Tier 0 — retry safe. No Slack. Hand the backoff delay back to n8n; when the
// schedule is exhausted, promote to Tier 1 + dead-letter (FR-3).
async function tier0({ id, event, decision, ctx, payloadHash }) {
  if (decision.action === 'discard') {
    await finalize(id, { scenarioId: event.scenario_id, outcome: 'success', autoResolved: true, feedback: 'tier0_resolved' })
    return { retry: false, discarded: true }
  }
  const delayMs = nextRetryDelay(ctx.retryCount)
  if (delayMs == null) {
    // Retries exhausted (FR-3): promote to Tier 1 AND write the operator-queue
    // entry so the dead_lettered flag and the fix queue never diverge.
    await query(
      `UPDATE make_remediation_log
         SET failure_tier = 1, remediation_action = 'dead_letter', dead_lettered = 1
       WHERE id = $1`,
      [id]
    )
    await deadLetter({
      event,
      decision: { ...decision, tier: 1, action: 'dead_letter' },
      payloadHash,
      fieldGap: null,
    })
    await finalize(id, { scenarioId: event.scenario_id, outcome: 'escalated', feedback: 'tier1_dead_lettered' })
    return { retry: false, promoted_to_tier: 1, dead_lettered: true }
  }
  await finalize(id, { scenarioId: event.scenario_id, outcome: 'pending', autoResolved: true, feedback: 'tier0_resolved' })
  return { retry: true, delay_ms: delayMs, attempt: ctx.retryCount + 1 }
}

// Tier 1 — data/logic. The 158-entry field-equivalence remap lives in
// cli_framework (out of scope here), so the repo-side action is to dead-letter
// with a suggested action for the operator fix queue. Slack is batched (FR-8).
async function tier1({ id, event, decision, payloadHash }) {
  await deadLetter({ event, decision, payloadHash, fieldGap: (event.missing_fields || []).join(',') || null })
  await query(`UPDATE make_remediation_log SET dead_lettered = 1 WHERE id = $1`, [id])
  await finalize(id, { scenarioId: event.scenario_id, outcome: 'escalated', feedback: 'tier1_dead_lettered' })
  return { dead_lettered: true, notify: 'batch' }
}

// Tier 2 — auth/credential. Session Rule 7: check the breaker BEFORE proposing a
// refresh — a tripped pair is paused, so no retry is attempted and the event goes
// straight to escalation. Otherwise increment the breaker (trips on the 2nd
// consecutive failure) and propose the refresh. Actual vendor token refresh is
// executed by n8n; we record whether it is even attemptable here. Immediate Slack.
async function tier2({ id, event, decision }) {
  const already = await isBreakerTripped(event.tenant_id, event.vendor)
  const cb = await bumpCircuitBreaker(event.tenant_id, event.vendor, decision.reason)

  const tokenRefresh = (decision.action === 'token_refresh' && !already && !cb.tripped)
    ? 'ATTEMPT (n8n)'
    : already
      ? 'SKIPPED (breaker open)'
      : 'NOT ATTEMPTED'

  await query(
    `UPDATE make_remediation_log SET circuit_breaker_tripped = $1 WHERE id = $2`,
    [cb.tripped ? 1 : 0, id]
  )

  await sendAlert(buildTierAlert(TIER.AUTH, {
    ...event,
    token_refresh: tokenRefresh,
    circuit_breaker_tripped: cb.tripped,
    paused_scenarios: cb.tripped ? `all for ${event.tenant_id}/${event.vendor}` : null,
  }))

  await finalize(id, {
    scenarioId: event.scenario_id,
    outcome: decision.humanRequired ? 'escalated' : 'pending',
    feedback: cb.tripped ? 'tier2_refresh_failed' : 'tier2_refresh_succeeded',
  })
  return { circuit_breaker_tripped: cb.tripped, token_refresh: tokenRefresh, notify: 'immediate' }
}

// Tier 3 — unknown. Hard stop, no remediation writes to vendor systems. Capture
// the payload hash, best-effort LLM enrichment (FR-6), dead-letter, immediate
// Slack. Confidence is frozen (FR-9).
async function tier3({ id, event, decision, payloadHash }) {
  const enrichment = await enrichWithLLM(event)
  if (enrichment) {
    await query(`UPDATE make_remediation_log SET llm_enrichment = $1 WHERE id = $2`, [enrichment, id])
  }
  await deadLetter({ event, decision, payloadHash, fieldGap: null })
  await query(`UPDATE make_remediation_log SET dead_lettered = 1 WHERE id = $1`, [id])

  await sendAlert(buildTierAlert(TIER.UNKNOWN, { ...event, llm_enrichment: enrichment }))

  await finalize(id, { scenarioId: event.scenario_id, outcome: 'escalated', feedback: 'tier3_escalated' })
  return { halted: true, dead_lettered: true, enriched: Boolean(enrichment), notify: 'immediate' }
}

// ── Shared DB helpers ────────────────────────────────────────────────────────

// Write the final outcome + Wilson-score delta on the log row, then apply that
// delta to the scenario's confidence store (FR-9). The confidence write is
// best-effort and never disturbs the log update.
async function finalize(id, { scenarioId, outcome, autoResolved = false, feedback }) {
  const { delta } = wilsonFeedback(feedback)
  await query(
    `UPDATE make_remediation_log
       SET remediation_outcome = $1,
           auto_resolved = CASE WHEN $2 = 1 THEN 1 ELSE auto_resolved END,
           wilson_score_delta = $3,
           resolved_at = CASE WHEN $1 IN ('success','escalated','failed') THEN $4 ELSE resolved_at END
     WHERE id = $5`,
    [outcome, autoResolved ? 1 : 0, delta, new Date().toISOString(), id]
  )
  if (scenarioId && feedback) {
    await recordConfidence({ query, scenarioId, outcomeKey: feedback })
  }
}

// Is the circuit breaker currently open for this tenant+vendor pair? (Session Rule 7)
async function isBreakerTripped(tenantId, vendor) {
  const { rows } = await query(
    `SELECT tripped FROM make_circuit_breaker WHERE tenant_id = $1 AND vendor = $2`,
    [tenantId, vendor]
  )
  return rows.length ? (rows[0].tripped === 1 || rows[0].tripped === true) : false
}

// Append to the operator fix queue (FR-4). Never discarded; always recoverable.
async function deadLetter({ event, decision, payloadHash, fieldGap }) {
  await query(
    `INSERT INTO make_dead_letter
       (id, execution_id, scenario_id, scenario_name, tenant_id, vendor,
        failure_tier, original_error, suggested_action, raw_payload_hash, field_gap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      crypto.randomUUID(),
      event.execution_id,
      event.scenario_id,
      event.scenario_name || null,
      event.tenant_id,
      event.vendor,
      decision.tier,
      event.error_message || decision.reason,
      decision.action,
      payloadHash,
      fieldGap,
    ]
  )
}

// Increment the circuit breaker for a tenant+vendor pair; trip on threshold.
async function bumpCircuitBreaker(tenantId, vendor, reason) {
  const now = new Date().toISOString()
  await query(
    `INSERT INTO make_circuit_breaker (tenant_id, vendor, consecutive_failures, reason, updated_at)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (tenant_id, vendor) DO UPDATE
       SET consecutive_failures = make_circuit_breaker.consecutive_failures + 1,
           reason = $3,
           updated_at = $4`,
    [tenantId, vendor, reason, now]
  )
  const { rows } = await query(
    `SELECT consecutive_failures FROM make_circuit_breaker WHERE tenant_id = $1 AND vendor = $2`,
    [tenantId, vendor]
  )
  const failures = rows[0]?.consecutive_failures || 1
  const tripped  = failures >= CIRCUIT_TRIP_THRESHOLD
  if (tripped) {
    await query(
      `UPDATE make_circuit_breaker SET tripped = 1, tripped_at = COALESCE(tripped_at, $3)
       WHERE tenant_id = $1 AND vendor = $2`,
      [tenantId, vendor, now]
    )
  }
  return { failures, tripped }
}

// Best-effort Claude enrichment for Tier 3 (FR-6). Env-gated, 10s timeout, never
// throws — on any error or absent key it returns null and the alert goes out
// without enrichment.
function enrichWithLLM(event) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return Promise.resolve(null)
  const model = process.env.MAKE_LLM_MODEL || 'claude-sonnet-4-6'

  const prompt = [
    'You are analyzing a Make.com automation failure.',
    'Classify the likely cause. Suggest the safest next action.',
    'Do not suggest any write operations.',
    `Error: ${event.error_message || 'n/a'}`,
    `Vendor: ${event.vendor || 'n/a'}`,
    `Module: ${event.module_name || 'n/a'}`,
    `Payload preview: ${String(JSON.stringify(event.raw_payload ?? event)).slice(0, 500)}`,
    'Respond in 3 sentences max.',
  ].join('\n')

  const body = JSON.stringify({
    model,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  })

  return new Promise((resolve) => {
    const reqL = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 10_000, // FR-6: 10s timeout, do not block
    }, (resp) => {
      let data = ''
      resp.on('data', c => { data += c })
      resp.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json?.content?.[0]?.text?.trim() || null)
        } catch { resolve(null) }
      })
    })
    reqL.on('timeout', () => { reqL.destroy(); resolve(null) })
    reqL.on('error', () => resolve(null))
    reqL.write(body)
    reqL.end()
  })
}

module.exports = router
