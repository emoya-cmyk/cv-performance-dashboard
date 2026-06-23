'use strict'

// Enforcement test: the vendored compaction module MUST stay byte-identical to the
// canonical shared-kit copy — same guard as vendorSync.test.js for dashboard-core.
// CI fails the moment they diverge, so a fix to the canonical primitive can't
// silently leave the dashboard consumer behind.
//
// Allowed differences: the vendor keeps its own PROVENANCE.md; canonical has no
// package-lock.json. Everything else (index.js, lib/, package.json, README.md,
// NOTICE, test/ + fixtures) must match exactly.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const CANONICAL = path.join(__dirname, '..', '..', 'shared-kit', 'compaction')
const VENDOR = path.join(__dirname, '..', 'vendor', 'compaction')
const IGNORE_CANONICAL = new Set(['package-lock.json'])
const IGNORE_VENDOR = new Set(['PROVENANCE.md'])

function walk (root, base = '', acc = new Map()) {
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? path.join(base, entry.name) : entry.name
    if (entry.isDirectory()) walk(root, rel, acc)
    else acc.set(rel, path.join(root, rel))
  }
  return acc
}

test('vendored compaction is byte-identical to canonical shared-kit', (t) => {
  if (!fs.existsSync(CANONICAL)) {
    t.skip('shared-kit/compaction not present (consumer repo)')
    return
  }
  const canonical = walk(CANONICAL)
  const vendor = walk(VENDOR)

  const missing = []
  const differ = []
  for (const [rel, abs] of canonical) {
    if (IGNORE_CANONICAL.has(rel)) continue
    const v = vendor.get(rel)
    if (!v) { missing.push(rel); continue }
    if (!fs.readFileSync(abs).equals(fs.readFileSync(v))) differ.push(rel)
  }

  const extra = []
  for (const rel of vendor.keys()) {
    if (IGNORE_VENDOR.has(rel)) continue
    if (!canonical.has(rel)) extra.push(rel)
  }

  assert.deepStrictEqual(missing, [], `vendor missing canonical files: ${missing.join(', ')}`)
  assert.deepStrictEqual(differ, [], `vendor drifted from canonical: ${differ.join(', ')} — re-sync from shared-kit/compaction`)
  assert.deepStrictEqual(extra, [], `vendor has files not in canonical: ${extra.join(', ')}`)
})
