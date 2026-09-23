import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The Files tab's Read deck button (SPA-90). The trigger is manual and
 * pull-based (docs/spec-ai-substrate.md §4): pressing it enqueues one
 * `document.read-deck` job keyed on the document, and pg-boss's
 * `singletonKey` — not a table — is what refuses a second press while the
 * first is queued or active. The run log is ai-25.
 */

export const readDeck = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { enqueueReadDeckProgram, ReadDeckRefused } =
      await import('../ai/read-deck')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(enqueueReadDeckProgram)(data.documentId, u.id)
    } catch (failure) {
      throw new Error(
        failure instanceof ReadDeckRefused
          ? failure.message
          : 'Could not start reading the deck',
      )
    }
  })

/** Where each deck's latest read stands — polled while any is reading. */
export const readDeckStatus = createServerFn()
  .validator(z.object({ documentIds: z.array(z.string().uuid()).max(200) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { readDeckStatusProgram } = await import('../ai/read-deck')
    const { effectFn } = await import('./effect')
    return effectFn(readDeckStatusProgram)(data.documentIds)
  })
