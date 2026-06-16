'use strict'

// Thin wrapper over the vendored @emoya-cmyk/dashboard-core authz guards.
// sameId, requireAgency, scopeClientParam, scopeClientId are byte-for-byte
// identical to the canonical module, so cv re-exports them from the vendored
// package (api/vendor/dashboard-core). Public export shape is preserved exactly:
// cv never exported the package's scopeClientQuery, so it is deliberately NOT
// re-exported here — no call site changes.

const {
  sameId,
  requireAgency,
  scopeClientParam,
  scopeClientId,
} = require('../vendor/dashboard-core')

module.exports = { sameId, requireAgency, scopeClientParam, scopeClientId }
