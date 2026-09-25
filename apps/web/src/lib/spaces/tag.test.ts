import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SPA-103's "no second write path to entity_space", held by grep: the
 * `tagIntoSpace` server fn and the `space_tag` accept branch both reach the
 * table through `insertSpaceTag` (`./tag.ts`), and neither spells an insert
 * of its own.
 *
 * The allowlist below is every production module that inserts into
 * `entity_space` today. Only `./tag.ts` *tags* a record; the other three
 * *file* something at birth or on a refile — a document filed where it was
 * dropped, a note written while standing in a space — and are not a person
 * or a model placing a record in the tree. A fourth module inserting here
 * fails this test until it is either routed through `insertSpaceTag` or
 * added below with its reason.
 */

const SRC = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const INSERT = /\.insert\(\s*entitySpace\s*\)/

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

describe('one entity_space insert for tagging', () => {
  it('tagIntoSpace calls insertSpaceTag and inserts nothing itself', () => {
    const src = read('lib/server/companies.ts')
    const start = src.indexOf('export const tagIntoSpace')
    const end = src.indexOf('export const untagFromSpace')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, end)
    expect(body).toContain('insertSpaceTag(')
    expect(body).not.toMatch(INSERT)
    expect(src).not.toMatch(INSERT)
  })

  it('accept() has exactly one space_tag branch, and it calls insertSpaceTag', () => {
    const src = read('lib/ai/propose.ts')
    expect(src.match(/row\.kind === 'space_tag'/g)).toHaveLength(1)
    expect(src.match(/insertSpaceTag\(/g)).toHaveLength(1)
    expect(src).not.toMatch(INSERT)
  })

  it('the only production modules inserting into entity_space are the known ones', () => {
    const inserting = walk(SRC)
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes('/seeds/'))
      .filter((f) => INSERT.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .sort()
    expect(inserting).toEqual([
      'lib/documents/birth.ts',
      'lib/documents/refile.ts',
      'lib/notes/create.ts',
      'lib/spaces/tag.ts',
    ])
  })
})
