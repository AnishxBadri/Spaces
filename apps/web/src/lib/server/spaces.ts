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

/**
 * "Run now" on a watch: send its run at once, cadence or not. The next
 * cadence tick still fires; an archived space or a stopped plugin is
 * refused, never queued. (D72)
 */
export const runWatchNow = createServerFn({ method: 'POST' })
  .validator(z.object({ watchId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { runWatchNowProgram, WatchRunRefused } =
      await import('@spaces/core/writes/watches/run')
    const { webEnqueue } = await import('../enqueue-live')
    try {
      return await Effect.runPromise(
        runWatchNowProgram(data.watchId).pipe(Effect.provide(webEnqueue)),
      )
    } catch (failure) {
      throw new Error(
        failure instanceof WatchRunRefused
          ? failure.message
          : 'Could not run the watch',
      )
    }
  })

export type {
  SpaceSignal,
  SpaceWatching,
  WatchEngine,
  WatchRow,
} from '../spaces/watching'

/** The space page's Watching and What's moving lanes, and the engines to add with. */
export const getSpaceWatching = createServerFn()
  .validator(z.object({ spaceId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { spaceWatchingProgram } = await import('../spaces/watching')
    const { effectFn } = await import('./effect')
    return effectFn(spaceWatchingProgram)(data.spaceId)
  })

/**
 * Add watch: one `space_watch` row; no cadence is Manual, which runs only
 * on Run now. The same lens twice is refused as "Already watching this".
 */
export const addSpaceWatch = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      spaceId: z.string().uuid(),
      integrationId: z.string().uuid(),
      values: z.record(z.string(), z.union([z.string(), z.boolean()])),
      cadenceMinutes: z.int().positive().nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { addSpaceWatchProgram, addWatchMessage } =
      await import('../spaces/watching')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(addSpaceWatchProgram)(u.id, data)
    } catch (failure) {
      throw new Error(addWatchMessage(failure))
    }
  })

/**
 * Move here: the chosen companies leave this space for one of its
 * subspaces, an untag and a tag each. The `filed` events and the lowering
 * restamps go after the commit. (D73)
 */
export const moveIntoSubspace = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      fromSpaceId: z.string().uuid(),
      toSpaceId: z.string().uuid(),
      entityIds: z.array(z.string().uuid()).min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { moveHereMessage, moveHereProgram } = await import('../spaces/split')
    const { restampUntagged } = await import('../spaces/tag')
    const { emitDomainEvent } = await import('../events/emit')
    const { effectFn } = await import('./effect')
    const result = await effectFn(moveHereProgram)(u.id, data).catch(
      (failure: unknown) => {
        throw new Error(moveHereMessage(failure))
      },
    )
    for (const emit of result.emits) await emitDomainEvent(emit)
    for (const entityId of result.moved)
      await restampUntagged(entityId, data.fromSpaceId)
    return { moved: result.moved.length }
  })
