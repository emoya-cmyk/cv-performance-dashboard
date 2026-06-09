require('dotenv').config()

// Auto-select SQLite (local dev) vs PostgreSQL (production)
if (!process.env.DATABASE_URL) {
  const sqlite = require('./db-sqlite')
  module.exports = sqlite
} else {
  const { Pool } = require('pg')
  const fs       = require('fs')
  const path     = require('path')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  })

  pool.on('error', (err) => {
    console.error('[db] idle client error', err.message)
  })

  async function query(text, params) {
    const start = Date.now()
    const res = await pool.query(text, params)
    if (process.env.NODE_ENV !== 'production') {
      console.log('[db]', `${Date.now() - start}ms`, text.slice(0, 80))
    }
    return res
  }

  function weekStart(date = new Date()) {
    const d = new Date(date)
    const day = d.getUTCDay()
    const diff = (day === 0 ? -6 : 1) - day
    d.setUTCDate(d.getUTCDate() + diff)
    return d.toISOString().split('T')[0]
  }

  async function migrate(close = false) {
    // One-time tracking table: each migration file is run exactly once.
    // This prevents re-running already-applied migrations on every cold-start,
    // which can fail when a migration has statements that are not fully
    // idempotent (e.g. RENAME COLUMN guards that depend on prior state).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const dir   = path.join(__dirname, 'migrations')
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql') && !f.endsWith('.sqlite.sql'))
      .sort()
    for (const f of files) {
      const { rows: already } = await pool.query(
        'SELECT 1 FROM _migrations WHERE filename = $1', [f]
      )
      if (already.length > 0) {
        console.log('[db] skip (already applied)', f)
        continue
      }
      const sql = fs.readFileSync(path.join(dir, f), 'utf8')
      await pool.query(sql)
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [f])
      console.log('[db] applied', f)
    }
    if (close) await pool.end()
  }

  module.exports = { query, pool, weekStart, migrate }
}
