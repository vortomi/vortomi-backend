import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each database test file boots its own in-memory Postgres (PGlite).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
