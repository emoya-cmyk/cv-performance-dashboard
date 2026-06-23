# @emoya-cmyk/compaction — lossless token-compaction

Two free, zero-dependency primitives that cut **input** tokens to the model
without changing a single value we send it:

1. **Lossless tabular compaction** — an array of near-uniform JSON objects becomes
   one schema header + one delimited line per row, so the repeated field names are
   named **once** instead of on every row. Every value survives:
   `expand(compact(x).text)` deep-equals `x` for all inputs.
2. **Prompt-prefix cache alignment** — a call-site discipline (one tiny helper) so
   the stable part of a prompt leads and the volatile compacted read trails, letting
   provider prompt caches hit on the prefix.

> Canonical home. This is the source of truth in `cv-performance-dashboard/shared-kit`;
> the Python twin lives in `../compaction-py` (byte-identical `enc=v1` format). Roll
> it into the other repos via `../CROSS_REPO_PLAYBOOK.md`.

This is a **clean-room** re-implementation of the one lossless primitive from
`chopratejas/headroom` (Apache-2.0). See [`NOTICE`](./NOTICE). The lossy paths that
project also offers (row-drop, CCR offload, opaque-blob substitution) are **out of
scope, family-wide** — they're incompatible with our grounded-AI invariant.

## Why lossless (not "preferred" — mandatory)

The family's grounded-AI invariant says **no AI sentence may assert a number not
derived from a deterministic evidence pack.** A lossless reformat preserves that
*by construction*: because the transform is a bijection on the value set — nothing
dropped, substituted, or reordered — any count/sum/lookup the model performs is over
the **complete, unaltered** set. Row-drop would let the model assert "12 open jobs"
over a set silently truncated to 15-of-N; reversible-offload with a TTL adds a second
failure mode for read→verify gaps. So this module is lossless-**only**, and any input
it cannot prove lossless it **passes through untouched**. Never guess.

## Usage

```js
const { compact, expand, assemblePrompt } = require('@emoya-cmyk/compaction')

const rows = await vendor.read(...)        // array of near-uniform objects
const { compacted, text, ratio } = compact(rows)   // text is ready to send

const prompt = assemblePrompt({
  stable:   [systemPolicy, schemaDoc, toolDefs],   // cacheable prefix (byte-stable)
  volatile: [text],                                 // the compacted read, last
})

// If you ever need the data back from a stored block:
const original = expand(text)              // deep-equals rows
```

`compact(value, opts)` returns:

| field | meaning |
|---|---|
| `compacted` | `true` only if a `##TBL` block was actually emitted |
| `text` | **always** model-ready — the block, or the original `JSON.stringify(value)` |
| `reason` | why it did / didn't compact (`compacted`, `below-min-rows`, `below-min-tokens`, `heterogeneous`, `no-gain`, `verify-failed-fallback`, …) — useful for the §8 measurement holdout |
| `originalChars`, `compactedChars`, `ratio` | **measured** size (never estimated) |
| `originalTokensEst`, `compactedTokensEst` | a cheap ≈chars/4 **estimate**, for the eligibility gate only — not a billing number |

### Options (D-3 defaults; all overridable per call)

| opt | default | effect |
|---|---|---|
| `minRows` | `5` | fewer rows → passthrough (header overhead not worth it) |
| `minTokens` | `200` | smaller rendered payload → passthrough |
| `coreFieldFraction` | `0.8` | a key is "core" if present in ≥ this share of rows |
| `heterogeneousCoreRatio` | `0.6` | if fewer than this share of union keys are core → passthrough |
| `verify` | `true` | round-trip inline; **fall back to the original on any mismatch** |

## Format (`enc=v1`)

```
##TBL keys=["id","status","amount","closed"] types=["s","s","n","b"] rows=5 enc=v1
c_001|won|4200|true
c_002|open|0|false
…
```

- **Header** carries the union `keys` and a per-column storage `types` (`s` string,
  `n` number, `b` boolean, `x` mixed/null/nested) as JSON arrays, so keys with
  commas/spaces survive. `rows` is the count; `enc` the version.
- **Cells** are delimited by `|`, rows by newline. `s`/`n`/`b` columns are bare; an
  `x` column tags each cell (`~` null, `s:`/`n:`/`b:`/`j:` for string/number/bool/
  JSON) so its exact type round-trips. A nested object/array rides inline as `j:`-JSON.
- **Absent vs empty vs null** are three distinct states: a key missing on a row is a
  reserved `\z` sentinel; an empty string is an empty cell; `null` is `~` (or its own
  `x` column). The escape (`\\ \| \n \r`) is reversible by construction — the escape
  char is escaped first, so no content can forge a delimiter or the sentinel.

### Deliberate v1 scope (deferred, not forgotten)

To keep G1 provably correct, two of the brief's compression refinements are **v2**:
heterogeneous arrays (core share < `heterogeneousCoreRatio`) are passed through rather
than bucketed by a guessed discriminator, and nested-uniform objects ride as inline
`j:`-JSON rather than being flattened to dotted keys. Both choices are lossless; they
just leave some compression on the table until we've measured real heterogeneous reads
(G2). Tune the thresholds, or lift these deferrals, once those fixtures exist.

## Guarantees (enforced in code, pinned by tests)

- Never drops a row, substitutes a value, or reorders within a row.
- `test/roundtrip.test.js` proves `decode(encode(x)) == x` on golden, real-shape
  reads (one per vendor surface + a dashboard synthesis payload), the adversarial
  cell cases (pipes, newlines, backslashes, nulls, nesting, absent keys, unicode),
  and the below-threshold / heterogeneous passthrough paths.
- `verify` mode round-trips inline and **falls back to the original** on any
  mismatch — fail loud-safe, never silently ship a lossy reformat. The
  `roundTripsLossless` predicate that gates the fallback is tested **both ways**
  (accepts a faithful block, rejects a corrupted one), so the guard is load-bearing.
- Zero npm dependencies (node builtins only). `npm test` → `node --test`.

## Cache alignment

`assemblePrompt({ stable, volatile })` concatenates the stable prefix first and the
volatile suffix last; `cachePrefix(stable)` returns just the cacheable portion.
**Keep `stable` byte-identical across requests** for a task — only `volatile` should
vary — and the provider cache hits the prefix. Pure string assembly; no data changes.

## Measurement (prove it, don't estimate it)

Report a **measured** delta, not an estimate (§8 of the brief). At an instrumented
call site, leave a ~10% control holdout uncompacted, log input-token counts for
compacted vs. control over the same workload, and report the delta with its sample
size. `compact().reason` makes the holdout/skip bookkeeping easy. On the golden
fixtures here the **char** reduction is ~30–55%; the model-token reduction is what
G2/G3 must measure on real calls.
