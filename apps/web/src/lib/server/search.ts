import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { int, uuidString } from '@spaces/core/attributes/registry'
import { entitySearchInput } from '@spaces/core/search/entity-search-input'
import { input } from './input'
import { requireUser } from './shared'

const query = Schema.Struct({ q: Schema.String.check(Schema.isMaxLength(200)) })

/**
 * The validator's schema is core's pure entity-search input: a server fn's
 * `.validator()` survives into the client bundle, so it must come from a
 * module that imports no `db`. The query it feeds is loaded lazily below.
 */
export type { EntitySearchInput } from '@spaces/core/search/entity-search-input'

/** Autocomplete over entities — mentions and reference pickers share it. */
export const searchEntities = createServerFn()
  .validator(input(entitySearchInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { entitySearchRows } =
      await import('@spaces/core/writes/read/entity-search')
    return entitySearchRows(u.id, data)
  })

/**
 * Cmd-K's Records and its lexical passages — the fused statement only, never
 * the vector lane, in its name-first order. This is the request half; the
 * query states its own invariants.
 */
export const searchAll = createServerFn()
  .validator(input(query))
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
  .validator(input(query))
  .handler(async ({ data }) => {
    const { searchPassagesHandler } =
      await import('#/lib/search/passages-handler')
    return searchPassagesHandler(data)
  })

/**
 * Cmd-K's preview pane, one read per highlighted result, cached by the
 * palette for its life.
 */
export const previewRecord = createServerFn()
  .validator(input(Schema.Struct({ id: uuidString })))
  .handler(async ({ data }) => {
    const { previewRecordHandler } =
      await import('#/lib/search/preview-handler')
    return previewRecordHandler(data)
  })

export const previewObject = createServerFn()
  .validator(
    input(
      Schema.Struct({
        slug: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(80),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { previewObjectHandler } =
      await import('#/lib/search/preview-handler')
    return previewObjectHandler(data)
  })

export const previewPassage = createServerFn()
  .validator(
    input(
      Schema.Struct({
        id: uuidString,
        page: Schema.NullOr(Schema.Number.check(int, Schema.isGreaterThan(0))),
        snippet: Schema.String.check(Schema.isMaxLength(400)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { previewPassageHandler } =
      await import('#/lib/search/preview-handler')
    return previewPassageHandler(data)
  })
