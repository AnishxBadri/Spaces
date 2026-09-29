// The same composition as apps/web's `vitest.seed.ts`, spelled here because a
// harness file is outside every package's `exports` and the worker's suite
// must not reach into apps/web's harness for it (SPA-181). Relative into
// core's for the same reason as apps/web's: the fixture user has to be the
// same row in every suite's database, so it is defined once, there.
import {
  FIXTURE_ACTOR,
  seedCoreTestDatabase,
} from '../../packages/core/vitest.seed.ts'
import { seedStarterTaxonomy } from '@spaces/core/writes/seeds/taxonomy'

export { FIXTURE_ACTOR }

/**
 * Everything the worker suite assumes a database already has: the core
 * objects, the system attributes and the fixture user (core's seed), then the
 * starter taxonomy — the jobs file documents into spaces and suggest space
 * tags, so the worker needs the same three things the web suite does.
 *
 * Importing this module opens `@spaces/db`'s pool against whatever
 * `process.env.DATABASE_URL` says at that moment, so the global setup imports
 * it dynamically, below `prepareTestDatabase`.
 */
export async function seedTestDatabase(): Promise<void> {
  await seedCoreTestDatabase()
  await seedStarterTaxonomy()
}
