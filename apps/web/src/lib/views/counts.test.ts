import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  OP_LABELS,
  isUnary,
  matchesConditions,
} from '@spaces/core/views/filter'
import {
  FILTER_FIXTURE_ATTRIBUTES,
  FILTER_FIXTURE_ROWS,
  fixtureTypeOf,
} from '@spaces/core/views/filter.fixtures'
import type { Condition, ConditionOp } from '@spaces/core/views/filter'

/**
 * The chip counts (SPA-162) against the client evaluator: a saved view per
 * (attribute, op, probe) over `sql.test.ts`'s fixture rows, all counted in
 * one `countViewsProgram` call, and each count must equal the number of rows
 * `matchesConditions` keeps. That is the assertion that the count is the list
 * page's own predicate — `compileConditions` over the live registry — and
 * not a second filter semantics.
 *
 * The fixture list's `json` attribute (`misc`) is the one type the
 * `attribute_type` enum cannot store, so it has no registry row here;
 * `sql.test.ts` covers it through a hand-built registry. Every op is still
 * walked over every other type.
 */

let objectId = ''
let userId = ''

/** How many fixture rows the browser's evaluator keeps. */
const expected = (conditions: Array<Condition>) =>
  FILTER_FIXTURE_ROWS.filter((r) =>
    matchesConditions(r.values, conditions, fixtureTypeOf),
  ).length

async function saveViews(
  filters: Array<Array<Condition>>,
): Promise<Array<string>> {
  if (filters.length === 0) return []
  const { db } = await import('@spaces/db')
  const { view } = await import('@spaces/db/schema')
  const rows = await db
    .insert(view)
    .values(
      filters.map((filter, i) => ({
        surface: 'object' as const,
        objectId,
        name: `View ${i}`,
        filter,
        visibility: 'shared' as const,
        createdBy: userId,
      })),
    )
    .returning({ id: view.id })
  return rows.map((r) => r.id)
}

async function count(
  ids: Array<string>,
  live?: { viewId: string; filter: Array<Condition> },
) {
  const { Effect } = await import('effect')
  const { countViewsProgram } = await import('./counts')
  return Effect.runPromise(countViewsProgram(objectId, ids, userId, live))
}

beforeAll(async () => {
  const { db } = await import('@spaces/db')
  const { attribute, attributeType, entity, objectDef } =
    await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const tag = randomUUID().slice(0, 8)
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  userId = actor.id
  const [obj] = await db
    .insert(objectDef)
    .values({
      slug: `fixtures-${tag}`,
      singular: `Fixture ${tag}`,
      plural: `Fixtures ${tag}`,
    })
    .returning({ id: objectDef.id })
  objectId = obj.id
  await db.insert(attribute).values(
    FILTER_FIXTURE_ATTRIBUTES.flatMap((a) => {
      const type = attributeType.enumValues.find((t) => t === a.type)
      return type ? [{ objectId, slug: a.slug, name: a.slug, type }] : []
    }),
  )
  await db.insert(entity).values(
    FILTER_FIXTURE_ROWS.map((r) => ({
      kind: 'custom' as const,
      objectId,
      canonicalName: `${r.key} ${tag}`,
      values: r.values,
    })),
  )
})

/** Spelled out, so a new op in `OP_LABELS` fails here until it is walked. */
const ALL_OPS: Array<ConditionOp> = [
  'is',
  'is_not',
  'contains',
  'empty',
  'not_empty',
  'gt',
  'lt',
]

describe('countViewsProgram agrees with matchesConditions', () => {
  it('counts every op OP_LABELS names, over every storable type', async () => {
    const { attributeType } = await import('@spaces/db/schema')
    expect([...ALL_OPS].sort()).toEqual(Object.keys(OP_LABELS).sort())

    const filters: Array<Array<Condition>> = []
    for (const a of FILTER_FIXTURE_ATTRIBUTES) {
      if (!attributeType.enumValues.some((t) => t === a.type)) continue
      for (const op of ALL_OPS)
        for (const value of isUnary(op) ? [null] : a.probes)
          filters.push([
            isUnary(op) ? { slug: a.slug, op } : { slug: a.slug, op, value },
          ])
    }
    // Two ANDed conditions and the empty filter, alongside the singles.
    filters.push(
      [
        { slug: 'stage', op: 'is', value: 'seed' },
        { slug: 'stars', op: 'gt', value: 2 },
        { slug: 'note', op: 'contains', value: 'imaging' },
      ],
      [],
    )
    const ids = await saveViews(filters)
    const counts = await count(ids)

    // Every op was walked at least once.
    expect(new Set(filters.flat().map((c) => c.op))).toEqual(new Set(ALL_OPS))
    filters.forEach((filter, i) => {
      expect(counts[ids[i]], JSON.stringify(filter)).toEqual({
        count: expected(filter),
      })
    })
    expect(counts[ids[ids.length - 1]]).toEqual({
      count: FILTER_FIXTURE_ROWS.length,
    })
  })
})

describe('a view the compiler cannot express', () => {
  it('has no count, never one from a partial where, and says why', async () => {
    const [ghost, mixed] = await saveViews([
      [{ slug: 'ghost', op: 'is', value: 'x' }],
      // `note contains imaging` alone would count 2 — the partial answer.
      [
        { slug: 'ghost', op: 'is', value: 'x' },
        { slug: 'note', op: 'contains', value: 'imaging' },
      ],
    ])
    const counts = await count([ghost, mixed])
    expect(counts[ghost]).toEqual({
      count: null,
      reason: expect.stringContaining('ghost'),
    })
    expect(counts[mixed].count).toBeNull()
  })

  it('names an archived attribute rather than widening past it', async () => {
    const { db } = await import('@spaces/db')
    const { attribute, objectDef, entity } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    // A second object of its own, so archiving does not reach the matrix.
    const tag = randomUUID().slice(0, 8)
    const [obj] = await db
      .insert(objectDef)
      .values({ slug: `arch-${tag}`, singular: 'Arch', plural: `Arch ${tag}` })
      .returning({ id: objectDef.id })
    await db
      .insert(attribute)
      .values({ objectId: obj.id, slug: 'stage', name: 'Stage', type: 'text' })
    await db.insert(entity).values([
      {
        kind: 'custom' as const,
        objectId: obj.id,
        canonicalName: `a ${tag}`,
        values: { stage: 'seed' },
      },
      {
        kind: 'custom' as const,
        objectId: obj.id,
        canonicalName: `b ${tag}`,
        values: { stage: 'growth' },
      },
    ])
    const saved = objectId
    objectId = obj.id
    try {
      const [id] = await saveViews([
        [{ slug: 'stage', op: 'is', value: 'seed' }],
      ])
      expect((await count([id]))[id]).toEqual({ count: 1 })
      await db
        .update(attribute)
        .set({ archived: true })
        .where(and(eq(attribute.objectId, obj.id), eq(attribute.slug, 'stage')))
      expect((await count([id]))[id]).toEqual({
        count: null,
        reason: expect.stringContaining('“Stage”, which is archived'),
      })
    } finally {
      objectId = saved
    }
  })
})

describe('the active chip moves with the Filter popover', () => {
  it('counts the page’s live conditions for the named view only', async () => {
    const seed: Array<Condition> = [{ slug: 'stage', op: 'is', value: 'seed' }]
    const [a, b] = await saveViews([seed, seed])
    const narrowed: Array<Condition> = [
      ...seed,
      { slug: 'note', op: 'contains', value: 'imaging' },
    ]
    const counts = await count([a, b], { viewId: a, filter: narrowed })
    expect(counts[a]).toEqual({ count: expected(narrowed) })
    expect(counts[b]).toEqual({ count: expected(seed) })
    expect(expected(narrowed)).toBeLessThan(expected(seed))
  })
})

describe('visibility and scope', () => {
  it('refuses a view that is not on this object or not visible', async () => {
    const { db } = await import('@spaces/db')
    const { view } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const other = `u-${randomUUID().slice(0, 8)}`
    await db.insert(user).values({
      id: other,
      name: 'Other',
      email: `${other}@example.test`,
    })
    const [priv] = await db
      .insert(view)
      .values({
        surface: 'object',
        objectId,
        name: 'Theirs',
        filter: [],
        visibility: 'private',
        createdBy: other,
      })
      .returning({ id: view.id })
    const counts = await count([priv.id])
    expect(counts[priv.id]).toEqual({ count: null, reason: 'View not found' })
  })

  it('counts a /companies view over the set the companies page pages', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { company, entity, view } = await import('@spaces/db/schema')
    const { objectIdForKind } = await import('../attributes/objects')
    const { listCompaniesPageProgram } = await import('./directory')
    const { countViewsProgram } = await import('./counts')
    const companyObject = await Effect.runPromise(objectIdForKind('company'))
    const tag = randomUUID().slice(0, 8)
    const made = await db
      .insert(entity)
      .values(
        [1, 2, 3].map((i) => ({
          kind: 'company' as const,
          objectId: companyObject,
          canonicalName: `Co ${i} ${tag}`,
        })),
      )
      .returning({ id: entity.id })
    await db.insert(company).values(made.map((m) => ({ entityId: m.id })))
    // A company entity with no subtype row is off the page, and off the count.
    await db.insert(entity).values({
      kind: 'company',
      objectId: companyObject,
      canonicalName: `Orphan ${tag}`,
    })
    const [v] = await db
      .insert(view)
      .values({
        surface: 'object',
        objectId: companyObject,
        name: 'Everything',
        filter: [],
        visibility: 'shared',
        createdBy: userId,
      })
      .returning({ id: view.id })
    const page = await Effect.runPromise(listCompaniesPageProgram([]))
    const counts = await Effect.runPromise(
      countViewsProgram(companyObject, [v.id], userId),
    )
    expect(counts[v.id]).toEqual({ count: page.total })
    expect(page.total).toBeGreaterThanOrEqual(3)
  })
})
