import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * The validator stays here rather than beside the query in
 * `lib/search/rows.ts`: a server fn's `.validator()` survives into the client
 * bundle, and that module imports `db` (SPA-155). `rows.ts` takes the
 * inferred type, which is erased.
 */
const entitySearchInput = z.object({
  q: z.string().max(120),
  kinds: z
    .array(
      z.enum([
        'company',
        'person',
        'deal',
        'space',
        'note',
        'document',
        'custom',
      ]),
    )
    .optional(),
  /** narrow to one object's records — a custom-object reference picker */
  objectId: z.string().uuid().optional(),
})

export type EntitySearchInput = z.infer<typeof entitySearchInput>

/** Autocomplete over entities — mentions and reference pickers share it. */
export const searchEntities = createServerFn()
  .validator(entitySearchInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { entitySearchRows } = await import('#/lib/search/rows')
    return entitySearchRows(u.id, data)
  })

/**
 * Unified search — Cmd-K's one box. The fused query and every invariant it
 * keeps live in `lib/search/query.ts` (SPA-148), outside `lib/server/` so a
 * test can call it without a request; this is the request half only.
 */
export const searchAll = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { searchAllProgram } = await import('#/lib/search/query')
    const { effectFn } = await import('./effect')
    return effectFn(searchAllProgram)({ userId: u.id, q: data.q })
  })
