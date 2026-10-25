import { Effect } from 'effect'
import { runMigrations } from '@spaces/db/migrate'
import type { MigrationOutcome } from '@spaces/db/migrate'
import { reconcileAttributeIndexes } from './attributes/reconcile'
import { seedSystemAttributes } from './attributes/seed'
import { firstBootPlugins } from './plugins/first-boot'
import { seedStarterTaxonomy } from './seeds/taxonomy'

/**
 * Every boot, in the one safe order (the container entrypoint and
 * `db:migrate:run` both call this):
 * 1. `runMigrations` — the downgrade guard runs inside it; a refusal stops
 *    here, and nothing below may touch a database the guard refused.
 * 2. System objects and `SYSTEM_ATTRIBUTES` — insert-if-absent every boot,
 *    so a new attribute appears on upgrade and a user's rename survives it.
 * 3. Starter taxonomy — first boot only; after the attributes its rows use.
 * 4. Per-attribute `values` indexes — after the seed, which flags
 *    `deal.stage`; retries any mint an earlier boot left undone. Never fatal.
 * 5. `SPACES_PLUGINS` / `SPACES_CREDENTIAL_<ID>` — optional, last, never
 *    fatal; the worker reconciles every row on its own boot.
 *
 * `runMigrations` stays a library this composes, never the reverse: the
 * schema package must not depend on the product. `migrationsFolder` is for
 * tests booting against truncated journals; the guard still runs against it.
 */
export async function boot(options?: {
  migrationsFolder?: string
}): Promise<MigrationOutcome> {
  const outcome = await runMigrations(options)
  if (outcome.kind === 'refused') return outcome
  await seedSystemAttributes()
  await seedStarterTaxonomy()
  await reconcileAttributeIndexes()
  await Effect.runPromise(firstBootPlugins())
  return outcome
}
