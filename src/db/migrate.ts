import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { logExternalOrigin } from '#/lib/server/external-origin'

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
  await migrate(db, { migrationsFolder: './drizzle' })
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
