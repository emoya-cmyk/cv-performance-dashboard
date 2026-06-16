'use strict'

// Thin wrapper over the vendored @emoya-cmyk/dashboard-core AI budget.
// createAiBudget, aiBudgetKey are byte-for-byte identical to the canonical
// module (only comments differ), so cv re-exports them from the vendored package
// (api/vendor/dashboard-core). Public export shape is unchanged:
// { createAiBudget, aiBudgetKey }.

const { createAiBudget, aiBudgetKey } = require('../vendor/dashboard-core')

module.exports = { createAiBudget, aiBudgetKey }
