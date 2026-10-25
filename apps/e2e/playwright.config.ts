import { defineConfig, devices } from '@playwright/test'
import { launchOptions } from './harness/shared.ts'

/**
 * The browser suite. One worker, no retries: the specs read and write
 * server-wide state (whether an admin exists), and a retry would hide
 * exactly the flake this suite is meant to surface. Global setup boots the
 * instances and its returned function tears them down.
 */
/**
 * Two ways to run, one harness:
 *
 *   default         global setup boots the built app twice against throwaway
 *                   databases; the specs under specs/ (not specs/image/) run.
 *   E2E_IMAGE_URL   the image smoke: CI has composed the image built for this
 *                   commit with Postgres and passes its address; nothing is
 *                   booted, global setup only waits for db ok + worker ok and
 *                   signs in, and only specs/image/ runs (CI's
 *                   `image-smoke` job).
 */
const imageUrl = process.env.E2E_IMAGE_URL
const image = imageUrl !== undefined && imageUrl !== ''

export default defineConfig({
  testDir: './specs',
  globalSetup: image ? './harness/image-setup.ts' : './harness/global-setup.ts',
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
  projects: image
    ? [
        {
          name: 'image',
          testMatch: 'image/**/*.spec.ts',
          // The worker has to extract a DOCX before its preview can pass.
          timeout: 90_000,
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'chromium',
          testIgnore: 'image/**',
          use: { ...devices['Desktop Chrome'] },
        },
      ],
})
