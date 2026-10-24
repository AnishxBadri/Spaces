import { defineConfig } from 'vitest/config'

// No harness, no env, no database: a plugin author tests against the SDK
// with Postgres stopped, and its own suite holds itself to that.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // fence.test's first lintText loads the workspace eslint config; on a
    // cold CI runner beside turbo's other test tasks that passes 5 s.
    testTimeout: 60_000,
  },
})
