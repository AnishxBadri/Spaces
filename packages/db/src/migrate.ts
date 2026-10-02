import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { inspectDowngrade } from './downgrade-guard.ts'

/**
 * The migrations folder, resolved from this module and never from cwd.
 * The journal is what an image is compared against (`inspectDowngrade`), so
 * "which journal" must not be a property of who called us.
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
 * - Seeding is deliberately not here: core's boot composition calls this and
 *   then seeds. packages/db never grows a seed
 *   (CONTEXT.md, "packages/db — what moved").
 * - `migrationsFolder` exists for the guard's fixtures (truncated journals).
 *   It is not a way around the guard: whatever folder is named, the guard
 *   runs against it first.
 */
export async function runMigrations(options?: {
  migrationsFolder?: string
}): Promise<MigrationOutcome> {
  const folder = options?.migrationsFolder ?? MIGRATIONS_FOLDER
  const db = drizzle(process.env.DATABASE_URL!)
  try {
    // The guard runs before anything else reaches the database — migrate(),
    // then whatever the caller seeds. It is the only thing standing between
    // an old image and a new schema. Deliberately no override env var:
    // hostability contract 5 says rollback is restore.
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
