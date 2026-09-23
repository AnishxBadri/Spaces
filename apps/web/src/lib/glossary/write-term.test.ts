import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Writing a term diff-syncs its aliases into `entity_alias(kind: 'name',
 * source_class: 'manual')` (SPA-75), the table Cmd-K's `name_hits` lane
 * already reads — so an abbreviation finds its term without the fused query
 * changing. Run through the programs `createTerm` / `updateTerm` call, not a
 * helper beside them. Imports are dynamic: `@spaces/db` builds its pool from
 * `DATABASE_URL`, which `vitest.setup.ts` rewrites per file.
 */

async function deps() {
  const { and, asc, eq } = await import('drizzle-orm')
  const { db } = await import('@spaces/db')
  const { entityAlias, term } = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const { createTermProgram, updateTermProgram } = await import('./write-term')
  const { searchAllProgram } = await import('#/lib/search/query')

  const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!me) throw new Error('the test seed has no user')

  const create = (name: string, aliases: Array<string>) =>
    Effect.runPromise(
      createTermProgram(me.id, {
        name,
        aliases,
        definitionMd: '',
        spaceId: null,
      }),
    )
  const update = (patch: Parameters<typeof updateTermProgram>[0]) =>
    Effect.runPromise(updateTermProgram(patch))

  const aliasRows = (entityId: string) =>
    db
      .select({
        kind: entityAlias.kind,
        value: entityAlias.value,
        valueNorm: entityAlias.valueNorm,
        sourceClass: entityAlias.sourceClass,
        isIdentity: entityAlias.isIdentity,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, entityId))
      .orderBy(asc(entityAlias.valueNorm))

  const aliasIds = (entityId: string) =>
    db
      .select({ id: entityAlias.id, valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(eq(entityAlias.entityId, entityId), eq(entityAlias.kind, 'name')),
      )
      .orderBy(asc(entityAlias.valueNorm))

  const search = (q: string) =>
    Effect.runPromise(searchAllProgram({ userId: me.id, q }))

  const termRow = async (id: string) =>
    (
      await db
        .select({ name: term.name, aliases: term.aliases })
        .from(term)
        .where(eq(term.entityId, id))
    ).at(0)

  return {
    db,
    entityAlias,
    create,
    update,
    aliasRows,
    aliasIds,
    search,
    termRow,
  }
}

describe('term alias sync', () => {
  it('writes each alias as a manual, non-identity name alias, once per normalized form', async () => {
    const d = await deps()
    const { id } = await d.create('Power Usage Effectiveness', [
      'PUE',
      'pue',
      'Data-hall PUE',
    ])

    expect(await d.aliasRows(id)).toEqual([
      {
        kind: 'name',
        value: 'Data-hall PUE',
        valueNorm: 'data hall pue',
        sourceClass: 'manual',
        isIdentity: false,
      },
      {
        kind: 'name',
        value: 'PUE',
        valueNorm: 'pue',
        sourceClass: 'manual',
        isIdentity: false,
      },
    ])
    expect(await d.termRow(id)).toEqual({
      name: 'Power Usage Effectiveness',
      aliases: ['PUE', 'pue', 'Data-hall PUE'],
    })
  })

  it('finds the term by its abbreviation through the name lane', async () => {
    const d = await deps()
    const { id } = await d.create('Levelized cost of hydrogen', ['LCOH'])

    const hit = (await d.search('LCOH')).find((h) => h.id === id)
    expect(hit).toMatchObject({
      rowKind: 'entity',
      kind: 'term',
      name: 'Levelized cost of hydrogen',
      matchedIn: 'name',
    })
  })

  it('renaming an alias removes the stale row, adds the new one, and leaves the unchanged row as it was', async () => {
    const d = await deps()
    const { id } = await d.create('Round-trip efficiency', ['RTE', 'AC-AC'])
    const before = await d.aliasIds(id)
    const keep = before.find((r) => r.valueNorm === 'rte')

    await d.update({ id, aliases: ['RTE', 'Roundtrip'] })

    const after = await d.aliasIds(id)
    expect(after.map((r) => r.valueNorm)).toEqual(['roundtrip', 'rte'])
    // Diffed, not rewritten: the surviving alias is the same row.
    expect(after.find((r) => r.valueNorm === 'rte')?.id).toBe(keep?.id)
    expect((await d.search('AC-AC')).some((h) => h.id === id)).toBe(false)
    expect((await d.search('Roundtrip')).some((h) => h.id === id)).toBe(true)
  })

  it('touches no alias of another source class, and a patch without aliases touches none at all', async () => {
    const d = await deps()
    const { id } = await d.create('Capacity factor', ['CF'])
    // A row the sync does not own: an imported name alias.
    await d.db.insert(d.entityAlias).values({
      entityId: id,
      kind: 'name',
      value: 'Load factor',
      valueNorm: 'load factor',
      isIdentity: false,
      sourceClass: 'import',
    })

    await d.update({ id, definitionMd: 'Output over nameplate.' })
    expect((await d.aliasRows(id)).map((r) => r.valueNorm)).toEqual([
      'cf',
      'load factor',
    ])

    await d.update({ id, aliases: [] })
    expect(await d.aliasRows(id)).toEqual([
      {
        kind: 'name',
        value: 'Load factor',
        valueNorm: 'load factor',
        sourceClass: 'import',
        isIdentity: false,
      },
    ])
  })
})
