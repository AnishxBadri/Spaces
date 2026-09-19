import { loadWorkspaceEnv, prepareTestDatabase } from '@spaces/db/test-db'

/**
 * The app's half of the SPA-143 harness: migrate the test database, then put
 * in it everything the suite assumes a database already has.
 *
 * Three things, in the order `src/db/boot.ts` composes the first two — this
 * is deliberately the pieces and not that entry, because `boot.ts` ends in
 * `process.exit`:
 *
 *   1. `seedSystemAttributes` — the three CORE_OBJECTS rows and
 *      SYSTEM_ATTRIBUTES; `objectIdForKindAsync('company')` is a precondition
 *      of half the DB-coupled files.
 *   2. `seedStarterTaxonomy` — the handful of starter spaces.
 *   3. The fixture actor. This is the hole a "just migrate it" harness falls
 *      into: sites across the suite do `select id from user limit 1` and use
 *      what comes back as the acting user, which on the dev database was
 *      whoever logged in first. A database that has never seen the app has
 *      no such row, and those files go red on `actor.id` of undefined.
 *
 * Every import of app code is dynamic and below `prepareTestDatabase`,
 * because `@spaces/db`'s `db` builds its pool from `process.env.DATABASE_URL`
 * at import time — a static import here would open a pool on the *dev*
 * database and seed it.
 */

/**
 * One better-auth user row, id and email fixed so reruns are the same row.
 * `.test` is reserved by RFC 2606, so this address can never be someone's.
 */
const FIXTURE_ACTOR = {
  id: 'spa143-fixture-actor',
  name: 'Test Fixture',
  email: 'fixture@spaces.test',
  emailVerified: true,
}

export default async function setup() {
  await prepareTestDatabase(loadWorkspaceEnv())

  const { seedSystemAttributes } = await import('#/lib/attributes/seed')
  await seedSystemAttributes()
  const { seedStarterTaxonomy } = await import('#/lib/seeds/taxonomy')
  await seedStarterTaxonomy()

  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  await db.insert(user).values(FIXTURE_ACTOR).onConflictDoNothing()

  // The workers open their own pools; this one belongs to the setup process
  // and would otherwise hold the event loop open after it returns.
  await db.$client.end()
}
