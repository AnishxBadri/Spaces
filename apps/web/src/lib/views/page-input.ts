import { Schema } from 'effect'
import type { ListPageOptions } from './paging'

/**
 * What a paged list surface accepts over the wire; `listObjectRecords`,
 * `listCompaniesTable` and `listPeopleTable` all validate against it.
 * Imports Effect Schema and types only: it is reachable from the
 * client-imported barrel.
 */
export const pagedListShape = {
  conditions: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          slug: Schema.String.check(
            Schema.isMinLength(1),
            Schema.isMaxLength(120),
          ),
          op: Schema.Literals([
            'is',
            'is_not',
            'contains',
            'empty',
            'not_empty',
            'gt',
            'lt',
          ]),
          value: Schema.optional(
            Schema.Union([
              Schema.String.check(Schema.isMaxLength(400)),
              Schema.Finite,
              Schema.Boolean,
              Schema.Null,
              Schema.mutable(
                Schema.Array(Schema.String.check(Schema.isMaxLength(400))),
              ).check(Schema.isMaxLength(50)),
            ]),
          ),
        }),
      ),
    ).check(Schema.isMaxLength(20)),
  ),
  // Opaque to the client: it round-trips whatever `nextCursor` said.
  cursor: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(400))),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  ),
  // The table's own column id — `name`, `createdAt`, `attr:<slug>`.
  sort: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
        desc: Schema.Boolean,
      }),
    ),
  ),
  q: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
}

export const pagedListInput = Schema.Struct(pagedListShape)

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
