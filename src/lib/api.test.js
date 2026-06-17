import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, post } from '@/lib/api'
import { setToken, clearToken } from '@/lib/auth'

// The api client builds every request URL + Authorization header. Those are the
// tenant/auth-sensitive bits, so we stub fetch (no network) and inspect what the
// client constructed. VITE_API_URL is set in vitest.config.js so USE_API is true
// and these go through the real fetch path rather than the demo resolver.
let calls

function stubFetch() {
  calls = []
  globalThis.fetch = vi.fn((url, opts) => {
    calls.push({ url, opts })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    })
  })
}

beforeEach(() => {
  localStorage.clear()
  stubFetch()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearToken()
})

describe('api client request + auth construction', () => {
  it('attaches a Bearer token when one is stored', async () => {
    setToken('tok-123')
    await api.clients()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://api.test/api/clients')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tok-123')
  })

  it('omits the Authorization header when no token is present', async () => {
    await api.clients()
    expect(calls[0].opts.headers.Authorization).toBeUndefined()
  })

  it('builds the summary query string from client + period', async () => {
    await api.summary('acme', 'last_4w')
    expect(calls[0].url).toBe('http://api.test/api/metrics/summary?client=acme&period=last_4w')
  })

  it('encodes the delete-client path with the client id', async () => {
    await api.deleteClient('client-7')
    expect(calls[0].url).toBe('http://api.test/api/clients/client-7')
    expect(calls[0].opts.method).toBe('DELETE')
  })

  it('sends a JSON body, content-type, and Bearer token on POST', async () => {
    setToken('tok-abc')
    await post('/api/clients', { name: 'New Co' })
    const { opts } = calls[0]
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers.Authorization).toBe('Bearer tok-abc')
    expect(JSON.parse(opts.body)).toEqual({ name: 'New Co' })
  })

  it('throws a descriptive error on a non-ok response', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'boom' }),
      }),
    )
    await expect(post('/api/clients', {})).rejects.toThrow('boom')
  })
})
