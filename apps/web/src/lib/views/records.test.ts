import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Condition } from '@spaces/core/views/filter'

/**
 * The consumer (SPA-40): the list page's server fn now takes the view's
 * conditions and narrows in Postgres, so a filtered list carries the rows it
 * shows and not the rows it hides.
 *
 * `listRecordsProgram` is the read `listObjectRecords` runs; the server fn
 * adds `requireUser()` and nothing else, which is why the assertion lives
 * here rather than against a fabricated request.
 */

async function fixture() {
  const { Effect } = await import('effect')
  const { createObjectProgram } =
    await import('@spaces/core/writes/attributes/object-registry')
  const { createAttributeProgram } =
    await import('@spaces/core/writes/attributes/create')
  const { db } = await import('@spaces/db')
  const { attribute, entity } = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const { eq } = await import('drizzle-orm')

  const tag = randomUUID().slice(0, 8)
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  const object = await Effect.runPromise(
    createObjectProgram({
      singular: `Fund ${tag}`,
      plural: `Funds ${tag}`,
      createdBy: actor.id,
    }),
  )
  await Effect.runPromise(
    createAttributeProgram({
      objectId: object.id,
      name: 'Stage',
      type: 'select',
      options: [{ label: 'Seed' }, { label: 'Growth' }],
      createdBy: actor.id,
    }),
  )
  await Effect.runPromise(
    createAttributeProgram({
      objectId: object.id,
      name: 'Score',
      type: 'number',
      createdBy: actor.id,
    }),
  )
  const defs = await db
    .select({
      id: attribute.id,
      slug: attribute.slug,
      options: attribute.options,
    })
    .from(attribute)
    .where(eq(attribute.objectId, object.id))
  const stage = defs.find((d) => d.slug === 'stage')
  const seed = stage?.options.options?.[0]?.id ?? 'seed'
  const growth = stage?.options.options?.[1]?.id ?? 'growth'

  // Forty records, three of them at the one stage the demo filters to.
  const rows = Array.from({ length: 40 }, (_, i) => ({
    kind: 'custom' as const,
    objectId: object.id,
    canonicalName: `Fund ${tag} ${i}`,
    values: { stage: i < 3 ? seed : growth, score: i },
  }))
  await db.insert(entity).values(rows)
  return { object, tag, seed, growth, stageId: stage?.id ?? '' }
}

describe('listObjectRecords — filtering in SQL', () => {
  it('returns only the matching rows, and everything without conditions', async () => {
    const { Effect } = await import('effect')
    const { listRecordsProgram } = await import('./records')
    const { object, seed } = await fixture()

    const all = await Effect.runPromise(listRecordsProgram(object.id, []))
    expect(all.rows).toHaveLength(40)

    const narrowed: Array<Condition> = [
      { slug: 'stage', op: 'is', value: seed },
    ]
    const some = await Effect.runPromise(
      listRecordsProgram(object.id, narrowed),
    )
    expect(some.rows).toHaveLength(3)
    expect(some.rows.every((r) => r.values.stage === seed)).toBe(true)

    // Two conditions AND, and the numeric one compares as a number.
    const both = await Effect.runPromise(
      listRecordsProgram(object.id, [
        ...narrowed,
        { slug: 'score', op: 'gt', value: 1 },
      ]),
    )
    expect(both.rows.map((r) => r.values.score)).toEqual([2])
  })

  it('ignores a condition on an archived attribute rather than emptying the list', async () => {
    const { Effect } = await import('effect')
    const { listRecordsProgram } = await import('./records')
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { object, seed, stageId } = await fixture()

    const conditions: Array<Condition> = [
      { slug: 'stage', op: 'is', value: seed },
    ]
    expect(
      (await Effect.runPromise(listRecordsProgram(object.id, conditions))).rows,
    ).toHaveLength(3)

    await db
      .update(attribute)
      .set({ archived: true })
      .where(eq(attribute.id, stageId))

    // The saved view still names `stage`; the list widens, it does not empty.
    expect(
      (await Effect.runPromise(listRecordsProgram(object.id, conditions))).rows,
    ).toHaveLength(40)
  })
})

/**
 * SPA-64. The page is a keyset window, not an offset: the cursor names the
 * last row's (sort key, id), so a record born between two fetches changes
 * what the *next* page holds but cannot make the reader see a row twice or
 * miss one they had not reached.
 */
describe('listObjectRecords — paging, sorting and counting in SQL', () => {
  it('pages on a keyset cursor: a record inserted mid-paging neither duplicates nor skips a row', async () => {
    const { Effect } = await import('effect')
    const { listRecordsProgram } = await import('./records')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { object, tag } = await fixture()

    const byName = { id: 'name', desc: false }
    const page1 = await Effect.runPromise(
      listRecordsProgram(object.id, [], { sort: byName, limit: 10 }),
    )
    expect(page1.rows).toHaveLength(10)
    expect(page1.total).toBe(40)
    expect(page1.nextCursor).not.toBeNull()

    // Sorts before every row already read — the case an offset gets wrong,
    // because it shifts page two back by one and repeats a row.
    await db.insert(entity).values({
      kind: 'custom',
      objectId: object.id,
      canonicalName: `Aardvark ${tag}`,
      values: {},
    })

    const page2 = await Effect.runPromise(
      listRecordsProgram(object.id, [], {
        sort: byName,
        limit: 10,
        cursor: page1.nextCursor,
      }),
    )
    const seen = new Set(page1.rows.map((r) => r.id))
    expect(page2.rows.filter((r) => seen.has(r.id))).toEqual([])

    // And nothing between them was passed over: walking the whole order from
    // scratch, rows 11–20 are exactly what page two returned.
    const all = await Effect.runPromise(
      listRecordsProgram(object.id, [], { sort: byName, limit: 200 }),
    )
    expect(all.rows).toHaveLength(41)
    expect(all.rows[0].name).toBe(`Aardvark ${tag}`)
    expect(all.rows.slice(1, 11).map((r) => r.id)).toEqual(
      page1.rows.map((r) => r.id),
    )
    expect(page2.rows.map((r) => r.id)).toEqual(
      all.rows.slice(11, 21).map((r) => r.id),
    )
    // The newcomer is the one row the paging reader never sees, which is the
    // point: it arrived behind them. The count already knows about it.
    expect(page2.total).toBe(41)
  })

  it('counts every matching row, not the loaded ones, and narrows with the conditions', async () => {
    const { Effect } = await import('effect')
    const { listRecordsProgram } = await import('./records')
    const { object, seed } = await fixture()

    const firstOfForty = await Effect.runPromise(
      listRecordsProgram(object.id, [], { limit: 5 }),
    )
    expect(firstOfForty.rows).toHaveLength(5)
    expect(firstOfForty.total).toBe(40)

    const narrowed: Array<Condition> = [
      { slug: 'stage', op: 'is', value: seed },
    ]
    const some = await Effect.runPromise(
      listRecordsProgram(object.id, narrowed, { limit: 2 }),
    )
    expect(some.rows).toHaveLength(2)
    // The foot would otherwise read "2 of 40" and both numbers would lie.
    expect(some.total).toBe(3)
    expect(some.nextCursor).not.toBeNull()

    const last = await Effect.runPromise(
      listRecordsProgram(object.id, narrowed, {
        limit: 2,
        cursor: some.nextCursor,
      }),
    )
    expect(last.rows).toHaveLength(1)
    expect(last.total).toBe(3)
    expect(last.nextCursor).toBeNull()
  })

  it('sorts by an attribute in SQL, nulls last in both directions and across a page boundary', async () => {
    const { Effect } = await import('effect')
    const { listRecordsProgram } = await import('./records')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { object, tag, growth } = await fixture()

    // Five records with no Score at all: the null tail the order has to put
    // last whichever way it runs.
    await db.insert(entity).values(
      Array.from({ length: 5 }, (_, i) => ({
        kind: 'custom' as const,
        objectId: object.id,
        canonicalName: `Unscored ${tag} ${i}`,
        values: { stage: growth },
      })),
    )

    // 42 of 45, so the boundary falls inside the null tail and page two's
    // cursor carries a null key rather than a value.
    const asc1 = await Effect.runPromise(
      listRecordsProgram(object.id, [], {
        sort: { id: 'attr:score', desc: false },
        limit: 42,
      }),
    )
    expect(asc1.total).toBe(45)
    expect(asc1.rows.slice(0, 40).map((r) => r.values.score)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    )
    expect(asc1.rows.slice(40).map((r) => r.values.score)).toEqual([
      undefined,
      undefined,
    ])
    const asc2 = await Effect.runPromise(
      listRecordsProgram(object.id, [], {
        sort: { id: 'attr:score', desc: false },
        limit: 42,
        cursor: asc1.nextCursor,
      }),
    )
    expect(asc2.rows).toHaveLength(3)
    expect(asc2.nextCursor).toBeNull()
    expect(asc2.rows.every((r) => !Object.hasOwn(r.values, 'score'))).toBe(true)
    const seen = new Set(asc1.rows.map((r) => r.id))
    expect(asc2.rows.filter((r) => seen.has(r.id))).toEqual([])

    // Descending: numeric, not lexical (39 before 9), and the nulls still
    // sort last rather than jumping to the front the way SQL defaults.
    const desc1 = await Effect.runPromise(
      listRecordsProgram(object.id, [], {
        sort: { id: 'attr:score', desc: true },
        limit: 42,
      }),
    )
    expect(desc1.rows.slice(0, 40).map((r) => r.values.score)).toEqual(
      Array.from({ length: 40 }, (_, i) => 39 - i),
    )
    expect(desc1.rows.slice(40).map((r) => r.values.score)).toEqual([
      undefined,
      undefined,
    ])
    const desc2 = await Effect.runPromise(
      listRecordsProgram(object.id, [], {
        sort: { id: 'attr:score', desc: true },
        limit: 42,
        cursor: desc1.nextCursor,
      }),
    )
    expect(desc2.rows).toHaveLength(3)
    expect(desc2.rows.every((r) => !Object.hasOwn(r.values, 'score'))).toBe(
      true,
    )
  })

  it('narrows on the text box with a case-insensitive ILIKE on the name, and counts that too', async () => {
    const { Effect } = await import('effect')
    const { listRecordsProgram } = await import('./records')
    const { object, tag, seed } = await fixture()

    const all = await Effect.runPromise(
      listRecordsProgram(object.id, [], { q: 'fUnD', limit: 200 }),
    )
    expect(all.rows).toHaveLength(40)

    // `Fund <tag> 1`, plus 10 through 19.
    const ones = await Effect.runPromise(
      listRecordsProgram(object.id, [], { q: `Fund ${tag} 1`, limit: 200 }),
    )
    expect(ones.rows).toHaveLength(11)
    expect(ones.total).toBe(11)

    // It composes with the view's conditions rather than replacing them.
    const both = await Effect.runPromise(
      listRecordsProgram(
        object.id,
        [{ slug: 'stage', op: 'is', value: seed }],
        {
          q: `Fund ${tag} 1`,
          limit: 200,
        },
      ),
    )
    expect(both.rows).toHaveLength(1)
    expect(both.total).toBe(1)

    // `%` is a character the reader typed, not syntax that matches every row.
    const literal = await Effect.runPromise(
      listRecordsProgram(object.id, [], { q: '%', limit: 200 }),
    )
    expect(literal.rows).toEqual([])
    expect(literal.total).toBe(0)
  })
})
