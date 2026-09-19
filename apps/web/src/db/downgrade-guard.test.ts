import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkDowngrade, readImageJournal } from './downgrade-guard'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const imageFolder = path.join(repoRoot, 'drizzle')

describe('checkDowngrade (pure)', () => {
  const image: Array<{ tag: string; when: number; hash: string }> = [
    { tag: '0000_a', when: 100, hash: 'aa' },
    { tag: '0001_b', when: 200, hash: 'bb' },
  ]

  it('passes when the database holds exactly what the image knows', () => {
    const verdict = checkDowngrade({
      image,
      applied: [
        { hash: 'aa', createdAt: 100 },
        { hash: 'bb', createdAt: 200 },
      ],
    })
    expect(verdict).toEqual({ kind: 'ok', applied: 2, known: 2 })
  })

  it('passes when the image is ahead — those are pending, not unknown', () => {
    const verdict = checkDowngrade({
      image,
      applied: [{ hash: 'aa', createdAt: 100 }],
    })
    expect(verdict.kind).toBe('ok')
  })

  it('names the timestamp when no file can identify the unknown entry', () => {
    const verdict = checkDowngrade({
      image,
      applied: [
        { hash: 'aa', createdAt: 100 },
        { hash: 'bb', createdAt: 200 },
        { hash: 'cc', createdAt: 300 },
      ],
    })
    expect(verdict.kind).toBe('refuse')
    if (verdict.kind !== 'refuse') return
    expect(verdict.message).toContain(
      'database has 3 migrations, this image knows 2',
    )
    expect(verdict.message).toContain('created_at 300')
    expect(verdict.message).toContain(
      'Restore the backup taken before the upgrade',
    )
  })

  it('refuses a divergent hash for a tag it does know, naming the tag', () => {
    const verdict = checkDowngrade({
      image,
      applied: [
        { hash: 'aa', createdAt: 100 },
        { hash: 'rebuilt', createdAt: 200 },
      ],
    })
    expect(verdict.kind).toBe('refuse')
    if (verdict.kind !== 'refuse') return
    expect(verdict.message).toContain('0001_b does not match')
  })
})

describe('readImageJournal', () => {
  it('reads every journal entry with a tag and drizzle-derived hash', () => {
    const journal = readImageJournal(imageFolder)
    const raw: { entries: Array<{ tag: string; when: number }> } = JSON.parse(
      readFileSync(path.join(imageFolder, 'meta/_journal.json'), 'utf8'),
    )
    expect(journal.map((e) => e.tag)).toEqual(raw.entries.map((e) => e.tag))
    expect(journal.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true)
  })
})

/**
 * The end-to-end proof. Needs a Postgres it can create a database on, because
 * the guard has to be shown against a database that was really migrated: a
 * throwaway database beside the one DATABASE_URL names, migrated with the
 * full journal, then booted by `src/db/migrate.ts` as the entrypoint runs it.
 */
const hasDb = Boolean(process.env.DATABASE_URL)
const TEST_DB = 'spa36_downgrade_guard'

describe.skipIf(!hasDb)('migrate.ts downgrade guard (real database)', () => {
  let adminUrl = ''
  let testUrl = ''
  let tmpRoot = ''
  // Row counts straight after the bare migration — some migrations insert
  // rows of their own, so "the seeds did not run" means "unchanged from here".
  const SEED_TABLES = ['object', 'attribute', 'entity']
  let baseline: Array<number> = []

  const bootDir = (name: string) => path.join(tmpRoot, name)

  async function adminExec(sql: string) {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: adminUrl })
    await client.connect()
    try {
      await client.query(sql)
    } finally {
      await client.end()
    }
  }

  async function countRows(table: string): Promise<number> {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: testUrl })
    await client.connect()
    try {
      const res = await client.query(
        `select count(*)::int as n from "${table}"`,
      )
      return Number(res.rows[0].n)
    } finally {
      await client.end()
    }
  }

  function runMigrateScript(cwd: string) {
    return spawnSync(
      path.join(repoRoot, 'node_modules/.bin/tsx'),
      [
        // The container runs this from /app; here it runs from a boot
        // directory holding a different `drizzle/`, so tsx needs the repo's
        // tsconfig to keep resolving the `#/` import alias.
        '--tsconfig',
        path.join(repoRoot, 'tsconfig.json'),
        path.join(repoRoot, 'src/db/migrate.ts'),
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: testUrl },
      },
    )
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    const admin = new URL(url.toString())
    admin.pathname = '/postgres'
    adminUrl = admin.toString()
    const test = new URL(url.toString())
    test.pathname = `/${TEST_DB}`
    testUrl = test.toString()

    await adminExec(`drop database if exists ${TEST_DB} with (force)`)
    await adminExec(`create database ${TEST_DB}`)

    // Boot directories, each holding the `drizzle/` folder a given image
    // would ship. migrate.ts resolves './drizzle' against its cwd.
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'spa36-'))
    for (const name of ['full', 'old', 'ancient', 'diverged']) {
      cpSync(imageFolder, path.join(bootDir(name), 'drizzle'), {
        recursive: true,
      })
    }

    const truncateJournal = (dir: string, keep: number) => {
      const journalPath = path.join(dir, 'drizzle/meta/_journal.json')
      const journal: { entries: Array<unknown> } = JSON.parse(
        readFileSync(journalPath, 'utf8'),
      )
      journal.entries = journal.entries.slice(0, keep)
      writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    }

    // The "older image": a journal truncated to 20 of the 24 entries, with
    // the .sql files still present — so the refusal can name the tag.
    truncateJournal(bootDir('old'), 20)

    // The genuinely older checkout: the journal stops at 22 and the two
    // later .sql files are not in the image at all, so nothing on disk can
    // name the unknown entry and the refusal falls back to its timestamp.
    truncateJournal(bootDir('ancient'), 22)
    for (const tag of ['0022_views', '0023_drop_lists']) {
      rmSync(path.join(bootDir('ancient'), `drizzle/${tag}.sql`))
    }

    // The "rebuilt migration": same tag and `when`, different bytes.
    const rebuilt = path.join(
      bootDir('diverged'),
      'drizzle/0023_drop_lists.sql',
    )
    writeFileSync(rebuilt, `${readFileSync(rebuilt, 'utf8')}\n-- rebuilt\n`)

    // Bring the database to the full journal *without* running the seeds, so
    // the refusal test can prove the seeds never ran.
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    const db = drizzle(testUrl)
    await migrate(db, { migrationsFolder: imageFolder })
    await db.$client.end()

    baseline = []
    for (const table of SEED_TABLES) baseline.push(await countRows(table))
  }, 120_000)

  afterAll(async () => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    if (adminUrl)
      await adminExec(`drop database if exists ${TEST_DB} with (force)`)
  })

  it('derives the same hashes drizzle recorded for the current journal', async () => {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: testUrl })
    await client.connect()
    const res = await client.query(
      `select hash, created_at from drizzle.__drizzle_migrations order by created_at asc`,
    )
    await client.end()
    const journal = readImageJournal(imageFolder)
    expect(res.rows.length).toBe(journal.length)
    expect(
      res.rows.map((r: { hash: string; created_at: string }) => ({
        hash: r.hash,
        when: Number(r.created_at),
      })),
    ).toEqual(journal.map((e) => ({ hash: e.hash, when: e.when })))
  })

  it('refuses when the database holds migrations this image lacks, and no seed runs', () => {
    const run = runMigrateScript(bootDir('old'))
    expect(run.status).toBe(1)
    const out = `${run.stdout}${run.stderr}`
    expect(out).toContain('database has 24 migrations, this image knows 20')
    expect(out).toContain('newest unknown: 0023_drop_lists')
    expect(out).toContain('Restore the backup taken before the upgrade')
    expect(out).toContain('never run against a newer schema')
    expect(out).not.toContain('[migrate] up to date')
    // Neither seed announced itself, so neither seed ran.
    expect(out).not.toContain('[attributes] seeded')
    expect(out).not.toContain('[taxonomy] seeded')
  })

  it('left the seed tables untouched — the guard ran before both seeds', async () => {
    const after: Array<number> = []
    for (const table of SEED_TABLES) after.push(await countRows(table))
    expect(after).toEqual(baseline)
  })

  it('refuses a real older checkout, naming the unknown entry by timestamp', () => {
    const run = runMigrateScript(bootDir('ancient'))
    expect(run.status).toBe(1)
    const out = `${run.stdout}${run.stderr}`
    expect(out).toContain('database has 24 migrations, this image knows 22')
    expect(out).toContain('newest unknown: applied 2026-09-11T09:30:25.129Z')
    expect(out).toContain('created_at 1789119025129')
    expect(out).toContain('Restore the backup taken before the upgrade')
    expect(out).not.toContain('[migrate] up to date')
  })

  it('refuses a rebuilt migration file, naming the tag', () => {
    const run = runMigrateScript(bootDir('diverged'))
    expect(run.status).toBe(1)
    const out = `${run.stdout}${run.stderr}`
    expect(out).toContain('database has 24 migrations, this image knows 24')
    expect(out).toContain('0023_drop_lists does not match')
    expect(out).toContain('Restore the backup taken before the upgrade')
  })

  it('proceeds and reports up to date when the journal matches', async () => {
    const run = runMigrateScript(bootDir('full'))
    expect(run.stderr).not.toContain('Restore the backup')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('[migrate] up to date')
    // ...and only now do the seeds reach the database.
    expect(run.stdout).toContain('[attributes] seeded')
    expect(await countRows('attribute')).toBeGreaterThan(baseline[1])
  }, 60_000)
})
