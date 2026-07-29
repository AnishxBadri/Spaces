import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { config as dotenv } from 'dotenv'

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  dotenv({ path: ['.env.local', '.env'], processEnv: out })
  return out
}

// Standalone config so vitest doesn't load the app's vite plugins
// (nitro, devtools, router codegen) just to run unit tests.
export default defineConfig({
  resolve: {
    alias: {
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: loadEnvLocal(),
  },
})
