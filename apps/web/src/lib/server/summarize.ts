import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The Summarize buttons (SPA-66) — on a Files-tab row (a document) and in a
 * record's header (the record itself). Manual and pull-based
 * (docs/spec-ai-substrate.md §4): pressing enqueues one `entity.summarize`
 * job keyed on the record and the source, and pg-boss's `singletonKey`
 * refuses a second press while the first is queued or active. The result is
 * a `suggestion(kind: 'note')` in the inbox, never a note.
 */

export const summarize = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      recordId: z.string().uuid(),
      /** Null summarizes the record itself. */
      documentId: z.string().uuid().nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { enqueueSummarizeProgram, SummarizeRefused } =
      await import('../ai/summarize')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(enqueueSummarizeProgram)({
        recordId: data.recordId,
        documentId: data.documentId,
        userId: u.id,
      })
    } catch (failure) {
      throw new Error(
        failure instanceof SummarizeRefused
          ? failure.message
          : 'Could not start the summary',
      )
    }
  })

/** Where each source's latest summary on a record stands — polled while one runs. */
export const summarizeStatus = createServerFn()
  .validator(
    z.object({
      recordId: z.string().uuid(),
      sourceIds: z.array(z.string().uuid()).max(200),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { summarizeStatusProgram } = await import('../ai/summarize')
    const { effectFn } = await import('./effect')
    return effectFn(summarizeStatusProgram)(data.recordId, data.sourceIds)
  })
