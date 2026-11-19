import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

const uuid = Schema.String.check(Schema.isUUID())

/**
 * The Files tab's Read deck button. Manual and pull-based: pressing it
 * enqueues one `document.read-deck` job keyed on the document, and pg-boss's
 * `singletonKey`, not a table, refuses a second press while the first is
 * queued or active. Each read is one `ai_run`.
 */

export const readDeck = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ documentId: uuid })))
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

/**
 * Read deck and summarize: the same job with the record the
 * summary lands on — one two-step run, extract then synthesize. The same
 * key, so it is refused while the deck is already being read either way.
 */
export const readDeckAndSummarize = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ documentId: uuid, recordId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { enqueueReadDeckProgram, ReadDeckRefused } =
      await import('../ai/read-deck')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(enqueueReadDeckProgram)(
        data.documentId,
        u.id,
        data.recordId,
      )
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
  .validator(
    input(
      Schema.Struct({
        documentIds: Schema.Array(uuid).check(Schema.isMaxLength(200)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { readDeckStatusProgram } = await import('../ai/read-deck')
    const { effectFn } = await import('./effect')
    return effectFn(readDeckStatusProgram)(data.documentIds)
  })
