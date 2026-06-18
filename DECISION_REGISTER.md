# Irreversible Decision Register

A lightweight ADR-style record of architectural commitments that **cannot be
cheaply undone** — data migrations, vendor constraints, identity keying. The
register's job is to make the *next* irreversible decision visible **before it
ships**, not to relitigate the seeded ones (Spec B).

## When to use it

Before any commit that touches **canonical identity**, the **verification
schema**, or the **promotion-tier read path**, add a candidate entry below and
pressure-test it (prompt #61 — "identify irreversible architectural decisions;
explain long-term risks and alternatives"). If, after that, the decision still
looks right, ship it and move the entry from _Candidate_ to a numbered record.

Each entry carries:

- **Decision** — what was committed.
- **Irreversibility** — why it can't be cheaply undone.
- **Alternatives considered** — and why rejected.
- **Blast radius** — what breaks if it's wrong.

---

## DR-1 — AccuLynx Layer C is permanently manual

- **Status:** Live (seeded).
- **Decision:** AccuLynx writes are performed by a human operator; the system
  never writes to AccuLynx automatically.
- **Irreversibility:** The AccuLynx public API is **GET-only by design**. No
  amount of internal work creates a write path; the constraint is the vendor's.
- **Alternatives considered:** Automated write integration (impossible — no write
  API); screen-scraping/RPA (brittle, ToS risk, rejected).
- **Blast radius:** Any roadmap item that assumes auto-write to AccuLynx is
  invalid. The correctness primitive (Spec A) accounts for this: AccuLynx is
  measured by **read-back verification of the operator's manual change**, on the
  same correctness axis as automated vendors — so the manual path is still
  measurable, just never auto-written.

## DR-2 — Canonical identity keyed on `acculynx_job_id`, with email/phone fallback

- **Status:** Live (seeded).
- **Decision:** Records are matched on `acculynx_job_id` as the primary canonical
  key; when absent, fall back to email, then phone.
- **Irreversibility:** Re-keying identity after data has accumulated means a
  full migration and re-linking of historical rows across every tenant — and any
  mis-merge during re-keying is itself hard to unwind.
- **Alternatives considered:** Composite natural keys (fragile across vendor
  representations); per-vendor surrogate keys (loses cross-vendor identity);
  email-first (less stable than the job id where it exists).
- **Blast radius:** Identity collisions or splits propagate into every
  tenant-scoped surface — including write-verification read-backs, which resolve
  the record to re-read by this exact key. The fallback order is therefore part
  of the contract, not an implementation detail.

## DR-3 — Write-verification correctness schema (three+one outcome axis)

- **Status:** Live (this branch).
- **Decision:** Verified writes are recorded on a correctness axis —
  `FAILED` / `PERSISTED_UNVERIFIED` / `PERSISTED_INCORRECT` / `VERIFIED_CORRECT`
  — accumulated per `(tenant, endpoint)` in `write_verification_stats`
  (migration `035_write_verification`). The spec names three states; we log
  "persisted-but-wrong" as its own distinct outcome (`PERSISTED_INCORRECT`)
  because the spec requires a mismatch be "logged as such," and the Wilson gate
  must count it as **not-correct without conflating it with a failed write**.
- **Irreversibility:** Once promotion tiers read from these counters, the
  *semantics* of the columns are load-bearing and historical samples can't be
  re-derived. Choosing the outcome taxonomy now fixes what "correct" means for
  every future autonomy decision.
- **Alternatives considered:** A literal two-state (`success`/`failed`) — the
  existing conflation, rejected as the whole point of Spec A; a strict
  three-state collapsing mismatch into `PERSISTED_UNVERIFIED` — rejected because
  it hides persisted-but-wrong writes from the gate.
- **Blast radius:** The Wilson promotion gate (deferred) keys entirely off this
  taxonomy. If the axis is wrong, every promotion decision built on it is wrong —
  which is exactly why the gate is **not wired yet**: correctness samples
  accumulate first, then the gate reads `VERIFIED_CORRECT / total`.

---

## Candidates (not yet committed)

> _Add a candidate here before a commit that touches identity, the verification
> schema, or the promotion-tier read path. Run prompt #61 against it, then either
> promote it to a numbered record or drop it._

- **(next):** Wiring the Wilson promotion gate to read
  `write_verification_stats`. This is deliberately deferred (Spec A sequencing) —
  promoting on the persistence data we already have would bake the
  persistence-vs-correctness conflation into the autonomy layer permanently.
  Promote this candidate only once real `VERIFIED_CORRECT` samples exist per
  `(tenant, endpoint)`.
