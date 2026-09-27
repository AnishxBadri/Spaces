import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The Files tab's Read with vision button (SPA-94). Manual and pull-based,
 * the Read deck button's shape: pressing it enqueues one `document.vision`
 * job keyed on the document, and pg-boss's `singletonKey` refuses a second
 * press while the first is queued or active. The program, the lane and the
 * no-rasterizer decision are `lib/ai/vision.ts`, imported inside the handler
 * so pdf-lib and the AI SDK never reach the client bundle — this module is
 * re-exported by the client-imported `server-fns` barrel.
 */

export const readWithVision = createServerFn({ method: 'POST' })
  .validator(z.object({ documentId: z.string().uuid() }))
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
  .validator(z.object({ documentIds: z.array(z.string().uuid()).max(200) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { visionStatusProgram } = await import('../ai/vision')
    const { effectFn } = await import('./effect')
    return effectFn(visionStatusProgram)(data.documentIds)
  })
