import { defineConfig, devices } from '@playwright/test'
import { launchOptions } from './harness/shared.ts'
import { SHOTS_STORAGE } from './harness/screenshots-setup.ts'

/**
 * `pnpm screenshots` — the README and marketing captures, from the built app
 * seeded with the developer bench (harness/screenshots-setup.ts). A config of
 * its own, not a project of playwright.config.ts, so `pnpm e2e` never boots
 * the extra instance and never picks up screenshots/: that config's testDir
 * is specs/, this one's is screenshots/.
 *
 * Fixed viewport and scale, light only (the app is light-only by decision),
 * one worker, no retries — a capture that needs a retry is a capture that
 * would differ from the last one.
 */
export default defineConfig({
  testDir: './screenshots',
  globalSetup: './harness/screenshots-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: 'test-results/screenshots',
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    launchOptions: launchOptions(),
  },
  projects: [
    {
      name: 'screenshots',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: 'light',
        locale: 'en-US',
        storageState: SHOTS_STORAGE,
      },
    },
  ],
})
