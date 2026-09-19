import { fileURLToPath } from 'node:url'
import { config as dotenv } from 'dotenv'
import { Client } from 'pg'
import { runMigrations } from './migrate.ts'

/**
 * The test database — derived, created, migrated (SPA-143).
 *
 * Until this module existed the suite ran against whatever `DATABASE_URL`
 * named, which in every developer checkout is the *dev* database the running
 * app is showing: ten files opened a connection and wrote entities,
 * attributes, links and activity into it. This gives the suite its own
 * database on the same server — same Postgres, second database, so
 * `docker-compose.dev.yml` is untouched.
 *
 * Nothing here ever drops a database. The only DDL it issues is
 * `create database`, and it refuses outright when the database it derived is
 * the one `DATABASE_URL` names. Cleanup between runs is the suites' own
 * (`cleanupTestEntities`), and dropping `spaces_test` is a human typing
 * `dropdb` — after which the next run recreates it.
 *
 * This module is the harness, not the product: it is imported by the two
 * `vitest.config.ts` files and the two global setups and by nothing that
 * ships.
 */

/** `.env.local` at the workspace root, resolved from this file, never cwd. */
const ENV_FILES = ['.env.local', '.env'].map((name) =>
  fileURLToPath(new URL(`../../../${name}`, import.meta.url)),
)

/**
 * One advisory-lock key for the whole harness. `turbo run test` runs
 * `@spaces/web` and `@spaces/db` in parallel and both call
 * `prepareTestDatabase`, so "create if absent" and "apply the journal" are
 * both races without it: two `create database` statements for one name, or
 * two migrators applying the same migration. The number is arbitrary and
 * only has to be the same in both processes.
 */
const HARNESS_LOCK = 143_000_143

export type TestDatabaseReady = {
  /** The connection string the suites are pointed at. */
  url: string
  /** True when this run is the one that created it. */
  created: boolean
  /** Migrations in this checkout's journal. */
  known: number
  /** Migrations the database already held before this run migrated it. */
  alreadyApplied: number
}

/**
 * The workspace `.env.local`, as a plain object — the same load both vitest
 * configs already did, in one place now because the global setups need it
 * too (vitest's `test.env` reaches the workers, not the setup file).
 */
export function loadWorkspaceEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  dotenv({ path: ENV_FILES, processEnv: out })
  // A real environment variable wins over the file for the two keys this
  // harness reads, so `DATABASE_URL_TEST=… pnpm test` works from the shell
  // and turbo's `globalEnv: ["DATABASE_URL"]` declaration stays true.
  for (const key of ['DATABASE_URL', 'DATABASE_URL_TEST']) {
    const fromShell = process.env[key]
    if (fromShell !== undefined && fromShell !== '') out[key] = fromShell
  }
  return out
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''))
}

/** Same server, same database — the one case that must never be written. */
function isSameDatabase(a: URL, b: URL): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    databaseName(a) === databaseName(b)
  )
}

/** The connection string, minus the password, for an error message. */
function redact(connectionString: string): string {
  const url = new URL(connectionString)
  if (url.password !== '') url.password = '***'
  return url.toString()
}

/**
 * `DATABASE_URL_TEST` when set, otherwise `DATABASE_URL` with `_test`
 * suffixed onto the database name — `…/spaces` becomes `…/spaces_test`.
 *
 * Pure, so the two guards below are testable: no environment, no connection.
 */
export function resolveTestDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const source = env.DATABASE_URL
  const override = env.DATABASE_URL_TEST

  if (override !== undefined && override !== '') {
    if (source !== undefined && source !== '') {
      if (isSameDatabase(new URL(override), new URL(source)))
        throw new Error(
          `[test-db] DATABASE_URL_TEST names the same database as DATABASE_URL (${redact(source)}). The suite writes to the test database; it must not be the one the app is showing.`,
        )
    }
    return override
  }

  if (source === undefined || source === '')
    throw new Error(
      '[test-db] neither DATABASE_URL_TEST nor DATABASE_URL is set. The test database is derived from DATABASE_URL, which .env.local at the workspace root supplies.',
    )

  const url = new URL(source)
  const name = databaseName(url)
  if (name === '')
    throw new Error(
      `[test-db] DATABASE_URL names no database (${redact(source)}), so there is nothing to suffix _test onto.`,
    )
  url.pathname = `/${encodeURIComponent(`${name}_test`)}`
  return url.toString()
}

/**
 * Connect, or fail naming the server. This is the whole point of doing it in
 * a global setup: with Postgres down the old suite threw ECONNREFUSED ten
 * times, once per DB-coupled file, and said nothing about which database it
 * had failed to reach.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    if (cause.message !== '') return cause.message
    // Node's happy-eyeballs AggregateError is the one that matters here — a
    // refused connection arrives with an empty message and the reason on
    // `code`, which is how "cannot reach Postgres at … — ." got shipped once.
    if ('code' in cause) return String(cause.code)
  }
  return String(cause)
}

async function connect(connectionString: string, role: string) {
  const client = new Client({ connectionString })
  try {
    await client.connect()
  } catch (cause) {
    const reason = describeCause(cause)
    throw new Error(
      `[test-db] cannot reach ${role} at ${redact(connectionString)} — ${reason}. Start it with: docker compose -f docker-compose.dev.yml up -d`,
      { cause },
    )
  }
  return client
}

async function ensureDatabase(url: string): Promise<boolean> {
  const target = new URL(url)
  const name = databaseName(target)
  // The name reaches `create database` as an identifier, never as a bound
  // value, so it is checked rather than escaped: it comes from a connection
  // string, and a connection string can hold anything.
  if (!/^[A-Za-z0-9_]+$/.test(name))
    throw new Error(
      `[test-db] refusing to create a database named ${JSON.stringify(name)} — letters, digits and underscores only.`,
    )

  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const client = await connect(maintenance.toString(), 'Postgres')
  try {
    // Held for the check and the create together; ending the session below
    // releases it.
    await client.query('select pg_advisory_lock($1)', [HARNESS_LOCK])
    const found = await client.query(
      'select 1 from pg_database where datname = $1',
      [name],
    )
    if (found.rowCount !== 0) return false
    await client.query(`create database "${name}"`)
    return true
  } finally {
    await client.end()
  }
}

/**
 * Derive, create if absent, migrate — and point `process.env.DATABASE_URL`
 * at the result before returning, because `@spaces/db`'s `db` builds its pool
 * from that variable at *import* time. A caller that seeds must therefore
 * `await import` its seeds after this resolves, not at the top of its file.
 */
export async function prepareTestDatabase(
  env: Record<string, string | undefined>,
): Promise<TestDatabaseReady> {
  const url = resolveTestDatabaseUrl(env)
  const source = env.DATABASE_URL
  if (source !== undefined && source !== '')
    if (isSameDatabase(new URL(url), new URL(source)))
      throw new Error(
        `[test-db] the derived test database is the same as DATABASE_URL (${redact(source)}). Refusing — the suite would write to the database the app is showing.`,
      )

  const created = await ensureDatabase(url)

  const client = await connect(url, 'the test database')
  try {
    await client.query('select pg_advisory_lock($1)', [HARNESS_LOCK])
    process.env.DATABASE_URL = url
    const outcome = await runMigrations()
    if (outcome.kind === 'refused')
      throw new Error(
        `[test-db] migrations refused on ${redact(url)} — ${outcome.message}`,
      )
    const name = databaseName(new URL(url))
    console.log(
      `[test-db] ${name} ${created ? 'created' : 'reused'} — ${outcome.known} migrations known, ${outcome.applied} already applied, ${outcome.known - outcome.applied} applied now`,
    )
    return {
      url,
      created,
      known: outcome.known,
      alreadyApplied: outcome.applied,
    }
  } finally {
    await client.end()
  }
}
