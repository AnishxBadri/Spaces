import { Effect, Schema } from 'effect'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import type { EntityValues } from '@spaces/db/schema'
import { getRecordProgram } from '#/lib/mcp/tools'
import type { McpRecord } from '#/lib/mcp/tools'
import { listRegistryProgram } from '#/lib/mcp/tools-read'
import type { RegistryObject } from '#/lib/mcp/tools-read'
import {
  listCompaniesPageProgram,
  listDealsPageProgram,
  listPeoplePageProgram,
} from '#/lib/views/directory'
import { pageOptions } from '#/lib/views/page-input'
import { decodeCursor } from '#/lib/views/paging'
import { listRecordsProgram } from '#/lib/views/records'

/**
 * The read half of integration map #11 (SPA-80): what `records.list` and
 * `records.get` in `api.ts` run, with no HttpApi import so the door stays
 * one file (`one-door.test.ts`).
 *
 * Nothing here is a query. Each procedure calls the program the app already
 * calls for the same question (decision 4: the server fn and the procedure
 * share the program, neither is a copy):
 *
 * - `registry.list` is `listRegistryProgram`, the MCP `list_registry` read —
 *   live on every call, so an object created a minute ago is listed.
 * - `records.list(object)` resolves the object through that same registry
 *   read (slug, singular or plural), then hands the page to the program the
 *   object's in-app list runs: `listCompaniesPageProgram` for `/companies`,
 *   `listPeoplePageProgram` for `/people`, `listRecordsProgram` for
 *   `/o/$objectSlug`, and `listDealsPageProgram` — the same scope and pager —
 *   for deals, whose board loads whole. No conditions, no sort, no text box:
 *   the order is the in-app default, newest first on `(created_at, id)`, and
 *   the cursor is that pager's keyset cursor, so a row created or deleted
 *   while a caller pages neither repeats nor drops another.
 * - `records.get(id)` is `getRecordProgram`, the MCP `get_record` read, run
 *   as the token's user: canRead is in it, so a private note the user may not
 *   read is not found, and is dropped from the far end of every link.
 *
 * Serialized registry-shaped: `values` is keyed by attribute slug, holds the
 * live registry's attributes only (an archived attribute is not in
 * `registry.list`, so its leftover value could not be interpreted), and an
 * unset attribute is absent rather than null.
 */

/** A cursor this API did not hand out. 400, never "start again". */
export class UnreadableCursor extends Schema.TaggedError<UnreadableCursor>()(
  'UnreadableCursor',
  { message: Schema.String },
) {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The in-app pager reads an unreadable cursor as page one, which is right
 * for a grid and wrong for a poller: a caller whose cursor was mangled would
 * silently walk the table again from the top. The API refuses it instead.
 */
const checkCursor = (
  cursor: string | undefined,
): Effect.Effect<void, UnreadableCursor> => {
  if (cursor === undefined) return Effect.void
  const decoded = decodeCursor(cursor)
  return decoded !== null && UUID.test(decoded.id)
    ? Effect.void
    : Effect.fail(
        new UnreadableCursor({
          message:
            'cursor is not one this API handed out — pass a previous page’s nextCursor, or omit it for the first page',
        }),
      )
}

export type ApiRecordRow = {
  id: string
  name: string
  createdAt: string
  values: EntityValues
  /** Companies only: their identity domains, as `/companies` shows them. */
  domains?: Array<string>
  /** People only: their identity emails, as `/people` shows them. */
  emails?: Array<string>
}

export type ApiRecordPage = {
  object: string
  rows: Array<ApiRecordRow>
  nextCursor: string | null
  total: number
}

/** `values` narrowed to the live registry's slugs, unset left out. */
const registryShaped = (
  values: EntityValues,
  slugs: ReadonlySet<string>,
): EntityValues => {
  const out: EntityValues = {}
  for (const [slug, value] of Object.entries(values))
    if (slugs.has(slug) && value !== null) out[slug] = value
  return out
}

/** Which in-app list an object's rows are read through. */
const listOf = (object: RegistryObject) => {
  if (object.isSystem && object.slug === CORE_OBJECTS.company.slug)
    return 'company'
  if (object.isSystem && object.slug === CORE_OBJECTS.person.slug)
    return 'person'
  if (object.isSystem && object.slug === CORE_OBJECTS.deal.slug) return 'deal'
  return 'custom'
}

export const listApiRecordsProgram = Effect.fn('listApiRecordsProgram')(
  function* (objectRef: string, page: { cursor?: string; limit?: number }) {
    yield* checkCursor(page.cursor)
    // One object, by slug, singular or plural; an unknown name refuses with
    // the slugs there are (`McpToolRefused`, a 404 at the door).
    const [object] = yield* listRegistryProgram({ object: objectRef })
    const slugs = new Set(object.attributes.map((a) => a.slug))
    const options = pageOptions(page)
    const core = (r: {
      id: string
      name: string
      createdAt: string
      values: EntityValues
    }): ApiRecordRow => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      values: registryShaped(r.values, slugs),
    })
    const list = listOf(object)
    const answer =
      list === 'company'
        ? yield* Effect.map(listCompaniesPageProgram([], options), (p) => ({
            ...p,
            rows: p.rows.map((r) => ({ ...core(r), domains: r.domains })),
          }))
        : list === 'person'
          ? yield* Effect.map(listPeoplePageProgram([], options), (p) => ({
              ...p,
              rows: p.rows.map((r) => ({ ...core(r), emails: r.emails })),
            }))
          : list === 'deal'
            ? yield* Effect.map(listDealsPageProgram([], options), (p) => ({
                ...p,
                rows: p.rows.map(core),
              }))
            : yield* Effect.map(
                listRecordsProgram(object.id, [], options),
                (p) => ({ ...p, rows: p.rows.map(core) }),
              )
    const result: ApiRecordPage = {
      object: object.slug,
      rows: answer.rows,
      nextCursor: answer.nextCursor,
      total: answer.total,
    }
    return result
  },
)

export type ApiRecord = Omit<McpRecord, 'attributes'> & {
  values: EntityValues
}

/**
 * One record as the token's user may see it. `getRecordProgram`'s
 * attributes arrive in registry order with the stored value; the wire keys
 * them by slug, like a list row, and leaves unset ones out. A reference's
 * target is named in `links`, by the attribute slug it materializes.
 */
export const getApiRecordProgram = Effect.fn('getApiRecordProgram')(function* (
  reader: { id: string },
  id: string,
) {
  const { attributes, ...record } = yield* getRecordProgram(reader, id)
  const values: EntityValues = {}
  for (const a of attributes) if (a.value !== null) values[a.slug] = a.value
  const result: ApiRecord = { ...record, values }
  return result
})
