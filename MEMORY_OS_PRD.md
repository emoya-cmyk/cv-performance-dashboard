# PRD — Memory OS: Persistent, Scoped, Grounded Memory for a Stateless Agent

_Status: Draft · Owner: TBD · Last updated: 2026-06-15 · Target branch: `claude/claude-fable-5-2jd9z6`_

> **Provenance note.** Part of the motivation below was sharpened by comparing this
> project's intelligence layer against a publicly-circulated, **unverified** extraction of a
> consumer Claude system prompt ("Fable 5"). That document is treated here only as *design
> inspiration for capability patterns* — it is **not** an authoritative spec, and nothing in
> this PRD depends on its authenticity. All hard requirements derive from this repo's own
> invariants (tenant isolation, grounded AI) and from established agent-memory patterns.

---

## 1. Summary

Give an autonomous agent — whether the in-product intelligence layer or an external coding
agent operating on this repo — a **persistent memory** that survives across stateless
sessions. Memories are **scoped** by tenant, **sourced** and ranked by authority,
**grounded** against deterministic evidence before they can influence output, and **decayed
/ evictable** so the store never accretes stale or unsafe claims.

The unit of memory is a *claim*, not a fact: it can inform retrieval freely, but it cannot
appear as an asserted sentence until verified — exactly the discipline `api/lib/evidence.js`
+ `api/lib/ai.js` already apply to AI narration today.

## 2. Background & motivation

- **The gap: agents are stateless.** Each session starts from a fresh clone in an ephemeral
  container; within a long session, context is *summarized/truncated*, not *remembered*.
  Project decisions, conventions, prior diagnoses, and "what we already tried" are re-derived
  every time. That is wasted work and a source of inconsistency.
- **The product already has the right primitives — just not persistence.** The intelligence
  layer (`api/lib/*`) self-calibrates baselines, attributes drivers, and grades its own
  forecasts, but its learning is recomputed rather than *remembered as durable, queryable
  claims*. A memory layer turns transient computation into accumulating institutional memory.
- **Comparison insight.** A consumer-assistant prompt carries an explicit memory subsystem
  hook; this agent does not. Closing that gap — the right way, with scoping and grounding —
  is the highest-leverage capability upgrade available.

## 3. Goals & non-goals

**Goals**
- G1. Durable memory that persists **across sessions** and survives container recycling.
- G2. **Tenant-scoped** reads/writes that cannot leak across `client_id` boundaries.
- G3. **Grounded recall** — a memory cannot be asserted as fact unless verified against the
  evidence path; unverifiable memories may still inform ranking/retrieval.
- G4. **Precedence** resolution — on conflict, higher-authority sources win (policy > fact >
  derived > ai > history).
- G5. **Decay & eviction** — confidence decays with age; hard TTL; explicit "forget."
- G6. Pure, **unit-tested** engine with a **leak-proof** isolation test, matching the repo's
  existing bar (`node --test` stays green; `vite build` clean).

**Non-goals (this version)**
- N1. Embedding/vector recall — start with structured + keyword recall; vectors are a later
  phase.
- N2. Cross-tenant "global learnings" surfaced to clients (agency-only systemic memory may
  exist server-side but is never rendered on a client surface).
- N3. Rewriting the agent's own system prompt — out of scope and not how this works.
- N4. A UI surface beyond a minimal read-only "what I remember" panel (deferred).

## 4. Users & use cases

| User | Use case |
|------|----------|
| `agency` operator | Recall prior diagnoses/decisions across all clients; "what did we try for client X's lead dip?" |
| `client` | Only their own tenant's remembered context (scoped, never another tenant's). |
| The agent (intelligence layer) | Persist baselines, recovery classifications, action→outcome efficacy as durable claims it can recall next run. |
| External coding agent | Persist project conventions/decisions so they aren't re-derived each session (the `CLAUDE.md`-as-living-memory idea). |

## 5. Functional requirements

### 5.1 Memory record
```
memory {
  id            uuid
  client_id     // SCOPE — null = agency-wide; else pinned to exactly one tenant
  kind          // 'decision' | 'observation' | 'convention' | 'efficacy' | ...
  content       // the remembered claim (human-readable)
  source        // 'policy' | 'fact' | 'derived' | 'ai' | 'user' | 'history'
  authority     // precedence tier derived from source
  confidence    // 0..1, decays with age
  evidence_ref  // pointer to fact_metric rows grounding it, or null
  created_at
  ttl           // hard expiry
  forgotten_at  // soft-delete for explicit "forget"
}
```

### 5.2 Write path — `remember(scope, claim)`
- Validate scope against the caller (see §6); reject cross-tenant writes.
- Assign `authority` from `source`; set `confidence`, `ttl`.
- **Dedup**: collapse near-duplicate claims within a scope (update confidence/recency rather
  than inserting a second row).

### 5.3 Read path — `recall(scope, query, k)`
1. Scoped query (own `client_id` + `null` for agency-wide), never another tenant.
2. Drop expired / forgotten rows.
3. Rank by `confidence * decay(age)` and relevance.
4. **Ground**: before any recalled claim is *asserted* in output, verify via the evidence
   path; unverifiable claims may still inform ranking but are flagged non-assertable.
5. Return top-k with their authority/confidence/evidence so callers can reason about trust.

### 5.4 Precedence
On conflicting claims for the same subject, the higher `authority` wins; a memory **never**
overrides a live `fact` or a policy rule. Mirrors the "ignore X even if present in history"
discipline.

### 5.5 Decay, TTL, forget
- `confidence *= decay(age)` on read.
- Hard `ttl` evicts; a nightly sweep (via `scheduler.js`) compacts expired/forgotten rows.
- Explicit `forget(scope, id|subject)` sets `forgotten_at` (auditable soft-delete).

## 6. Security & isolation requirements (load-bearing)

- R1. Every read/write routes through the same gate as `middleware/authz.js#scopeClientId`:
  a `client` caller can only touch `client_id = own` or `null`; an `agency` caller passes.
- R2. Any memory endpoint that takes a `:clientId` uses `scopeClientParam`; agency-only
  memory reads use `requireAgency`.
- R3. **Leak-proof test** (mirroring the existing pattern): assert a `client` token can never
  read or write another tenant's memory, and that agency-only systemic memory never reaches a
  client surface.
- R4. No `NaN`/`Infinity`/`5xx` on an empty store (cold-start parity with existing sweep).

## 7. Proposed API surface

Engine (pure, tested): `api/lib/memory.js`
- `remember(scope, claim)` → id
- `recall(scope, query, { k })` → ranked, grounded claims
- `forget(scope, selector)` → count

REST (scoped via `authz.js`):
- `POST /api/memory` (write — agency, or `client` for own scope)
- `GET  /api/memory/:clientId` (`scopeClientParam`)
- `GET  /api/memory` (agency-only, fleet/systemic)
- `DELETE /api/memory/:id` (scoped)

Routes registered before any param-bearing siblings (routing-order safe).

## 8. Data model & migrations

- New table `agent_memory` with the §5.1 columns; index on `(client_id, kind, created_at)`.
- **Paired migrations**: add both `0NN_agent_memory.sql` (Postgres) and
  `0NN_agent_memory.sqlite.sql` (SQLite), kept in sync — per repo convention.

## 9. Integration points

- `api/lib/evidence.js` / `ai.js` — the grounding gate reused for recalled claims.
- `api/lib/baselines.js`, efficacy/recovery engines — natural first *producers* of memories.
- `api/scheduler.js` — nightly compaction/decay sweep + memory write-back after sweeps.
- (Later) a read-only "what I remember" panel in `ClientView`/`Intelligence`.

## 10. Phasing

- **Phase 1 (MVP):** `agent_memory` table + paired migration; `api/lib/memory.js` with
  `remember`/`recall`/`forget` honoring scope + precedence + decay; unit tests + leak-proof
  isolation test. No AI-runtime wiring yet.
- **Phase 2:** grounding integration (recalled claims pass through `evidence.js`); first real
  producer (efficacy/recovery write-back).
- **Phase 3:** scheduler decay/compaction sweep; REST surface + minimal read-only UI.
- **Phase 4 (optional):** embedding/vector recall; richer relevance.

## 11. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Cross-tenant leak | Single scoping gate (R1–R3) + mandatory leak-proof test; no direct table access outside the engine. |
| Stale/wrong memory asserted | Grounding gate (G3) — unverifiable claims never asserted; decay + TTL. |
| Store bloat | Dedup on write; nightly compaction; hard TTL. |
| Premise drift (treating the "Fable 5" doc as spec) | Provenance note; all hard requirements sourced from repo invariants, not the doc. |

## 12. Success metrics

- 0 cross-tenant leaks (enforced by test, not hoped for).
- Test suite stays 100% green; `vite build` clean.
- Reduction in re-derived context across sessions (qualitative at first; later, % of recalls
  that pass grounding).
- No regression in cold-start/empty-state guarantees.

## 13. Open questions

- Authority ordering for `user`-sourced vs `derived` claims — confirm the tier list.
- Decay curve shape and default TTL per `kind`.
- Whether agency-wide (`null`-scoped) memory needs a separate retention policy from
  per-client memory.

---

### Appendix A — relationship to the "Fable 5" comparison
The comparison clarified *what capability was missing* (durable, scoped memory) by contrast
with a consumer-assistant prompt that carries a memory hook this agent lacks. It contributed
**motivation and naming only**. Every requirement here is independently justified by this
repo's tenant-isolation and grounded-AI invariants; the document's authenticity is
irrelevant to the design and was not assumed.
</content>
