'use strict'

// ============================================================
// lib/authSecurity.js — small, pure auth-hardening helpers.
//
// Three launch-hardening primitives the auth router and the server bootstrap
// share, kept here so they are unit-testable without a DB or Express:
//
//   1. validatePassword(pw)       — enforce a sane strength floor so the most
//                                    privileged account (the first agency admin)
//                                    can't be created with a 1-char password.
//   2. checkProductionSecret(env) — FAIL-CLOSED guard: refuse to boot in
//                                    production when JWT_SECRET is unset or still
//                                    the public dev fallback. We never invent or
//                                    store a secret — that stays an operator gate;
//                                    we only refuse to run insecurely without one.
//   3. DUMMY_HASH                 — a fixed, valid cost-10 bcrypt digest used to
//                                    equalize /login latency on the no-such-user
//                                    branch, closing the account-enumeration
//                                    timing oracle.
//
// Pure functions only — no DB, no Express, no process mutation.
// ============================================================

// The literal the codebase falls back to when JWT_SECRET is unset (see
// routes/auth.js + middleware/auth.js). Kept in ONE place so the guard and the
// fallback can never drift.
const DEV_SECRET_FALLBACK = 'dev-secret-change-in-production'

// Minimum password length. 10 is a pragmatic floor for a B2B dashboard — long
// enough to defeat trivial guessing, short enough not to push operators toward
// reuse. A stricter bar can be requested per call site via { min }.
const MIN_PASSWORD_LENGTH = 10

// bcrypt silently truncates input at 72 BYTES — anything beyond is ignored, so a
// 200-char "strong" password is no stronger than its first 72 bytes and gives a
// false sense of entropy. Reject above the limit with a clear message rather than
// hash a truncated prefix.
const BCRYPT_MAX_BYTES = 72

// A fixed, valid cost-10 bcrypt hash of a throwaway string. A compare against it
// is always false and costs ~the same as a real compare, so the /login no-user
// branch can spend equal time and not leak account existence via response
// timing. Hard-coded (not generated at load) so behavior is byte-identical across
// processes and test runs.
const DUMMY_HASH = '$2a$10$bPnkTvT7HGW8XcqbOwdWHO1OUyX2sp8EarXuyrdqKcNZc0VbcwTHq'

// Validate a candidate password. Pure → { ok, error }.
//   opts.min — override the default length floor (non-finite/≤0 → default).
function validatePassword(pw, opts = {}) {
  const min = Number.isFinite(opts.min) && opts.min > 0 ? opts.min : MIN_PASSWORD_LENGTH
  if (typeof pw !== 'string') return { ok: false, error: 'Password must be a string' }
  if (pw.length < min) return { ok: false, error: `Password must be at least ${min} characters` }
  if (Buffer.byteLength(pw, 'utf8') > BCRYPT_MAX_BYTES) {
    return { ok: false, error: `Password must be at most ${BCRYPT_MAX_BYTES} bytes` }
  }
  if (pw.trim().length === 0) return { ok: false, error: 'Password must not be blank' }
  return { ok: true, error: null }
}

// Fail-closed production secret guard. Pure → { ok, error }.
// ok:false ONLY in production with a missing/dev-fallback JWT_SECRET. In any
// non-production env (test, development, undefined) it is permissive so the suite
// and local dev keep working with the built-in fallback.
function checkProductionSecret(env = {}) {
  if (env.NODE_ENV !== 'production') return { ok: true, error: null }
  const secret = env.JWT_SECRET
  if (!secret || secret === DEV_SECRET_FALLBACK) {
    return {
      ok: false,
      error:
        'JWT_SECRET is unset or still the public dev fallback. Set a strong, ' +
        'random JWT_SECRET in the environment before starting in production ' +
        '(Render sets it automatically via generateValue; off-Render, set it ' +
        'yourself).',
    }
  }
  return { ok: true, error: null }
}

module.exports = {
  DEV_SECRET_FALLBACK,
  MIN_PASSWORD_LENGTH,
  BCRYPT_MAX_BYTES,
  DUMMY_HASH,
  validatePassword,
  checkProductionSecret,
}
