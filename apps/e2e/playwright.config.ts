import { defineConfig, devices } from '@playwright/test'
import { launchOptions } from './harness/shared.ts'

/**
 * The browser suite (SPA-184). One worker, no retries: the specs read and
 * write server-wide state (whether an admin exists), and a retry would hide
 * exactly the flake this suite is meant to surface. Global setup boots the
 * instances and its returned function tears them down — see
 * harness/global-setup.ts.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './harness/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  timeout: 30_000,
  outputDir: 'test-results',
  reporter: process.env.CI !== undefined ? [['list'], ['github']] : 'list',
  use: {
    // The trace CI uploads when a spec fails.
    trace: 'retain-on-failure',
    launchOptions: launchOptions(),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
