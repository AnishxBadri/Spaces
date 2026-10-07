import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Attach from a storage-source link (Drive), and the poll its pending row
 * reads. Each handler is `requireUser()` plus the program from
 * `#/lib/documents/attach-link`, reached by a dynamic import so Effect and
 * drizzle stay out of the client bundle (CLAUDE.md → Traps).
 */

export type {
  AttachFromLinkOutcome,
  LinkFetchStatus,
} from '../documents/attach-link'

/** A same-origin path, never a URL: where a Connect dance lands. */
const samePath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)/, 'A path on this site')

export const attachFromLink = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      url: z.string().url().max(2000),
      attachTo: z.string().uuid(),
      returnTo: samePath,
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { attachFromLinkProgram, attachLinkMessage } =
      await import('../documents/attach-link')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(attachFromLinkProgram)(u.id, data)
    } catch (failure) {
      throw new Error(attachLinkMessage(failure))
    }
  })

export const linkFetchStatus = createServerFn()
  .validator(z.object({ fetchIds: z.array(z.string().uuid()).max(50) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { linkFetchStatusProgram } = await import('../documents/attach-link')
    const { effectFn } = await import('./effect')
    return effectFn(linkFetchStatusProgram)(data.fetchIds)
  })
