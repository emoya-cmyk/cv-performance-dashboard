'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// @emoya/memory-os — portable, scoped, decaying agent memory.
//
// Decoupled from any one app: you inject a `query(sql, params)` function (pg-style
// $1..$N placeholders, resolving to { rows, rowCount }) and, for grounding, a
// `verify(text, pack)` function. Works on Postgres or SQLite behind that seam.
//
//   const mem = createMemory({ query })
//   await mem.remember({ role: 'agency' }, { client_id, kind, content, source })
//   const hits = await mem.recall({ role: 'client', clientId }, { kind }, { k: 5 })
//
// Invariants (the reason to use this rather than a bare table):
//   • SCOPE      — a 'client' scope can never read/write another tenant's rows.
//   • PRECEDENCE — authority tier from source; higher wins conflicts + ranking ties.
//   • DECAY/TTL  — confidence decays from last-reinforced time; hard TTL; forget;
//                  compact reclaims long-dead rows (live rows never touched).
// ─────────────────────────────────────────────────────────────────────────────

const AUTHORITY = Object.freeze({ policy: 5, user: 4, fact: 3, derived: 2, ai: 1, history: 0 })
const DAY_MS = 86_400_000

const nowIso = () => new Date().toISOString()
const sameId = (a, b) =>
  a != null && a !== '' && b != null && b !== '' && String(a).trim() === String(b).trim()

function createMemory({ query, table = 'agent_memory', halfLifeDays = 30 } = {}) {
  if (typeof query !== 'function') throw new Error('memory-os: a query(sql, params) function is required')

  const decayFactor = (ageDays) => (ageDays > 0 ? Math.pow(0.5, ageDays / halfLifeDays) : 1)
  const ageDays = (iso, now) => {
    const t = Date.parse(iso); return Number.isNaN(t) ? 0 : (Date.parse(now) - t) / DAY_MS
  }

  function normalizeScope(scope) {
    if (!scope || (scope.role !== 'agency' && scope.role !== 'client')) {
      throw new Error('memory-os: invalid scope (role must be "agency" or "client")')
    }
    if (scope.role === 'client' && (scope.clientId == null || scope.clientId === '')) {
      throw new Error('memory-os: client scope requires a clientId')
    }
    return scope
  }
  function resolveWriteClientId(scope, claimClientId) {
    if (scope.role === 'agency') return claimClientId === undefined ? null : claimClientId
    if (claimClientId != null && !sameId(claimClientId, scope.clientId)) {
      throw new Error('memory-os: client scope cannot write to another client_id')
    }
    return scope.clientId
  }
  function pushClientEq(clauses, params, clientId) {
    if (clientId == null) { clauses.push('client_id IS NULL') }
    else { params.push(clientId); clauses.push(`client_id = $${params.length}`) }
  }
  const clampConfidence = (c) => {
    const n = c == null ? 1 : Number(c); return Number.isNaN(n) ? 1 : Math.min(1, Math.max(0, n))
  }
  const ttlToExpiry = (ttlDays, now) => {
    const d = Number(ttlDays); return d > 0 ? new Date(Date.parse(now) + d * DAY_MS).toISOString() : null
  }
  const numId = (v) => { const n = Number(v); return Number.isNaN(n) ? v : n }
  const isoOf = (v) => (v instanceof Date ? v.toISOString() : String(v))

  async function remember(scope, claim) {
    normalizeScope(scope)
    if (!claim || typeof claim !== 'object') throw new Error('memory-os: claim required')
    const kind = String(claim.kind || '').trim()
    const content = String(claim.content || '').trim()
    const source = String(claim.source || '').trim()
    if (!kind) throw new Error('memory-os: claim.kind required')
    if (!content) throw new Error('memory-os: claim.content required')
    if (!(source in AUTHORITY)) throw new Error(`memory-os: unknown source "${source}"`)

    const clientId = resolveWriteClientId(scope, claim.client_id)
    const authority = AUTHORITY[source]
    const confidence = clampConfidence(claim.confidence)
    const now = nowIso()
    const expiresAt = ttlToExpiry(claim.ttlDays, now)
    const evidence = claim.evidence_ref ?? null

    const fc = ['forgotten_at IS NULL']; const fp = []
    fp.push(kind); fc.push(`kind = $${fp.length}`)
    fp.push(content); fc.push(`content = $${fp.length}`)
    pushClientEq(fc, fp, clientId)
    const existing = await query(
      `SELECT id, confidence, authority, source, evidence_ref FROM ${table} WHERE ${fc.join(' AND ')} LIMIT 1`, fp)

    if (existing.rows.length > 0) {
      const row = existing.rows[0]
      const keepNew = authority >= Number(row.authority)
      await query(
        `UPDATE ${table} SET confidence=$1, authority=$2, source=$3, evidence_ref=$4, updated_at=$5, expires_at=$6 WHERE id=$7`,
        [Math.max(Number(row.confidence), confidence), Math.max(Number(row.authority), authority),
         keepNew ? source : row.source, keepNew ? evidence : (row.evidence_ref ?? null), now, expiresAt, row.id])
      return { id: numId(row.id), deduped: true }
    }
    const ins = await query(
      `INSERT INTO ${table} (client_id, kind, content, source, authority, confidence, evidence_ref, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [clientId ?? null, kind, content, source, authority, confidence, evidence, now, now, expiresAt])
    return { id: numId(ins.rows[0].id), deduped: false }
  }

  async function recall(scope, q = {}, opts = {}) {
    normalizeScope(scope)
    const k = Number.isInteger(opts.k) && opts.k > 0 ? opts.k : 10
    const now = opts.now || nowIso()
    const clauses = ['forgotten_at IS NULL', '(expires_at IS NULL OR expires_at > $1)']
    const params = [now]
    if (scope.role === 'client') pushClientEq(clauses, params, scope.clientId)
    else if (Object.prototype.hasOwnProperty.call(q, 'clientId')) pushClientEq(clauses, params, q.clientId)
    if (q.kind) { params.push(q.kind); clauses.push(`kind = $${params.length}`) }
    if (q.text) { params.push(`%${String(q.text).toLowerCase()}%`); clauses.push(`LOWER(content) LIKE $${params.length}`) }

    const { rows } = await query(
      `SELECT id, client_id, kind, content, source, authority, confidence, evidence_ref, created_at, updated_at, expires_at
         FROM ${table} WHERE ${clauses.join(' AND ')}`, params)

    return rows.map((r) => {
      const confidence = Number(r.confidence)
      return {
        id: numId(r.id), client_id: r.client_id ?? null, kind: r.kind, content: r.content,
        source: r.source, authority: Number(r.authority), confidence,
        effective_confidence: confidence * decayFactor(ageDays(isoOf(r.updated_at), now)),
        evidence_ref: r.evidence_ref ?? null,
        created_at: isoOf(r.created_at), updated_at: isoOf(r.updated_at),
        expires_at: r.expires_at ? isoOf(r.expires_at) : null,
      }
    }).sort((a, b) =>
      b.effective_confidence - a.effective_confidence || b.authority - a.authority ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id).slice(0, k)
  }

  async function forget(scope, selector = {}) {
    normalizeScope(scope)
    const now = nowIso()
    const clauses = ['forgotten_at IS NULL']; const params = [now]
    if (selector.id != null) { params.push(selector.id); clauses.push(`id = $${params.length}`) }
    if (selector.kind) { params.push(selector.kind); clauses.push(`kind = $${params.length}`) }
    if (selector.content) { params.push(selector.content); clauses.push(`content = $${params.length}`) }
    if (scope.role === 'client') pushClientEq(clauses, params, scope.clientId)
    else if (Object.prototype.hasOwnProperty.call(selector, 'clientId')) pushClientEq(clauses, params, selector.clientId)
    const res = await query(`UPDATE ${table} SET forgotten_at = $1 WHERE ${clauses.join(' AND ')}`, params)
    return res.rowCount || 0
  }

  async function compact({ retentionDays = 90, now = nowIso() } = {}) {
    const cutoff = new Date(Date.parse(now) - Math.max(0, Number(retentionDays) || 0) * DAY_MS).toISOString()
    const res = await query(
      `DELETE FROM ${table}
        WHERE (forgotten_at IS NOT NULL AND forgotten_at < $1) OR (expires_at IS NOT NULL AND expires_at < $1)`,
      [cutoff])
    return res.rowCount || 0
  }

  return { remember, recall, forget, compact, AUTHORITY, decayFactor }
}

// Grounding helper: given an injected verify(text, pack) → { grounded, offending },
// annotate recalled claims with `assertable` without filtering them out.
function groundClaims(claims, pack, verify) {
  const list = Array.isArray(claims) ? claims : []
  if (!pack || typeof verify !== 'function') return list.map((c) => ({ ...c, assertable: null, offending: [] }))
  return list.map((c) => {
    const { grounded, offending } = verify(String(c.content || ''), pack)
    return { ...c, assertable: grounded, offending: offending || [] }
  })
}

module.exports = { createMemory, groundClaims, AUTHORITY }
