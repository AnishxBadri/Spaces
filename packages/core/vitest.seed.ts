import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { seedSystemAttributes } from './src/writes/attributes/seed.ts'

/**
 * What every core test file assumes the database has, in one function so the
 * global and per-file setups cannot drift.
 * - The system objects and SYSTEM_ATTRIBUTES, in boot order
 *   (`objectIdForKindAsync('company')` is a precondition of half the files).
 * - One better-auth user row for the `select id from user limit 1` sites.
 * - Not the starter taxonomy: no core test wants a space. apps/web's seed adds
 *   it and takes FIXTURE_ACTOR from here so both suites share the user.
 * - Importing this opens `db`'s pool against the current `DATABASE_URL`, so
 *   the global setup imports it dynamically, below `prepareTestDatabase`.
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
