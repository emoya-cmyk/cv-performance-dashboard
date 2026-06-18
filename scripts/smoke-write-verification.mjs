#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// smoke-write-verification.mjs — SELF-CONTAINED end-to-end proof of the
// write-verification correctness loop (Spec A). No deployment needed: it spins
// the real routers in-process over an isolated SQLite DB, POSTs one of each
// outcome to the ingest webhook, then reads them back via the operator
// correctness endpoint and asserts the ledger reflects them.
//
// It doubles as executable documentation of the cli_framework ingest contract
// (see WRITE_VERIFICATION_CONTRACT.md). Run: `node scripts/smoke-write-verification.mjs`
// Exit 0 = the loop works end-to-end; non-zero = a step failed.
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'module'
import path from 'path'
import url from 'url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const apiDir = path.join(__dirname, '..', 'api')
const req = createRequire(path.join(apiDir, 'package.json'))

// Pin the env BEFORE requiring db (db.js selects SQLite on no DATABASE_URL and
// reads SQLITE_PATH; auth + the webhook read their secrets at request time).
const os = req('os'); const fs = req('fs')
const DB_PATH = path.join(os.tmpdir(), `wv_smoke_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
delete process.env.DATABASE_URL
process.env.SQLITE_PATH = DB_PATH
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wv-smoke-secret'
process.env.MAKE_WEBHOOK_SECRET = process.env.MAKE_WEBHOOK_SECRET || 'wv-smoke-webhook-secret'

const express = req('express')
const jwt     = req('jsonwebtoken')
const db      = req('./db')
const wvRouter  = req('./routes/webhooks/writeVerification')
const opsRouter = req('./routes/makeRemediation')
const { requireAuth } = req('./middleware/auth')

let PASS = 0, FAIL = 0
const ok  = (m) => { console.log(`  PASS  ${m}`); PASS++ }
const bad = (m) => { console.log(`  FAIL  ${m}`); FAIL++ }

const app = express()
app.use(express.json())
app.use('/api/webhooks/write-verification', wvRouter)
app.use('/api/make-remediation', requireAuth, opsRouter)

const TENANT = 't-smoke'
const ENDPOINT = 'acculynx:job.update'
const SIG = { 'x-make-signature': process.env.MAKE_WEBHOOK_SECRET, 'content-type': 'application/json' }
const AGENCY = jwt.sign({ id: 'smoke', email: 'smoke@local', role: 'agency', client_id: null }, process.env.JWT_SECRET)

const cases = [
  { name: 'VERIFIED_CORRECT', body: { tenant_id: TENANT, endpoint: ENDPOINT, persisted: true,
      canonical_id: 'job_1', canonical_id_kind: 'primary',
      intended: { phone: '(555) 123-4567', status: 'won' },
      read_back: { phone: '5551234567', status: 'won' }, equivalence: { phone: { kind: 'phone' } } } },
  { name: 'PERSISTED_INCORRECT', body: { tenant_id: TENANT, endpoint: ENDPOINT, persisted: true,
      canonical_id: 'job_2', intended: { status: 'won' }, read_back: { status: 'lost' } } },
  { name: 'PERSISTED_UNVERIFIED', body: { tenant_id: TENANT, endpoint: ENDPOINT, persisted: true,
      canonical_id: 'job_3', intended: { status: 'won' }, read_back: null } },
  { name: 'FAILED', body: { tenant_id: TENANT, endpoint: ENDPOINT, persisted: false, intended: { status: 'won' } } },
]

async function main() {
  console.log(`Write-verification smoke → in-process (sqlite ${path.basename(DB_PATH)})`)
  await db.migrate()
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)) })
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    // 1. auth gate: a bad signature is rejected
    const badAuth = await fetch(`${base}/api/webhooks/write-verification`, {
      method: 'POST', headers: { 'x-make-signature': 'wrong', 'content-type': 'application/json' },
      body: JSON.stringify(cases[0].body) })
    badAuth.status === 401 ? ok('bad signature → 401') : bad(`bad signature → ${badAuth.status} (want 401)`)

    // 2. ingest each outcome and check the derived verdict
    for (const c of cases) {
      const r = await fetch(`${base}/api/webhooks/write-verification`, {
        method: 'POST', headers: SIG, body: JSON.stringify(c.body) })
      const j = await r.json().catch(() => ({}))
      ;(r.status === 200 && j.outcome === c.name)
        ? ok(`ingest ${c.name} → ${j.outcome}`)
        : bad(`ingest ${c.name} → ${r.status} ${JSON.stringify(j)}`)
    }
    // mismatch fields are surfaced for the persisted-but-wrong case
    const wrong = await (await fetch(`${base}/api/webhooks/write-verification`, {
      method: 'POST', headers: SIG, body: JSON.stringify({ tenant_id: TENANT, endpoint: ENDPOINT,
        persisted: true, intended: { status: 'won' }, read_back: { status: 'lost' } }) })).json()
    Array.isArray(wrong.mismatchFields) && wrong.mismatchFields.includes('status')
      ? ok('mismatch fields surfaced (status)') : bad(`mismatch fields → ${JSON.stringify(wrong.mismatchFields)}`)

    // 3. operator read: the (tenant, endpoint) accumulator reflects the ingests
    const corr = await (await fetch(`${base}/api/make-remediation/correctness?tenant_id=${TENANT}`,
      { headers: { Authorization: `Bearer ${AGENCY}` } })).json()
    const row = (corr.endpoints || []).find((e) => e.endpoint === ENDPOINT)
    if (!row) { bad('correctness row present'); }
    else {
      ok('correctness row present')
      row.verified_correct >= 1 ? ok(`verified_correct=${row.verified_correct}`) : bad(`verified_correct=${row.verified_correct}`)
      row.persisted_incorrect >= 2 ? ok(`persisted_incorrect=${row.persisted_incorrect}`) : bad(`persisted_incorrect=${row.persisted_incorrect}`)
      row.persisted_unverified >= 1 ? ok(`persisted_unverified=${row.persisted_unverified}`) : bad(`persisted_unverified=${row.persisted_unverified}`)
      row.failed >= 1 ? ok(`failed=${row.failed}`) : bad(`failed=${row.failed}`)
      ;(typeof row.verified_rate === 'number' && typeof row.wilson_lower === 'number' && row.wilson_lower <= row.verified_rate)
        ? ok(`verified_rate=${row.verified_rate}, wilson_lower=${row.wilson_lower}`) : bad('rate/wilson shape')
    }

    // 4. tenant isolation: a different tenant sees nothing
    const other = await (await fetch(`${base}/api/make-remediation/correctness?tenant_id=t-other`,
      { headers: { Authorization: `Bearer ${AGENCY}` } })).json()
    ;((other.endpoints || []).length === 0) ? ok('tenant isolation (t-other empty)') : bad('tenant leak!')
  } finally {
    await new Promise((r) => server.close(r))
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`)
  process.exit(FAIL ? 1 : 0)
}
main().catch((e) => { console.error('smoke crashed:', e); process.exit(2) })
