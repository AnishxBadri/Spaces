import { runMigrations } from '@spaces/db/migrate'
import type { MigrationOutcome } from '@spaces/db/migrate'
import { reconcileAttributeIndexes } from './attributes/reconcile'
import { seedSystemAttributes } from './attributes/seed'
import { seedStarterTaxonomy } from './seeds/taxonomy'

/**
 * The boot composition, and only the composition (SPA-177; the interim
 * apps/web entry mono-3 created is now the process shell around this): the
 * four things every boot does, in the one order that is safe, as one
 * function the container entrypoint and `pnpm db:migrate:run` both reach
 * through `apps/web/src/db/boot.ts`.
 *
 * 1. Migrate — `@spaces/db`'s `runMigrations()`, a library function this
 *    composes and never the reverse: the schema package grows no seed,
 *    because then it would depend on the product. The downgrade guard runs
 *    inside it, and a refusal stops here — nothing below may touch a
 *    database the guard would not let the migrator touch.
 * 2. System objects and SYSTEM_ATTRIBUTES — insert-if-absent on every boot,
 *    so a release's new attribute appears on upgrade and a user's rename
 *    survives it.
 * 3. The starter taxonomy — first boot only, idempotent on path, so a
 *    deleted node stays deleted. After the attributes, because its entity
 *    rows are written against them.
 * 4. Per-attribute `values` indexes (SPA-93) — the same insert-if-absent
 *    shape one step up, for a set of objects drizzle's journal cannot hold
 *    because it is a function of user data rather than of the schema. After
 *    the seed because the seed is what declares `deal.stage` flagged on a
 *    fresh database, and it is the retry for every mint an earlier boot or
 *    an interrupted `CREATE INDEX CONCURRENTLY` left undone. Never fatal: an
 *    unindexed attribute is a slow list, not a broken one.
 *
 * `migrationsFolder` names a journal other than the package's own; nothing
 * in the boot path passes it — `boot.test.ts` does, to boot against
 * deliberately truncated journals, and it defeats nothing: the guard runs
 * against whatever folder is named.
 */
export async function boot(options?: {
  migrationsFolder?: string
}): Promise<MigrationOutcome> {
  const outcome = await runMigrations(options)
  if (outcome.kind === 'refused') return outcome
  await seedSystemAttributes()
  await seedStarterTaxonomy()
  await reconcileAttributeIndexes()
  return outcome
}
