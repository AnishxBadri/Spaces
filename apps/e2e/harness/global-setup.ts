import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAdmin } from './admin.ts'
import { assertUntouched, countOutsideRows, startInstance } from './instance.ts'
import { ENV } from './shared.ts'
import type { FullConfig } from '@playwright/test'
import type { Instance } from './instance.ts'

/**
 * Boots two instances and hands their addresses to the specs through the
 * environment (Playwright forks its workers after this returns):
 *
 *   firstrun — an empty database nobody has signed up to. The first-run spec
 *              is the only thing that touches it; it needs the window open.
 *   main     — the same, until this setup creates the admin through the real
 *              first-run flow: /setup in Chromium, the token read from the
 *              server's own log, the form submitted. That session is saved
 *              and reused; no seed writes a password hash.
 *
 * The returned function is the teardown: it stops both, drops both
 * databases, removes both DATA_DIRs, and then proves the claim the harness
 * makes — the dev database and every `spaces_test*` database hold exactly
 * the rows they held before the run.
 */
export default async function globalSetup(config: FullConfig) {
  const before = await countOutsideRows()

  const started: Instance[] = []
  const stopAll = async () => {
    await Promise.allSettled(started.map((i) => i.stop()))
  }

  try {
    const [firstrun, main] = await Promise.all([
      startInstance('firstrun'),
      startInstance('main'),
    ])
    started.push(firstrun, main)

    const outputDir = config.projects.at(0)?.outputDir ?? 'test-results'
    const storageState = join(outputDir, 'admin.storage.json')
    await createAdmin(
      main.url,
      () => readFile(main.logFile, 'utf8'),
      storageState,
    )

    process.env[ENV.firstrunUrl] = firstrun.url
    process.env[ENV.firstrunLog] = firstrun.logFile
    process.env[ENV.firstrunDb] = firstrun.databaseUrl
    process.env[ENV.mainUrl] = main.url
    process.env[ENV.mainLog] = main.logFile
    process.env[ENV.mainDb] = main.databaseUrl
    process.env[ENV.adminStorage] = storageState
  } catch (err) {
    await stopAll()
    throw err
  }

  return async () => {
    await stopAll()
    await assertUntouched(before)
  }
}
