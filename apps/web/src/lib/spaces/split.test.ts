import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { company, entity, entitySpace } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { createSpaceRow } from '#/lib/server/shared'
import { getSpaceProgram } from './read'
import { MoveHereRefused, moveHereProgram } from './split'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * Split by hand against the test database: Move here untags each
 * chosen company from the parent and tags it in the child — one
 * `space.untagged` and one `space.tagged` each — and moves only the
 * parent's own filings.
 */

const me = FIXTURE_ACTOR.id

async function aCompany(name: string): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned nothing')
  await db.insert(company).values({ entityId: row.id })
  return row.id
}

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({ entityId, spaceId, source: 'manual' })

const filedIn = async (entityId: string) =>
  (
    await db
      .select({ spaceId: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, entityId))
  ).map((r) => r.spaceId)

const lines = (entityIds: Array<string>) =>
  db
    .select({
      verb: activity.verb,
      subject: activity.subjectEntityId,
      object: activity.objectEntityId,
    })
    .from(activity)
    .where(
      and(
        inArray(activity.subjectEntityId, entityIds),
        inArray(activity.verb, ['space.tagged', 'space.untagged']),
      ),
    )

/** In-space manufacturing with Materials under it, the demo's shape. */
async function demo() {
  const parent = await createSpaceRow('In-space manufacturing', null, me)
  const child = await createSpaceRow('Materials', parent, me)
  const varda = await aCompany('Varda')
  const forge = await aCompany('Space Forge')
  const stays = await aCompany('Astroforge')
  const inherited = await aCompany('Atomos')
  for (const id of [varda, forge, stays]) await file(id, parent)
  await file(inherited, child)
  return { parent, child, varda, forge, stays, inherited }
}

describe('Move here', () => {
  it('lists the parent’s direct filings only, never one filed via a subspace', async () => {
    const d = await demo()
    const spc = await Effect.runPromise(getSpaceProgram(d.parent, me))
    expect(spc.companies.map((c) => c.id).sort()).toEqual(
      [d.varda, d.forge, d.stays].sort(),
    )
    expect(spc.companies.map((c) => c.id)).not.toContain(d.inherited)
  })

  it('untags each chosen company from the parent and tags it in the child, one event each', async () => {
    const d = await demo()
    const moved = await Effect.runPromise(
      moveHereProgram(me, {
        fromSpaceId: d.parent,
        toSpaceId: d.child,
        entityIds: [d.varda, d.forge],
      }),
    )
    expect(moved.moved.sort()).toEqual([d.varda, d.forge].sort())
    // A `filed` event per new tag, dispatched by the server fn after commit.
    expect(moved.emits).toHaveLength(2)

    expect(await filedIn(d.varda)).toEqual([d.child])
    expect(await filedIn(d.forge)).toEqual([d.child])
    expect(await filedIn(d.stays)).toEqual([d.parent])

    const history = await lines([d.varda, d.forge, d.stays])
    for (const id of [d.varda, d.forge]) {
      const mine = history.filter((h) => h.subject === id)
      expect(mine).toHaveLength(2)
      expect(mine).toContainEqual({
        verb: 'space.untagged',
        subject: id,
        object: d.parent,
      })
      expect(mine).toContainEqual({
        verb: 'space.tagged',
        subject: id,
        object: d.child,
      })
    }
    expect(history.filter((h) => h.subject === d.stays)).toEqual([])
  })

  it('refuses whole when a chosen company is not filed in the parent itself', async () => {
    const d = await demo()
    const failure = await Effect.runPromise(
      moveHereProgram(me, {
        fromSpaceId: d.parent,
        toSpaceId: d.child,
        entityIds: [d.varda, d.inherited],
      }).pipe(Effect.flip),
    )
    expect(failure).toBeInstanceOf(MoveHereRefused)
    expect(await filedIn(d.varda)).toEqual([d.parent])
    expect(await lines([d.varda, d.inherited])).toEqual([])
  })

  it('refuses a target that is not a subspace of the space', async () => {
    const d = await demo()
    const elsewhere = await createSpaceRow('Elsewhere', null, me)
    const failure = await Effect.runPromise(
      moveHereProgram(me, {
        fromSpaceId: d.parent,
        toSpaceId: elsewhere,
        entityIds: [d.varda],
      }).pipe(Effect.flip),
    )
    expect(failure).toBeInstanceOf(MoveHereRefused)
    expect(await filedIn(d.varda)).toEqual([d.parent])
  })
})
