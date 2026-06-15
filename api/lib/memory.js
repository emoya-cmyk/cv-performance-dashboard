'use strict'

// ── Memory OS — Phase 1 engine ────────────────────────────────────────────────
//
// Persistent, scoped, decaying memory for a stateless agent. See MEMORY_OS_PRD.md.
//
// A memory is a *claim*, not a fact: it can inform retrieval freely, but callers
// must treat recalled content as unverified. (Grounding — verifying a claim
// against the deterministic evidence pack before it is asserted in output — is
// Phase 2 and is deliberately NOT wired here.)
//
// This Phase-1 slice ships the three load-bearing invariants:
//   • SCOPE      — every read/write is confined to a tenant; a 'client' scope can
//                  never touch another client's rows (the leak-proof boundary,
//                  the same hard rule middleware/authz.js enforces on REST).
//   • PRECEDENCE — each memory carries an authority tier (from its source); on
//                  conflict higher authority wins, and ranking breaks ties by it.
//   • DECAY/EVICTION — confidence decays from the last-reinforced time, a hard
//                  TTL expires rows, and forget() soft-deletes.
//
// Backend-agnostic: all SQL goes through db.query (pg-style $N placeholders; the
// SQLite test adapter translates). Timestamps are written as explicit ISO-8601
// strings (UTC, trailing Z) rather than DB defaults, so decay math and TTL
// comparisons are identical on Postgres and SQLite. ISO-8601 also sorts
// lexically === chronologically, so `expires_at > $now` is correct as a string
// compare on SQLite and a timestamp compare on Postgres.

const db = require('../db')
const { sameId } = require('../middleware/authz')

// Precedence tiers. Higher number wins a conflict. 'user' sits just below
// 'policy': an explicit human directive is authoritative, but a policy/safety
// rule still overrides it. (Resolves PRD §13 open question on user vs derived.)
const AUTHORITY = Object.freeze({
  policy:  5,
  user:    4,
  fact:    3,
  derived: 2,
  ai:      1,
  history: 0,
})

const HALF_LIFE_DAYS = 30   // confidence halves every 30 days since last reinforcement
const DEFAULT_K      = 10   // default recall fan-out
const DAY_MS         = 86_400_000
const MAX_KIND_LEN    = 64    // a kind is a short tag
const MAX_CONTENT_LEN = 2000  // bound a single memory's size to prevent store bloat

function nowIso() { return new Date().toISOString() }

// Exponential decay on the [0,1] confidence, anchored at the last-reinforced
// time. Age ≤ 0 (clock skew / just written) is a no-op factor of 1.
function decayFactor(ageDays) {
  if (!(ageDays > 0)) return 1
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

function ageDaysSince(iso, now) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return (Date.parse(now) - t) / DAY_MS
}

// FAIL CLOSED. A scope is either the trusted agency (may touch any client_id,
// including NULL/agency-wide) or a single client pinned to its own client_id.
// Anything else — missing scope, unknown role, a client with no bound id — throws.
function normalizeScope(scope) {
  if (!scope || (scope.role !== 'agency' && scope.role !== 'client')) {
    throw new Error('memory: invalid scope (role must be "agency" or "client")')
  }
  if (scope.role === 'client' && (scope.clientId === null || scope.clientId === undefined || scope.clientId === '')) {
    throw new Error('memory: client scope requires a clientId')
  }
  return scope
}

// Resolve the client_id a write lands on, enforcing the scope boundary.
//   • agency  — claim.client_id as given (undefined → NULL agency-wide).
//   • client  — always the caller's own id; a mismatching explicit id is a
//               hard error (never silently redirected).
function resolveWriteClientId(scope, claimClientId) {
  if (scope.role === 'agency') {
    return claimClientId === undefined ? null : claimClientId
  }
  if (claimClientId !== undefined && claimClientId !== null && !sameId(claimClientId, scope.clientId)) {
    throw new Error('memory: client scope cannot write to another client_id')
  }
  return scope.clientId
}

// Append a NULL-safe `client_id` predicate to a params array (Postgres has
// IS NOT DISTINCT FROM, SQLite does not — so branch explicitly).
function pushClientEq(clauses, params, clientId) {
  if (clientId === null || clientId === undefined) {
    clauses.push('client_id IS NULL')
  } else {
    params.push(clientId)
    clauses.push(`client_id = $${params.length}`)
  }
}

// ── remember ──────────────────────────────────────────────────────────────────
// Persist (or reinforce) a claim. Dedups on (client_id, kind, content) among
// live rows: a repeat reinforces the existing memory (max confidence/authority,
// refreshed recency + TTL) instead of inserting a duplicate.
//
//   claim = { client_id?, kind, content, source, confidence?, ttlDays?, evidence_ref? }
//
// Returns { id, deduped }.
async function remember(scope, claim) {
  normalizeScope(scope)
  if (!claim || typeof claim !== 'object') throw new Error('memory: claim required')

  const kind    = typeof claim.kind === 'string' ? claim.kind.trim() : ''
  const content = typeof claim.content === 'string' ? claim.content.trim() : ''
  const source  = typeof claim.source === 'string' ? claim.source.trim() : ''
  if (!kind)    throw new Error('memory: claim.kind required')
  if (!content) throw new Error('memory: claim.content required')
  // Size guardrails — bound what a single write can store so an oversized payload
  // can't bloat the store (the route surfaces these as 400, not 500).
  if (kind.length > MAX_KIND_LEN)       throw new Error(`memory: kind exceeds ${MAX_KIND_LEN} chars`)
  if (content.length > MAX_CONTENT_LEN) throw new Error(`memory: content exceeds ${MAX_CONTENT_LEN} chars`)
  if (!(source in AUTHORITY)) {
    throw new Error(`memory: unknown source "${source}" (expected one of ${Object.keys(AUTHORITY).join(', ')})`)
  }

  const clientId   = resolveWriteClientId(scope, claim.client_id)
  const authority  = AUTHORITY[source]
  const confidence = clampConfidence(claim.confidence)
  const now        = nowIso()
  const expiresAt  = ttlToExpiry(claim.ttlDays, now)
  const evidence   = claim.evidence_ref ?? null

  // Dedup against live rows with the same (client_id, kind, content).
  const findClauses = ['forgotten_at IS NULL']
  const findParams  = []
  findParams.push(kind);    findClauses.push(`kind = $${findParams.length}`)
  findParams.push(content); findClauses.push(`content = $${findParams.length}`)
  pushClientEq(findClauses, findParams, clientId)
  const existing = await db.query(
    `SELECT id, confidence, authority, source, evidence_ref
       FROM agent_memory WHERE ${findClauses.join(' AND ')} LIMIT 1`,
    findParams,
  )

  if (existing.rows.length > 0) {
    const row = existing.rows[0]
    // Reinforce: keep the strongest confidence/authority, refresh recency + TTL.
    // A restatement at >= the stored authority carries its source/evidence
    // forward; a weaker-authority repeat preserves the stored metadata.
    const keepNewMeta = authority >= Number(row.authority)
    await db.query(
      `UPDATE agent_memory
          SET confidence = $1, authority = $2, source = $3, evidence_ref = $4,
              updated_at = $5, expires_at = $6
        WHERE id = $7`,
      [
        Math.max(Number(row.confidence), confidence),
        Math.max(Number(row.authority), authority),
        keepNewMeta ? source : row.source,
        keepNewMeta ? evidence : (row.evidence_ref ?? null),
        now,
        expiresAt,
        row.id,
      ],
    )
    return { id: numId(row.id), deduped: true }
  }

  const ins = await db.query(
    `INSERT INTO agent_memory
       (client_id, kind, content, source, authority, confidence, evidence_ref, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [clientId ?? null, kind, content, source, authority, confidence, evidence, now, now, expiresAt],
  )
  return { id: numId(ins.rows[0].id), deduped: false }
}

// ── recall ────────────────────────────────────────────────────────────────────
// Return up to k live, in-scope memories, ranked by decayed confidence then
// authority. A 'client' scope is hard-clamped to its own client_id regardless of
// what the query asks for (clamp, never trust — mirrors POST /api/query).
//
//   query = { clientId?, kind?, text? }   ('clientId' present, incl. null, filters)
//
// Returns claims with both raw `confidence` and computed `effective_confidence`.
async function recall(scope, query = {}, opts = {}) {
  normalizeScope(scope)
  const k   = Number.isInteger(opts.k) && opts.k > 0 ? opts.k : DEFAULT_K
  // `opts.now` (ISO) pins the decay/expiry clock so a recall is deterministic
  // for a given instant; defaults to the wall clock.
  const now = opts.now || nowIso()

  const clauses = ['forgotten_at IS NULL', `(expires_at IS NULL OR expires_at > $1)`]
  const params  = [now]

  if (scope.role === 'client') {
    pushClientEq(clauses, params, scope.clientId)            // hard clamp
  } else if (Object.prototype.hasOwnProperty.call(query, 'clientId')) {
    pushClientEq(clauses, params, query.clientId)            // agency may target one client (or NULL)
  }
  if (query.kind) {
    params.push(query.kind); clauses.push(`kind = $${params.length}`)
  }
  if (query.text) {
    params.push(`%${String(query.text).toLowerCase()}%`)
    clauses.push(`LOWER(content) LIKE $${params.length}`)
  }

  const { rows } = await db.query(
    `SELECT id, client_id, kind, content, source, authority, confidence,
            evidence_ref, created_at, updated_at, expires_at
       FROM agent_memory
      WHERE ${clauses.join(' AND ')}`,
    params,
  )

  return rows
    .map(r => {
      const confidence = Number(r.confidence)
      const effective  = confidence * decayFactor(ageDaysSince(isoOf(r.updated_at), now))
      return {
        id:                   numId(r.id),
        client_id:            r.client_id ?? null,
        kind:                 r.kind,
        content:              r.content,
        source:               r.source,
        authority:            Number(r.authority),
        confidence,
        effective_confidence: effective,
        evidence_ref:         r.evidence_ref ?? null,
        created_at:           isoOf(r.created_at),
        updated_at:           isoOf(r.updated_at),
        expires_at:           r.expires_at ? isoOf(r.expires_at) : null,
      }
    })
    .sort((a, b) =>
      b.effective_confidence - a.effective_confidence ||
      b.authority - a.authority ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
      b.id - a.id)
    .slice(0, k)
}

// ── forget ────────────────────────────────────────────────────────────────────
// Soft-delete live memories matching the selector, within scope. A 'client'
// scope can only forget its own rows. Returns the number forgotten.
//
//   selector = { id?, clientId?, kind?, content? }
async function forget(scope, selector = {}) {
  normalizeScope(scope)
  const now = nowIso()

  const clauses = ['forgotten_at IS NULL']
  const params  = [now]   // $1 is the forgotten_at value in SET

  if (selector.id !== undefined && selector.id !== null) {
    params.push(selector.id); clauses.push(`id = $${params.length}`)
  }
  if (selector.kind) {
    params.push(selector.kind); clauses.push(`kind = $${params.length}`)
  }
  if (selector.content) {
    params.push(selector.content); clauses.push(`content = $${params.length}`)
  }

  if (scope.role === 'client') {
    pushClientEq(clauses, params, scope.clientId)            // hard clamp
  } else if (Object.prototype.hasOwnProperty.call(selector, 'clientId')) {
    pushClientEq(clauses, params, selector.clientId)
  }

  const res = await db.query(
    `UPDATE agent_memory SET forgotten_at = $1 WHERE ${clauses.join(' AND ')}`,
    params,
  )
  return res.rowCount || 0
}

// ── compact ───────────────────────────────────────────────────────────────────
// Reclaim long-dead rows: those FORGOTTEN or EXPIRED longer ago than the
// retention window. LIVE memories (not forgotten, and not past their expiry) are
// never touched — a memory with no TTL never becomes eligible. Idempotent and
// safe to run on a schedule. Returns the number of rows reclaimed.
async function compact({ retentionDays = 90, now = nowIso() } = {}) {
  const days   = Math.max(0, Number(retentionDays) || 0)
  const cutoff = new Date(Date.parse(now) - days * DAY_MS).toISOString()
  const res = await db.query(
    `DELETE FROM agent_memory
       WHERE (forgotten_at IS NOT NULL AND forgotten_at < $1)
          OR (expires_at   IS NOT NULL AND expires_at   < $1)`,
    [cutoff],
  )
  return res.rowCount || 0
}

// ── small helpers ─────────────────────────────────────────────────────────────
function clampConfidence(c) {
  const n = c === undefined || c === null ? 1 : Number(c)
  if (Number.isNaN(n)) return 1
  return Math.min(1, Math.max(0, n))
}

function ttlToExpiry(ttlDays, now) {
  if (ttlDays === undefined || ttlDays === null) return null
  const d = Number(ttlDays)
  if (!(d > 0)) return null
  return new Date(Date.parse(now) + d * DAY_MS).toISOString()
}

function numId(v) { const n = Number(v); return Number.isNaN(n) ? v : n }

// Normalise a stored timestamp to a comparable ISO string. Postgres returns a
// Date for TIMESTAMPTZ; SQLite returns the TEXT we wrote (already ISO).
function isoOf(v) {
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

module.exports = { remember, recall, forget, compact, AUTHORITY, HALF_LIFE_DAYS, decayFactor }
