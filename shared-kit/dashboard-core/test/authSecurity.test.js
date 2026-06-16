'use strict'

// Unit tests for the authSecurity helpers — ported from agency's
// api/test/authSecurity.test.js, plus coverage for the added assertJwtSecret
// boot guard. Pure: no DB, no Express.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const {
  DEV_SECRET_FALLBACK,
  MIN_PASSWORD_LENGTH,
  BCRYPT_MAX_BYTES,
  DUMMY_HASH,
  validatePassword,
  checkProductionSecret,
  assertJwtSecret,
} = require('..')

// ── validatePassword (password floor) ─────────────────────────────────────────
test('validatePassword: rejects non-strings', () => {
  for (const v of [undefined, null, 12345, {}, [], true]) {
    const r = validatePassword(v)
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to be rejected`)
    assert.match(r.error, /string/)
  }
})

test('validatePassword: enforces the length floor', () => {
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok, false)
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH)).ok, true)
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH + 5)).ok, true)
  assert.equal(validatePassword('').ok, false)
  assert.match(validatePassword('short').error, /at least/)
})

test('validatePassword: custom min overrides the default; bad min falls back', () => {
  assert.equal(validatePassword('abcdefghijkl', { min: 16 }).ok, false)
  assert.equal(validatePassword('a'.repeat(16), { min: 16 }).ok, true)
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH), { min: 0 }).ok, true)
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1), { min: 0 }).ok, false)
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH), { min: NaN }).ok, true)
  assert.equal(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH), { min: -5 }).ok, true)
})

test('validatePassword: rejects blank/whitespace-only above the floor', () => {
  const r = validatePassword(' '.repeat(MIN_PASSWORD_LENGTH + 2))
  assert.equal(r.ok, false)
  assert.match(r.error, /blank/)
})

test('validatePassword: rejects > bcrypt 72-byte ceiling (incl. multibyte)', () => {
  assert.equal(validatePassword('a'.repeat(BCRYPT_MAX_BYTES)).ok, true)
  const over = validatePassword('a'.repeat(BCRYPT_MAX_BYTES + 1))
  assert.equal(over.ok, false)
  assert.match(over.error, /bytes/)
  assert.equal(validatePassword('€'.repeat(24)).ok, true)   // 72 bytes
  assert.equal(validatePassword('€'.repeat(25)).ok, false)  // 75 bytes
})

// ── checkProductionSecret (boot guard) ────────────────────────────────────────
test('checkProductionSecret: permissive outside production', () => {
  const envs = [
    {},
    { NODE_ENV: 'test' },
    { NODE_ENV: 'development' },
    { NODE_ENV: 'test', JWT_SECRET: DEV_SECRET_FALLBACK },
    { NODE_ENV: undefined, JWT_SECRET: undefined },
  ]
  for (const env of envs) {
    const r = checkProductionSecret(env)
    assert.equal(r.ok, true)
    assert.equal(r.error, null)
  }
})

test('checkProductionSecret: fails closed in production with missing/dev/empty secret', () => {
  const missing = checkProductionSecret({ NODE_ENV: 'production' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /JWT_SECRET/)

  assert.equal(checkProductionSecret({ NODE_ENV: 'production', JWT_SECRET: DEV_SECRET_FALLBACK }).ok, false)
  assert.equal(checkProductionSecret({ NODE_ENV: 'production', JWT_SECRET: '' }).ok, false)
})

test('checkProductionSecret: passes in production with a real secret', () => {
  const r = checkProductionSecret({ NODE_ENV: 'production', JWT_SECRET: 'a-genuinely-random-long-secret-value' })
  assert.equal(r.ok, true)
  assert.equal(r.error, null)
})

test('checkProductionSecret: a custom devSecretFallback is also rejected in prod', () => {
  const r = checkProductionSecret(
    { NODE_ENV: 'production', JWT_SECRET: 'repo-specific-dev-fallback' },
    { devSecretFallback: 'repo-specific-dev-fallback' }
  )
  assert.equal(r.ok, false)
})

// ── assertJwtSecret (throwing boot guard) ─────────────────────────────────────
test('assertJwtSecret: throws in production on missing/fallback secret', () => {
  assert.throws(() => assertJwtSecret({ NODE_ENV: 'production' }), /JWT_SECRET/)
  assert.throws(
    () => assertJwtSecret({ NODE_ENV: 'production', JWT_SECRET: DEV_SECRET_FALLBACK }),
    /JWT_SECRET/
  )
  assert.throws(() => assertJwtSecret({ NODE_ENV: 'production', JWT_SECRET: '' }), /JWT_SECRET/)
})

test('assertJwtSecret: returns the effective secret when usable', () => {
  assert.equal(
    assertJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'strong-secret' }),
    'strong-secret'
  )
  // Outside production it never throws; unset → the dev fallback (what agency's
  // middleware/auth.js uses when JWT_SECRET is missing).
  assert.equal(assertJwtSecret({ NODE_ENV: 'test' }), DEV_SECRET_FALLBACK)
  assert.equal(assertJwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'dev' }), 'dev')
})

// ── DUMMY_HASH (login timing equalizer) ───────────────────────────────────────
test('DUMMY_HASH: valid 60-char bcrypt digest that never matches', async () => {
  assert.match(DUMMY_HASH, /^\$2[aby]\$\d{2}\$/)
  assert.equal(DUMMY_HASH.length, 60)
  assert.equal(await bcrypt.compare('anything', DUMMY_HASH), false)
  assert.equal(await bcrypt.compare('', DUMMY_HASH), false)
  assert.equal(await bcrypt.compare('timing-equalizer-not-a-real-password ', DUMMY_HASH), false)
})
