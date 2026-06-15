# @emoya-cmyk/memory-os

Portable, scoped, decaying **agent memory**. Extracted from the Memory OS built
in `cv-performance-dashboard`, decoupled so any repo can reuse it: you inject the
DB `query` function (and, for grounding, a `verify` function). Postgres or SQLite.

## Why
A memory is a **claim**, not a fact. This gives an agent durable memory across
stateless sessions with three guarantees a bare table doesn't:
- **Scope** — a `client` scope can never read/write another tenant's rows.
- **Precedence** — each memory carries an authority tier from its `source`
  (`policy > user > fact > derived > ai > history`); higher wins conflicts + ranking.
- **Decay / eviction** — confidence decays from last-reinforced time; hard TTL;
  `forget` soft-deletes; `compact` reclaims long-dead rows (live rows untouched).

## Install (GitHub Packages)
```
# .npmrc in the consuming repo:
@emoya-cmyk:registry=https://npm.pkg.github.com
```
```
npm install @emoya-cmyk/memory-os
```

## Use
```js
const { createMemory, groundClaims } = require('@emoya-cmyk/memory-os')

// query(sql, params) must use pg-style $1..$N and resolve to { rows, rowCount }.
const mem = createMemory({ query })            // optional: { table, halfLifeDays }

await mem.remember({ role: 'agency' }, {
  client_id: 'acme', kind: 'highlight', content: 'Revenue up 33% wow', source: 'derived', ttlDays: 90,
})

// A client only ever sees its own tenant (clamped server-side):
const hits = await mem.recall({ role: 'client', clientId: 'acme' }, { kind: 'highlight' }, { k: 5 })

// Grounding: annotate (don't filter) recalled claims against an evidence pack.
const annotated = groundClaims(hits, pack, verify)   // verify(text, pack) → { grounded, offending }

await mem.compact({ retentionDays: 90 })       // schedule daily
```

## Schema
Apply `schema.sql` (Postgres) or `schema.sqlite.sql` (SQLite) once. The `query`
seam is the only coupling — on SQLite, wrap a driver to translate `$N → ?` and
expose `{ rows, rowCount }` (see `api/db-sqlite.js` in cv-performance-dashboard).

## Reference / tests
The behavior mirrors the in-app engine, whose full unit + leak-proof tests live
in `cv-performance-dashboard/api/test/memory*.test.js`. Port those when adapting.
