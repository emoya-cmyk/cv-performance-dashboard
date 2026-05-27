'use strict'
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

// Remove old db
try { fs.unlinkSync('./dev.db') } catch {}

const db = new Database('./dev.db')
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const sqlFile = path.join(__dirname, 'migrations/001_initial.sqlite.sql')
const sql = fs.readFileSync(sqlFile, 'utf8')

const stmts = sql
  .split(/;\s*(\n|$)/m)
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith('--'))

console.log(`Found ${stmts.length} statements`)
for (let i = 0; i < stmts.length; i++) {
  const stmt = stmts[i]
  console.log(`\n--- Stmt ${i + 1} (${stmt.length} chars) ---`)
  console.log(stmt.slice(0, 80))
  try {
    db.exec(stmt + ';')
    console.log('  OK')
  } catch (err) {
    console.error('  ERR:', err.message)
  }
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('\nTables created:', tables.map(t => t.name).join(', '))
db.close()
process.exit(0)
