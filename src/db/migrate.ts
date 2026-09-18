import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { logExternalOrigin } from '#/lib/server/external-origin'
import { inspectDowngrade } from './downgrade-guard.ts'

const MIGRATIONS_FOLDER = './drizzle'

/**
 * Programmatic migration runner — called by the container entrypoint on
 * every boot (migrations auto-run, no `docker exec` step) and usable in dev
 * as `pnpm db:migrate:run`.
 */
async function main() {
  // The entrypoint runs this before either process starts, for every ROLE,
  // so it is the one place that logs exactly once per boot. Print the
  // APP_URL decision first: when HTTPS is misconfigured, the answer is
  // waiting at the top of `docker compose logs app`.
  logExternalOrigin()
  const db = drizzle(process.env.DATABASE_URL!)

  // The downgrade guard goes after that banner and before everything else.
  // `logExternalOrigin` only prints — it reads APP_URL and touches no
  // database — so keeping it first costs nothing, and a refused boot still
  // tells the operator which origin this image thought it had. The guard is
  // first among everything that *reaches* the database: migrate(), then both
  // seeds. A database carrying migrations this image lacks is not an error to
  // drizzle — it applies nothing and reports "up to date" — so this check is
  // the only thing standing between an old image and a new schema.
  // Deliberately no override env var: hostability contract 5 says rollback is
  // restore, and an override would exist only to defeat this check.
  const verdict = await inspectDowngrade(
    (text) => db.$client.query(text),
    MIGRATIONS_FOLDER,
  )
  if (verdict.kind === 'refuse') {
    console.error(verdict.message)
    await db.$client.end()
    process.exit(1)
  }

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  console.log('[migrate] up to date')
  await db.$client.end()
  // System attributes: insert-if-absent on every boot; user edits survive.
  const { seedSystemAttributes } = await import('#/lib/attributes/seed')
  await seedSystemAttributes()
  // Starter taxonomy: first boot only, so deleted nodes stay deleted.
  const { seedStarterTaxonomy } = await import('#/lib/seeds/taxonomy')
  await seedStarterTaxonomy()
  process.exit(0)
}

main().catch((err) => {
  console.error('[migrate] failed', err)
  process.exit(1)
})
