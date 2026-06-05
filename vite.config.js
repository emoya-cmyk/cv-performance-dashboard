import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target:    'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5174,
    proxy: {
      '/api': {
        target:    'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Vendor-only chunking. App source is left alone so the route-lazy boundaries
        // keep per-page (and agency-vs-client) code naturally separated.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // recharts + its transitive d3/victory deps → one async "charts" chunk.
          // Only the lazy pages import these, so this chunk stays OUT of the entry.
          if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap)[\\/]/.test(id)) {
            return 'charts'
          }
          // React runtime + router — needed by the eager shell; split into a stable,
          // long-cacheable vendor chunk so app-code edits don't bust it.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return 'react-vendor'
          }
        },
      },
    },
  },
})
