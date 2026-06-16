'use strict'

// Thin wrapper over the vendored @emoya-cmyk/dashboard-core security headers.
// Byte-for-byte identical to the canonical securityHeaders, so cv re-exports it
// from the vendored package (api/vendor/dashboard-core). Public export shape is
// unchanged: { securityHeaders }.

const { securityHeaders } = require('../vendor/dashboard-core')

module.exports = { securityHeaders }
