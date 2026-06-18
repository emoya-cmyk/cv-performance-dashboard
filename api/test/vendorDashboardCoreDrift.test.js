'use strict'

// Drift gate for the VENDORED @emoya-cmyk/dashboard-core snapshot. Canonical
// source lives in cv-performance-dashboard/shared-kit/dashboard-core; this repo
// carries a copy. dashboard-core.lock.json pins the sha256 of every vendored lib
// file to its canonical content at sync time. This fails if a vendored file is
// edited locally, truncated, or a partial re-sync leaves it stale — the exact
// silent drift that let auth.js fall a feature behind across every repo. Fix:
// re-sync from canonical and regenerate the lock.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CORE = path.join(__dirname, '..', 'vendor', 'dashboard-core')
const LOCK = path.join(CORE, 'dashboard-core.lock.json')

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

test('vendored dashboard-core matches its lock (no silent drift)', () => {
  assert.ok(fs.existsSync(LOCK), 'dashboard-core.lock.json present')
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
  const files = lock.files || {}
  assert.ok(Object.keys(files).length > 0, 'lock pins at least one file')

  // every pinned file exists and still matches its canonical hash
  for (const [rel, expected] of Object.entries(files)) {
    const abs = path.join(CORE, rel)
    assert.ok(fs.existsSync(abs), `pinned file present: ${rel}`)
    assert.equal(sha256(abs), expected,
      `vendored ${rel} drifted from canonical — re-sync from shared-kit/dashboard-core and regenerate the lock`)
  }

  // no vendored lib/*.js is missing from the lock (catches rogue/untracked edits)
  for (const f of fs.readdirSync(path.join(CORE, 'lib'))) {
    if (f.endsWith('.js')) {
      assert.ok(files[`lib/${f}`] != null, `lib/${f} is tracked in the lock`)
    }
  }
})
