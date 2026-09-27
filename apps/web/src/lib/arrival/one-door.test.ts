import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SPA-86's "one entry gate", held by grep: nothing under `lib/arrival/`
 * inserts into `entity` or `entity_alias` itself. People and companies
 * arrive through `resolveEntity` (`participant-records.ts`), whose collision
 * door is the only place an identity key is ever claimed; the body note
 * through `lib/notes/body-note.ts`.
 *
 * Production modules only. The tests build the graph an arrival reads —
 * a company that already holds a domain, a deal on it — and that fixture
 * work is not the lane writing records.
 */

const DIR = import.meta.dirname
const INSERT = /\.insert\(\s*(?:entity|entityAlias)\s*\)/
const RAW_SQL = /insert\s+into\s+"?(?:entity|entity_alias)"?[\s(]/i

function walk(dir: string): Array<string> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

describe('arrival has one door into the graph', () => {
  const sources = walk(DIR).filter((f) => !/\.test\.tsx?$/.test(f))

  it('reads the modules it means to', () => {
    const names = sources.map((f) => relative(DIR, f))
    expect(names).toContain('file.ts')
    expect(names).toContain('participant-records.ts')
  })

  it('no production module inserts into entity or entity_alias', () => {
    const offenders = sources
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
        return INSERT.test(src) || RAW_SQL.test(src)
      })
      .map((f) => relative(DIR, f))
    expect(offenders).toEqual([])
  })

  it('creates through resolveEntity, with the mailbox as the source', () => {
    const src = readFileSync(join(DIR, 'participant-records.ts'), 'utf8')
    expect(src.match(/resolveEntity\(/g)?.length).toBe(2)
    expect(src).toMatch(/class: 'integration',\s*ref: ctx\.integrationId/)
  })

  it('the patterns catch what they are for', () => {
    expect(INSERT.test('await tx.insert(entity).values({})')).toBe(true)
    expect(INSERT.test('db.insert( entityAlias )')).toBe(true)
    expect(INSERT.test('tx.insert(entitySpace)')).toBe(false)
    expect(RAW_SQL.test('INSERT INTO entity_alias (kind)')).toBe(true)
    expect(RAW_SQL.test('insert into "entity" (id)')).toBe(true)
    expect(RAW_SQL.test('insert into entity_space (id)')).toBe(false)
  })
})
