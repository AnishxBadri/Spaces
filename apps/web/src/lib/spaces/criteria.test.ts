import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { space } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { setSpaceCriteriaProgram } from '@spaces/core/writes/entities/space'
import { createSpaceRow } from '#/lib/server/shared'
import { getSpaceProgram } from './read'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * A space's criteria (D72): edited in place, one activity line per save
 * that changes it, and blank stays blank — never a placeholder stored.
 */

const me = FIXTURE_ACTOR.id

const set = (id: string, criteria: string) =>
  Effect.runPromise(setSpaceCriteriaProgram(me, { id, criteria }))

const lines = (id: string) =>
  db
    .select({ meta: activity.meta })
    .from(activity)
    .where(
      and(
        eq(activity.subjectEntityId, id),
        eq(activity.verb, 'space.criteria_changed'),
      ),
    )

const stored = async (id: string) =>
  (
    await db
      .select({ criteria: space.criteria })
      .from(space)
      .where(eq(space.entityId, id))
  ).at(0)?.criteria

describe('space criteria', () => {
  it('writes one activity line per save that changes it', async () => {
    const id = await createSpaceRow(`Criteria ${String(Date.now())}`, null, me)
    expect(await stored(id)).toBeNull()

    const sentence = 'Software that runs rental properties in India.'
    expect(await set(id, `  ${sentence} `)).toEqual({
      criteria: sentence,
      changed: true,
    })
    expect(await stored(id)).toBe(sentence)
    expect(await lines(id)).toEqual([{ meta: { from: null, to: sentence } }])

    // The same text again is no save.
    expect((await set(id, sentence)).changed).toBe(false)
    expect(await lines(id)).toHaveLength(1)

    const read = await Effect.runPromise(getSpaceProgram(id, me))
    expect(read.criteria).toBe(sentence)
  })

  it('clears to null on a blank save, never a placeholder', async () => {
    const id = await createSpaceRow(`Blank ${String(Date.now())}`, null, me)
    await set(id, 'Climate hardware.')
    expect(await set(id, '   ')).toEqual({ criteria: null, changed: true })
    expect(await stored(id)).toBeNull()
    expect(await lines(id)).toHaveLength(2)
    expect((await set(id, '')).changed).toBe(false)
  })

  it('refuses a space that does not exist', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        setSpaceCriteriaProgram(me, {
          id: '00000000-0000-4000-8000-000000000000',
          criteria: 'x',
        }),
      ),
    )
    expect(failure._tag).toBe('SpaceNotFound')
  })
})
