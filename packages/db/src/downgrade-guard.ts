import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { z } from 'zod'

/**
 * Downgrade guard — an image refuses a database from the future.
 *
 * - Drizzle's `migrate()` treats unknown applied migrations as nothing to do,
 *   so old code would start against a new schema; `runMigrations` asks this first.
 * - Contract 5 (CONTEXT.md, hostability): "Never run an older image against
 *   a newer schema." There is deliberately no override.
 * - `drizzle.__drizzle_migrations` stores `hash` and `created_at` (the
 *   journal's `when`), never the tag, so `when` is the join key.
 */

export type JournalEntry = { tag: string; when: number; hash: string }
export type AppliedMigration = { hash: string; createdAt: number }

export type SqlQuery = (
  text: string,
) => Promise<{ rows: Array<Record<string, unknown>> }>

export type DowngradeVerdict =
  | { kind: 'ok'; applied: number; known: number }
  | { kind: 'refuse'; message: string }

const REMEDY =
  'Restore the backup taken before the upgrade. An older image must never ' +
  'run against a newer schema, and there is no override.'

/** The journal is data crossing a boundary, so it is decoded, not trusted. */
const journalSchema = z.object({
  entries: z.array(z.object({ when: z.number(), tag: z.string() })),
})

/**
 * The image's journal, tag included.
 * - Hashes come from drizzle's own `readMigrationFiles`, so the guard and the
 *   migrator can never disagree about what a migration hashes to.
 * - The journal supplies the tag `readMigrationFiles` drops; both walk
 *   `journal.entries` in order, so index i lines up.
 */
export function readImageJournal(
  migrationsFolder: string,
): Array<JournalEntry> {
  const raw = readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')
  const journal = journalSchema.parse(JSON.parse(raw))
  const files = readMigrationFiles({ migrationsFolder })
  return journal.entries.map((entry, i) => {
    const file = files.at(i)
    if (!file)
      throw new Error(
        `[migrate] journal entry ${entry.tag} has no migration file`,
      )
    return { tag: entry.tag, when: entry.when, hash: file.hash }
  })
}

/**
 * Hashes of .sql files sitting in the migrations folder that the journal does
 * not list — a truncated or hand-edited journal leaves these behind. When an
 * unrecognised database row matches one, the refusal can name a tag instead
 * of only a timestamp. A genuinely older image has neither the entry nor the
 * file, and the message falls back to the timestamp.
 */
export function orphanTagsByHash(
  migrationsFolder: string,
  journal: Array<JournalEntry>,
): Map<string, string> {
  const known = new Set(journal.map((e) => e.tag))
  const out = new Map<string, string>()
  for (const name of readdirSync(migrationsFolder)) {
    if (!name.endsWith('.sql')) continue
    const tag = name.slice(0, -'.sql'.length)
    if (known.has(tag)) continue
    const sql = readFileSync(`${migrationsFolder}/${name}`, 'utf8')
    out.set(createHash('sha256').update(sql).digest('hex'), tag)
  }
  return out
}

/**
 * The rows drizzle has recorded, oldest first. `null` means the migrations
 * table does not exist yet — a fresh database, nothing to compare.
 */
export async function readAppliedMigrations(
  query: SqlQuery,
): Promise<Array<AppliedMigration> | null> {
  const present = await query(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  )
  if (present.rows.at(0)?.present !== true) return null
  const result = await query(
    `select hash, created_at from drizzle.__drizzle_migrations order by created_at asc`,
  )
  return result.rows.map((row) => ({
    hash: String(row.hash),
    createdAt: Number(row.created_at),
  }))
}

const short = (hash: string) => hash.slice(0, 12)

/** Pure comparison — the whole decision, testable without a database. */
export function checkDowngrade(args: {
  image: Array<JournalEntry>
  applied: Array<AppliedMigration>
  orphanTags?: Map<string, string>
}): DowngradeVerdict {
  const { image, applied } = args
  const byWhen = new Map(image.map((e) => [e.when, e]))
  const counts = `database has ${applied.length} migrations, this image knows ${image.length}`

  const unknown = applied
    .filter((row) => !byWhen.has(row.createdAt))
    .sort((a, b) => a.createdAt - b.createdAt)
  const newest = unknown.at(-1)
  if (newest) {
    const tag = args.orphanTags?.get(newest.hash)
    const named = tag
      ? tag
      : `applied ${new Date(newest.createdAt).toISOString()} (created_at ${newest.createdAt}, hash ${short(newest.hash)})`
    return {
      kind: 'refuse',
      message:
        `[migrate] ${counts} — newest unknown: ${named}. ${REMEDY}\n` +
        `[migrate] ${unknown.length} of the database's migrations are not in this image's journal.`,
    }
  }

  // Same `when`, different bytes: a migration file rebuilt after it shipped.
  const diverged: Array<{ entry: JournalEntry; row: AppliedMigration }> = []
  for (const row of applied) {
    const entry = byWhen.get(row.createdAt)
    if (entry && entry.hash !== row.hash) diverged.push({ entry, row })
  }
  diverged.sort((a, b) => a.row.createdAt - b.row.createdAt)
  const worst = diverged.at(-1)
  if (worst) {
    return {
      kind: 'refuse',
      message:
        `[migrate] ${counts} — migration ${worst.entry.tag} does not match: the database recorded hash ${short(worst.row.hash)}, this image has ${short(worst.entry.hash)}. ${REMEDY}\n` +
        `[migrate] ${diverged.length} recorded migration(s) were rebuilt or replaced in this image.`,
    }
  }

  return { kind: 'ok', applied: applied.length, known: image.length }
}

/**
 * The call `runMigrations` makes: read both sides, decide. A fresh database (no
 * migrations table) is always ok.
 */
export async function inspectDowngrade(
  query: SqlQuery,
  migrationsFolder: string,
): Promise<DowngradeVerdict> {
  const image = readImageJournal(migrationsFolder)
  const applied = await readAppliedMigrations(query)
  if (applied === null) return { kind: 'ok', applied: 0, known: image.length }
  return checkDowngrade({
    image,
    applied,
    orphanTags: orphanTagsByHash(migrationsFolder, image),
  })
}
