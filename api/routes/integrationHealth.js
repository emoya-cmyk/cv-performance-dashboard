'use strict'

// Integration-health bridge — the cli_framework → dashboard "Integration Health"
// landing surface.
//
// WHY THIS EXISTS
//   cli_framework (a SEPARATE toolkit operating the multi-tenant CRM/field-service
//   integrations) produces a read-only, per-tenant integration-health JSON. This
//   dashboard is a PASSIVE SINK: a machine push (POST below, shared-secret gated)
//   lands one snapshot row per cli tenant; agency operators READ it (GET below,
//   agency-only) on the Intelligence page. The dashboard NEVER calls cli_framework.
//   The feature is INERT until data is pushed — every read is empty-state safe.
//
// TWO SURFACES, TWO DIFFERENT GATES (mounted in server.js):
//   • POST /api/integration-health — MACHINE-to-machine. No user JWT. Guarded by a
//     shared secret (ihAuth), mirroring routes/cron.js: FAIL CLOSED (503 if the env
//     secret is unset), constant-time bearer compare, read at request time.
//   • GET  /api/integration-health — AGENCY operators. requireAuth + requireAgency,
//     exactly like the other agency-only operational reads.

const crypto  = require('crypto')
const express = require('express')

const { query }         = require('../db')
const { requireAuth }   = require('../middleware/auth')
const { requireAgency } = require('../middleware/authz')

// ── Shared-secret guard for the ingest push ───────────────────────────────────
// Modeled on cron.js's cronAuth:
//   • FAILS CLOSED — INTEGRATION_HEALTH_SECRET unset ⇒ 503 (disabled), never open.
//   • CONSTANT-TIME — both sides SHA-256'd to fixed 32 bytes, compared with
//     crypto.timingSafeEqual (so an empty/garbage header can't throw on length and
//     the secret can't be probed by timing).
//   • Read at REQUEST time so arming the route needs no restart.
// Accepts either `Authorization: Bearer <secret>` or `x-secret: <secret>`.
function ihAuth(req, res, next) {
  const secret = process.env.INTEGRATION_HEALTH_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'integration-health ingest disabled (INTEGRATION_HEALTH_SECRET unset)' })
  }
  const header    = req.get('authorization') || ''
  const bearer    = header.startsWith('Bearer ') ? header.slice(7) : ''
  const presented = bearer || req.get('x-secret') || ''

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest()
  if (!crypto.timingSafeEqual(sha(presented), sha(secret))) {
    return res.status(401).json({ error: 'invalid integration-health credential' })
  }
  next()
}

const router = express.Router()

// Health-grade precedence — worst first. Used to order the read AND to clamp an
// unexpected grade. (Producer enum: ok | watch | degraded | critical.)
const HEALTH_RANK = { critical: 0, degraded: 1, watch: 2, ok: 3 }
const VALID_HEALTH = new Set(Object.keys(HEALTH_RANK))

// Coerce a value to a non-negative integer (defensive against a bad payload).
function nonNegInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

// Normalise a nullable ISO timestamp — pass through a non-empty string, else null.
function isoOrNull(v) {
  return (typeof v === 'string' && v.trim()) ? v : null
}

// Sanitise the breakers_tripped array → [{vendor,reason,since}] of strings, dropping
// anything malformed. Always returns an array (stored as JSON in both dialects).
function cleanBreakers(arr) {
  if (!Array.isArray(arr)) return []
  return arr
    .filter(b => b && typeof b === 'object')
    .map(b => ({
      vendor: String(b.vendor ?? ''),
      reason: String(b.reason ?? ''),
      since:  isoOrNull(b.since),
    }))
}

// ── POST /api/integration-health — machine ingest (ihAuth-gated) ──────────────
// Validates the payload shape minimally and UPSERTs one row per tenants[] entry,
// keyed by client_id. Response: { ok, upserted }. Defensive: a malformed payload
// is 400, never 500.
router.post('/', ihAuth, async (req, res) => {
  const payload = req.body
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'body must be an object', code: 'BAD_PAYLOAD' })
  }
  const tenants = payload.tenants
  if (!Array.isArray(tenants)) {
    return res.status(400).json({ error: 'tenants must be an array', code: 'BAD_TENANTS' })
  }
  // generated_at → reported_at; fall back to now if absent/blank.
  const reportedAt = isoOrNull(payload.generated_at) || new Date().toISOString()

  try {
    let upserted = 0
    for (const t of tenants) {
      if (!t || typeof t !== 'object') continue
      const clientId = (typeof t.tenant_id === 'string') ? t.tenant_id.trim() : ''
      if (!clientId) continue   // a tenant with no id is unaddressable — skip it

      const health = VALID_HEALTH.has(t.health) ? t.health : 'watch'
      const audit  = (t.audit && typeof t.audit === 'object') ? t.audit : null
      const breakers = JSON.stringify(cleanBreakers(t.breakers_tripped))

      // UPSERT by client_id. id is only consumed on INSERT (SQLite needs the TEXT
      // PK supplied; Postgres would default it, but passing it is harmless and keeps
      // the two dialects on one write path). updated_at is bumped every write.
      await query(
        `INSERT INTO integration_health
           (id, client_id, health,
            audit_critical, audit_high, audit_medium, audit_low, audit_as_of,
            dead_letters_open, breakers_tripped, last_activity,
            reported_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (client_id) DO UPDATE SET
           health            = EXCLUDED.health,
           audit_critical    = EXCLUDED.audit_critical,
           audit_high        = EXCLUDED.audit_high,
           audit_medium      = EXCLUDED.audit_medium,
           audit_low         = EXCLUDED.audit_low,
           audit_as_of       = EXCLUDED.audit_as_of,
           dead_letters_open = EXCLUDED.dead_letters_open,
           breakers_tripped  = EXCLUDED.breakers_tripped,
           last_activity     = EXCLUDED.last_activity,
           reported_at       = EXCLUDED.reported_at,
           updated_at        = EXCLUDED.updated_at`,
        [
          crypto.randomUUID(),
          clientId,
          health,
          nonNegInt(audit?.critical),
          nonNegInt(audit?.high),
          nonNegInt(audit?.medium),
          nonNegInt(audit?.low),
          audit ? isoOrNull(audit.as_of) : null,
          nonNegInt(t.dead_letters_open),
          breakers,
          isoOrNull(t.last_activity),
          reportedAt,
        ]
      )
      upserted += 1
    }
    res.json({ ok: true, upserted })
  } catch (err) {
    console.error('[integration-health] ingest error', err.message)
    res.status(400).json({ error: 'could not ingest payload', code: 'INGEST_FAILED' })
  }
})

// ── GET /api/integration-health — agency read (requireAuth + requireAgency) ───
// Returns the stored rows worst-health-first plus a by_health summary. Empty table
// → { tenants: [], summary: { ...zeros } } at 200 (the feature is INERT until pushed).
router.get('/', requireAuth, requireAgency, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT client_id, health,
              audit_critical, audit_high, audit_medium, audit_low, audit_as_of,
              dead_letters_open, breakers_tripped, last_activity,
              reported_at, updated_at
         FROM integration_health`
    )

    const tenants = rows.map(r => {
      let breakers = []
      // breakers_tripped is TEXT in SQLite, JSONB in Postgres (pg may hand back an
      // already-parsed array). Parse defensively either way.
      const bt = r.breakers_tripped
      if (Array.isArray(bt)) breakers = bt
      else if (typeof bt === 'string' && bt.trim()) {
        try { const p = JSON.parse(bt); if (Array.isArray(p)) breakers = p } catch { breakers = [] }
      }
      return {
        tenant_id:         r.client_id,
        health:            r.health,
        audit: {
          critical: r.audit_critical,
          high:     r.audit_high,
          medium:   r.audit_medium,
          low:      r.audit_low,
          as_of:    r.audit_as_of || null,
        },
        dead_letters_open: r.dead_letters_open,
        breakers_tripped:  breakers,
        last_activity:     r.last_activity || null,
        reported_at:       r.reported_at || null,
      }
    })

    // Worst health first; stable tie-break by tenant_id for deterministic order.
    tenants.sort((a, b) => {
      const ra = HEALTH_RANK[a.health] ?? 99
      const rb = HEALTH_RANK[b.health] ?? 99
      if (ra !== rb) return ra - rb
      return String(a.tenant_id).localeCompare(String(b.tenant_id))
    })

    const by_health = { ok: 0, watch: 0, degraded: 0, critical: 0 }
    let dead_letters_open = 0
    let breakers_tripped  = 0
    for (const t of tenants) {
      if (t.health in by_health) by_health[t.health] += 1
      dead_letters_open += Number(t.dead_letters_open) || 0
      breakers_tripped  += Array.isArray(t.breakers_tripped) ? t.breakers_tripped.length : 0
    }

    res.json({
      tenants,
      summary: {
        tenant_count: tenants.length,
        by_health,
        dead_letters_open,
        breakers_tripped,
      },
    })
  } catch (err) {
    console.error('[integration-health] read error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = { router, ihAuth }
