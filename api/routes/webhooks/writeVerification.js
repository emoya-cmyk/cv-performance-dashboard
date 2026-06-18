'use strict'

/**
 * Write-Verification ingest (Spec A — cli_framework correctness primitive).
 * POST /api/webhooks/write-verification
 *
 * The orchestrator reports the result of a verified write here. After it writes
 * a record it re-reads by canonical identity (acculynx_job_id, email/phone
 * fallback) and POSTs the intended payload plus the read-back, so this service
 * classifies the write on the correctness axis
 *   FAILED / PERSISTED_UNVERIFIED / PERSISTED_INCORRECT / VERIFIED_CORRECT
 * and accumulates it per (tenant, endpoint). GET-only vendors (AccuLynx) report
 * the operator's manual change the same way — read-back verification still
 * applies, so the manual path is measured on the same correctness axis.
 *
 * This is the signal a future Wilson promotion gate will read; it is
 * intentionally NOT wired to promotion yet (build correctness samples first —
 * see DECISION_REGISTER.md and MAKE_REMEDIATION_PRD.md).
 *
 * Auth: same optional shared-secret gate as the Make remediation webhook
 * (MAKE_WEBHOOK_SECRET, constant-time). Skipped when unset (local dev).
 */

const express = require('express')
const crypto  = require('crypto')
const { query } = require('../../db')
const { recordWriteVerification } = require('../../lib/writeVerificationStore')

const router = express.Router()

const MAKE_WEBHOOK_SECRET = process.env.MAKE_WEBHOOK_SECRET || ''
const VALID_KIND = new Set(['primary', 'email_fallback', 'phone_fallback'])

// Constant-time shared-secret check. Returns true when unset (dev) or matched.
function verifySecret(req) {
  if (!MAKE_WEBHOOK_SECRET) return true
  const got = String(req.headers['x-make-signature'] || '')
  const exp = MAKE_WEBHOOK_SECRET
  if (got.length !== exp.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp))
}

router.post('/', async (req, res) => {
  if (!verifySecret(req)) {
    return res.status(401).json({ error: 'invalid signature' })
  }

  const e = req.body || {}
  if (!e.tenant_id || !e.endpoint) {
    return res.status(400).json({ error: 'tenant_id and endpoint are required' })
  }
  if (typeof e.persisted !== 'boolean') {
    return res.status(400).json({ error: 'persisted (boolean) is required' })
  }

  try {
    const result = await recordWriteVerification({
      query,
      tenantId:        e.tenant_id,
      endpoint:        e.endpoint,
      vendor:          e.vendor || null,
      scenarioId:      e.scenario_id || null,
      executionId:     e.execution_id || null,
      canonicalId:     e.canonical_id || null,
      canonicalIdKind: VALID_KIND.has(e.canonical_id_kind) ? e.canonical_id_kind : null,
      persisted:       e.persisted,
      intended:        e.intended || {},
      // omit read_back entirely (or send null) to log PERSISTED_UNVERIFIED.
      readBack:        ('read_back' in e) ? e.read_back : undefined,
      equivalence:     e.equivalence || {},
      note:            e.note || null,
    })
    return res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[webhook/write-verification] error', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
