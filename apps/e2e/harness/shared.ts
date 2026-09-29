import type { LaunchOptions } from '@playwright/test'

/**
 * What global setup hands the specs. Playwright forks its workers after
 * global setup returns, so `process.env` is the channel — these are the
 * names, in one place.
 */
export const ENV = {
  firstrunUrl: 'E2E_FIRSTRUN_URL',
  firstrunLog: 'E2E_FIRSTRUN_LOG',
  firstrunDb: 'E2E_FIRSTRUN_DATABASE_URL',
  mainUrl: 'E2E_MAIN_URL',
  mainLog: 'E2E_MAIN_LOG',
  mainDb: 'E2E_MAIN_DATABASE_URL',
  adminStorage: 'E2E_ADMIN_STORAGE',
  /**
   * Set by the caller, not by a setup: the composed image to smoke (SPA-186).
   * When present the suite runs the image project instead of booting its
   * own instances — see playwright.config.ts.
   */
  imageUrl: 'E2E_IMAGE_URL',
} as const

export type EnvName = (typeof ENV)[keyof typeof ENV]

export function fromEnv(name: EnvName): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`[e2e] ${name} is unset — global setup did not run`)
  return value
}

/** The admin global setup creates on `main` through the first-run flow. */
export const ADMIN = {
  name: 'E2E Admin',
  email: 'admin@e2e.spaces.test',
  password: 'correct horse battery staple',
} as const

/**
 * Chromium from Playwright's own download (`playwright install chromium`,
 * which CI runs), unless PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH names another —
 * for a machine that ships a browser of its own and cannot download one.
 */
export function launchOptions(): LaunchOptions {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  return executablePath === undefined || executablePath === ''
    ? {}
    : { executablePath }
}
