import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

/**
 * Programmatic migration runner — called by the container entrypoint on
 * every boot (migrations auto-run, no `docker exec` step) and usable in dev
 * as `pnpm db:migrate:run`.
 */
async function main() {
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
