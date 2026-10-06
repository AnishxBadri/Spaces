import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Data, Effect, Exit, Layer, Predicate } from 'effect'
import type { Pool, PoolClient, QueryConfig, QueryResultRow } from 'pg'
import { z } from 'zod'
import { db } from '@spaces/db'
import { JobPermanent, JobRetryable, PluginDb } from '@spaces/sdk'
import type { JobError, JsonObject, JsonValue } from '@spaces/sdk'
import type { BoundIntegration } from '@spaces/core/writes/ports/binding'
import { splitStatements } from './sql-split'

/**
 * PluginDb: a plugin's own Postgres schema, its own migration journal, and a
 * role that cannot write `public` (loader step 5 and the live port).
 *
 * - Containment is the `plugin_runtime` role: created by the owning user
 *   (DATABASE_URL's), `nologin`, granted USAGE on `public`, SELECT on its
 *   tables and REFERENCES on `entity(id)` — nothing that writes. Every
 *   plugin statement runs after `set local role plugin_runtime` on a pooled
 *   connection, inside a transaction, so the role never leaks to the pool.
 * - `plugin_<id>` (hyphens become underscores) is owned by the role, so
 *   migrations run as the role too: DDL in `public` is refused by Postgres.
 * - A refused CREATE ROLE, a role that can write `public`, or a failing
 *   migration degrades that one plugin with the reason — never uncontained.
 * - A guard against a plugin's mistake, not a sandbox: SQL that means to can
 *   RESET ROLE. Trust in plugin code comes from signing. (D54)
 */

export const PLUGIN_RUNTIME_ROLE = 'plugin_runtime'

/** The journal table in each plugin schema: one row per applied file. */
export const JOURNAL_TABLE = 'spaces_migrations'

/** Postgres truncates identifiers past 63 bytes; a schema name never is. */
const IDENT_MAX = 63

export const pluginSchemaName = (pluginId: string): string =>
  `plugin_${pluginId.replaceAll('-', '_')}`

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Why a plugin's schema could not be set up or migrated — its `last_error`. */
export class PluginDbRefused extends Data.TaggedError('PluginDbRefused')<{
  readonly reason: string
}> {}

export type PluginDbOptions = {
  /** The owning user's connections; defaults to the db pool. */
  readonly pool?: Pool
  /** Defaults to `PLUGIN_RUNTIME_ROLE`. */
  readonly role?: string
}

class SqlFailed extends Data.TaggedError('SqlFailed')<{
  /** The SQLSTATE, or a node error code for a connection that failed. */
  readonly code: string | null
  readonly message: string
}> {}

const sqlFailed = (error: unknown): SqlFailed =>
  new SqlFailed({
    code:
      Predicate.hasProperty(error, 'code') && Predicate.isString(error.code)
        ? error.code
        : null,
    message: error instanceof Error ? error.message : String(error),
  })

const query = <TRow extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: ReadonlyArray<JsonValue>,
) =>
  Effect.tryPromise({
    try: () =>
      client.query<TRow>(text, values === undefined ? undefined : [...values]),
    catch: sqlFailed,
  })

/** One statement on the extended protocol, which refuses a second one. */
const queryOne = (
  client: PoolClient,
  text: string,
  values: ReadonlyArray<JsonValue>,
) => {
  const config: QueryConfig<Array<JsonValue>> & {
    readonly queryMode: 'extended'
  } = { text, values: [...values], queryMode: 'extended' }
  return Effect.tryPromise({
    try: () => client.query(config),
    catch: sqlFailed,
  })
}

/** A pooled connection for `use`; destroyed rather than reused after a failure. */
const withClient = <TValue, TError>(
  pool: Pool,
  use: (client: PoolClient) => Effect.Effect<TValue, TError>,
): Effect.Effect<TValue, TError | SqlFailed> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => pool.connect(), catch: sqlFailed }),
    use,
    (client, exit) => Effect.sync(() => client.release(Exit.isFailure(exit))),
  )

const inTransaction = <TValue, TError>(
  client: PoolClient,
  body: Effect.Effect<TValue, TError>,
): Effect.Effect<TValue, TError | SqlFailed> =>
  Effect.gen(function* () {
    yield* query(client, 'begin')
    const value = yield* body.pipe(
      Effect.onError(() => query(client, 'rollback').pipe(Effect.ignore)),
    )
    yield* query(client, 'commit')
    return value
  })

/** Fails unless the connection is still acting as `role`. */
const stillRole = (client: PoolClient, role: string, what: string) =>
  Effect.gen(function* () {
    const result = yield* query<{ who: string }>(
      client,
      'select current_user::text as who',
    )
    if (result.rows.at(0)?.who === role) return
    return yield* new SqlFailed({
      code: null,
      message: `${what} left the ${role} role`,
    })
  })

const refuse =
  (prefix: string) =>
  (error: SqlFailed): PluginDbRefused =>
    new PluginDbRefused({ reason: `${prefix}: ${error.message}` })

const oneLine = (statement: string): string =>
  statement.replace(/\s+/g, ' ').trim()

/**
 * Creates the role when it is absent. Outside any transaction: a concurrent
 * CREATE ROLE (another worker, or another database on the cluster) fails
 * with a duplicate, which is success here.
 */
const ensureRole = (client: PoolClient, role: string) =>
  Effect.gen(function* () {
    const found = yield* query(
      client,
      'select 1 from pg_roles where rolname = $1',
      [role],
    )
    if (found.rows.length > 0) return
    yield* query(client, `create role ${ident(role)} nologin`).pipe(
      Effect.catchTag('SqlFailed', (error) =>
        error.code === '42710' || error.code === '23505'
          ? Effect.void
          : Effect.fail(error),
      ),
    )
  }).pipe(Effect.mapError(refuse(`could not create role ${role}`)))

/**
 * The role's grants on `public`, re-applied on every load so a table a core
 * migration added since is readable, then the containment check: the role
 * may neither create in `public` nor write any table there, by any grant.
 */
const containRole = (client: PoolClient, role: string) =>
  Effect.gen(function* () {
    const me = yield* query<{ rolsuper: boolean }>(
      client,
      'select rolsuper from pg_roles where rolname = current_user',
    ).pipe(Effect.mapError(refuse('could not read the owning role')))
    // A superuser may SET ROLE to anything; anyone else needs the membership.
    if (me.rows.at(0)?.rolsuper !== true) {
      yield* query(client, `grant ${ident(role)} to current_user`).pipe(
        Effect.mapError(refuse(`could not enter role ${role}`)),
      )
    }
    for (const grant of [
      `grant usage on schema public to ${ident(role)}`,
      `grant select on all tables in schema public to ${ident(role)}`,
      `grant references (id) on table public.entity to ${ident(role)}`,
    ]) {
      yield* query(client, grant).pipe(
        Effect.mapError(refuse(`could not grant ${role} its reads`)),
      )
    }
    const create = yield* query<{ can: boolean }>(
      client,
      `select has_schema_privilege($1, 'public', 'CREATE') as can`,
      [role],
    ).pipe(Effect.mapError(refuse('could not check containment')))
    if (create.rows.at(0)?.can === true) {
      return yield* new PluginDbRefused({
        reason: `role ${role} can create in schema public; revoke CREATE on schema public from it and from PUBLIC`,
      })
    }
    const writable = yield* query<{ name: string }>(
      client,
      `select c.relname::text as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
        order by 1 limit 1`,
      [role],
    ).pipe(Effect.mapError(refuse('could not check containment')))
    const table = writable.rows.at(0)?.name
    if (table !== undefined) {
      return yield* new PluginDbRefused({
        reason: `role ${role} can write public.${table}; revoke INSERT, UPDATE, DELETE, TRUNCATE on it`,
      })
    }
  })

type MigrationFile = {
  readonly name: string
  readonly text: string
  readonly sha256: string
}

/** `migrations/*.sql`, in lexical order. */
const readMigrations = (dir: string | null) =>
  Effect.try({
    try: (): ReadonlyArray<MigrationFile> => {
      if (dir === null || !existsSync(dir)) return []
      return readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => {
          const text = readFileSync(path.join(dir, name), 'utf8')
          const sha256 = createHash('sha256').update(text).digest('hex')
          return { name, text, sha256 }
        })
    },
    catch: (error) =>
      new PluginDbRefused({
        reason: `could not read migrations: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

export type Migrated = {
  readonly schema: string
  /** The files this run applied, in order; empty when the journal was current. */
  readonly applied: ReadonlyArray<string>
}

/**
 * Loader step 5: the role, the schema `plugin_<id>`, its journal, and every
 * migration file the journal lacks — in one transaction, under one advisory
 * lock, so a failure leaves the schema and `public` as they were.
 *
 * - The journal is forward-only: an applied file that changed, or a journal
 *   row this version ships no file for, refuses the load.
 * - A file is split into statements and each runs alone, so `last_error`
 *   names the statement Postgres refused.
 */
export const migratePlugin = Effect.fn('migratePlugin')(function* (
  pluginId: string,
  migrationsDir: string | null,
  options: PluginDbOptions = {},
): Effect.fn.Return<Migrated, PluginDbRefused> {
  const pool = options.pool ?? db.$client
  const role = options.role ?? PLUGIN_RUNTIME_ROLE
  const schema = pluginSchemaName(pluginId)
  if (Buffer.byteLength(schema) > IDENT_MAX) {
    return yield* new PluginDbRefused({
      reason: `schema name ${schema} is longer than ${IDENT_MAX} bytes`,
    })
  }
  const files = yield* readMigrations(migrationsDir)
  const journal = `${ident(schema)}.${ident(JOURNAL_TABLE)}`

  const migrate = (client: PoolClient) =>
    Effect.gen(function* () {
      const setup = refuse(`could not set up schema ${schema}`)
      yield* query(client, 'select pg_advisory_xact_lock(hashtext($1))', [
        'spaces.plugin-db',
      ]).pipe(Effect.mapError(setup))
      yield* containRole(client, role)
      yield* query(
        client,
        `create schema if not exists ${ident(schema)} authorization ${ident(role)}`,
      ).pipe(Effect.mapError(setup))
      yield* query(client, `set local role ${ident(role)}`).pipe(
        Effect.mapError(setup),
      )
      yield* query(
        client,
        `set local search_path to ${ident(schema)}, public`,
      ).pipe(Effect.mapError(setup))
      yield* query(
        client,
        `create table if not exists ${journal} (
           name text primary key,
           sha256 text not null,
           applied_at timestamptz not null default now()
         )`,
      ).pipe(Effect.mapError(setup))
      const recorded = yield* query<{ name: string; sha256: string }>(
        client,
        `select name, sha256 from ${journal} order by name`,
      ).pipe(Effect.mapError(setup))

      const shipped = new Map(files.map((file) => [file.name, file]))
      for (const row of recorded.rows) {
        const file = shipped.get(row.name)
        if (file === undefined) {
          return yield* new PluginDbRefused({
            reason: `journal records ${row.name}, which this version does not ship — restore, never run an older plugin against its newer schema`,
          })
        }
        if (file.sha256 !== row.sha256) {
          return yield* new PluginDbRefused({
            reason: `migration ${row.name} changed after it was applied`,
          })
        }
      }

      const done = new Set(recorded.rows.map((row) => row.name))
      const applied: Array<string> = []
      for (const file of files) {
        if (done.has(file.name)) continue
        for (const statement of splitStatements(file.text)) {
          const at = `migration ${file.name} failed at \`${oneLine(statement)}\``
          yield* queryOne(client, statement, []).pipe(
            Effect.mapError(refuse(at)),
          )
          yield* stillRole(client, role, 'the statement').pipe(
            Effect.mapError(refuse(at)),
          )
        }
        yield* query(
          client,
          `insert into ${journal} (name, sha256) values ($1, $2)`,
          [file.name, file.sha256],
        ).pipe(Effect.mapError(refuse(`could not journal ${file.name}`)))
        applied.push(file.name)
      }
      return { schema, applied } satisfies Migrated
    })

  return yield* withClient(pool, (client) =>
    Effect.gen(function* () {
      yield* ensureRole(client, role)
      return yield* inTransaction(client, migrate(client))
    }),
  ).pipe(
    Effect.catchTag('SqlFailed', (error) =>
      Effect.fail(refuse(`could not migrate schema ${schema}`)(error)),
    ),
  )
})

/** A SQLSTATE worth retrying: connection, resources, shutdown, serialization. */
const retryable = (code: string | null): boolean =>
  code === null ||
  !/^[0-9A-Z]{5}$/.test(code) ||
  /^(08|53|57P)/.test(code) ||
  code === '40001' ||
  code === '40P01'

const toJobError = (error: SqlFailed): JobError =>
  retryable(error.code)
    ? new JobRetryable({ reason: `PluginDb: ${error.message}` })
    : new JobPermanent({ reason: `PluginDb: ${error.message}` })

const jsonRows = z.array(z.record(z.string(), z.json()))

/** pg's rows as JSON: a Date becomes its ISO string, as `JSON.stringify` writes it. */
const toJsonRows = (rows: ReadonlyArray<unknown>) =>
  Effect.try({
    try: (): ReadonlyArray<JsonObject> =>
      jsonRows.parse(JSON.parse(JSON.stringify(rows))),
    catch: (error) =>
      new JobPermanent({
        reason: `PluginDb: a row is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

/**
 * The live port for one plugin: each `query` is one statement in its own
 * transaction, as `plugin_runtime`, with `search_path` set to the plugin's
 * schema then `public` — unqualified names are the plugin's tables, and
 * `public.entity` reads but never writes.
 */
export const PluginDbLive = (
  row: Pick<BoundIntegration, 'capabilityId'>,
  options: PluginDbOptions = {},
): Layer.Layer<PluginDb> => {
  const pool = options.pool ?? db.$client
  const role = options.role ?? PLUGIN_RUNTIME_ROLE
  const schema = pluginSchemaName(row.capabilityId)

  const run = (sql: string, params: ReadonlyArray<JsonValue>) =>
    withClient(pool, (client) =>
      inTransaction(
        client,
        Effect.gen(function* () {
          yield* query(client, `set local role ${ident(role)}`)
          yield* query(
            client,
            `set local search_path to ${ident(schema)}, public`,
          )
          const result = yield* queryOne(client, sql, params)
          yield* stillRole(client, role, 'the query')
          return result.rows
        }),
      ),
    )

  return Layer.succeed(PluginDb, {
    query: (sql, params = []) =>
      run(sql, params).pipe(
        Effect.mapError(toJobError),
        Effect.flatMap(toJsonRows),
      ),
  })
}

/**
 * Drops a plugin's schema, its tables and its journal, as the owning user.
 * Uninstall's drop-data option is the caller this exists for; without it the
 * schema survives an uninstall and a reinstall finds its data and journal.
 */
export const dropPluginSchema = Effect.fn('dropPluginSchema')(function* (
  pluginId: string,
  options: Pick<PluginDbOptions, 'pool'> = {},
): Effect.fn.Return<void, PluginDbRefused> {
  const pool = options.pool ?? db.$client
  const schema = pluginSchemaName(pluginId)
  yield* withClient(pool, (client) =>
    query(client, `drop schema if exists ${ident(schema)} cascade`),
  ).pipe(Effect.mapError(refuse(`could not drop schema ${schema}`)))
})
