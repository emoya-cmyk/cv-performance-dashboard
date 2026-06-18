'use strict'

// Enforcement test: the vendored dashboard-core MUST stay byte-identical to the
// canonical shared-kit copy. This is the guard that was missing — cv's vendor had
// silently drifted to 0.2.0 (auth.js behind canonical 0.4.0) and nothing caught
// it until a manual diff. Now CI fails the moment they diverge.
//
// Scope: cv is the canonical home, so it can compare in-repo. Sibling repos are
// covered by shared-kit/scripts/check_vendor_drift.py (cross-repo scan).
//
// Allowed differences: the vendor keeps its own PROVENANCE.md; canonical keeps a
// package-lock.json that isn't vendored. Everything else must match exactly.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const CANONICAL = path.join(__dirname, '..', '..', 'shared-kit', 'dashboard-core')
const VENDOR = path.join(__dirname, '..', 'vendor', 'dashboard-core')
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

test('vendored dashboard-core is byte-identical to canonical shared-kit', (t) => {
  if (!fs.existsSync(CANONICAL)) {
    t.skip('shared-kit/dashboard-core not present (consumer repo)')
    return
  }
  const canonical = walk(CANONICAL)
  const vendor = walk(VENDOR)

  // 1) every canonical file is vendored, with identical bytes
  const missing = []
  const differ = []
  for (const [rel, abs] of canonical) {
    if (IGNORE_CANONICAL.has(rel)) continue
    const v = vendor.get(rel)
    if (!v) { missing.push(rel); continue }
    if (!fs.readFileSync(abs).equals(fs.readFileSync(v))) differ.push(rel)
  }

  // 2) the vendor carries nothing extra (beyond its allowed PROVENANCE.md)
  const extra = []
  for (const rel of vendor.keys()) {
    if (IGNORE_VENDOR.has(rel)) continue
    if (!canonical.has(rel)) extra.push(rel)
  }

  assert.deepStrictEqual(missing, [], `vendor missing canonical files: ${missing.join(', ')}`)
  assert.deepStrictEqual(differ, [], `vendor drifted from canonical: ${differ.join(', ')} — re-sync from shared-kit/dashboard-core`)
  assert.deepStrictEqual(extra, [], `vendor has files not in canonical: ${extra.join(', ')}`)
})

test('vendored dashboard-core version matches canonical', (t) => {
  if (!fs.existsSync(CANONICAL)) { t.skip('canonical not present'); return }
  const cv = JSON.parse(fs.readFileSync(path.join(CANONICAL, 'package.json'), 'utf8')).version
  const vv = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8')).version
  assert.strictEqual(vv, cv, `vendor is ${vv}, canonical is ${cv} — re-sync`)
})
