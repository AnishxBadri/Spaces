import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { createAdmin } from './admin.ts'
import type { Owner } from './admin.ts'
import { assertUntouched, countOutsideRows, startInstance } from './instance.ts'
import { ENV } from './shared.ts'

/**
 * Global setup for `pnpm screenshots` (playwright.screenshots.config.ts):
 * the README and marketing captures, taken from the built app rather than
 * drawn, so they can be re-taken after any UI change.
 *
 * One instance against a throwaway `spaces_e2e_<pid>_shots` database, the
 * owner made through the real first-run flow, then the developer bench
 * (`apps/web/src/db/seed.ts`, the script behind `pnpm db:seed`) run against
 * it as a process. The bench is the source because every company, person
 * and number in it is invented and it covers every surface; `--bulk` is left
 * off, since its filler rows are named "Bench Co 001" and would read as a
 * stress test rather than a fund's book.
 *
 * The teardown makes the harness's usual promise: the instance stops, its
 * database and DATA_DIR go, and the dev and unit-suite databases hold the
 * rows they held before.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** Where the PNGs land — committed, and linked from the README and the site. */
export const SHOTS_DIR = join(REPO, 'docs/assets/screenshots')

/** The owner's saved session, read by every capture. */
export const SHOTS_STORAGE = fileURLToPath(
  new URL(
    '../test-results/screenshots-auth/owner.storage.json',
    import.meta.url,
  ),
)

/**
 * The workspace and owner every capture shows in its shell. Invented, like
 * everything the bench seeds; the second member the bench adds is its own.
 */
export const SHOTS_OWNER: Owner = {
  // Short enough that the sidebar does not truncate it.
  workspace: 'Harbour Lane',
  name: 'Anika Rao',
  email: 'anika@fund.example',
  password: 'harbour lane screenshots',
}

/**
 * `pnpm e2e` expects DATABASE_URL in the shell (CI's job env). A capture is
 * run by hand on a dev machine, so when the shell has none this takes that
 * one variable — and only that one — from the repo's `.env.local`, which is
 * where the dev stack's Postgres is named. The harness still creates its own
 * database on that server and never writes the one named.
 */
function ensureDatabaseUrl() {
  const current = process.env.DATABASE_URL
  if (current !== undefined && current !== '') return
  const file = join(REPO, '.env.local')
  if (!existsSync(file)) return
  const fromFile = parseEnv(readFileSync(file, 'utf8')).DATABASE_URL
  if (fromFile !== undefined && fromFile !== '')
    process.env.DATABASE_URL = fromFile
}

export default async function screenshotsSetup() {
  ensureDatabaseUrl()
  const before = await countOutsideRows()

  const shots = await startInstance('shots')
  try {
    await createAdmin(
      shots.url,
      () => readFile(shots.logFile, 'utf8'),
      SHOTS_STORAGE,
      SHOTS_OWNER,
    )
    await shots.exec('src/db/seed.ts', [`--user=${SHOTS_OWNER.email}`])

    process.env[ENV.shotsUrl] = shots.url
    process.env[ENV.shotsDb] = shots.databaseUrl
  } catch (err) {
    // stop() removes the log with the database; print the end of it first,
    // since that is where a failed seed says why.
    const log = await readFile(shots.logFile, 'utf8').catch(() => '')
    console.error(`[shots] instance log (tail):\n${log.slice(-4000)}`)
    await shots.stop()
    throw err
  }

  return async () => {
    await shots.stop()
    await assertUntouched(before)
  }
}
