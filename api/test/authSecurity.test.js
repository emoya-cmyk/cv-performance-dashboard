'use strict'

// Unit tests for lib/authSecurity.js — pure, no DB, no Express.

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
} = require('../lib/authSecurity')

// ── validatePassword ─────────────────────────────────────────────────────────
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
  // non-positive / non-finite min → default floor (not a zero/negative bypass)
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
  // '€' is 3 UTF-8 bytes — 24 = 72 bytes (ok), 25 = 75 bytes (reject)
  assert.equal(validatePassword('€'.repeat(24)).ok, true)
  assert.equal(validatePassword('€'.repeat(25)).ok, false)
})

// ── checkProductionSecret ────────────────────────────────────────────────────
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

// ── DUMMY_HASH ───────────────────────────────────────────────────────────────
test('DUMMY_HASH: valid 60-char bcrypt digest that never matches', async () => {
  assert.match(DUMMY_HASH, /^\$2[aby]\$\d{2}\$/)
  assert.equal(DUMMY_HASH.length, 60)
  assert.equal(await bcrypt.compare('anything', DUMMY_HASH), false)
  assert.equal(await bcrypt.compare('', DUMMY_HASH), false)
  assert.equal(await bcrypt.compare('timing-equalizer-not-a-real-password ', DUMMY_HASH), false)
})
