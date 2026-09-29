// Relative, not a package specifier: `vitest.seed.ts` is a harness file
// outside core's `exports`, and the fixture user has to be the same row in
// both suites' databases, so it is defined once, there.
import {
  FIXTURE_ACTOR,
  seedCoreTestDatabase,
} from '../../packages/core/vitest.seed.ts'
import { seedStarterTaxonomy } from '#/lib/seeds/taxonomy'

export { FIXTURE_ACTOR }

/**
 * Everything the suite assumes a database already has, in one function so the
 * global setup and the per-file setup cannot drift (SPA-145). The per-file
 * setup truncates `public` and calls this again; the global setup calls it
 * once on `spaces_test`, the reference database, so that database is also
 * usable by hand.
 *
 * Three things, in the order `src/db/boot.ts` composes the first two — this is
 * deliberately the pieces and not that entry, because `boot.ts` ends in
 * `process.exit`.
 *
 * Importing this module opens `@spaces/db`'s pool against whatever
 * `process.env.DATABASE_URL` says at that moment, so the global setup imports
 * it dynamically, below `prepareTestDatabase`. The per-file setup can import
 * it at the top: vitest's `test.env` has already been applied to the worker's
 * environment before setup files run.
 */

/**
 * The fixture user is the hole a "just migrate it" harness falls into: sites
 * across the suite do `select id from user limit 1` and use what comes back
 * as the acting user, which on the dev database was whoever logged in first.
 * A database that has never seen the app has no such row, and those files go
 * red on `actor.id` of undefined. Since SPA-174/175 it is core's
 * `vitest.seed.ts` that inserts it, with the system attributes — both suites
 * need both — and this composition adds the one seed only apps/web wants.
 */
export async function seedTestDatabase(): Promise<void> {
  // The three CORE_OBJECTS rows, SYSTEM_ATTRIBUTES and the fixture user.
  await seedCoreTestDatabase()
  // The handful of starter spaces.
  await seedStarterTaxonomy()
}
