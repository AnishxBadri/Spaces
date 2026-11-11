import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER } from './migrate'

/**
 * The migration that drops `scratch` from `note_kind`, run against rows that
 * hold it: a database is migrated to the entry before it, given a scratch
 * note and a scratch template, then migrated the rest of the way.
 * Runs in a throwaway database beside this worker's own, which the file's
 * truncate never sees.
 */

const TAG = '0092_note_kind_two'
const TEST_DB = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_notekind`

describe(`${TAG} (real database)`, () => {
  let adminUrl = ''
  let testUrl = ''
  let tmpRoot = ''

  async function exec<T extends pg.QueryResultRow>(
    url: string,
    sql: string,
  ): Promise<Array<T>> {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      return (await client.query<T>(sql)).rows
    } finally {
      await client.end()
    }
  }

  /** Several statements in one round trip; `query` answers no rows for those. */
  async function run(sql: string) {
    const client = new pg.Client({ connectionString: testUrl })
    await client.connect()
    try {
      await client.query(sql)
    } finally {
      await client.end()
    }
  }

  async function migrateTo(folder: string) {
    const db = drizzle(testUrl)
    try {
      await migrate(db, { migrationsFolder: folder })
    } finally {
      await db.$client.end()
    }
  }

  beforeAll(async () => {
    const admin = new URL(process.env.DATABASE_URL!)
    admin.pathname = '/postgres'
    adminUrl = admin.toString()
    const test = new URL(process.env.DATABASE_URL!)
    test.pathname = `/${TEST_DB}`
    testUrl = test.toString()

    await exec(adminUrl, `drop database if exists ${TEST_DB} with (force)`)
    await exec(adminUrl, `create database ${TEST_DB}`)

    // The journal as it stood the moment before this migration.
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'note-kind-'))
    const before = path.join(tmpRoot, 'drizzle')
    cpSync(MIGRATIONS_FOLDER, before, { recursive: true })
    const journalPath = path.join(before, 'meta/_journal.json')
    const parsed: { entries: Array<{ tag: string }> } = JSON.parse(
      readFileSync(journalPath, 'utf8'),
    )
    const cut = parsed.entries.findIndex((e) => e.tag === TAG)
    expect(cut).toBeGreaterThan(0)
    parsed.entries = parsed.entries.slice(0, cut)
    writeFileSync(journalPath, JSON.stringify(parsed, null, 2))
    await migrateTo(before)

    await run(
      `insert into "user" (id, name, email) values ('u1', 'U', 'u@example.test');
       insert into entity (id, kind, canonical_name) values
         ('00000000-0000-0000-0000-000000000001', 'note', 'Scratch'),
         ('00000000-0000-0000-0000-000000000002', 'note', 'Memo');
       insert into note (entity_id, kind, author_id) values
         ('00000000-0000-0000-0000-000000000001', 'scratch', 'u1'),
         ('00000000-0000-0000-0000-000000000002', 'memo', 'u1');
       insert into template (kind, note_kind, name, body, created_by) values
         ('note', 'scratch', 'Scratch template', '[]', 'u1'),
         ('note', null, 'Plain template', '[]', 'u1');`,
    )

    await migrateTo(MIGRATIONS_FOLDER)
  }, 120_000)

  afterAll(async () => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    if (adminUrl)
      await exec(adminUrl, `drop database if exists ${TEST_DB} with (force)`)
  }, 120_000)

  it('maps a scratch note to note and leaves a memo alone', async () => {
    const rows = await exec<{ title: string; kind: string }>(
      testUrl,
      `select e.canonical_name as title, n.kind::text as kind
         from note n join entity e on e.id = n.entity_id
        order by e.canonical_name`,
    )
    expect(rows).toEqual([
      { title: 'Memo', kind: 'memo' },
      { title: 'Scratch', kind: 'note' },
    ])
  })

  it('maps a scratch template to note and leaves a null alone', async () => {
    const rows = await exec<{ name: string; note_kind: string | null }>(
      testUrl,
      `select name, note_kind::text as note_kind from template order by name`,
    )
    expect(rows).toEqual([
      { name: 'Plain template', note_kind: null },
      { name: 'Scratch template', note_kind: 'note' },
    ])
  })

  it('leaves note_kind with two labels, the old type gone, the default note', async () => {
    const labels = await exec<{ label: string }>(
      testUrl,
      `select unnest(enum_range(null::note_kind))::text as label`,
    )
    expect(labels.map((r) => r.label)).toEqual(['note', 'memo'])
    expect(
      await exec(
        testUrl,
        `select 1 from pg_type where typname = 'note_kind_old'`,
      ),
    ).toEqual([])
    await run(
      `insert into entity (id, kind, canonical_name) values
         ('00000000-0000-0000-0000-000000000003', 'note', 'Default');
       insert into note (entity_id, author_id)
         values ('00000000-0000-0000-0000-000000000003', 'u1');`,
    )
    expect(
      await exec(
        testUrl,
        `select kind::text as kind from note
          where entity_id = '00000000-0000-0000-0000-000000000003'`,
      ),
    ).toEqual([{ kind: 'note' }])
  })
})
