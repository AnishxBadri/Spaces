import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { Pool } from 'pg'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { dropPluginSchemaStatement } from '@spaces/core/writes/plugins/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { JobPermanent, PluginDb } from '@spaces/sdk'
import type { JsonValue } from '@spaces/sdk'
import { makePluginHost } from './host'
import { reconcilePlugins } from './loader'
import type { ReconcileOptions } from './loader'
import {
  JOURNAL_TABLE,
  PLUGIN_RUNTIME_ROLE,
  PluginDbLive,
  SECRET_TABLES,
  pluginSchemaName,
} from './plugin-db'

/**
 * Loader step 5 and the live PluginDb against a real database: the tabled
 * fixture (two clean migrations, a job that writes its table) and the
 * trespass fixture (a migration that reaches into `public`). Plugin schemas
 * and the cluster-wide role outlive the harness's truncate of `public`, so
 * each test starts by dropping the fixtures' schemas.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-plugin-db-')),
    'plugins',
  )
  mkdirSync(root, { recursive: true })
  return root
}

/** Copy a fixture's dist/ — bundle, manifest and migrations — to `<root>/<id>/current/`. */
const install = (root: string, fixture: string) => {
  const dir = path.join(root, fixture, 'current')
  mkdirSync(dir, { recursive: true })
  cpSync(path.join(fixtures, fixture, 'dist'), dir, { recursive: true })
  return dir
}

const row = async (capabilityId: string) => {
  const inserted = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (inserted === undefined) throw new Error('no integration row')
  return inserted
}

const run = (pluginsRoot: string, options: ReconcileOptions = {}) =>
  Effect.runPromise(reconcilePlugins({ pluginsRoot, ...options }))

const rowsOf = async <TRow extends Record<string, unknown>>(
  text: string,
  values: ReadonlyArray<string> = [],
) => (await db.$client.query<TRow>(text, [...values])).rows

const tablesIn = async (schema: string) =>
  (
    await rowsOf<{ name: string }>(
      `select table_name::text as name from information_schema.tables
        where table_schema = $1 order by 1`,
      [schema],
    )
  ).map((r) => r.name)

const journalOf = (schema: string) =>
  rowsOf<{ name: string; applied_at: Date }>(
    `select name, applied_at from "${schema}"."${JOURNAL_TABLE}" order by name`,
  )

const schemaExists = async (schema: string) =>
  (await rowsOf(`select 1 from pg_namespace where nspname = $1`, [schema]))
    .length > 0

const seedCompany = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: 'Northwind Robotics',
      keys: { domain: 'northwind.example' },
      source: { class: 'manual' },
    })
  ).entityId

const pluginQuery = (
  pluginId: string,
  text: string,
  params: ReadonlyArray<JsonValue> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PluginDb).query(text, params)
    }).pipe(
      Effect.provide(PluginDbLive({ capabilityId: pluginId })),
      Effect.result,
    ),
  )

const TABLED = pluginSchemaName('tabled')
const TRESPASS = pluginSchemaName('trespass')

beforeEach(async () => {
  await db.delete(integration).where(isNotNull(integration.id))
  for (const id of ['tabled', 'trespass']) {
    await db.execute(dropPluginSchemaStatement(id))
  }
})

describe('pluginSchemaName', () => {
  it('maps a hyphen to an underscore, which a plugin id cannot hold', () => {
    expect(pluginSchemaName('needs-key')).toBe('plugin_needs_key')
  })
})

describe('step 5 with two clean migrations', () => {
  it('creates plugin_tabled on first load, and a reboot runs nothing new', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    install(root, 'echo')
    await row('tabled')
    await row('echo')

    const first = await run(root)
    expect(first.verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['echo', 'enabled', null],
      ['tabled', 'enabled', null],
    ])
    expect(first.verdicts.at(1)?.line).toContain(
      'migrated 0001_note.sql, 0002_note_seen.sql',
    )
    expect(await tablesIn(TABLED)).toEqual(['note', JOURNAL_TABLE])
    const columns = await rowsOf<{ name: string }>(
      `select column_name::text as name from information_schema.columns
        where table_schema = $1 and table_name = 'note' order by ordinal_position`,
      [TABLED],
    )
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'entity_id',
      'body',
      'seen_at',
    ])
    const owner = await rowsOf<{ owner: string }>(
      `select nspowner::regrole::text as owner from pg_namespace where nspname = $1`,
      [TABLED],
    )
    expect(owner.at(0)?.owner).toBe(PLUGIN_RUNTIME_ROLE)
    // Echo uses no PluginDb and ships no migrations: no schema for it.
    expect(await schemaExists(pluginSchemaName('echo'))).toBe(false)

    const journal = await journalOf(TABLED)
    expect(journal.map((r) => r.name)).toEqual([
      '0001_note.sql',
      '0002_note_seen.sql',
    ])

    const second = await run(root)
    expect(second.verdicts.map((v) => [v.id, v.status])).toEqual([
      ['echo', 'enabled'],
      ['tabled', 'enabled'],
    ])
    expect(second.verdicts.at(1)?.line).not.toContain('migrated')
    expect(await journalOf(TABLED)).toEqual(journal)
  })

  it('refuses a load whose applied migration changed, and one whose journal is ahead of its files', async () => {
    const root = newPluginsRoot()
    const dir = install(root, 'tabled')
    const tabled = await row('tabled')
    await run(root)

    writeFileSync(
      path.join(dir, 'migrations', '0002_note_seen.sql'),
      'alter table note add column other text;\n',
    )
    const edited = await run(root)
    expect(edited.verdicts.at(0)?.reason).toBe(
      'migration 0002_note_seen.sql changed after it was applied',
    )

    rmSync(path.join(dir, 'migrations', '0002_note_seen.sql'))
    const older = await run(root)
    expect(older.verdicts.at(0)?.reason).toMatch(
      /^journal records 0002_note_seen\.sql, which this version does not ship/,
    )
    const stored = (
      await db.select().from(integration).where(eq(integration.id, tabled.id))
    ).at(0)
    expect(stored?.status).toBe('degraded')
  })
})

describe('a migration that touches public', () => {
  const publicTables = () => tablesIn('public')

  it('fails, rolls back and degrades that plugin with the statement, and public is unchanged', async () => {
    const root = newPluginsRoot()
    install(root, 'trespass')
    install(root, 'echo')
    const trespass = await row('trespass')
    await row('echo')
    const before = await publicTables()

    const { verdicts } = await run(root)
    const reason =
      'migration 0002_public.sql failed at `create table public.trespass (id integer primary key)`: permission denied for schema public'
    expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['echo', 'enabled', null],
      ['trespass', 'degraded', reason],
    ])
    const stored = (
      await db.select().from(integration).where(eq(integration.id, trespass.id))
    ).at(0)
    expect(stored).toMatchObject({ status: 'degraded', lastError: reason })

    expect(await publicTables()).toEqual(before)
    // The clean first migration and the schema went with the transaction.
    expect(await schemaExists(TRESPASS)).toBe(false)
  })

  it('refuses altering a shared enum the same way', async () => {
    const root = newPluginsRoot()
    const dir = install(root, 'trespass')
    writeFileSync(
      path.join(dir, 'migrations', '0002_public.sql'),
      "alter type public.source_class add value 'trespass';\n",
    )
    await row('trespass')
    const labels = () =>
      rowsOf<{ label: string }>(
        `select enumlabel::text as label from pg_enum
          where enumtypid = 'public.source_class'::regtype order by enumsortorder`,
      )
    const before = await labels()

    const { verdicts } = await run(root)
    expect(verdicts.at(0)?.status).toBe('degraded')
    expect(verdicts.at(0)?.reason).toBe(
      "migration 0002_public.sql failed at `alter type public.source_class add value 'trespass'`: must be owner of type source_class",
    )
    expect(await labels()).toEqual(before)
    expect(await schemaExists(TRESPASS)).toBe(false)
  })
})

describe('the live PluginDb', () => {
  it('resolves unqualified names in plugin_tabled, reads public.entity, and cannot write it', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    await row('tabled')
    await run(root)
    const companyId = await seedCompany()

    const inserted = await pluginQuery(
      'tabled',
      'insert into note (entity_id, body) values ($1, $2) returning entity_id, body',
      [companyId, 'first'],
    )
    expect(inserted).toMatchObject({
      _tag: 'Success',
      success: [{ entity_id: companyId, body: 'first' }],
    })
    const qualified = await rowsOf<{ body: string }>(
      `select body from "${TABLED}".note`,
    )
    expect(qualified).toEqual([{ body: 'first' }])

    const read = await pluginQuery(
      'tabled',
      'select id, canonical_name from public.entity where id = $1',
      [companyId],
    )
    expect(read).toMatchObject({
      _tag: 'Success',
      success: [{ id: companyId, canonical_name: 'Northwind Robotics' }],
    })

    const countEntities = async () =>
      (await rowsOf<{ n: number }>('select count(*)::int as n from entity')).at(
        0,
      )?.n
    const entities = await countEntities()
    for (const write of [
      "update public.entity set canonical_name = 'Taken' where id = $1",
      'delete from entity where id = $1',
    ]) {
      const refused = await pluginQuery('tabled', write, [companyId])
      expect(refused._tag).toBe('Failure')
      if (refused._tag === 'Failure') {
        expect(refused.failure).toBeInstanceOf(JobPermanent)
        expect(refused.failure.reason).toBe(
          'PluginDb: permission denied for table entity',
        )
      }
    }
    const insert = await pluginQuery(
      'tabled',
      `insert into public.entity (object_id, canonical_name) select object_id, 'Forged' from public.entity limit 1`,
    )
    expect(insert._tag).toBe('Failure')
    expect(await countEntities()).toBe(entities)
    const name = await rowsOf<{ name: string }>(
      'select canonical_name as name from entity where id = $1',
      [companyId],
    )
    expect(name).toEqual([{ name: 'Northwind Robotics' }])
  })

  it('refuses a second statement in one call and a statement that leaves the role', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    await row('tabled')
    await run(root)

    const two = await pluginQuery('tabled', 'select 1; select 2')
    expect(two._tag).toBe('Failure')
    if (two._tag === 'Failure') {
      expect(two.failure.reason).toBe(
        'PluginDb: cannot insert multiple commands into a prepared statement',
      )
    }
    const reset = await pluginQuery('tabled', 'reset role')
    expect(reset._tag).toBe('Failure')
    if (reset._tag === 'Failure') {
      expect(reset.failure.reason).toBe(
        `PluginDb: the query left the ${PLUGIN_RUNTIME_ROLE} role`,
      )
    }
  })

  it('a wired job writes its own table through the host', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    const tabled = await row('tabled')
    const companyId = await seedCompany()
    const host = makePluginHost({
      enqueue: Layer.succeed(Enqueue, {
        enqueue: () => Effect.succeed('job-1'),
      }),
    })
    try {
      const { loaded } = await run(root)
      const wired = await Effect.runPromise(host.wire(loaded))
      expect(wired.map((v) => v.status)).toEqual(['enabled'])
      await Effect.runPromise(
        host.invoke(tabled.id, 'note', { entityId: companyId }),
      )
    } finally {
      await Effect.runPromise(host.releaseAll())
    }
    const notes = await rowsOf<{ entity_id: string; body: string }>(
      `select entity_id::text, body from "${TABLED}".note`,
    )
    expect(notes).toEqual([{ entity_id: companyId, body: 'seen' }])
  })
})

describe('containment of plugin_runtime', () => {
  it('holds no write privilege on any public table, by any grant', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    await row('tabled')
    await run(root)

    const granted = await rowsOf<{ table_name: string; privilege: string }>(
      `select table_name::text, privilege_type::text as privilege
         from information_schema.role_table_grants
        where grantee = $1 and table_schema = 'public'
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`,
      [PLUGIN_RUNTIME_ROLE],
    )
    expect(granted).toEqual([])
    // has_table_privilege also counts grants to PUBLIC and inherited roles.
    const writable = await rowsOf<{ name: string }>(
      `select c.relname::text as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')`,
      [PLUGIN_RUNTIME_ROLE],
    )
    expect(writable).toEqual([])
    const create = await rowsOf<{ can: boolean }>(
      `select has_schema_privilege($1, 'public', 'CREATE') as can`,
      [PLUGIN_RUNTIME_ROLE],
    )
    expect(create).toEqual([{ can: false }])
    const select = await rowsOf<{ can: boolean }>(
      `select has_table_privilege($1, 'public.entity', 'SELECT') as can`,
      [PLUGIN_RUNTIME_ROLE],
    )
    expect(select).toEqual([{ can: true }])
    const secrets = await rowsOf<{ name: string }>(
      `select c.relname::text as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($2::text[])
          and has_any_column_privilege($1, c.oid, 'SELECT')`,
      [PLUGIN_RUNTIME_ROLE, `{${SECRET_TABLES.join(',')}}`],
    )
    expect(secrets).toEqual([])
  })

  it('reads no secret table, and no schema but public and its own', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    await row('tabled')
    await run(root)
    // pg-boss creates its schema on first start; the worker always has it.
    await db.$client.query('create schema if not exists pgboss')

    const refusal = async (text: string) => {
      const result = await pluginQuery('tabled', text)
      expect(result._tag).toBe('Failure')
      return result._tag === 'Failure' ? result.failure.reason : null
    }
    expect(await refusal('select * from public.session')).toBe(
      'PluginDb: permission denied for table session',
    )
    expect(await refusal('select token from public.session')).toBe(
      'PluginDb: permission denied for table session',
    )
    for (const table of SECRET_TABLES) {
      expect(await refusal(`select 1 from public."${table}" limit 1`)).toBe(
        `PluginDb: permission denied for table ${table}`,
      )
    }
    expect(await refusal('select * from drizzle.__drizzle_migrations')).toBe(
      'PluginDb: permission denied for schema drizzle',
    )
    expect(await refusal('select * from pgboss.job')).toBe(
      'PluginDb: permission denied for schema pgboss',
    )
    // A graph table next to them still reads.
    const read = await pluginQuery(
      'tabled',
      'select count(*)::int as n from public.entity',
    )
    expect(read._tag).toBe('Success')
  })

  it('a secret table readable through PUBLIC degrades the plugin, naming the table', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    install(root, 'echo')
    await row('tabled')
    await row('echo')
    await db.$client.query('grant select on public.session to public')
    try {
      const { verdicts } = await run(root)
      expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
        ['echo', 'enabled', null],
        [
          'tabled',
          'degraded',
          `role ${PLUGIN_RUNTIME_ROLE} can read public.session, which holds secrets; revoke SELECT on it from the role and from PUBLIC`,
        ],
      ])
    } finally {
      await db.$client.query('revoke select on public.session from public')
    }
    expect(await schemaExists(TABLED)).toBe(false)
  })

  it('a plugin schema may point at public.entity, and nothing in public points into a plugin schema', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    await row('tabled')
    await run(root)

    const fks = (from: string, to: string) =>
      rowsOf<{ name: string }>(
        `select con.conname::text as name
           from pg_constraint con
           join pg_class src on src.oid = con.conrelid
           join pg_namespace srcn on srcn.oid = src.relnamespace
           join pg_class dst on dst.oid = con.confrelid
           join pg_namespace dstn on dstn.oid = dst.relnamespace
          where con.contype = 'f' and srcn.nspname like $1 and dstn.nspname like $2`,
        [from, to],
      )
    expect((await fks(TABLED, 'public')).length).toBe(1)
    expect(await fks('public', 'plugin\\_%')).toEqual([])
  })

  it('a CREATE ROLE the database refuses degrades that plugin with the refusal, and nothing else changes', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    install(root, 'echo')
    await row('tabled')
    await row('echo')
    // A connection acting as a role without CREATEROLE, as on a managed
    // Postgres; the role name is one no test creates.
    const refusing = new Pool({ connectionString: process.env.DATABASE_URL })
    refusing.on('connect', (client) => {
      void client.query('set role pg_read_all_data')
    })
    const role = 'plugin_runtime_refused'
    try {
      const { verdicts } = await run(root, {
        pluginDb: { pool: refusing, role },
      })
      expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
        ['echo', 'enabled', null],
        [
          'tabled',
          'degraded',
          `could not create role ${role}: permission denied to create role`,
        ],
      ])
    } finally {
      await refusing.end()
    }
    expect(
      await rowsOf(`select 1 from pg_roles where rolname = $1`, [role]),
    ).toEqual([])
    expect(await schemaExists(TABLED)).toBe(false)
  })
})

describe('dropPluginSchemaStatement', () => {
  it('without it the schema survives an uninstall and a reinstall finds its data and journal; with it both go', async () => {
    const root = newPluginsRoot()
    install(root, 'tabled')
    const first = await row('tabled')
    await run(root)
    const companyId = await seedCompany()
    await pluginQuery(
      'tabled',
      'insert into note (entity_id, body) values ($1, $2)',
      [companyId, 'kept'],
    )
    const journal = await journalOf(TABLED)

    // Uninstall without dropping data: the row and the files go.
    await db.delete(integration).where(eq(integration.id, first.id))
    rmSync(path.join(root, 'tabled'), { recursive: true })
    expect(await schemaExists(TABLED)).toBe(true)

    install(root, 'tabled')
    await row('tabled')
    const again = await run(root)
    expect(again.verdicts.at(0)?.status).toBe('enabled')
    expect(again.verdicts.at(0)?.line).not.toContain('migrated')
    expect(await journalOf(TABLED)).toEqual(journal)
    expect(
      await rowsOf<{ body: string }>(`select body from "${TABLED}".note`),
    ).toEqual([{ body: 'kept' }])

    await db.execute(dropPluginSchemaStatement('tabled'))
    expect(await schemaExists(TABLED)).toBe(false)
    const fresh = await run(root)
    expect(fresh.verdicts.at(0)?.line).toContain(
      'migrated 0001_note.sql, 0002_note_seen.sql',
    )
    expect(await rowsOf(`select body from "${TABLED}".note`)).toEqual([])
  })
})
