'use strict'

// ── FR-1 coverage audit: every Make scenario must carry the universal error ────
// handler that POSTs to the remediation webhook. This script lists a team's
// scenarios via the Make API, inspects each blueprint for an HTTP module whose
// URL matches the remediation endpoint, and reports any scenario missing it.
//
// "No error handler = no remediation" — the PRD calls this non-negotiable, so the
// script exits non-zero when any gap is found (usable as a CI / pre-deploy gate).
//
// Usage:
//   MAKE_API_TOKEN=… MAKE_TEAM_ID=… [MAKE_ZONE=us2.make.com] \
//   MAKE_REMEDIATION_URL=https://api…/api/webhooks/make-remediation \
//   node scripts/auditMakeHandlers.js
//
// Env:
//   MAKE_API_TOKEN        (required) Make API token
//   MAKE_TEAM_ID          (required) team whose scenarios to audit
//   MAKE_ZONE             (optional) API host, default 'us2.make.com'
//   MAKE_REMEDIATION_URL  (optional) substring the handler URL must contain,
//                         default '/api/webhooks/make-remediation'

const https = require('https')

const TOKEN   = process.env.MAKE_API_TOKEN
const TEAM    = process.env.MAKE_TEAM_ID
const ZONE    = process.env.MAKE_ZONE || 'us2.make.com'
const NEEDLE  = process.env.MAKE_REMEDIATION_URL || '/api/webhooks/make-remediation'

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ZONE,
      path,
      method: 'GET',
      headers: { Authorization: `Token ${TOKEN}`, 'content-type': 'application/json' },
      timeout: 15_000,
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`bad JSON from ${path}: ${e.message}`)) }
        } else {
          reject(new Error(`Make API ${res.statusCode} on ${path}: ${data.slice(0, 200)}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout on ${path}`)) })
    req.on('error', reject)
    req.end()
  })
}

// Recursively scan a blueprint for any HTTP module URL containing the needle.
function blueprintHasHandler(node, needle) {
  if (node == null) return false
  if (typeof node === 'string') return node.includes(needle)
  if (Array.isArray(node)) return node.some(n => blueprintHasHandler(n, needle))
  if (typeof node === 'object') return Object.values(node).some(v => blueprintHasHandler(v, needle))
  return false
}

async function main() {
  if (!TOKEN || !TEAM) {
    console.error('auditMakeHandlers: MAKE_API_TOKEN and MAKE_TEAM_ID are required.')
    process.exit(2)
  }

  const list = await apiGet(`/api/v2/scenarios?teamId=${encodeURIComponent(TEAM)}`)
  const scenarios = list.scenarios || list.data || []
  if (!scenarios.length) {
    console.log('auditMakeHandlers: no scenarios found for team', TEAM)
    return
  }

  const missing = []
  for (const s of scenarios) {
    const id = s.id || s.scenarioId
    let bp
    try {
      bp = await apiGet(`/api/v2/scenarios/${id}/blueprint`)
    } catch (err) {
      console.warn(`  ! could not load blueprint for scenario ${id} (${s.name}): ${err.message}`)
      missing.push({ id, name: s.name, reason: 'blueprint unavailable' })
      continue
    }
    if (!blueprintHasHandler(bp, NEEDLE)) {
      missing.push({ id, name: s.name, reason: 'no remediation error handler' })
    }
  }

  const covered = scenarios.length - missing.length
  console.log(`auditMakeHandlers: ${covered}/${scenarios.length} scenarios carry the remediation handler.`)
  if (missing.length) {
    console.log('\nScenarios MISSING the universal error handler:')
    for (const m of missing) console.log(`  ✗ [${m.id}] ${m.name} — ${m.reason}`)
    process.exit(1)
  }
  console.log('All scenarios covered ✓')
}

main().catch(err => { console.error('auditMakeHandlers failed:', err.message); process.exit(2) })
