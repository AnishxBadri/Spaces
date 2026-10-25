import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Live files: Follow and Unfollow from a file row's `···`, and the
 * viewer's revision ledger. Each handler is `requireUser()` plus a follow
 * program, reached by a dynamic import so Effect and drizzle stay out of
 * the client bundle.
 */

export type { FollowOutcome } from '../documents/follow'
export type { RevisionRow } from '@spaces/core/documents/revisions'

const COULD_NOT_FOLLOW = 'Could not follow this file'

/** Follow a filed file from the record whose Files tab it was followed on. */
export const followDocument = createServerFn({ method: 'POST' })
  .validator(
    z.object({ documentId: z.string().uuid(), recordId: z.string().uuid() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { followDocumentProgram } = await import('../documents/follow')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(followDocumentProgram)(u.id, data)
    } catch {
      throw new Error(COULD_NOT_FOLLOW)
    }
  })

/** Unfollow: polling stops, the revisions stay. */
export const unfollowDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { unfollowDocumentProgram } = await import('../documents/follow')
    const { effectFn } = await import('./effect')
    return {
      unfollowed: await effectFn(unfollowDocumentProgram)(
        u.id,
        data.documentId,
      ),
    }
  })

/** A document's revisions, newest first; null when it cannot be read. */
export const listDocumentRevisions = createServerFn()
  .validator(z.object({ documentId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { documentRevisionsForProgram } = await import('../documents/follow')
    const { effectFn } = await import('./effect')
    return effectFn(documentRevisionsForProgram)(u.id, data.documentId)
  })
