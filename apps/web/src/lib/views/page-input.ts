import { z } from 'zod'
import type { ListPageOptions } from './paging'

/**
 * What a paged list surface accepts over the wire (SPA-64, shared SPA-96).
 *
 * The three list server fns — `listObjectRecords`, `listCompaniesTable`,
 * `listPeopleTable` — validate against this one shape, so "the paging
 * contract" is a thing the compiler knows about rather than three hand-kept
 * copies of the same twenty lines. Only the surface key differs, and that
 * stays with each fn.
 *
 * Type-only import of `ListPageOptions`, so this module carries zod and
 * nothing else: it is reachable from the client-imported barrel's graph.
 */
export const pagedListShape = {
  conditions: z
    .array(
      z.object({
        slug: z.string().min(1).max(120),
        op: z.enum([
          'is',
          'is_not',
          'contains',
          'empty',
          'not_empty',
          'gt',
          'lt',
        ]),
        value: z
          .union([
            z.string().max(400),
            z.number(),
            z.boolean(),
            z.null(),
            z.array(z.string().max(400)).max(50),
          ])
          .optional(),
      }),
    )
    .max(20)
    .optional(),
  // Opaque to the client: it round-trips whatever `nextCursor` said.
  cursor: z.string().max(400).nullish(),
  limit: z.number().int().min(1).max(200).optional(),
  // The table's own column id — `name`, `createdAt`, `attr:<slug>`.
  sort: z
    .object({ id: z.string().min(1).max(160), desc: z.boolean() })
    .nullish(),
  q: z.string().max(200).optional(),
}

export const pagedListInput = z.object(pagedListShape)

/**
 * The validated request as the program takes it. `exactOptionalPropertyTypes`
 * is why `limit` and `q` are spread rather than assigned `?? undefined`:
 * absent means the program's own default, not an explicit `undefined`.
 */
export function pageOptions(data: {
  cursor?: string | null | undefined
  limit?: number | undefined
  sort?: { id: string; desc: boolean } | null | undefined
  q?: string | undefined
}): ListPageOptions {
  return {
    cursor: data.cursor ?? null,
    sort: data.sort ?? null,
    ...(data.limit === undefined ? {} : { limit: data.limit }),
    ...(data.q === undefined ? {} : { q: data.q }),
  }
}
