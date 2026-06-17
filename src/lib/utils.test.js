import { describe, it, expect } from 'vitest'
import { fmtN, fmtPct, fmtDollar, fmtDollarShort, delta } from '@/lib/utils'

// Formatters render every figure on the dashboard, so their null-guards and
// rounding are load-bearing. Pure functions — fully deterministic.

describe('numeric + currency formatters', () => {
  it('formats integers with thousands separators', () => {
    expect(fmtN(1234567)).toBe('1,234,567')
    expect(fmtN(42)).toBe('42')
  })

  it('normalizes fractions and whole numbers to a percent', () => {
    expect(fmtPct(0.123)).toBe('12.3%')
    expect(fmtPct(12.3)).toBe('12.3%')
  })

  it('formats USD with no fractional digits by default', () => {
    expect(fmtDollar(12345)).toBe('$12,345')
  })

  it('abbreviates large dollar amounts', () => {
    expect(fmtDollarShort(950)).toBe('$950')
    expect(fmtDollarShort(1500)).toBe('$1.5k')
    expect(fmtDollarShort(2_500_000)).toBe('$2.5M')
  })

  it('returns an em-dash for null / undefined / NaN inputs', () => {
    expect(fmtN(null)).toBe('—')
    expect(fmtPct(undefined)).toBe('—')
    expect(fmtDollar(NaN)).toBe('—')
  })
})

describe('delta', () => {
  it('computes a positive, significant percent change', () => {
    expect(delta(110, 100)).toEqual({ pct: 10, positive: true, significant: true })
  })

  it('flags small changes as not significant', () => {
    expect(delta(102, 100)).toEqual({ pct: 2, positive: true, significant: false })
  })

  it('guards against a zero / missing baseline', () => {
    expect(delta(50, 0)).toEqual({ pct: null, positive: true, significant: false })
  })
})
