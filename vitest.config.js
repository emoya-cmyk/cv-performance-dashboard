import { defineConfig } from 'vitest/config'
import path from 'path'

// Minimal Vitest config for the frontend smoke tests. jsdom gives the pure
// auth/api helpers a browser-like environment (localStorage, window); the `@`
// alias mirrors vite.config.js so imports resolve the same way as the app.
// VITE_API_URL is set so the api client takes its real fetch path (USE_API)
// rather than the static demo resolver — the tests stub fetch to inspect the
// request + Authorization header the client constructs.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    globals: false,
    env: { VITE_API_URL: 'http://api.test' },
  },
})
