import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium } from '@playwright/test'
import { ADMIN, launchOptions } from './shared.ts'

/** Every first-run setup token in a server log, oldest first. */
export function setupTokensIn(log: string): string[] {
  return [...log.matchAll(/First-run setup token: ([0-9a-f]{32})/g)].flatMap(
    (m) => m.at(1) ?? [],
  )
}

/**
 * The first-run flow, in a real browser: /setup, the token read from the
 * server's own log, the form submitted — the path an operator takes, and the
 * only way this suite ever gets an admin (no seed writes a password hash).
 * The session is saved to `storageState` for the specs to reuse.
 *
 * `readLog` is where the log lives: a file the harness wrote for an instance
 * it booted (global-setup.ts), or `docker compose logs app` for the composed
 * image (image-setup.ts). Loading /setup is what prints the token
 * (getSetupState), so the log is read after the page is up, never before.
 */
export async function createAdmin(
  url: string,
  readLog: () => Promise<string>,
  storageState: string,
): Promise<void> {
  const browser = await chromium.launch(launchOptions())
  try {
    const page = await browser.newPage()
    await page.goto(`${url}/setup`)
    await page.getByLabel('Setup token').waitFor()
    const token = setupTokensIn(await readLog()).at(-1)
    if (token === undefined)
      throw new Error(`[e2e] no setup token in the log of ${url}`)

    await page.getByLabel('Setup token').fill(token)
    await page.getByLabel('Workspace name').fill('E2E Holdings')
    await page.getByLabel('Your name').fill(ADMIN.name)
    await page.getByLabel('Email', { exact: true }).fill(ADMIN.email)
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.getByText('Start with demo data?').waitFor()
    mkdirSync(dirname(storageState), { recursive: true })
    await page.context().storageState({ path: storageState })
  } finally {
    await browser.close()
  }
}
