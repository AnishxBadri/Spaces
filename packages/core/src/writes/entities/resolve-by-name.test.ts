import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { previewResolveByName, resolveEntity } from './resolve'

/**
 * `previewResolveByName`, the match-only name lane: exact → attach, close →
 * candidates, nothing → no match, and never a row written on any of them.
 */

const company = async (name: string, domain?: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      ...(domain === undefined ? {} : { keys: { domain } }),
      source: { class: 'manual' },
    })
  ).entityId

/** Rows in every table a resolve or a sweep can write. */
const rowCounts = async () => {
  const result = await db.execute<{
    entities: number
    aliases: number
    pairs: number
    suggestions: number
    events: number
  }>(sql`select
    (select count(*)::int from entity) as entities,
    (select count(*)::int from entity_alias) as aliases,
    (select count(*)::int from duplicate_candidate) as pairs,
    (select count(*)::int from suggestion) as suggestions,
    (select count(*)::int from attribute_event) as events`)
  return result.rows.at(0)
}

describe('previewResolveByName', () => {
  it('attaches on one exact normalised name, and writes nothing', async () => {
    const sunfire = await company('Sunfire GmbH')
    const before = await rowCounts()
    expect(
      await previewResolveByName({ kind: 'company', name: 'SUNFIRE' }),
    ).toEqual({
      verdict: 'attach',
      entityId: sunfire,
      matchedOn: { kind: 'name', value: 'sunfire' },
    })
    expect(await rowCounts()).toEqual(before)
  })

  it('a typo is fuzzy with the candidate, and inserts nothing', async () => {
    const ohmium = await company('Ohmium')
    const before = await rowCounts()
    const found = await previewResolveByName({ kind: 'company', name: 'Ohium' })
    expect(found.verdict).toBe('fuzzy')
    if (found.verdict !== 'fuzzy') return
    expect(found.candidates.map((c) => c.entityId)).toEqual([ohmium])
    expect(found.candidates.at(0)?.name).toBe('Ohmium')
    expect(found.candidates.at(0)?.score).toBeCloseTo(0.44, 2)
    expect(await rowCounts()).toEqual(before)
  })

  it('no match inserts nothing', async () => {
    const before = await rowCounts()
    expect(
      await previewResolveByName({ kind: 'company', name: 'Electrolysers' }),
    ).toEqual({ verdict: 'no_match' })
    expect(await rowCounts()).toEqual(before)
  })

  it('two records holding the exact name are candidates, never a guess', async () => {
    const first = await company('Twin Energy', 'twin-one.example')
    const second = await company('Twin Energy', 'twin-two.example')
    const found = await previewResolveByName({
      kind: 'company',
      name: 'twin energy',
    })
    expect(found.verdict).toBe('fuzzy')
    if (found.verdict !== 'fuzzy') return
    expect(found.candidates.map((c) => c.entityId).sort()).toEqual(
      [first, second].sort(),
    )
  })

  it('an identity key still attaches first', async () => {
    const held = await company('Keyed', 'keyed.example')
    expect(
      await previewResolveByName({
        kind: 'company',
        name: 'Something else',
        keys: { domain: 'https://keyed.example/' },
      }),
    ).toMatchObject({ verdict: 'attach', entityId: held })
  })
})
