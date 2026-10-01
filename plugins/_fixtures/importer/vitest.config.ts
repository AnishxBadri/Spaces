import { defineConfig } from 'vitest/config'

// No database and no env, like the SDK itself: a plugin is tested with
// Postgres stopped.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
