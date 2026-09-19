import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDowngrade, readImageJournal } from './downgrade-guard'
import { MIGRATIONS_FOLDER } from './migrate'

/**
 * The guard's own tests: the pure comparison, and the journal read against
 * this package's real `drizzle/` folder. Neither needs a database.
 *
 * The end-to-end half — an image booted against a truncated journal, refusing
 * before either seed runs — lives in `apps/web/src/db/boot.test.ts`, because
 * what it proves is the *ordering of the boot composition*, and the
 * composition is the app's (SPA-142). This package has no seeds to run.
 */

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
    const journal = readImageJournal(MIGRATIONS_FOLDER)
    const raw: { entries: Array<{ tag: string; when: number }> } = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    )
    expect(journal.map((e) => e.tag)).toEqual(raw.entries.map((e) => e.tag))
    expect(journal.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true)
  })

  /**
   * The cwd trap, as a test. `MIGRATIONS_FOLDER` is resolved from
   * `import.meta.url`, so it is absolute and reading it does not depend on
   * where the process was started — which is the property that let the
   * folder move from apps/web to packages/db without the journal moving with
   * the caller (SPA-142).
   */
  it('resolves the migrations folder absolutely, not against cwd', () => {
    expect(path.isAbsolute(MIGRATIONS_FOLDER)).toBe(true)
    expect(readImageJournal(MIGRATIONS_FOLDER).length).toBeGreaterThan(0)
  })
})
