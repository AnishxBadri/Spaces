import { Effect } from 'effect'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  attribute,
  entity,
  entitySpace,
  objectDef,
  space,
} from '@spaces/db/schema'
import type { AttributeOptions, EntityValues } from '@spaces/db/schema'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import type { IdentityKey } from '@spaces/core/attributes/registry'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import type { Condition, ConditionOp } from '@spaces/core/views/filter'
import { searchAllProgram } from '#/lib/search/query'
import type { SearchHit } from '#/lib/search/query'
import { compileViewWhere, scopeOf, viewLensProgram } from '#/lib/views/counts'
import type { ViewLens } from '#/lib/views/counts'
import {
  clampLimit,
  orderByPage,
  planSort,
  sortKeyColumn,
} from '#/lib/views/paging'
import type { SortPlan } from '#/lib/views/paging'
import { interactionStatAt, interactionStatDay } from '#/lib/views/resolve'
import { listScope } from '#/lib/views/scope'
import type { FieldResolver } from '#/lib/views/sql'
import { interactionStatField } from '#/lib/views/stat-fields'
import type { InteractionStatField } from '#/lib/views/stat-fields'
import type { SQL } from 'drizzle-orm'
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
 * - `query_records(object, conditions, sort, limit)` — the views compiler
 *   behind a door: computed filters, order and counts. (D70, D71)
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

// ---------------------------------------------------------------------------
// query_records (D70, D71)

/**
 * The interaction-stat columns `query_records` names beside attributes,
 * read from `interaction_stat` through the compiler's helpers. (D67)
 * - A registry attribute with the same slug wins.
 * - The list pages' `stat:` slugs are accepted too.
 */
export const QUERY_STATS: ReadonlyMap<
  string,
  Pick<InteractionStatField, 'kind' | 'at'>
> = new Map([
  ['last_interaction', { kind: 'any', at: 'last' }],
  ['first_email', { kind: 'email', at: 'first' }],
  ['last_email', { kind: 'email', at: 'last' }],
  ['next_meeting', { kind: 'any', at: 'next' }],
])

/** At most this many rows per call; a larger `limit` is clamped. */
export const QUERY_RECORDS_MAX = 200

const STAT_NAMES = [...QUERY_STATS.keys()].join(', ')

const CONDITION_OPS = [
  'is',
  'is_not',
  'contains',
  'empty',
  'not_empty',
  'gt',
  'lt',
] as const satisfies ReadonlyArray<ConditionOp>

const conditionValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
])
const opCondition = z.object({
  op: z.enum(CONDITION_OPS),
  value: conditionValue.optional(),
})
const spaceCondition = z.object({
  id: z.string().min(1),
  includeDescendants: z.boolean().optional(),
})

/** The tool's input, validated by zod at the MCP boundary. */
export const queryRecordsShape = {
  object: z
    .string()
    .min(1)
    .describe(
      'An object’s slug, singular or plural name (see list_registry): companies, people, deals or a custom object',
    ),
  conditions: z
    .object({
      space: spaceCondition
        .optional()
        .describe(
          'Records filed in this space (its id, or its exact name). includeDescendants, default true, also takes records filed in any space below it',
        ),
    })
    // The catchall names `spaceCondition` too only so the inferred index
    // signature admits `space`; `splitConditions` refuses it on any other key.
    .catchall(
      z.union([
        conditionValue,
        opCondition,
        z.array(opCondition).min(1),
        spaceCondition,
      ]),
    )
    .optional()
    .describe(
      `{[attribute slug]: value | {op, value} | [{op, value}, …]}, all ANDed; a bare value means op "is". Ops: is, is_not, contains, empty, not_empty (no value), gt, lt. Select and status values are option ids (see list_registry). Also the interaction columns ${STAT_NAMES}, compared as YYYY-MM-DD days`,
    ),
  sort: z
    .object({
      by: z
        .string()
        .min(1)
        .describe(
          `An attribute flagged filterable or sortable, or one of ${STAT_NAMES}`,
        ),
      direction: z.enum(['asc', 'desc']).optional(),
    })
    .optional()
    .describe('Default: newest records first. Empty values sort last'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Rows to return; default 50, at most ${QUERY_RECORDS_MAX} (more is clamped)`,
    ),
}

const queryRecordsInput = z.object(queryRecordsShape)
export type QueryRecordsInput = z.infer<typeof queryRecordsInput>

export type QueryRecordsRow = {
  id: string
  name: string
  /** Stored attribute values keyed by slug, as get_record reads them. */
  values: EntityValues
  /** The sort key as text; null when the record has none. */
  sortValue: string | null
}

export type QueryRecordsResult = {
  object: string
  /** Every readable record that matches, not only the rows returned. */
  total: number
  rows: Array<QueryRecordsRow>
}

type FiledSpace = { id: string; path: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A space by id or exact name; a shared name refuses with the candidates. */
const resolveSpaceProgram = Effect.fn('resolveSpaceProgram')(function* (
  ref: string,
): Effect.fn.Return<FiledSpace, McpToolRefused | McpToolQueryFailed> {
  const wanted = ref.trim()
  const rows = yield* query(() =>
    db
      .select({ id: space.entityId, path: space.path })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        UUID.test(wanted)
          ? eq(space.entityId, wanted.toLowerCase())
          : and(
              isNull(entity.mergedIntoId),
              sql`lower(${entity.canonicalName}) = lower(${wanted})`,
            ),
      )
      .orderBy(asc(space.path)),
  )
  const only = rows.at(0)
  if (!only)
    return yield* new McpToolRefused({ message: `No space "${wanted}"` })
  if (rows.length > 1)
    return yield* new McpToolRefused({
      message: `${rows.length} spaces are named "${wanted}" — ask again by id: ${rows
        .map((r) => `${r.path} (${r.id})`)
        .join('; ')}`,
    })
  return only
})

/**
 * Filed in the space, or with descendants in any space whose path sits
 * under it — ancestor visibility, one `exists` per row. (D71)
 */
export const inSpaceSql = (at: FiledSpace, includeDescendants: boolean): SQL =>
  includeDescendants
    ? sql`exists (select 1 from ${entitySpace} inner join ${space} on ${space.entityId} = ${entitySpace.spaceId} where ${entitySpace.entityId} = ${entity.id} and ${space.path} <@ ${at.path}::ltree)`
    : sql`exists (select 1 from ${entitySpace} where ${entitySpace.entityId} = ${entity.id} and ${entitySpace.spaceId} = ${at.id}::uuid)`

/** canRead as the reader, in the `where`, so rows and total agree. */
export const canReadRecordSql = (userId: string): SQL =>
  sql`exists (select 1 from ${entity} e where e.id = ${entity.id} and ${canReadNoteSql(userId)})`

type SpaceFilter = { ref: string; includeDescendants: boolean }

/**
 * The keyed conditions as the compiler's list, with `space` set apart. A
 * value it cannot read refuses, naming its key; nothing is dropped.
 */
function splitConditions(
  conditions: QueryRecordsInput['conditions'],
): { list: Array<Condition>; filed: SpaceFilter | null } | { refused: string } {
  const list: Array<Condition> = []
  let filed: SpaceFilter | null = null
  for (const [slug, raw] of Object.entries(conditions ?? {})) {
    if (slug === 'space') {
      const parsed = spaceCondition.safeParse(raw)
      if (!parsed.success)
        return { refused: 'The space condition takes {id, includeDescendants}' }
      filed = {
        ref: parsed.data.id,
        includeDescendants: parsed.data.includeDescendants ?? true,
      }
      continue
    }
    const each =
      Array.isArray(raw) && raw.some((x) => typeof x === 'object') ? raw : [raw]
    for (const c of each) {
      const withOp = opCondition.safeParse(c)
      const bare = conditionValue.safeParse(c)
      if (withOp.success) {
        const { op, value } = withOp.data
        list.push(value === undefined ? { slug, op } : { slug, op, value })
      } else if (bare.success) list.push({ slug, op: 'is', value: bare.data })
      else
        return {
          refused: `The condition on "${slug}" is not a value, {op, value} or a list of them`,
        }
    }
  }
  return { list, filed }
}

/**
 * The list pages' resolver (live attributes, `stat:` slugs), then the stat
 * names above as their UTC day, as a `stat:` condition reads.
 */
const toolResolver =
  (lens: ViewLens): FieldResolver =>
  (slug) => {
    const own = lens.resolve(slug)
    if (own) return own
    const stat = QUERY_STATS.get(slug)
    return stat ? { expr: interactionStatDay(stat), type: 'date' } : null
  }

/** The order asked for, or a refusal naming what this object can sort on. */
function planToolSort(
  sort: QueryRecordsInput['sort'],
  lens: ViewLens,
  sortable: ReadonlyArray<string>,
  objectSlug: string,
): Effect.Effect<SortPlan, McpToolRefused> {
  if (sort === undefined) return Effect.succeed(planSort(null, lens.resolve))
  const by = sort.by.trim()
  const desc = sort.direction === 'desc'
  if (sortable.includes(by))
    return Effect.succeed(planSort({ id: `attr:${by}`, desc }, lens.resolve))
  if (interactionStatField(by))
    return Effect.succeed(planSort({ id: by, desc }, lens.resolve))
  const known = lens.resolve(by) !== null
  const stat = QUERY_STATS.get(by)
  if (!known && stat)
    return Effect.succeed({
      expr: interactionStatAt(stat),
      cast: 'timestamptz',
      desc,
    })
  const why = known
    ? `"${by}" is not flagged filterable or sortable on ${objectSlug}`
    : `No attribute "${by}" on ${objectSlug}`
  return Effect.fail(
    new McpToolRefused({
      message: `${why} — sort by one of: ${[...sortable, STAT_NAMES].join(', ')}`,
    }),
  )
}

/** One statement's worth of query, compiled; nothing has run. */
export type CompiledRecordQuery = {
  object: LiveObject
  where: SQL
  plan: SortPlan
  limit: number
}

/** The page statement, unexecuted, so a plan test can EXPLAIN it. */
export const recordsPageStatement = (q: CompiledRecordQuery) =>
  db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      sortValue: sortKeyColumn(q.plan),
    })
    .from(entity)
    .where(q.where)
    .orderBy(orderByPage(q.plan))
    .limit(q.limit)

/**
 * Conditions, space and sort compiled over the object's list scope as the
 * reader. The `where` is the counts compiler's (`compileViewWhere` inside
 * `listScope`) plus the space and canRead clauses, and `total` counts it.
 * - An unknown slug refuses, naming it; it never widens the set.
 */
export const compileRecordQueryProgram = Effect.fn('compileRecordQueryProgram')(
  function* (
    reader: Reader,
    input: QueryRecordsInput,
  ): Effect.fn.Return<
    CompiledRecordQuery,
    McpToolRefused | McpToolQueryFailed
  > {
    const object = yield* pickObject(yield* liveObjects(), input.object)
    const lens = yield* viewLensProgram(object.id).pipe(
      Effect.mapError((e) => new McpToolQueryFailed({ cause: e })),
    )
    const split = splitConditions(input.conditions)
    if ('refused' in split)
      return yield* new McpToolRefused({ message: split.refused })
    const { list, filed } = split

    const compiled = compileViewWhere(list, {
      ...lens,
      resolve: toolResolver(lens),
    })
    if ('lost' in compiled)
      return yield* new McpToolRefused({
        message: compiled.archived
          ? `Cannot filter on "${compiled.lost}": it is archived on ${object.slug}`
          : `No attribute "${compiled.lost}" on ${object.slug} — see list_registry, or use ${STAT_NAMES}`,
      })

    const sortable = (yield* query(() =>
      db
        .select({ slug: attribute.slug })
        .from(attribute)
        .where(
          and(
            eq(attribute.objectId, object.id),
            eq(attribute.archived, false),
            or(eq(attribute.filterable, true), eq(attribute.sortable, true)),
          ),
        )
        .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
    )).map((a) => a.slug)
    const plan = yield* planToolSort(input.sort, lens, sortable, object.slug)

    const inSpace =
      filed === null
        ? undefined
        : inSpaceSql(
            yield* resolveSpaceProgram(filed.ref),
            filed.includeDescendants,
          )
    return {
      object,
      where:
        and(
          listScope(scopeOf(object)),
          compiled.where,
          inSpace,
          canReadRecordSql(reader.id),
        ) ?? sql`true`,
      plan,
      limit: Math.min(clampLimit(input.limit), QUERY_RECORDS_MAX),
    }
  },
)

export const queryRecordsProgram = Effect.fn('queryRecordsProgram')(function* (
  reader: Reader,
  input: QueryRecordsInput,
): Effect.fn.Return<QueryRecordsResult, McpToolRefused | McpToolQueryFailed> {
  const q = yield* compileRecordQueryProgram(reader, input)
  const rows = yield* query(() => recordsPageStatement(q))
  const counted = yield* query(() =>
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(entity)
      .where(q.where),
  )
  return {
    object: q.object.slug,
    total: counted.at(0)?.total ?? 0,
    rows,
  }
})
