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
    const dir   = path.join(__dirname, 'migrations')
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql') && !f.endsWith('.sqlite.sql'))
      .sort()
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8')
      await pool.query(sql)
      console.log('[db] applied', f)
    }
    if (close) await pool.end()
  }

  module.exports = { query, pool, weekStart, migrate }
}
