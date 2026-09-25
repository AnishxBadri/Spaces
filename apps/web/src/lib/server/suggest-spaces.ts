import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The Spaces rail's "Suggest spaces" (SPA-103). Pressing it checks the
 * classify lane's policy against the record's sensitivity — a record under a
 * sensitive space on a cloud route is refused here, naming the space — then
 * enqueues one `entity.suggest-spaces` job keyed on the record; pg-boss's
 * `singletonKey` refuses a second press while the first is queued or
 * active. The bodies live in `lib/ai/suggest-spaces.ts`.
 */

const byRecord = z.object({ entityId: z.string().uuid() })

export type {
  SuggestSpacesEnqueued,
  SuggestSpacesRefusal,
  SuggestSpacesStatus,
} from '../ai/suggest-spaces'

export const suggestSpaces = createServerFn({ method: 'POST' })
  .validator(byRecord)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { pressSuggestSpacesProgram } = await import('../ai/suggest-spaces')
    const { effectFn } = await import('./effect')
    return effectFn(pressSuggestSpacesProgram)(data.entityId, u.id)
  })

/** Where the record's latest run stands — polled while one is running. */
export const suggestSpacesStatus = createServerFn()
  .validator(byRecord)
  .handler(async ({ data }) => {
    await requireUser()
    const { suggestSpacesStatusProgram } = await import('../ai/suggest-spaces')
    const { effectFn } = await import('./effect')
    return effectFn(suggestSpacesStatusProgram)(data.entityId)
  })
