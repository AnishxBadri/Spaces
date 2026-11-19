import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

const uuid = Schema.String.check(Schema.isUUID())

/**
 * The Files tab's Read with vision button. Manual and pull-based, the Read
 * deck button's shape: pressing it enqueues one `document.vision` job keyed
 * on the document, and pg-boss's `singletonKey` refuses a second press while
 * the first is queued or active. The program is imported inside the handler
 * so pdf-lib and the AI SDK never reach the client bundle: this module is
 * re-exported by the client-imported `server-fns` barrel.
 */

export const readWithVision = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ documentId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { enqueueVisionProgram, VisionRefused } = await import('../ai/vision')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(enqueueVisionProgram)(data.documentId, u.id)
    } catch (failure) {
      throw new Error(
        failure instanceof VisionRefused
          ? failure.message
          : 'Could not start reading with vision',
      )
    }
  })

/** Where each document's latest vision read stands — polled while one runs. */
export const visionStatus = createServerFn()
  .validator(
    input(
      Schema.Struct({
        documentIds: Schema.Array(uuid).check(Schema.isMaxLength(200)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { visionStatusProgram } = await import('../ai/vision')
    const { effectFn } = await import('./effect')
    return effectFn(visionStatusProgram)(data.documentIds)
  })
