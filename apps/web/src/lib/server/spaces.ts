import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'
import { db } from '@spaces/db'
import { activity } from '@spaces/db/schema/activity'
import { getSpaceProgram, listSpacesProgram } from '#/lib/spaces/read'
import { createSpaceRow, requireUser } from './shared'

// Spaces — first real write path through the entity core. The reads are
// Effect programs in lib/spaces/read.ts: the handler checks the session, the
// program does the work, `Effect.runPromise` is the seam. Nothing but server
// fns may be exported from this file — see the note at the top of read.ts.

export const listSpaces = createServerFn().handler(async () => {
  const u = await requireUser()
  return Effect.runPromise(listSpacesProgram(u.id))
})

export const getSpace = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(getSpaceProgram(data.id, u.id))
  })

const createSpaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().optional(),
})

export const createSpace = createServerFn({ method: 'POST' })
  .validator(createSpaceInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const id = await createSpaceRow(data.name, data.parentId ?? null, u.id)
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'space.created',
      subjectEntityId: id,
    })
    return { id }
  })

/** Rename in place: the name changes everywhere it is read; slug and path stay. */
export const renameSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { renameRecordProgram } =
      await import('@spaces/core/writes/entities/rename')
    const { effectFn } = await import('./effect')
    return effectFn(renameRecordProgram)(u.id, data)
  })

/**
 * What belongs here, edited in place on the space page (D72). A blank save
 * clears it; each change is one `space.criteria_changed` line.
 */
export const setSpaceCriteria = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: z.string().uuid(), criteria: z.string().max(1000) }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { setSpaceCriteriaProgram, spaceWriteMessage } =
      await import('@spaces/core/writes/entities/space')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(setSpaceCriteriaProgram)(u.id, data)
    } catch (failure) {
      throw new Error(spaceWriteMessage(failure))
    }
  })

/** Archive asks nothing — Restore undoes it. (D73) */
export const archiveSpace = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { archiveSpaceProgram, spaceWriteMessage } =
      await import('@spaces/core/writes/entities/space')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(archiveSpaceProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(spaceWriteMessage(failure))
    }
  })

export const restoreSpace = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { restoreSpaceProgram, spaceWriteMessage } =
      await import('@spaces/core/writes/entities/space')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(restoreSpaceProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(spaceWriteMessage(failure))
    }
  })

/**
 * Move a space under a new parent, or to the root (`parentId: null`). The
 * lowering half of the sensitivity cache is queued after the commit.
 */
export const moveSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { moveSpaceProgram, spaceWriteMessage } =
      await import('@spaces/core/writes/entities/space')
    const { enqueueRestamp } = await import('../ai/enqueue-restamp')
    const { effectFn } = await import('./effect')
    try {
      const moved = await effectFn(moveSpaceProgram)(u.id, data)
      await enqueueRestamp(moved.restamp)
      return { moved: moved.moved, from: moved.from, to: moved.to }
    } catch (failure) {
      throw new Error(spaceWriteMessage(failure))
    }
  })
