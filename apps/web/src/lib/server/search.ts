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
    const { entitySearchRows } = await import('#/lib/search/rows')
    return entitySearchRows(u.id, data)
  })

/**
 * Cmd-K's Records — the lexical fused statement only, never the vector lane,
 * ordered so a typed name puts its record first (`nameFirst`). (D70) The
 * query and its invariants live in `lib/search/query.ts`; this is the
 * request half.
 */
export const searchAll = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    const { searchAllHandler } = await import('#/lib/search/search-all-handler')
    const { nameFirst } = await import('#/lib/search/records')
    // A record's picture draws in place of its kind icon; MCP has no use for it.
    const { withPictures } = await import('#/lib/records/pictures')
    return withPictures(nameFirst(await searchAllHandler(data), data.q))
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
