# compaction (Python) — lossless token-compaction

Python twin of `../compaction` (JS). **Byte-identical `enc=v1` format** — a block
written by either language decodes in the other (the smoke test pins the same golden
bytes the JS suite pins). Standard library only; zero dependencies. This is the port
the Python repos consume (`cli_framework` first; `mlb_v159` lossless-only — see the
betting fence in the brief).

See `../compaction/README.md` for the full spec, the "why lossless" rationale, the
format, and the cache-alignment rule. This file documents only the Python surface.

## Usage

```python
from compaction import compact, expand
from cache_align import assemble_prompt

rows = vendor_read(...)                 # list of near-uniform dicts
res = compact(rows)                     # res["text"] is ready to send
payload = res["text"]

prompt = assemble_prompt(
    stable=[system_policy, schema_doc, tool_defs],   # cacheable prefix (byte-stable)
    volatile=[payload],                              # the compacted read, last
)

original = expand(payload)              # == rows
```

`compact(value, ...)` returns a dict: `compacted` (bool), `text` (always model-ready:
the block, or `json.dumps(value)`), `reason`, and `original_chars` / `compacted_chars`
/ `ratio` (**measured**) plus `*_tokens_est` (≈chars/4 **estimate**, eligibility gate
only). Keyword options mirror the JS defaults: `min_rows=5`, `min_tokens=200`,
`core_field_fraction=0.8`, `heterogeneous_core_ratio=0.6`, `verify=True`.

> `verify=True` (recommended everywhere — D-4) round-trips inline and **falls back to
> the original** on any mismatch: it would rather send more tokens than one altered
> value. In `cli_framework` this runs on the **read→model** payload only; the
> write/verify path is out of scope and untouched.

## Test

```bash
python3 tests/test_smoke.py        # prints + asserts; exit 0 = pass
```

Self-contained (the kit's Python test convention — no pytest). Runs the shared golden
fixtures, the adversarial cell cases, the three-state empty/null/absent check, the
`round_trips_lossless` predicate both ways, format parity with the JS golden bytes,
and the cache-alignment helper.
