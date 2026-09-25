import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The Files tab's Extract key terms button (SPA-91). Manual and pull-based
 * (docs/spec-ai-substrate.md §4), the Read deck button's shape: pressing it
 * enqueues one `document.key-terms` job keyed on the document, and
 * pg-boss's `singletonKey` refuses a second press while the first is queued
 * or active. The result is a `suggestion(kind: 'note')` on the deal, never a
 * note.
 */

export const extractKeyTerms = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { enqueueKeyTermsProgram, KeyTermsRefused } =
      await import('../ai/key-terms')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(enqueueKeyTermsProgram)(data.documentId, u.id)
    } catch (failure) {
      throw new Error(
        failure instanceof KeyTermsRefused
          ? failure.message
          : 'Could not start extracting the key terms',
      )
    }
  })

/** Where each document's latest key-terms read stands — polled while one runs. */
export const keyTermsStatus = createServerFn()
  .validator(z.object({ documentIds: z.array(z.string().uuid()).max(200) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { keyTermsStatusProgram } = await import('../ai/key-terms')
    const { effectFn } = await import('./effect')
    return effectFn(keyTermsStatusProgram)(data.documentIds)
  })
