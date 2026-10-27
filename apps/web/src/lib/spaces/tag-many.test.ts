import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { company, entity, entitySpace } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { createSpaceRow } from '#/lib/server/shared'
import { untagByHand } from './tag'
import { TagManyRefused, tagManyProgram } from './tag-many'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * Add to space from a list against the test database: one transaction tags
 * every chosen record, `tagged` names only the ones it filed, and the Undo —
 * an untag per tagged id, as `untagFromSpace` does it — puts the filings
 * back exactly as they were.
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

/** Every filing of these records, as `record→space` pairs, sorted. */
const filings = async (ids: Array<string>) =>
  (
    await db
      .select({ e: entitySpace.entityId, s: entitySpace.spaceId })
      .from(entitySpace)
      .where(inArray(entitySpace.entityId, ids))
  )
    .map((r) => `${r.e}→${r.s}`)
    .sort()

describe('Add to space, then Undo', () => {
  it('tags the new ones in one go and Undo restores the prior filings', async () => {
    const ops = await createSpaceRow('Property ops', null, me)
    const other = await createSpaceRow('Proptech', null, me)
    const flent = await aCompany('Flent')
    const nestaway = await aCompany('Nestaway')
    const zolo = await aCompany('Zolo')
    // Flent is already in the space; Zolo sits in another one.
    await db.insert(entitySpace).values([
      { entityId: flent, spaceId: ops, source: 'manual' },
      { entityId: zolo, spaceId: other, source: 'manual' },
    ])
    const ids = [flent, nestaway, zolo]
    const before = await filings(ids)

    const out = await Effect.runPromise(
      tagManyProgram(me, { spaceId: ops, entityIds: ids }),
    )
    expect(out.tagged.sort()).toEqual([nestaway, zolo].sort())
    expect(await filings(ids)).toEqual(
      [...before, `${nestaway}→${ops}`, `${zolo}→${ops}`].sort(),
    )
    const lines = await db
      .select({ subject: activity.subjectEntityId })
      .from(activity)
      .where(
        and(
          eq(activity.verb, 'space.tagged'),
          eq(activity.objectEntityId, ops),
        ),
      )
    expect(lines.map((l) => l.subject).sort()).toEqual(ids.slice().sort())

    for (const entityId of out.tagged)
      await db.transaction((tx) =>
        untagByHand(tx, { entityId, spaceId: ops, actorId: me }),
      )
    expect(await filings(ids)).toEqual(before)
  })

  it('refuses a space that is not there and files nothing', async () => {
    const flent = await aCompany('Flent')
    const failure = await Effect.runPromise(
      Effect.flip(
        tagManyProgram(me, {
          spaceId: '00000000-0000-4000-8000-00000000dead',
          entityIds: [flent],
        }),
      ),
    )
    expect(failure).toBeInstanceOf(TagManyRefused)
    expect(await filings([flent])).toEqual([])
  })
})
