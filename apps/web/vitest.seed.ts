import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { seedSystemAttributes } from '#/lib/attributes/seed'
import { seedStarterTaxonomy } from '#/lib/seeds/taxonomy'

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
 * One better-auth user row, id and email fixed so reruns are the same row.
 * `.test` is reserved by RFC 2606, so this address can never be someone's.
 *
 * This is the hole a "just migrate it" harness falls into: sites across the
 * suite do `select id from user limit 1` and use what comes back as the
 * acting user, which on the dev database was whoever logged in first. A
 * database that has never seen the app has no such row, and those files go
 * red on `actor.id` of undefined.
 */
export const FIXTURE_ACTOR = {
  id: 'spa143-fixture-actor',
  name: 'Test Fixture',
  email: 'fixture@spaces.test',
  emailVerified: true,
}

export async function seedTestDatabase(): Promise<void> {
  // The three CORE_OBJECTS rows and SYSTEM_ATTRIBUTES;
  // `objectIdForKindAsync('company')` is a precondition of half the
  // DB-coupled files.
  await seedSystemAttributes()
  // The handful of starter spaces.
  await seedStarterTaxonomy()
  await db.insert(user).values(FIXTURE_ACTOR).onConflictDoNothing()
}
