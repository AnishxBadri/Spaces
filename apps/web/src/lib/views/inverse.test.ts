import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { matchesConditions } from '@spaces/core/views/filter'
import type { Condition, ConditionOp } from '@spaces/core/views/filter'

/**
 * Inverse attributes in a list: company Team, read from the links a
 * person's `companies` writes, plus a 1:1 pair whose inverse holds one
 * record. The SQL and the browser evaluator — over the row values the page
 * fills from `relationsProgram` — must pick the same companies, and a saved
 * view on the inverse must outlive a rename.
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

type Fixture = {
  tag: string
  companyObjectId: string
  /** Company name suffix → id. */
  company: Record<'a' | 'b' | 'c' | 'd', string>
  person: Array<string>
  board: string
  boardOwnerId: string
  teamId: string
  ownerId: string
}

async function actorId() {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db.select({ id: user.id }).from(user).limit(1)
  return row.id
}

/**
 * Companies a (no team), b (p0), c (p0, p1), d (p1, p2, p3); p3 holds the
 * 1:1 board seat on c.
 */
async function fixture(): Promise<Fixture> {
  const { Effect } = await import('effect')
  const { db } = await import('@spaces/db')
  const { attribute, company, entity, person } =
    await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { objectIdForKind } =
    await import('@spaces/core/writes/attributes/objects')
  const { createRelationshipProgram } =
    await import('@spaces/core/writes/attributes/relationship')
  const { setValues } = await import('@spaces/core/writes/attributes/values')

  const tag = randomUUID().slice(0, 8)
  const companyObjectId = await Effect.runPromise(objectIdForKind('company'))
  const personObjectId = await Effect.runPromise(objectIdForKind('person'))
  const actor = await actorId()

  const pair = await Effect.runPromise(
    createRelationshipProgram({
      objectId: personObjectId,
      name: 'Board seat',
      targetObjectId: companyObjectId,
      inverseName: 'Board member',
      cardinality: '1:1',
      createdBy: actor,
    }),
  )
  const boardInverse = pair.owner === 'a' ? pair.b : pair.a
  const boardOwner = pair.owner === 'a' ? pair.a : pair.b

  const companies = await db
    .insert(entity)
    .values(
      ['a', 'b', 'c', 'd'].map((k) => ({
        kind: 'company' as const,
        canonicalName: `Co ${tag} ${k}`,
      })),
    )
    .returning({ id: entity.id })
  await db.insert(company).values(companies.map((r) => ({ entityId: r.id })))
  const people = await db
    .insert(entity)
    .values(
      [0, 1, 2, 3].map((i) => ({
        kind: 'person' as const,
        canonicalName: `Pat ${tag} ${i}`,
      })),
    )
    .returning({ id: entity.id })
  await db.insert(person).values(people.map((r) => ({ entityId: r.id })))
  const [a, b, c, d] = companies.map((r) => r.id)
  const p = people.map((r) => r.id)

  const write = (entityId: string, patch: Record<string, unknown>) =>
    setValues({ entityId, patch, actor: { type: 'user', id: actor } })
  await write(p[0], { companies: [b, c] })
  await write(p[1], { companies: [c, d] })
  await write(p[2], { companies: [d] })
  await write(p[3], { companies: [d], [boardOwner.slug]: c })

  const ids = await db
    .select({ id: attribute.id, slug: attribute.slug })
    .from(attribute)
    .where(
      and(eq(attribute.objectId, companyObjectId), eq(attribute.slug, 'team')),
    )
  const owner = await db
    .select({ id: attribute.id })
    .from(attribute)
    .where(
      and(
        eq(attribute.objectId, personObjectId),
        eq(attribute.slug, 'companies'),
      ),
    )
  return {
    tag,
    companyObjectId,
    company: { a, b, c, d },
    person: p,
    board: boardInverse.slug,
    boardOwnerId: boardOwner.id,
    teamId: ids.at(0)?.id ?? '',
    ownerId: owner.at(0)?.id ?? '',
  }
}

const suffix = (name: string) => name.slice(-1)

describe('inverse attributes in a list', () => {
  let fx: Fixture
  beforeAll(async () => {
    fx = await fixture()
  })

  async function list(
    conditions: Array<Condition>,
    sort?: { id: string; desc: boolean },
  ) {
    const { Effect } = await import('effect')
    const { listCompaniesPageProgram } = await import('./directory')
    return Effect.runPromise(
      listCompaniesPageProgram(conditions, {
        q: fx.tag,
        limit: 50,
        ...(sort ? { sort } : {}),
      }),
    )
  }

  it('fills each row with the inverse, its count and the far names', async () => {
    const page = await list([], { id: 'name', desc: false })
    const byName = Object.fromEntries(
      page.rows.map((r) => [suffix(r.name), r.values]),
    )
    expect(byName.a.team).toEqual([])
    expect(byName.a['count:team']).toBe(0)
    expect(byName.d['count:team']).toBe(3)
    expect(byName.c[fx.board]).toBe(fx.person[3])
    expect(byName.b[fx.board]).toBeNull()
    expect(page.refNames[fx.person[0]].name).toBe(`Pat ${fx.tag} 0`)
  })

  it('compiles every op the way the browser evaluator reads the filled row', async () => {
    const all = (await list([])).rows
    const typeOf = (slug: string) =>
      slug === 'team' || slug === fx.board
        ? 'record_reference'
        : slug.startsWith('count:')
          ? 'number'
          : undefined
    const probes: Record<string, Array<Condition['value']>> = {
      team: [fx.person[0], fx.person[3], '', 'nobody', [fx.person[1]]],
      [fx.board]: [fx.person[3], fx.person[0], '', null],
      'count:team': [0, 1, 2, '2', 'x', ''],
      [`count:${fx.board}`]: [0, 1],
    }
    for (const [slug, values] of Object.entries(probes))
      for (const op of ALL_OPS)
        for (const value of op === 'empty' || op === 'not_empty'
          ? [null]
          : values) {
          const c: Condition =
            op === 'empty' || op === 'not_empty'
              ? { slug, op }
              : { slug, op, value }
          const expected = all
            .filter((r) => matchesConditions(r.values, [c], typeOf))
            .map((r) => suffix(r.name))
            .sort()
          const got = (await list([c])).rows.map((r) => suffix(r.name)).sort()
          expect(got, `${slug} ${op} ${JSON.stringify(value)}`).toEqual(
            expected,
          )
        }
  })

  it('sorts by the count and by the first referenced name', async () => {
    const byCount = await list([], { id: 'count:team', desc: true })
    expect(byCount.rows.map((r) => suffix(r.name))).toEqual([
      'd',
      'c',
      'b',
      'a',
    ])
    // First names: b and c → Pat 0 (tied, then by id), d → Pat 1, a has
    // none and sorts last.
    const byName = (await list([], { id: 'attr:team', desc: false })).rows.map(
      (r) => suffix(r.name),
    )
    expect(byName.slice(0, 2).sort()).toEqual(['b', 'c'])
    expect(byName.slice(2)).toEqual(['d', 'a'])
    // Keyset paging holds across the count key.
    const { Effect } = await import('effect')
    const { listCompaniesPageProgram } = await import('./directory')
    const first = await Effect.runPromise(
      listCompaniesPageProgram([], {
        q: fx.tag,
        limit: 2,
        sort: { id: 'count:team', desc: true },
      }),
    )
    const next = await Effect.runPromise(
      listCompaniesPageProgram([], {
        q: fx.tag,
        limit: 2,
        sort: { id: 'count:team', desc: true },
        cursor: first.nextCursor,
      }),
    )
    expect([...first.rows, ...next.rows].map((r) => suffix(r.name))).toEqual([
      'd',
      'c',
      'b',
      'a',
    ])
  })

  it('keeps a saved view on the inverse through a rename of either half', async () => {
    const { Effect } = await import('effect')
    const { saveViewProgram, listViewsProgram } =
      await import('@spaces/core/writes/views/store')
    const { updateAttributeProgram } =
      await import('@spaces/core/writes/attributes/update')
    const { countViewsProgram } = await import('./counts')
    const actor = await actorId()

    const saved = await Effect.runPromise(
      saveViewProgram(
        {
          surface: 'object',
          objectId: fx.companyObjectId,
          name: `Teams ${fx.tag}`,
          filter: [{ slug: 'count:team', op: 'gt', value: 1 }],
          sort: { id: 'count:team', desc: true },
          columns: { 'attr:team': true, 'count:team': true },
          extra: {},
          visibility: 'shared',
        },
        { id: actor, isAdmin: true },
      ),
    )
    const run = async () => {
      const views = await Effect.runPromise(
        listViewsProgram(
          { surface: 'object', objectId: fx.companyObjectId },
          actor,
        ),
      )
      const v = views.find((x) => x.id === saved.id)
      if (!v?.sort) throw new Error('the saved view is gone')
      const page = await list(v.filter, v.sort)
      return page.rows.map((r) => suffix(r.name))
    }
    expect(await run()).toEqual(['d', 'c'])

    await Effect.runPromise(
      updateAttributeProgram({ id: fx.teamId, name: `People ${fx.tag}` }),
    )
    await Effect.runPromise(
      updateAttributeProgram({ id: fx.ownerId, name: `Employers ${fx.tag}` }),
    )
    expect(await run()).toEqual(['d', 'c'])
    // The chip counts it too, rather than refusing a lost condition.
    const counts = await Effect.runPromise(
      countViewsProgram(fx.companyObjectId, [saved.id], actor),
    )
    expect(counts[saved.id]).toEqual({ count: 2 })
  })

  it('drops an inverse whose owner is archived, as the resolver does', async () => {
    const { Effect } = await import('effect')
    const { lensRegistry } = await import('./inverse')
    const { updateAttributeProgram } =
      await import('@spaces/core/writes/attributes/update')
    const before = await lensRegistry(fx.companyObjectId)
    expect(before.live.find((a) => a.slug === fx.board)?.inverse).toEqual({
      linkSlug: expect.any(String),
      from: { kind: 'person' },
      multi: false,
    })
    await Effect.runPromise(
      updateAttributeProgram({ id: fx.boardOwnerId, archived: true }),
    )
    const after = await lensRegistry(fx.companyObjectId)
    expect(after.live.some((a) => a.slug === fx.board)).toBe(false)
  })
})
