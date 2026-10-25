// Composed like apps/web's seed, not imported from it: the worker suite must
// not reach into apps/web's harness. Core's seed is imported relatively so the
// fixture user is the same row in every suite's database.
import {
  FIXTURE_ACTOR,
  seedCoreTestDatabase,
} from '../../packages/core/vitest.seed.ts'
import { seedStarterTaxonomy } from '@spaces/core/writes/seeds/taxonomy'

export { FIXTURE_ACTOR }

/**
 * Everything the worker suite assumes a database already has: the core
 * objects, the system attributes and the fixture user (core's seed), then the
 * starter taxonomy, because the jobs file documents into spaces and suggest
 * space tags.
 *
 * Importing this module opens `@spaces/db`'s pool against whatever
 * `process.env.DATABASE_URL` says at that moment, so the global setup imports
 * it dynamically, below `prepareTestDatabase`.
 */
export async function seedTestDatabase(): Promise<void> {
  await seedCoreTestDatabase()
  await seedStarterTaxonomy()
}
