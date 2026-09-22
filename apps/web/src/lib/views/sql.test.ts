import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  OP_LABELS,
  isUnary,
  matchesConditions,
  opsFor,
} from '@spaces/core/views/filter'
import {
  FILTER_FIXTURE_ATTRIBUTES,
  FILTER_FIXTURE_ROWS,
  fixtureTypeOf,
} from '@spaces/core/views/filter.fixtures'
import type { Condition, ConditionOp } from '@spaces/core/views/filter'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'

/**
 * The pin (SPA-40): two evaluators, one fixture list, and the assertion that
 * they select the same records. `matchesConditions` runs over the fixtures in
 * memory; `compileConditions` runs as a real `where` against the same rows
 * stored as entities. Every op in `OP_LABELS` is walked against every type
 * `opsFor` covers — not only the ops that type's menu offers, because a saved
 * view whose attribute was retyped carries the old op and both evaluators
 * have to answer it the same way.
 *
 * The named cases below are the traps the property test would report but not
 * explain: a missing key is not a null, `empty` spans four different
 * absences, and an attribute the registry has lost widens the list instead of
 * emptying it.
 */

const registry = FILTER_FIXTURE_ATTRIBUTES.map((a) => ({
  slug: a.slug,
  type: a.type,
}))
const resolve = entityValuesResolver(registry)

/** The id set `matchesConditions` picks, by fixture key. */
const expectedKeys = (conditions: Array<Condition>) =>
  FILTER_FIXTURE_ROWS.filter((r) =>
    matchesConditions(r.values, conditions, fixtureTypeOf),
  )
    .map((r) => r.key)
    .sort()

let objectId = ''
/** entity id → fixture key, so a SQL result reads as fixture keys. */
const keyOf = new Map<string, string>()

/** The id set `compileConditions` picks, by fixture key. */
async function sqlKeys(conditions: Array<Condition>): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const rows = await db
    .select({ id: entity.id })
    .from(entity)
    .where(
      and(
        eq(entity.objectId, objectId),
        compileConditions(conditions, resolve),
      ),
    )
  return rows.map((r) => keyOf.get(r.id) ?? r.id).sort()
}

beforeAll(async () => {
  const { db } = await import('@spaces/db')
  const { entity, objectDef } = await import('@spaces/db/schema')
  const tag = randomUUID().slice(0, 8)
  const [obj] = await db
    .insert(objectDef)
    .values({
      slug: `fixtures-${tag}`,
      singular: `Fixture ${tag}`,
      plural: `Fixtures ${tag}`,
    })
    .returning({ id: objectDef.id })
  objectId = obj.id
  const inserted = await db
    .insert(entity)
    .values(
      FILTER_FIXTURE_ROWS.map((r) => ({
        kind: 'custom' as const,
        objectId,
        canonicalName: `${r.key} ${tag}`,
        values: r.values,
      })),
    )
    .returning({ id: entity.id, name: entity.canonicalName })
  for (const row of inserted)
    keyOf.set(row.id, row.name.slice(0, row.name.length - tag.length - 1))
})

/**
 * Spelled out rather than derived, so that adding an op to `OP_LABELS`
 * fails the first test below until the matrix is widened to cover it.
 */
const ALL_OPS: Array<ConditionOp> = [
  'is',
  'is_not',
  'contains',
  'empty',
  'not_empty',
  'gt',
  'lt',
]

describe('compileConditions agrees with matchesConditions', () => {
  it('walks every op OP_LABELS names, over every type opsFor covers', () => {
    expect([...ALL_OPS].sort()).toEqual(Object.keys(OP_LABELS).sort())
    // Every fixture type maps onto a menu; a type that does not is not a
    // type this matrix can claim to have covered.
    for (const a of FILTER_FIXTURE_ATTRIBUTES)
      expect(opsFor(a.type).length).toBeGreaterThan(0)
  })

  for (const a of FILTER_FIXTURE_ATTRIBUTES)
    it(`${a.type} (${a.slug}) — every op, every probe`, async () => {
      for (const op of ALL_OPS) {
        const values = isUnary(op) ? [null] : a.probes
        for (const value of values) {
          const c: Condition = isUnary(op)
            ? { slug: a.slug, op }
            : { slug: a.slug, op, value }
          expect(
            await sqlKeys([c]),
            `${a.type} ${op} ${JSON.stringify(value)}`,
          ).toEqual(expectedKeys([c]))
        }
      }
    })

  it('ANDs a condition list the same way', async () => {
    const conditions: Array<Condition> = [
      { slug: 'stage', op: 'is', value: 'seed' },
      { slug: 'stars', op: 'gt', value: 2 },
      { slug: 'note', op: 'contains', value: 'imaging' },
    ]
    expect(await sqlKeys(conditions)).toEqual(expectedKeys(conditions))
    expect(expectedKeys(conditions)).toEqual(['full'])
  })
})

describe('the NULL traps', () => {
  it('matches is_not for a row whose key is missing, and not contains', async () => {
    const isNot: Array<Condition> = [
      { slug: 'stage', op: 'is_not', value: 'seed' },
    ]
    expect(await sqlKeys(isNot)).toEqual(expectedKeys(isNot))
    expect(await sqlKeys(isNot)).toContain('absent')
    expect(await sqlKeys(isNot)).toContain('nulls')

    const contains: Array<Condition> = [
      { slug: 'stage', op: 'contains', value: 'seed' },
    ]
    expect(await sqlKeys(contains)).toEqual(expectedKeys(contains))
    expect(await sqlKeys(contains)).not.toContain('absent')
  })

  it('counts a missing key, a JSON null, an empty string and [] as empty', async () => {
    const tagsEmpty: Array<Condition> = [{ slug: 'tags', op: 'empty' }]
    // `blank` stores [], `absent` stores no key, `nulls` stores JSON null.
    expect(await sqlKeys(tagsEmpty)).toEqual(['absent', 'blank', 'nulls'])
    expect(await sqlKeys(tagsEmpty)).toEqual(expectedKeys(tagsEmpty))

    const stageEmpty: Array<Condition> = [{ slug: 'stage', op: 'empty' }]
    // `blank` stores '' here — the fourth absence.
    expect(await sqlKeys(stageEmpty)).toEqual(['absent', 'blank', 'nulls'])
    expect(await sqlKeys(stageEmpty)).toEqual(expectedKeys(stageEmpty))

    // Not empty: 0 and false are values, not absences.
    const scoreEmpty: Array<Condition> = [{ slug: 'score', op: 'empty' }]
    expect(await sqlKeys(scoreEmpty)).not.toContain('blank')
  })

  it('ignores a condition on an attribute the registry has lost', async () => {
    const all = FILTER_FIXTURE_ROWS.map((r) => r.key).sort()
    // Unknown slug: the resolver returns null and the condition drops, so the
    // list widens rather than empties.
    const ghost: Array<Condition> = [{ slug: 'ghost', op: 'is', value: 'x' }]
    expect(compileConditions(ghost, resolve)).toBeUndefined()
    expect(await sqlKeys(ghost)).toEqual(all)
    expect(await sqlKeys(ghost)).toEqual(expectedKeys(ghost))

    // An archived attribute is the same shape: it is absent from the live
    // registry read, so the resolver it is built from never sees the slug.
    const archived = entityValuesResolver(
      registry.filter((d) => d.slug !== 'stage'),
    )
    const onStage: Array<Condition> = [
      { slug: 'stage', op: 'is', value: 'seed' },
    ]
    expect(compileConditions(onStage, archived)).toBeUndefined()
    // …and the surviving conditions still apply.
    const mixed: Array<Condition> = [
      { slug: 'stage', op: 'is', value: 'seed' },
      { slug: 'note', op: 'contains', value: 'imaging' },
    ]
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const rows = await db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(eq(entity.objectId, objectId), compileConditions(mixed, archived)),
      )
    expect(rows.map((r) => keyOf.get(r.id)).sort()).toEqual([
      'full',
      'negative',
    ])
  })

  it('never throws on a non-numeric stored value, and compares dates as text', async () => {
    // `score` holds 'abc' and 'n/a'-shaped junk; a cast would error the query.
    const gt: Array<Condition> = [{ slug: 'score', op: 'gt', value: 1 }]
    expect(await sqlKeys(gt)).toEqual(expectedKeys(gt))
    expect(await sqlKeys(gt)).toEqual(['full', 'padded', 'strings'])

    const money: Array<Condition> = [
      { slug: 'valuation', op: 'gt', value: '100' },
    ]
    expect(await sqlKeys(money)).toEqual(expectedKeys(money))

    const dates: Array<Condition> = [
      { slug: 'founded', op: 'lt', value: '2021-01-01' },
    ]
    expect(await sqlKeys(dates)).toEqual(expectedKeys(dates))
    expect(await sqlKeys(dates)).toEqual(['padded', 'upper'])
  })
})
