import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { uuidString } from '@spaces/core/attributes/registry'
import { requireUser } from './shared'
import { input } from './input'

/**
 * The Spaces rail's "Suggest spaces". Pressing it checks the
 * classify lane's policy against the record's sensitivity — a record under a
 * sensitive space on a cloud route is refused here, naming the space — then
 * enqueues one `entity.suggest-spaces` job keyed on the record; pg-boss's
 * `singletonKey` refuses a second press while the first is queued or
 * active.
 */

const byRecord = Schema.Struct({ entityId: uuidString })

export type {
  SuggestSpacesEnqueued,
  SuggestSpacesRefusal,
  SuggestSpacesStatus,
} from '../ai/suggest-spaces'

export const suggestSpaces = createServerFn({ method: 'POST' })
  .validator(input(byRecord))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { pressSuggestSpacesProgram } = await import('../ai/suggest-spaces')
    const { effectFn } = await import('./effect')
    return effectFn(pressSuggestSpacesProgram)(data.entityId, u.id)
  })

/** Where the record's latest run stands — polled while one is running. */
export const suggestSpacesStatus = createServerFn()
  .validator(input(byRecord))
  .handler(async ({ data }) => {
    await requireUser()
    const { suggestSpacesStatusProgram } = await import('../ai/suggest-spaces')
    const { effectFn } = await import('./effect')
    return effectFn(suggestSpacesStatusProgram)(data.entityId)
  })
