import { fileURLToPath } from 'node:url'
import { config as dotenv } from 'dotenv'
import { Client } from 'pg'
import { runMigrations } from './migrate.ts'
import type { SqlQuery } from './downgrade-guard.ts'

/**
 * The test harness: derives, creates and migrates the suite's own databases on
 * the dev Postgres, one per vitest worker, truncated between files.
 * - `spaces_test` is the reference database; workers never write to it. Each
 *   worker owns a sibling (`spaces_test_web1`, `spaces_test_db1`, …) so one
 *   worker's truncate cannot reach another worker's file mid-test.
 * - Nothing here ever drops a database. The only DDL is `create database` and
 *   `truncate`, and it refuses when the derived database is `DATABASE_URL`'s.
 * - Harness, not product: imported by vitest configs and setups only.
 */

/** `.env.local` at the workspace root, resolved from this file, never cwd. */
const ENV_FILES = ['.env.local', '.env'].map((name) =>
  fileURLToPath(new URL(`../../../${name}`, import.meta.url)),
)

/**
 * One advisory-lock key for the whole harness.
 * - turbo runs every package's `test` at once, so "create if absent", "apply
 *   the journal" and seeding all race without it.
 * - The number is arbitrary; it only has to be the same in every process.
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
 * The workspace `.env.local`, as a plain object, for configs and global
 * setups alike (vitest's `test.env` reaches the workers, not the setup file).
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
 * How many vitest workers a multi-worker suite runs, and so how many worker
 * databases its global setup builds (the config's `maxWorkers`; the per-file
 * setup indexes by `VITEST_POOL_ID`, `1…maxWorkers`).
 * - Change it here and nowhere else. A run given more workers is refused by
 *   the per-file setup rather than putting two workers on one database.
 * - Four was measured fastest; past it the workers contend for one Postgres.
 */
export const TEST_WORKERS = 4

/**
 * The database one worker of one suite owns: the base name plus suite name
 * plus pool id (`spaces_test_web2`), so suites turbo runs in parallel never
 * share one.
 */
export function workerDatabaseUrl(
  baseUrl: string,
  suite: string,
  poolId: number,
): string {
  if (!/^[a-z]+$/.test(suite))
    throw new Error(
      `[test-db] suite name ${JSON.stringify(suite)} must be lowercase letters — it becomes part of a database name.`,
    )
  const url = new URL(baseUrl)
  url.pathname = `/${encodeURIComponent(`${databaseName(url)}_${suite}${poolId}`)}`
  return url.toString()
}

/** The worker this process is, as vitest numbers them (1…maxWorkers). */
export function currentPoolId(env: Record<string, string | undefined>): number {
  const raw = env.VITEST_POOL_ID
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

/**
 * Empty every table in `public`, which is the whole of what a test file may
 * have written, and nothing else.
 * - Structural, not a list: `drizzle.__drizzle_migrations` and the `pgboss`
 *   schema are outside `public`, and a new table is covered unasked.
 * - One statement: `truncate a, b, c` ignores FKs among the tables it names,
 *   `cascade` covers the rest, `restart identity` resets the serial columns.
 */
export async function truncatePublicTables(query: SqlQuery): Promise<number> {
  const found = await query(
    "select quote_ident(tablename) as ident from pg_tables where schemaname = 'public'",
  )
  const idents = found.rows.map((row) => String(row.ident))
  if (idents.length === 0) return 0
  await query(`truncate table ${idents.join(', ')} restart identity cascade`)
  return idents.length
}

/**
 * The reason a connect failed, for an error that names the server once
 * instead of every file throwing a bare ECONNREFUSED.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    if (cause.message !== '') return cause.message
    // Node's happy-eyeballs AggregateError arrives with an empty message and
    // the reason on `code`.
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
 * Derive, create if absent, migrate, seed, and point `process.env.DATABASE_URL`
 * at the result before returning.
 * - `db` builds its pool from that variable at *import* time, so a caller that
 *   seeds must `await import` its seeds after this resolves, or pass `seed`.
 * - Pass `seed` when several setups seed one database: it runs inside the
 *   harness lock, so two insert-if-absent seeders cannot both see "absent".
 */
export async function prepareTestDatabase(
  env: Record<string, string | undefined>,
  seed?: () => Promise<void>,
): Promise<TestDatabaseReady> {
  const url = resolveTestDatabaseUrl(env)
  const source = env.DATABASE_URL
  if (source !== undefined && source !== '')
    if (isSameDatabase(new URL(url), new URL(source)))
      throw new Error(
        `[test-db] the derived test database is the same as DATABASE_URL (${redact(source)}). Refusing — the suite would write to the database the app is showing.`,
      )

  return prepareDatabase(url, seed)
}

/**
 * The same create-and-migrate for a database the caller already named: the
 * worker databases from `workerDatabaseUrl`. No "is this the app's database"
 * guard here; it ran on the `resolveTestDatabaseUrl` name they derive from.
 */
export async function prepareDatabase(
  url: string,
  seed?: () => Promise<void>,
): Promise<TestDatabaseReady> {
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
    // Still under the lock: `DATABASE_URL` already names this database, so a
    // seed that imports `@spaces/db` here opens its pool on it, and a second
    // setup waiting on the lock seeds after this one has finished.
    if (seed) await seed()
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
