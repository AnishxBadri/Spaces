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
import { readImageJournal } from '@spaces/db/downgrade-guard'
import { MIGRATIONS_FOLDER } from '@spaces/db/migrate'

/**
 * The boot composition, end to end (SPA-36, re-sited by SPA-142).
 *
 * The guard's own unit tests live with the guard, in
 * `packages/db/src/downgrade-guard.test.ts`. What is proven *here* is the
 * ordering that only the app can compose: migrate first, and the two seeds
 * only if migrate was allowed to run. So it needs a Postgres it can create a
 * database on — a throwaway beside the one DATABASE_URL names, migrated with
 * the full journal, then booted by `src/db/boot.ts` exactly as the container
 * entrypoint boots it.
 */

const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const bootEntry = path.join(webRoot, 'src/db/boot.ts')
const imageFolder = MIGRATIONS_FOLDER

const TEST_DB = 'spa36_downgrade_guard'

describe('db/boot.ts (real database)', () => {
  let adminUrl = ''
  let testUrl = ''
  let tmpRoot = ''
  // Row counts straight after the bare migration — some migrations insert
  // rows of their own, so "the seeds did not run" means "unchanged from here".
  const SEED_TABLES = ['object', 'attribute', 'entity']
  let baseline: Array<number> = []

  // Derived, never hard-coded: every migration-bearing slice adds an entry,
  // and a literal count here would turn each one into a red suite that says
  // nothing about the guard.
  const journal = readImageJournal(imageFolder)
  const TOTAL = journal.length
  // Where the two truncated fixtures cut the journal.
  const OLD_KEEPS = 20
  const ANCIENT_KEEPS = 22
  // The newest journal entry is what both truncated fixtures fail to know.
  const NEWEST = journal[TOTAL - 1]

  const fixtureFolder = (name: string) => path.join(tmpRoot, name, 'drizzle')

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

  /**
   * Boot the app's entry the way the entrypoint does. `migrationsFolder` is
   * the fixture's journal, handed over on argv — since SPA-142 the folder is
   * resolved from `import.meta.url` inside the package, so varying the cwd
   * no longer varies the journal, and a fixture has to say which one it
   * means. `cwd` defaults to a directory that is not the repo, which is the
   * point of the criterion the last test in this block checks.
   */
  function runBoot(options?: { migrationsFolder?: string; cwd?: string }) {
    return spawnSync(
      path.join(webRoot, 'node_modules/.bin/tsx'),
      [
        // tsx resolves the `#/` alias from tsconfig `paths`, not from
        // package.json `imports`, and this runs from outside the package.
        '--tsconfig',
        path.join(webRoot, 'tsconfig.json'),
        bootEntry,
        ...(options?.migrationsFolder ? [options.migrationsFolder] : []),
      ],
      {
        cwd: options?.cwd ?? tmpRoot,
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

    // One `drizzle/` folder per fixture, each holding the journal a given
    // image would ship.
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'spa36-'))
    for (const name of ['old', 'ancient', 'diverged']) {
      cpSync(imageFolder, fixtureFolder(name), { recursive: true })
    }

    const truncateJournal = (folder: string, keep: number) => {
      const journalPath = path.join(folder, 'meta/_journal.json')
      const parsed: { entries: Array<unknown> } = JSON.parse(
        readFileSync(journalPath, 'utf8'),
      )
      parsed.entries = parsed.entries.slice(0, keep)
      writeFileSync(journalPath, JSON.stringify(parsed, null, 2))
    }

    // The "older image": a journal truncated to 20 of the entries, with the
    // .sql files still present — so the refusal can name the tag.
    truncateJournal(fixtureFolder('old'), OLD_KEEPS)

    // The genuinely older checkout: the journal stops short and every later
    // .sql file is absent from the image, so nothing on disk can name the
    // unknown entry and the refusal falls back to its timestamp.
    truncateJournal(fixtureFolder('ancient'), ANCIENT_KEEPS)
    for (const entry of journal.slice(ANCIENT_KEEPS)) {
      rmSync(path.join(fixtureFolder('ancient'), `${entry.tag}.sql`))
    }

    // The "rebuilt migration": same tag and `when`, different bytes.
    const rebuilt = path.join(fixtureFolder('diverged'), '0023_drop_lists.sql')
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
    expect(res.rows.length).toBe(TOTAL)
    expect(
      res.rows.map((r: { hash: string; created_at: string }) => ({
        hash: r.hash,
        when: Number(r.created_at),
      })),
    ).toEqual(journal.map((e) => ({ hash: e.hash, when: e.when })))
  })

  it('refuses when the database holds migrations this image lacks, and no seed runs', () => {
    const run = runBoot({ migrationsFolder: fixtureFolder('old') })
    expect(run.status).toBe(1)
    const out = `${run.stdout}${run.stderr}`
    expect(out).toContain(
      `database has ${TOTAL} migrations, this image knows ${OLD_KEEPS}`,
    )
    expect(out).toContain(`newest unknown: ${NEWEST.tag}`)
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
    const run = runBoot({ migrationsFolder: fixtureFolder('ancient') })
    expect(run.status).toBe(1)
    const out = `${run.stdout}${run.stderr}`
    expect(out).toContain(
      `database has ${TOTAL} migrations, this image knows ${ANCIENT_KEEPS}`,
    )
    expect(out).toContain(
      `newest unknown: applied ${new Date(NEWEST.when).toISOString()}`,
    )
    expect(out).toContain(`created_at ${NEWEST.when}`)
    expect(out).toContain('Restore the backup taken before the upgrade')
    expect(out).not.toContain('[migrate] up to date')
  })

  it('refuses a rebuilt migration file, naming the tag', () => {
    const run = runBoot({ migrationsFolder: fixtureFolder('diverged') })
    expect(run.status).toBe(1)
    const out = `${run.stdout}${run.stderr}`
    expect(out).toContain(
      `database has ${TOTAL} migrations, this image knows ${TOTAL}`,
    )
    expect(out).toContain('0023_drop_lists does not match')
    expect(out).toContain('Restore the backup taken before the upgrade')
  })

  /**
   * The criterion the folder move turns on: booted from a directory that is
   * neither the repo nor anywhere near the journal, and told nothing about
   * where the journal is, it still finds it — because `@spaces/db` resolves
   * it from `import.meta.url`. Before SPA-142 the same run read `./drizzle`
   * relative to this cwd and found nothing.
   */
  it('boots from an unrelated cwd with no folder argument, and seeds', async () => {
    const run = runBoot({ cwd: tmpdir() })
    expect(run.stderr).not.toContain('Restore the backup')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('[migrate] up to date')
    // ...and only now do the seeds reach the database.
    expect(run.stdout).toContain('[attributes] seeded')
    expect(await countRows('attribute')).toBeGreaterThan(baseline[1])
  }, 60_000)
})
