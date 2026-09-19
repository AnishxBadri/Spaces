import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { inspectDowngrade } from './downgrade-guard.ts'

/**
 * The migrations folder, resolved from this module and never from cwd.
 *
 * It used to be the string `'./drizzle'`, which worked only because the
 * container entrypoint happens to `cd /app` — the same call from any other
 * directory read a folder that was not there, or worse, a different one. The
 * journal is the thing an image is compared against (see `downgrade-guard`),
 * so "which journal" must not be a property of who called us.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../drizzle', import.meta.url),
)

export type MigrationOutcome =
  /** The database now matches this image's journal. */
  | { kind: 'ok'; applied: number; known: number }
  /** The guard refused; the message has already been printed. */
  | { kind: 'refused'; message: string }

/**
 * Migrations, and nothing else — guard, then `migrate()`. This is the whole
 * of what packages/db will do to a database.
 *
 * Seeding is deliberately not here. `seedSystemAttributes` and
 * `seedStarterTaxonomy` are core concerns living in apps/web today, and the
 * one-command boot contract (migrations auto-run on every boot, no `docker
 * exec` step) is composed there, in `apps/web/src/db/boot.ts`, which calls
 * this first and then seeds. That split is the interim shape recorded in
 * CONTEXT.md; mono-9a moves both seeds into core and the composition with
 * them.
 *
 * `migrationsFolder` exists for the guard's own fixtures, which boot this
 * against deliberately truncated journals. It is not a way around the guard:
 * whatever folder is named, the guard runs against it first.
 */
export async function runMigrations(options?: {
  migrationsFolder?: string
}): Promise<MigrationOutcome> {
  const folder = options?.migrationsFolder ?? MIGRATIONS_FOLDER
  const db = drizzle(process.env.DATABASE_URL!)
  try {
    // The guard is first among everything that *reaches* the database:
    // migrate(), and then whatever the caller seeds. A database carrying
    // migrations this image lacks is not an error to drizzle — it applies
    // nothing and reports "up to date" — so this check is the only thing
    // standing between an old image and a new schema. Deliberately no
    // override env var: hostability contract 5 says rollback is restore, and
    // an override would exist only to defeat this check.
    const verdict = await inspectDowngrade(
      (text) => db.$client.query(text),
      folder,
    )
    if (verdict.kind === 'refuse') {
      console.error(verdict.message)
      return { kind: 'refused', message: verdict.message }
    }

    await migrate(db, { migrationsFolder: folder })
    console.log('[migrate] up to date')
    return { kind: 'ok', applied: verdict.applied, known: verdict.known }
  } finally {
    await db.$client.end()
  }
}
