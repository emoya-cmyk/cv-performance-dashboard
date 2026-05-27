'use strict'
const { migrate } = require('./db')
migrate().then(() => {
  console.log('migrate done')
  const Database = require('better-sqlite3')
  const db = new Database('./dev.db')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  console.log('Tables:', tables.map(t => t.name).join(', '))
  db.close()
  process.exit(0)
}).catch(e => { console.error('ERR', e.message); process.exit(1) })
