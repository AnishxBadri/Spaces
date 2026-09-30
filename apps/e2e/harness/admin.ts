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

/** Who the first-run form creates, and the workspace it names. */
export type Owner = {
  readonly workspace: string
  readonly name: string
  readonly email: string
  readonly password: string
}

/**
 * The first-run flow, in a real browser: /setup, the token read from the
 * server's own log, the form submitted — the path an operator takes, and the
 * only way this suite ever gets an admin (no seed writes a password hash).
 * The session is saved to `storageState` for the specs to reuse. `who`
 * defaults to the suite's admin; the screenshot pipeline names a fund of its
 * own, since the workspace and owner names show in every capture.
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
  who: Owner = { workspace: 'E2E Holdings', ...ADMIN },
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
    await page.getByLabel('Workspace name').fill(who.workspace)
    await page.getByLabel('Your name').fill(who.name)
    await page.getByLabel('Email', { exact: true }).fill(who.email)
    await page.getByLabel('Password', { exact: true }).fill(who.password)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.getByText('Start with demo data?').waitFor()
    mkdirSync(dirname(storageState), { recursive: true })
    await page.context().storageState({ path: storageState })
  } finally {
    await browser.close()
  }
}
