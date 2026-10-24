import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Versions: the two manual `supersedes` writers. Nothing is deleted;
 * the older item stays readable and searchable, and ranks lower.
 */

/** "Newer version of…": `newerId` replaces `olderId`. One link row, idempotent. */
export const markNewerVersion = createServerFn({ method: 'POST' })
  .validator(
    z.object({ newerId: z.string().uuid(), olderId: z.string().uuid() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { markNewerVersionProgram, supersedesMessage } =
      await import('@spaces/core/writes/links/supersedes')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(markNewerVersionProgram)({
        newerId: data.newerId,
        olderId: data.olderId,
        actorId: u.id,
      })
    } catch (failure) {
      throw new Error(supersedesMessage(failure))
    }
  })

/** "Save as new version" on a note: a copy that supersedes it. */
export const saveNoteAsNewVersion = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { saveNoteAsNewVersionProgram, noteVersionMessage } =
      await import('../notes/new-version')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(saveNoteAsNewVersionProgram)(u.id, data.id)
    } catch (failure) {
      throw new Error(noteVersionMessage(failure))
    }
  })
