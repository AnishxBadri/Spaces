import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { entitySearchInput } from '@spaces/core/search/entity-search-input'
import { requireUser } from './shared'

/**
 * The validator's schema is core's pure `search/entity-search-input`
 * (SPA-198): a server fn's `.validator()` survives into the client bundle,
 * so it must come from a module that imports no `db` (SPA-155); the query
 * it feeds is `@spaces/core/writes/read/entity-search`, loaded lazily below.
 */
export type { EntitySearchInput } from '@spaces/core/search/entity-search-input'

/** Autocomplete over entities — mentions and reference pickers share it. */
export const searchEntities = createServerFn()
  .validator(entitySearchInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { entitySearchRows } =
      await import('@spaces/core/writes/read/entity-search')
    return entitySearchRows(u.id, data)
  })

/**
 * Cmd-K's Records and its lexical passages — the fused statement only, never
 * the vector lane, in its name-first order. (D70) The query and its
 * invariants live in `lib/search/query.ts`; this is the request half.
 */
export const searchAll = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    const { paletteRecordsHandler } =
      await import('#/lib/search/palette-records')
    return paletteRecordsHandler(data)
  })

/**
 * Cmd-K's Passages — the semantic lane alone, asked for once typing pauses.
 * Embeds the query as the searching user; no pin answers nothing.
 */
export const searchPassages = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    const { searchPassagesHandler } =
      await import('#/lib/search/passages-handler')
    return searchPassagesHandler(data)
  })

/**
 * Cmd-K's preview pane, one read per highlighted result, cached by the
 * palette for its life. (D70) The reads are `lib/search/preview.ts`.
 */
export const previewRecord = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { previewRecordHandler } =
      await import('#/lib/search/preview-handler')
    return previewRecordHandler(data)
  })

export const previewObject = createServerFn()
  .validator(z.object({ slug: z.string().min(1).max(80) }))
  .handler(async ({ data }) => {
    const { previewObjectHandler } =
      await import('#/lib/search/preview-handler')
    return previewObjectHandler(data)
  })

export const previewPassage = createServerFn()
  .validator(
    z.object({
      id: z.string().uuid(),
      page: z.number().int().positive().nullable(),
      snippet: z.string().max(400),
    }),
  )
  .handler(async ({ data }) => {
    const { previewPassageHandler } =
      await import('#/lib/search/preview-handler')
    return previewPassageHandler(data)
  })
