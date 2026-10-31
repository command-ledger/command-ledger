import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Pay Intl and WebCrypto start-up before any test is timed; see the file.
    setupFiles: ['./src/lib/test-setup.js'],
    // Every test here is pure and finishes in milliseconds. Vitest's 5s
    // default failed them intermittently on slow 2-core machines where
    // parallel workers compete for CPU; 30s still catches a real hang.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
})
