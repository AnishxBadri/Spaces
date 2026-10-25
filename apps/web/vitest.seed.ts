// Relative, not a package specifier: `vitest.seed.ts` is a harness file
// outside core's `exports`, and the fixture user has to be the same row in
// both suites' databases, so it is defined once, there.
import {
  FIXTURE_ACTOR,
  seedCoreTestDatabase,
} from '../../packages/core/vitest.seed.ts'
import { seedStarterTaxonomy } from '@spaces/core/writes/seeds/taxonomy'

export { FIXTURE_ACTOR }

/**
 * Everything the suite assumes a database already has, shared by the global
 * and per-file setups so they cannot drift.
 * - The pieces of the boot composition, not the boot entry: that ends in
 *   `process.exit`.
 * - Importing this module opens `@spaces/db`'s pool against the current
 *   `DATABASE_URL`, so the global setup imports it dynamically, after
 *   `prepareTestDatabase`.
 */

/**
 * Core's seed (system attributes and the fixture user that the
 * `select id from user limit 1` sites resolve against), plus the one seed only
 * apps/web wants.
 */
export async function seedTestDatabase(): Promise<void> {
  // The three CORE_OBJECTS rows, SYSTEM_ATTRIBUTES and the fixture user.
  await seedCoreTestDatabase()
  // The handful of starter spaces.
  await seedStarterTaxonomy()
}
