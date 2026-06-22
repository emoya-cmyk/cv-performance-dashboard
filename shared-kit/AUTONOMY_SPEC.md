# Loop Engineering & Autonomy Standard — `emoya-cmyk` family (canonical)

**Version 2.0** · supersedes 1.x · Owner: Ernesto (CRM/Automation) ·
Review cadence: quarterly + on any vendor-schema change

This is the **canonical** copy of the family autonomy standard, kept in the
shared kit so every `emoya-cmyk` repo standardizes on one version. The
**reference implementation** of Part 4 lives in the federated hub,
`cli_framework/enhancements/autonomy/` (with a clause-by-clause implementation
map in `cli_framework/AUTONOMY_SPEC.md`).

**Scope:** `cli_framework`, `MAKE_REMEDIATION`, `SEO_Revenue_Engine`, and
(optionally) the betting engine. **Excluded:** `mlb_v159` — air-gapped by
construction (registers no adapter; the controller has no handle to it).

---

## Foundational principles
1. **One signal** — self-heal, self-learn, autonomy all run on whether an action
   was **value-correct**.
2. **Verification is decoupled from application** — lets the system learn (in
   shadow) before it is trusted.
3. **The trust label is a process metric the action controls**, never a
   confounded downstream outcome.
4. **Every autonomous write carries its own undo** at write time.
5. **Maker ≠ checker**, and the verifier is itself code under test.
6. **Trust is slow to gain, fast to lose.**

## The mechanism (Part 4, summarized)
- Everything promotable is a scoped **Action Kind** `(repo, kind, scope)`; a repo
  joins by implementing `RepoAdapter`. Not registering = not governed.
- Tiers: **L1 suggest · L2 draft · L3 apply-low-risk (human-gated) · L4
  auto-complete + audit.**
- **Event-sourced:** agents append idempotent `VerificationEvent`s; one reducer
  is the sole mutator; projections rebuild by replay (no restart amnesia).
- **Statistics:** cohort clustering + design-effect deflation (correlated
  failures can't inflate confidence), empirical-Bayes partial pooling toward a
  `parent_scope`, and a posterior lower credible bound as the promotion gate —
  all partitioned by `verifier_version`.
- **Shadow scoring** earns trust from human-applied, verified actions before the
  agent ever writes.
- **Demotion** is automatic and one trigger suffices (hard-trip / blind / drift /
  regime-change), with reversal sweeps and hysteresis.
- **Verifier canary** (golden good/bad/unverifiable) freezes autonomy on
  regression.

## Guardrail invariants
`unverifiable` is pending not success (#1); no auto-apply above L2 while blind
(#2); **AccuLynx writes frozen ≤ L3** (#3); no L4 without a reversible undo (#4);
demotion strictly easier than promotion (#5); quarantine a regressed corpus first
(#6); **`mlb_v159` never governed** (#7); §1.2 gate before any loop (#8); security
checks before L4 publish (#9); auto-pause under 50% acceptance (#10); no loops on
architecture/auth/vault/billing (#11); audit connector/skill scope every 30 days
(#12); process-metric trust label only (#13); effective (deflated) counts,
versioned (#14); failing canary freezes the verifier (#15); append-only events,
one reducer (#16).

## Governance
Semver'd; thresholds/priors are version-controlled config reviewed quarterly and
on any vendor-schema change. Break-glass: only the named owner may unfreeze a
hard-tripped action or force-promote; safety-critical unfreezes and any forced L4
require a **two-person rule**; every override is logged and auto-expires.

---

## Adoption checklist (per repo joining governance)
1. Read this standard + your repo's standing `VISION.md`/`AGENTS.md` every run.
2. Implement a `RepoAdapter` against the hub
   (`cli_framework/enhancements/autonomy`): `propose` / `snapshot_prior` /
   `apply` / `verify` / `would_propose`.
3. Define the **process-metric verifier** for your action kind (see the Part 4.3
   table) and its golden canary cases.
4. Pick the scope + `parent_scope` (pooling level) and the cohort key
   (deploy/schema/failure-class).
5. Start at L1; let **shadow scoring** accrue evidence before any autonomous
   write. Never register `mlb_v159`.

> The full prose standard (Parts 0–11, the verifier table, Appendix B
> calibration) is mirrored in `cli_framework/AUTONOMY_SPEC.md`, which also maps
> each clause to the enforcing code and test.
