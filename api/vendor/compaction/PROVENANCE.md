# Provenance

Vendored from `cv-performance-dashboard/shared-kit/compaction` (canonical).
**Re-sync from there; do not edit in place.**

- **Source:** `shared-kit/compaction` @ `@emoya-cmyk/compaction` v0.1.0
- **Source commit (cv):** `143f64ff0f37555d7cc46d6f2dbc4824e896f2a7`
- **Synced:** 2026-06-22 (G3 — dashboard adoption of the token-compaction layer)

This copy is byte-identical to canonical (index.js, lib/, package.json, README.md,
NOTICE, test/). The vendored copy keeps only this extra `PROVENANCE.md`; the
canonical side has no `package-lock.json`. `test/vendorSyncCompaction.test.js`
fails CI the moment the two diverge (same guard as dashboard-core).

Used by `api/lib/ask.js` (`buildNarrateContent`) to losslessly compact the
tabular result rows sent to the model. Permanent fix is GitHub Packages
(`@emoya-cmyk/compaction`) per `shared-kit/PACKAGES.md`.
