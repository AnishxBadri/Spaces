import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAdmin } from './admin.ts'
import {
  maintenance,
  publicRowCount,
  sourceDatabaseUrl,
  startInstance,
  withDatabase,
} from './instance.ts'
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
    const after = await countOutsideRows()
    const moved = [...before].filter(([db, n]) => after.get(db) !== n)
    for (const [db, n] of before)
      console.log(`[e2e] ${db}: ${n} rows before, ${after.get(db)} after`)
    if (moved.length > 0)
      throw new Error(
        `[e2e] the run changed databases it must never touch: ${moved
          .map(([db, n]) => `${db} ${n} → ${after.get(db)}`)
          .join(', ')}`,
      )
    const left = await maintenance((c) =>
      c.query<{ datname: string }>(
        `select datname from pg_database where datname like 'spaces\\_e2e\\_${process.pid}\\_%'`,
      ),
    )
    if (left.rows.length > 0)
      throw new Error(
        `[e2e] left databases behind: ${left.rows.map((r) => r.datname).join(', ')}`,
      )
  }
}

/**
 * The databases this harness promises not to touch, whichever of them exist
 * on the server right now: the one DATABASE_URL names (the dev database, or
 * CI's `spaces`), and every database the unit suite owns — `<that>_test*`
 * by default, or `<DATABASE_URL_TEST's name>*` when that override is set,
 * the same derivation packages/db/src/test-db.ts makes.
 */
async function countOutsideRows(): Promise<Map<string, number>> {
  const source = sourceDatabaseUrl()
  const nameOf = (url: URL) =>
    decodeURIComponent(url.pathname.replace(/^\//, ''))
  const own = nameOf(source)
  const override = process.env.DATABASE_URL_TEST
  const testPrefix =
    override === undefined || override === ''
      ? `${own}_test`
      : nameOf(new URL(override))
  const like = (prefix: string) => `${prefix.replace(/[\\_%]/g, '\\$&')}%`
  const names = await maintenance(async (c) => {
    const res = await c.query<{ datname: string }>(
      `select datname from pg_database
        where datname = $1 or datname like $2
        order by datname`,
      [own, like(testPrefix)],
    )
    return res.rows.map((r) => r.datname)
  })
  const counts = new Map<string, number>()
  for (const name of names)
    counts.set(name, await publicRowCount(withDatabase(source, name)))
  return counts
}
