# memory-os (Python)

Python port of `@emoya-cmyk/memory-os` — portable, scoped, decaying **agent
memory**. Same guarantees and SQL contract as the JS package, for repos like
`cli_framework` / `mlb_v159`.

## Use
```python
from memory_os import Memory

# query(sql, params) uses pg-style $1..$N placeholders and returns an object/dict
# with `rows` (list of dict) and `rowcount`. Wrap your DB driver to match.
mem = Memory(query)                       # optional: table=, half_life_days=

mem.remember({"role": "agency"},
             {"client_id": "acme", "kind": "highlight",
              "content": "Revenue up 33% wow", "source": "derived", "ttl_days": 90})

# A client only ever sees its own tenant (clamped):
hits = mem.recall({"role": "client", "client_id": "acme"}, {"kind": "highlight"}, k=5)

mem.compact(retention_days=90)            # schedule daily
```

## Schema
Apply `schema.sql` (Postgres) or `schema.sqlite.sql` (SQLite) once — identical to
the JS package's tables.

## DB adapter
The single coupling is the injected `query`. Example for stdlib `sqlite3`
(translates `$N → ?` and reconstructs `RETURNING` via `lastrowid`) is in
`test_smoke.py`. For Postgres (psycopg), translate `$N → %s` and return
`cursor.fetchall()` (as dicts) + `cursor.rowcount`.

## Verify
```
python test_smoke.py     # scope isolation, cross-write block, precedence, dedup, forget
```
