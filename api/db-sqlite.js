/**
 * SQLite adapter for local development.
 * Wraps better-sqlite3 behind a pg-compatible interface:
 *   query(sql, params?) → Promise<{ rows: [] }>
 * Auto-selected by db.js when DATABASE_URL is not set.
 *
 * Translation handled here:
 *   $1..$N → ? (SQLite positional style)
 *   RETURNING clauses  → captured via LAST_INSERT_ROWID or a follow-up SELECT
 *   UUID defaults       → generated in JS (crypto.randomUUID)
 *   NOW() / CURRENT_TIMESTAMP → handled by SQLite
 */

'use strict'

const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')
const crypto   = require('crypto')

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'dev.db')

let db

function getDb() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

// Translate $1..$N positional params → ? honoring the placeholder NUMBER (not its
// order of appearance) and supporting reuse of the same $N. Postgres indexes $N
// into the params array regardless of WHERE each placeholder sits in the SQL; a
// naive appearance-order replace silently mis-binds any out-of-order or repeated
// placeholder — e.g. `UPDATE t SET a=$2, b=$3 WHERE id=$1` would bind id from the
// 3rd param, matching zero rows. Returns the rewritten SQL plus a params array
// reordered to line up 1:1 with the emitted `?` sequence (undefined → null).
function pgToSqlite(sql, params = []) {
  const mapped = []
  const out = sql.replace(/\$(\d+)/g, (_, n) => {
    mapped.push(params[Number(n) - 1] ?? null)
    return '?'
  })
  return { sql: out, params: mapped }
}

// Strip RETURNING clause — we re-fetch manually
// Returns { stripped, returningCols }
function stripReturning(sql) {
  const m = sql.match(/\bRETURNING\s+(.+)$/is)
  if (!m) return { stripped: sql, returningCols: null }
  return {
    stripped:       sql.slice(0, m.index).trim(),
    returningCols:  m[1].trim(),
  }
}

// Main query function — pg-compatible: returns { rows, rowCount }
async function query(text, params = []) {
  const conn = getDb()

  // Normalise undefined → null, then translate $N → ? honoring the placeholder
  // NUMBER (see pgToSqlite) so out-of-order / reused placeholders bind correctly.
  const rawArgs = (params || []).map(p => (p === undefined ? null : p))
  const translated = pgToSqlite(text, rawArgs)
  let sql = translated.sql
  const args = translated.params

  // Handle RETURNING
  const { stripped, returningCols } = stripReturning(sql)
  if (returningCols) {
    sql = stripped
  }

  try {
    const isSelect = /^\s*(SELECT|WITH|EXPLAIN)/i.test(sql)

    if (isSelect) {
      const stmt = conn.prepare(sql)
      const rows = stmt.all(...args)
      return { rows, rowCount: rows.length }
    }

    // Write statement
    const stmt  = conn.prepare(sql)
    const info  = stmt.run(...args)

    if (!returningCols) {
      return { rows: [], rowCount: info.changes }
    }

    // Reconstruct RETURNING rows:
    // For INSERT: use lastInsertRowid (works for INTEGER PK tables)
    // For UPDATE / DELETE: try to re-fetch based on changes
    // We use a simple approach: parse the table name and re-fetch lastInsertRowid or use rowid
    let rows = []
    if (/^\s*(INSERT)/i.test(stripped)) {
      const tbl = stripped.match(/INTO\s+(\w+)/i)?.[1]
      if (tbl && info.lastInsertRowid) {
        const sel = conn.prepare(`SELECT * FROM ${tbl} WHERE rowid = ?`)
        const row = sel.get(info.lastInsertRowid)
        rows = row ? [row] : []
      }
    } else if (/^\s*(UPDATE)/i.test(stripped)) {
      // Re-fetch by parsing WHERE clause from the original stripped SQL
      // This is a best-effort approach; works for simple WHERE id = ? patterns
      const tbl = stripped.match(/UPDATE\s+(\w+)/i)?.[1]
      const whereM = stripped.match(/WHERE\s+(.+)$/i)
      if (tbl && whereM) {
        const whereSql = whereM[1]
        // Count the number of ? placeholders before WHERE
        const beforeWhere = stripped.slice(0, stripped.toUpperCase().indexOf('WHERE'))
        const priorQmarks = (beforeWhere.match(/\?/g) || []).length
        const whereArgs   = args.slice(priorQmarks)
        const sel = conn.prepare(`SELECT * FROM ${tbl} WHERE ${whereSql}`)
        try { rows = sel.all(...whereArgs) } catch { rows = [] }
      }
    }
    return { rows, rowCount: info.changes }

  } catch (err) {
    // Attach the SQL for debugging
    err.message = `[SQLite] ${err.message}\nSQL: ${sql.slice(0, 200)}`
    throw err
  }
}

// Minimal pool shim (server.js does pool.on('error', ...) and pool.end())
const pool = {
  on:    () => {},
  end:   () => Promise.resolve(),
  query: (text, params) => query(text, params),
}

// ── Monday of the week containing a given date ────────────────────────────────
function weekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

// ── Migration runner ──────────────────────────────────────────────────────────
async function migrate(close = false) {
  const conn = getDb()
  const dir  = path.join(__dirname, 'migrations')

  // Prefer sqlite-specific migrations (*.sqlite.sql), fall back to main .sql files
  const allFiles = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

  // Build a set: for each NNN_ prefix, pick *.sqlite.sql if present, else the plain .sql
  const prefixMap = {}
  allFiles.forEach(f => {
    const prefix = f.replace(/\.sqlite\.sql$/, '').replace(/\.sql$/, '')
    if (f.endsWith('.sqlite.sql')) {
      prefixMap[prefix] = f  // sqlite-specific wins
    } else if (!prefixMap[prefix]) {
      prefixMap[prefix] = f  // plain sql only if no sqlite version
    }
  })

  const files = Object.values(prefixMap).sort()
  for (const f of files) {
    const rawSql = fs.readFileSync(path.join(dir, f), 'utf8')

    // For SQLite-specific files: run the whole file at once (better-sqlite3 supports multi-stmt exec)
    // For plain Postgres files: skip PG-only syntax (UUID type, gen_random_uuid, TIMESTAMPTZ, etc.)
    const isSqliteFile = f.endsWith('.sqlite.sql')

    if (isSqliteFile) {
      try {
        conn.exec(rawSql)
      } catch (err) {
        if (!err.message.includes('already exists') &&
            !err.message.includes('duplicate column')) {
          console.warn('[db-sqlite] migration warning:', err.message.slice(0, 200))
        }
      }
      console.log('[db-sqlite] applied', f)
      continue
    }

    // For plain .sql files (Postgres-oriented), run statement-by-statement, skipping PG-only syntax
    const pgOnlyPatterns = [
      /\bUUID\b/i,
      /gen_random_uuid/i,
      /TIMESTAMPTZ/i,
      /NUMERIC\s*\(/i,
    ]

    const stmts = rawSql
      .split(/;\s*\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))

    for (const stmt of stmts) {
      // Skip statements with PG-only syntax
      if (pgOnlyPatterns.some(p => p.test(stmt))) continue
      try {
        conn.exec(stmt + ';')
      } catch (err) {
        if (!err.message.includes('already exists') &&
            !err.message.includes('duplicate column')) {
          console.warn('[db-sqlite] migration stmt warning:', err.message.slice(0, 120))
        }
      }
    }
    console.log('[db-sqlite] applied', f)
  }
}

module.exports = { query, pool, weekStart, migrate }
