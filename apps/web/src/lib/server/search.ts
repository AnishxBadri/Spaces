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
 * Unified search — Cmd-K's one box. The fused query and every invariant it
 * keeps live in `lib/search/query.ts` (SPA-148), outside `lib/server/` so a
 * test can call it without a request; this is the request half only.
 * `semantic` is the palette's second wave (SPA-129): the same query plus
 * the vector lane, which embeds the query text as the searching user.
 */
export const searchAll = createServerFn()
  .validator(
    z.object({ q: z.string().max(200), semantic: z.boolean().optional() }),
  )
  .handler(async ({ data }) => {
    // The body lives outside `lib/server/` so a test can call it (SPA-28:
    // the MCP `search_records` tool is pinned to answer exactly this).
    const { searchAllHandler } = await import('#/lib/search/search-all-handler')
    return searchAllHandler(data)
  })
