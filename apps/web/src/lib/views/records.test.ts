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
  const { createObjectProgram } = await import('../attributes/object-registry')
  const { createAttributeProgram } = await import('../attributes/create')
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
