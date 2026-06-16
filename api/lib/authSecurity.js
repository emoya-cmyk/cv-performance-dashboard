'use strict'

// Thin wrapper over the vendored @emoya-cmyk/dashboard-core auth-hardening
// primitives. The symbols cv uses — DEV_SECRET_FALLBACK, MIN_PASSWORD_LENGTH,
// BCRYPT_MAX_BYTES, DUMMY_HASH, validatePassword, checkProductionSecret — are
// byte-for-byte identical to the canonical module, so cv re-exports them from the
// vendored package (api/vendor/dashboard-core).
//
// checkProductionSecret(env) is called positionally with a single arg here and at
// cv's call sites; the package adds an optional second `opts` (devSecretFallback)
// that defaults to DEV_SECRET_FALLBACK, so omitting it is identical to cv today.
//
// Public export shape is preserved exactly: cv never exported the package's
// assertJwtSecret, so it is deliberately NOT re-exported here — no call site
// changes.

const {
  DEV_SECRET_FALLBACK,
  MIN_PASSWORD_LENGTH,
  BCRYPT_MAX_BYTES,
  DUMMY_HASH,
  validatePassword,
  checkProductionSecret,
} = require('../vendor/dashboard-core')

module.exports = {
  DEV_SECRET_FALLBACK,
  MIN_PASSWORD_LENGTH,
  BCRYPT_MAX_BYTES,
  DUMMY_HASH,
  validatePassword,
  checkProductionSecret,
}
