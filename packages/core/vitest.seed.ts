import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { seedSystemAttributes } from './src/writes/attributes/seed.ts'

/**
 * What a core test file assumes a database already has, in one function so
 * the global setup and the per-file setup cannot drift (SPA-145, here since
 * SPA-174/175 brought the write paths and their tests). Two things, in the
 * order `apps/web/src/db/boot.ts` composes the first: the system objects and
 * SYSTEM_ATTRIBUTES — `objectIdForKindAsync('company')` is a precondition of
 * half the files here — and one better-auth user row for the
 * `select id from user limit 1` sites. Not the starter taxonomy: that seed is
 * still apps/web's until the boot composition moves (mono-9e), and no core
 * test wants a space.
 *
 * apps/web's `vitest.seed.ts` composes this plus the taxonomy, and takes
 * FIXTURE_ACTOR from here so the two suites agree on the one user.
 *
 * Importing this module opens `@spaces/db`'s pool against whatever
 * `process.env.DATABASE_URL` says at that moment, so the global setup imports
 * it dynamically, below `prepareTestDatabase`.
 */

/**
 * One better-auth user row, id and email fixed so reruns are the same row.
 * `.test` is reserved by RFC 2606, so this address can never be someone's.
 */
export const FIXTURE_ACTOR = {
  id: 'spa143-fixture-actor',
  name: 'Test Fixture',
  email: 'fixture@spaces.test',
  emailVerified: true,
}

export async function seedCoreTestDatabase(): Promise<void> {
  await seedSystemAttributes()
  await db.insert(user).values(FIXTURE_ACTOR).onConflictDoNothing()
}
