'use strict'

// Thin wrapper over the vendored @emoya-cmyk/dashboard-core auth layer.
// cv consumes the canonical module (vendored at api/vendor/dashboard-core) for
// the byte-for-byte-identical requireAuth. The original cv implementation read
//   const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'
// at module load and built requireAuth around it. createAuth() with no args
// captures process.env.JWT_SECRET || DEV_SECRET_FALLBACK (the same literal) at
// call time — invoked here at module load, so behaviour is identical. Public
// export shape is unchanged: { requireAuth }.

const { createAuth } = require('../vendor/dashboard-core')

const { requireAuth } = createAuth()

module.exports = { requireAuth }
