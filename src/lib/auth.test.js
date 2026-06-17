import { describe, it, expect, beforeEach } from 'vitest'
import {
  getToken,
  setToken,
  clearToken,
  setUser,
  getUser,
  isLoggedIn,
  isAgency,
} from '@/lib/auth'

// Auth/session helpers back every tenant- and role-scoped decision in the UI,
// so their token + role logic is worth a deterministic smoke test. jsdom
// supplies localStorage.

beforeEach(() => {
  localStorage.clear()
})

describe('token storage', () => {
  it('round-trips a token through set / get / clear', () => {
    expect(getToken()).toBe('')
    expect(isLoggedIn()).toBe(false)

    setToken('tok-123')
    expect(getToken()).toBe('tok-123')
    expect(isLoggedIn()).toBe(true)

    clearToken()
    expect(getToken()).toBe('')
    expect(isLoggedIn()).toBe(false)
  })

  it('clearToken also drops the stored user', () => {
    setUser({ role: 'agency' })
    setToken('tok-9')
    clearToken()
    expect(getUser()).toBeNull()
  })
})

describe('getUser', () => {
  it('returns null when nothing is stored', () => {
    expect(getUser()).toBeNull()
  })

  it('returns null (no throw) on corrupt JSON', () => {
    localStorage.setItem('pd_user', '{not-json')
    expect(getUser()).toBeNull()
  })

  it('parses a stored user object', () => {
    setUser({ id: 7, role: 'client' })
    expect(getUser()).toEqual({ id: 7, role: 'client' })
  })
})

describe('isAgency role gating', () => {
  it('is true for agency and admin roles', () => {
    setUser({ role: 'agency' })
    expect(isAgency()).toBe(true)
    setUser({ role: 'admin' })
    expect(isAgency()).toBe(true)
  })

  it('is false for a client role or no user', () => {
    setUser({ role: 'client' })
    expect(isAgency()).toBe(false)
    clearToken()
    expect(isAgency()).toBe(false)
  })
})
