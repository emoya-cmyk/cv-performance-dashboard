'use strict'

// ============================================================================
// lib/writeVerificationStore.js — the I/O half of the write-verification
// correctness primitive (Spec A). The verdict logic lives in
// lib/writeVerification.js (pure); this module records a verified write to the
// append-only ledger and accumulates the per-(tenant, endpoint) correctness
// counters the promotion gate will eventually read.
//
// Per-tenant isolation is load-bearing: stats are keyed (tenant_id, endpoint),
// so a vendor proven correct for one tenant is never counted toward another.
// ============================================================================

const crypto = require('crypto')
const {
  classifyWrite,
  compareReadback,
  hashIntended,
  wilsonLowerBound,
  STAT_COLUMN,
} = require('./writeVerification')

/**
 * Record a verified write: classify it on the correctness axis, append a log
 * row, and bump the (tenant, endpoint) accumulator.
 *
 * @param {object} args
 * @param {Function} args.query  db.query
 * @param {string}  args.tenantId
 * @param {string}  args.endpoint            scoping unit, e.g. `${vendor}:${operation}`
 * @param {string}  [args.vendor]
 * @param {string}  [args.scenarioId]
 * @param {string}  [args.executionId]
 * @param {string}  [args.canonicalId]       identity used for read-back (acculynx_job_id, …)
 * @param {string}  [args.canonicalIdKind]   'primary' | 'email_fallback' | 'phone_fallback'
 * @param {boolean} args.persisted           did the write land at all?
 * @param {object}  [args.intended]          intended field→value payload
 * @param {object}  [args.readBack]          re-read field→value; omit/undefined = unavailable
 * @param {object}  [args.equivalence]       per-field normalization map
 * @param {string}  [args.note]
 * @param {Date}    [args.now]
 * @returns {Promise<{id:string, outcome:string, mismatchFields:string[], readBackAvailable:boolean}>}
 */
async function recordWriteVerification({
  query, tenantId, endpoint, vendor = null, scenarioId = null, executionId = null,
  canonicalId = null, canonicalIdKind = null, persisted, intended = {},
  readBack = undefined, equivalence = {}, note = null, now = new Date(),
}) {
  if (!tenantId || !endpoint) throw new Error('tenantId and endpoint are required')

  const comparison = compareReadback(intended, readBack, { equivalence })
  const outcome = classifyWrite({ persisted, comparison })
  const intendedHash = hashIntended(intended, equivalence)
  const id = crypto.randomUUID()

  await query(
    `INSERT INTO write_verification_log
       (id, created_at, tenant_id, endpoint, vendor, scenario_id, execution_id,
        canonical_id, canonical_id_kind, outcome, read_back_available,
        intended_hash, field_count, match_count, mismatch_fields, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, now.toISOString(), tenantId, endpoint, vendor, scenarioId, executionId,
      canonicalId, canonicalIdKind, outcome, comparison.readBackAvailable ? 1 : 0,
      intendedHash, comparison.fieldCount, comparison.matchCount,
      comparison.mismatchFields.length ? JSON.stringify(comparison.mismatchFields) : null,
      note,
    ]
  )

  await bumpStats({ query, tenantId, endpoint, outcome, now })

  return {
    id,
    outcome,
    mismatchFields: comparison.mismatchFields,
    readBackAvailable: comparison.readBackAvailable,
  }
}

/**
 * Increment the per-(tenant, endpoint) correctness accumulator for one outcome.
 * Read-then-upsert (dialect-safe; mirrors makeRemediationSweeps.recordConfidence)
 * so we never interpolate a column name into SQL.
 */
async function bumpStats({ query, tenantId, endpoint, outcome, now = new Date() }) {
  const col = STAT_COLUMN[outcome]
  if (!col) throw new Error(`unknown outcome: ${outcome}`)

  const { rows } = await query(
    `SELECT failed, persisted_unverified, persisted_incorrect, verified_correct
       FROM write_verification_stats WHERE tenant_id = $1 AND endpoint = $2`,
    [tenantId, endpoint]
  )
  const cur = rows[0] || {}
  const next = {
    failed:               Number(cur.failed) || 0,
    persisted_unverified: Number(cur.persisted_unverified) || 0,
    persisted_incorrect:  Number(cur.persisted_incorrect) || 0,
    verified_correct:     Number(cur.verified_correct) || 0,
  }
  next[col] += 1
  const total = next.failed + next.persisted_unverified + next.persisted_incorrect + next.verified_correct

  await query(
    `INSERT INTO write_verification_stats
       (tenant_id, endpoint, failed, persisted_unverified, persisted_incorrect,
        verified_correct, total, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, endpoint) DO UPDATE
       SET failed = $3, persisted_unverified = $4, persisted_incorrect = $5,
           verified_correct = $6, total = $7, updated_at = $8`,
    [tenantId, endpoint, next.failed, next.persisted_unverified,
     next.persisted_incorrect, next.verified_correct, total, now.toISOString()]
  )
  return { ...next, total }
}

/**
 * Read the correctness accumulator, optionally scoped to one tenant, with the
 * verified rate and Wilson lower bound computed per row. `wilson_lower` is
 * REPORTING ONLY — it is not (yet) used to gate promotion (Spec A sequencing).
 *
 * @param {{ query:Function, tenantId?:string }} deps
 * @returns {Promise<Array>}
 */
async function getCorrectnessStats({ query, tenantId = null }) {
  const { rows } = tenantId
    ? await query(
        `SELECT * FROM write_verification_stats WHERE tenant_id = $1 ORDER BY endpoint`,
        [tenantId])
    : await query(`SELECT * FROM write_verification_stats ORDER BY tenant_id, endpoint`)

  return rows.map(r => {
    const total = Number(r.total) || 0
    const correct = Number(r.verified_correct) || 0
    return {
      tenant_id:            r.tenant_id,
      endpoint:             r.endpoint,
      failed:               Number(r.failed) || 0,
      persisted_unverified: Number(r.persisted_unverified) || 0,
      persisted_incorrect:  Number(r.persisted_incorrect) || 0,
      verified_correct:     correct,
      total,
      verified_rate: total ? Number((correct / total).toFixed(4)) : 0,
      wilson_lower:  total ? Number(wilsonLowerBound(correct, total).toFixed(4)) : 0,
    }
  })
}

module.exports = { recordWriteVerification, bumpStats, getCorrectnessStats }
