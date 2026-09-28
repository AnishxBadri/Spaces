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
