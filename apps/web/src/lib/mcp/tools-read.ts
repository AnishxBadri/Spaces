import { Effect } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, objectDef } from '@spaces/db/schema'
import type { AttributeOptions } from '@spaces/db/schema'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import type { IdentityKey } from '@spaces/core/attributes/registry'
import { searchAllProgram } from '#/lib/search/query'
import type { SearchHit } from '#/lib/search/query'
import { McpToolQueryFailed, McpToolRefused } from './tools'

/**
 * The other two read tools of the MCP surface (SPA-28, spec §5):
 *
 * - `search_records(query, object?)` — Cmd-K's search, `searchAllProgram`,
 *   run as the token's user. canRead is the program's own: the private-note
 *   carve-out is in its SQL on every lane that can reach a note, keyed on the
 *   user id handed in, so the assistant sees what its owner's palette shows.
 *   It always asks for the semantic lane, as the palette's settled second
 *   wave does; with no embedding pin (or a provider that fails) the program
 *   answers the lexical statement, so the tool never needs a provider.
 * - `list_registry(object?)` — the object registry: every live object, and
 *   under each its live attributes in registry order with their per-type
 *   config (select/status options, reference targets, currency codes). Read
 *   from the database on every call, so an object or attribute created a
 *   minute ago is in the next answer with no restart.
 *
 * Nothing here writes. `object` is spoken the way a person names it — the
 * slug, the singular or the plural, in any case — so "Fund" and "funds"
 * both find the Funds object.
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new McpToolQueryFailed({ cause }),
  })

type Reader = { id: string }

type LiveObject = {
  id: string
  slug: string
  singular: string
  plural: string
  isSystem: boolean
  identityKeys: Array<IdentityKey>
}

/** Live (unarchived) objects, system rows first, then by creation. */
const liveObjects = Effect.fn('liveObjects')(function* (): Effect.fn.Return<
  Array<LiveObject>,
  McpToolQueryFailed
> {
  const rows = yield* query(() =>
    db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        isSystem: objectDef.isSystem,
        identityKeys: objectDef.identityKeys,
      })
      .from(objectDef)
      .where(eq(objectDef.archived, false))
      .orderBy(asc(objectDef.createdAt), asc(objectDef.slug)),
  )
  return [...rows].sort((a, b) => Number(b.isSystem) - Number(a.isSystem))
})

/**
 * One object by slug, singular or plural, case-insensitively. An unknown
 * name refuses with the slugs there are, so the assistant can ask again.
 */
const pickObject = (
  objects: ReadonlyArray<LiveObject>,
  ref: string,
): Effect.Effect<LiveObject, McpToolRefused> => {
  const wanted = ref.trim().toLowerCase()
  const hit = objects.find((o) =>
    [o.slug, o.singular, o.plural].some((n) => n.toLowerCase() === wanted),
  )
  return hit
    ? Effect.succeed(hit)
    : Effect.fail(
        new McpToolRefused({
          message: `No object "${ref.trim()}" — the objects are: ${objects
            .map((o) => o.slug)
            .join(', ')}`,
        }),
      )
}

export const searchRecordsProgram = Effect.fn('searchRecordsProgram')(
  function* (
    reader: Reader,
    input: { query: string; object?: string | undefined },
  ): Effect.fn.Return<Array<SearchHit>, McpToolRefused | McpToolQueryFailed> {
    const narrowed =
      input.object === undefined
        ? null
        : yield* pickObject(yield* liveObjects(), input.object)
    return yield* searchAllProgram({
      userId: reader.id,
      q: input.query,
      semantic: true,
      ...(narrowed === null ? {} : { objectId: narrowed.id }),
    }).pipe(Effect.mapError((e) => new McpToolQueryFailed({ cause: e })))
  },
)

export type RegistryAttribute = {
  id: string
  slug: string
  name: string
  description: string | null
  type: string
  isSystem: boolean
  /**
   * The slug of the object a `record_reference` points at; null for every
   * other type, and for a reference whose target is gone.
   */
  target: string | null
  /** Per-type config as stored: options, target, multi, code, max, default. */
  options: AttributeOptions
}

export type RegistryObject = {
  id: string
  slug: string
  singular: string
  plural: string
  isSystem: boolean
  identityKeys: Array<IdentityKey>
  attributes: Array<RegistryAttribute>
}

export const listRegistryProgram = Effect.fn('listRegistryProgram')(
  function* (input: {
    object?: string | undefined
  }): Effect.fn.Return<
    Array<RegistryObject>,
    McpToolRefused | McpToolQueryFailed
  > {
    const objects = yield* liveObjects()
    const shown =
      input.object === undefined
        ? objects
        : [yield* pickObject(objects, input.object)]
    // Reference targets are named by slug, archived objects included: a
    // reference into an archived object still stores its ids.
    const slugById = new Map(
      (yield* query(() =>
        db.select({ id: objectDef.id, slug: objectDef.slug }).from(objectDef),
      )).map((o) => [o.id, o.slug] as const),
    )
    const targetOf = (options: AttributeOptions): string | null =>
      options.targetObjectId !== undefined
        ? (slugById.get(options.targetObjectId) ?? null)
        : options.targetKind !== undefined
          ? CORE_OBJECTS[options.targetKind].slug
          : null
    // Live attributes in registry order — the filter and order the write
    // path validates against (`getRegistryByObjectId`), read in one query
    // for every object shown, with the description that reader leaves out.
    const defs =
      shown.length === 0
        ? []
        : yield* query(() =>
            db
              .select({
                id: attribute.id,
                objectId: attribute.objectId,
                slug: attribute.slug,
                name: attribute.name,
                description: attribute.description,
                type: attribute.type,
                isSystem: attribute.isSystem,
                options: attribute.options,
              })
              .from(attribute)
              .where(
                and(
                  inArray(
                    attribute.objectId,
                    shown.map((o) => o.id),
                  ),
                  eq(attribute.archived, false),
                ),
              )
              .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
          )
    return shown.map((o) => ({
      ...o,
      attributes: defs
        .filter((d) => d.objectId === o.id)
        .map((d) => ({
          id: d.id,
          slug: d.slug,
          name: d.name,
          description: d.description,
          type: d.type,
          isSystem: d.isSystem,
          target: d.type === 'record_reference' ? targetOf(d.options) : null,
          options: d.options,
        })),
    }))
  },
)
