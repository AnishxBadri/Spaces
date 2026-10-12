import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  entityAlias,
  entitySpace,
  interactionStat,
  link,
} from '@spaces/db/schema'
import { objectIdForKind } from '@spaces/core/writes/attributes/objects'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'
import { inversesOf, lensRegistry, withInverseValues } from './inverse'
import { listScope } from './scope'
import type { RowStats } from './stat-fields'
import {
  afterCursor,
  clampLimit,
  cutPage,
  decodeCursor,
  likeArg,
  orderByPage,
  planSort,
  sortKeyColumn,
} from './paging'
import type { SQL } from 'drizzle-orm'
import type { FieldResolver } from './sql'
import type { ListPageOptions } from './paging'
import type { Condition } from '@spaces/core/views/filter'

/**
 * `/companies` and `/people`, on views-3's contract (SPA-96).
 *
 * These two are the registry-generated list read with a different `where`:
 * the rows are `entity` rows, the conditions are over the same `values`
 * jsonb, and the sort key, the cursor and the count come from the same
 * `./paging` helpers `/o/$objectSlug` uses. Nothing here is a second pager.
 *
 * What is different is what a row carries beyond its values — a company's
 * domains, a person's emails, and their interaction stats. Those were whole-table side queries: three `select`s
 * with no `where` that built a map of every alias in the database so fifty
 * rows could read fifty entries out of it. **They run over the page's ids
 * now**, which is the only shape that survives twenty thousand companies.
 *
 * It lives outside `lib/server/` for the reason `records.ts` does:
 * `lib/server-fns.ts` is a client-imported barrel and re-exports
 * `server/companies.ts`, so a plain export from there ships to the browser —
 * only `createServerFn().handler()` bodies are stripped (CLAUDE.md, traps).
 * The server fns import this inside their handlers; a test calls it directly.
 *
 * **Why /deals and /portfolio are not here.** Both compute a number over
 * every row before they draw one: the board's stage chips count the whole
 * pipeline, and portfolio's metrics sum every holding. A page would make
 * those numbers lie about a set the reader cannot see. Their routes say so
 * at the loader.
 */

export class DirectoryQueryFailed extends Schema.TaggedError<DirectoryQueryFailed>()(
  'DirectoryQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DirectoryQueryFailed({ cause }),
  })

type ShownAliasKind = 'domain' | 'email'

/**
 * The text box narrows on the name **or** on an identity alias — a domain on
 * /companies, an email on /people. Correlated `exists`, not a join: a
 * company with three domains must still be one row.
 */
const aliasMatch = (kind: ShownAliasKind, q: string): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.entityId, entity.id),
          eq(entityAlias.kind, kind),
          ilike(entityAlias.valueNorm, likeArg(q)),
        ),
      ),
  )

const nameOrAlias = (kind: ShownAliasKind, q: string) =>
  or(ilike(entity.canonicalName, likeArg(q)), aliasMatch(kind, q))

/** Identity aliases of one kind, for the page's rows only. */
async function aliasesFor(
  kind: ShownAliasKind,
  ids: Array<string>,
): Promise<Map<string, Array<string>>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ entityId: entityAlias.entityId, value: entityAlias.valueNorm })
    .from(entityAlias)
    .where(
      and(
        eq(entityAlias.kind, kind),
        eq(entityAlias.isIdentity, true),
        inArray(entityAlias.entityId, ids),
      ),
    )
    // Oldest first, so a column that shows one shows the first claimed.
    .orderBy(asc(entityAlias.createdAt), asc(entityAlias.id))
  const by = new Map<string, Array<string>>()
  for (const r of rows)
    by.set(r.entityId, [...(by.get(r.entityId) ?? []), r.value])
  return by
}

const NO_STATS: RowStats = {
  lastContact: null,
  lastEmail: null,
  nextMeeting: null,
}

/**
 * Last contact, last email and next meeting for the page's rows, read from
 * `interaction_stat` — one primary-key range over the page's ids.
 */
async function statsFor(ids: Array<string>): Promise<Map<string, RowStats>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      entityId: interactionStat.entityId,
      kind: interactionStat.kind,
      lastAt: interactionStat.lastAt,
      nextAt: interactionStat.nextAt,
    })
    .from(interactionStat)
    .where(
      and(
        inArray(interactionStat.entityId, ids),
        inArray(interactionStat.kind, ['any', 'email']),
      ),
    )
  const by = new Map<string, RowStats>()
  for (const r of rows) {
    const cur = by.get(r.entityId) ?? NO_STATS
    by.set(
      r.entityId,
      r.kind === 'any'
        ? {
            ...cur,
            lastContact: r.lastAt?.toISOString() ?? null,
            nextMeeting: r.nextAt?.toISOString() ?? null,
          }
        : { ...cur, lastEmail: r.lastAt?.toISOString() ?? null },
    )
  }
  return by
}

/** Spaces each of the page's rows is tagged into. */
async function spacesFor(
  ids: Array<string>,
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      entityId: entitySpace.entityId,
      spaceId: entitySpace.spaceId,
      spaceName: entity.canonicalName,
    })
    .from(entitySpace)
    .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
    .where(inArray(entitySpace.entityId, ids))
  const by = new Map<string, Array<{ id: string; name: string }>>()
  for (const r of rows)
    by.set(r.entityId, [
      ...(by.get(r.entityId) ?? []),
      { id: r.spaceId, name: r.spaceName },
    ])
  return by
}

/**
 * The half both surfaces share: resolve the live registry for the kind,
 * compile the conditions and the sort against it, then cut one keyset page
 * and count the whole matching set beside it.
 *
 * The surface's own `where` — the subtype guard, the kind, not merged — is
 * `listScope(kind)`, shared with the view chips' counts (SPA-162); `search`
 * is how its text box narrows. Everything else is the pager.
 */
/** The kind's live registry, as the conditions and the sort resolve against it. */
const resolverOf = Effect.fn('resolverOf')(function* (
  kind: 'company' | 'person' | 'deal',
) {
  const objectId = yield* objectIdForKind(kind)
  // Live attributes only: an archived slug resolves to null and its
  // condition is dropped, the way `matchesConditions` skips an unknown one.
  const registry = (yield* query(() => lensRegistry(objectId))).live
  return {
    resolve: entityValuesResolver(registry),
    inverses: inversesOf(registry),
  }
})

/**
 * Everything the reader asked for, cursor excluded: the page is a window
 * onto this set, and `total` is how big it is. The text box narrows, so it
 * narrows the count too.
 */
const matchingOf = (
  kind: 'company' | 'person' | 'deal',
  resolve: FieldResolver,
  search: (q: string) => SQL | undefined,
  conditions: Array<Condition>,
  q: string,
) =>
  and(
    listScope({ kind }),
    compileConditions(conditions, resolve),
    q ? search(q) : undefined,
  )

const pageOfKind = Effect.fn('pageOfKind')(function* (
  kind: 'company' | 'person' | 'deal',
  search: (q: string) => SQL | undefined,
  conditions: Array<Condition>,
  options: ListPageOptions,
) {
  const { resolve, inverses } = yield* resolverOf(kind)
  const plan = planSort(options.sort, resolve)
  const limit = clampLimit(options.limit)
  const q = (options.q ?? '').trim()
  const matching = matchingOf(kind, resolve, search, conditions, q)
  const cursor = options.cursor ? decodeCursor(options.cursor) : null

  const page = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        createdAt: entity.createdAt,
        sortKey: sortKeyColumn(plan),
      })
      .from(entity)
      .where(cursor ? and(matching, afterCursor(plan, cursor)) : matching)
      .orderBy(orderByPage(plan))
      // One more than asked: its existence is the only question, so it is
      // never returned. `nextCursor` null is what the foot reads as "end".
      .limit(limit + 1),
  )
  const counted = yield* query(() =>
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(entity)
      .where(matching),
  )
  const { rows, nextCursor } = cutPage(page, limit)
  const filled = yield* withInverseValues(rows, inverses).pipe(
    Effect.mapError((e) => new DirectoryQueryFailed({ cause: e })),
  )
  return {
    rows: filled.rows,
    refNames: filled.refNames,
    nextCursor,
    total: counted.at(0)?.total ?? 0,
    ids: rows.map((r) => r.id),
  }
})

/**
 * The ids a list's view holds — its conditions and its text box — newest
 * first, at most `max`, with the whole count: what the list's `···` Enrich…
 * runs over.
 */
export const listIdsProgram = Effect.fn('listIdsProgram')(function* (
  kind: 'company' | 'person',
  conditions: Array<Condition>,
  q: string,
  max: number,
) {
  const { resolve } = yield* resolverOf(kind)
  const matching = matchingOf(
    kind,
    resolve,
    (text) => nameOrAlias(kind === 'company' ? 'domain' : 'email', text),
    conditions,
    q.trim(),
  )
  const rows = yield* query(() =>
    db
      .select({ id: entity.id })
      .from(entity)
      .where(matching)
      .orderBy(desc(entity.createdAt), asc(entity.id))
      .limit(max),
  )
  const counted = yield* query(() =>
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(entity)
      .where(matching),
  )
  return { ids: rows.map((r) => r.id), total: counted.at(0)?.total ?? 0 }
})

/**
 * The `/companies` table: entity core + values + spaces. `domains` is the
 * identity index read back, for the API's `records.list`; the values carry
 * the same domains as an attribute.
 */
export const listCompaniesPageProgram = Effect.fn('listCompaniesPageProgram')(
  function* (conditions: Array<Condition>, options: ListPageOptions = {}) {
    const page = yield* pageOfKind(
      'company',
      (q) => nameOrAlias('domain', q),
      conditions,
      options,
    )
    const [domains, spaces, stats] = yield* query(() =>
      Promise.all([
        aliasesFor('domain', page.ids),
        spacesFor(page.ids),
        statsFor(page.ids),
      ]),
    )
    return {
      rows: page.rows.map((r) => ({
        id: r.id,
        name: r.name,
        values: r.values,
        domains: domains.get(r.id) ?? [],
        spaces: spaces.get(r.id) ?? [],
        stats: stats.get(r.id) ?? NO_STATS,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      total: page.total,
      refNames: page.refNames,
    }
  },
)

/**
 * Names for the page's record-reference values — a person's `companies` and
 * any custom reference — so the cells can print them. Merged-away targets
 * are left out: their links have already moved to the winner.
 */
async function referenceNamesFor(
  ids: Array<string>,
): Promise<Record<string, { name: string }>> {
  if (ids.length === 0) return {}
  const rows = await db
    .select({ id: entity.id, name: entity.canonicalName })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(
        eq(link.relation, 'references'),
        isNull(entity.mergedIntoId),
        inArray(link.fromEntityId, ids),
      ),
    )
  return Object.fromEntries(rows.map((r) => [r.id, { name: r.name }]))
}

/** The `/people` table: entity core + values + identity emails + reference names. */
export const listPeoplePageProgram = Effect.fn('listPeoplePageProgram')(
  function* (conditions: Array<Condition>, options: ListPageOptions = {}) {
    const page = yield* pageOfKind(
      'person',
      (q) => nameOrAlias('email', q),
      conditions,
      options,
    )
    const [emails, refNames, stats] = yield* query(() =>
      Promise.all([
        aliasesFor('email', page.ids),
        referenceNamesFor(page.ids),
        statsFor(page.ids),
      ]),
    )
    return {
      rows: page.rows.map((r) => ({
        id: r.id,
        name: r.name,
        values: r.values,
        emails: emails.get(r.id) ?? [],
        stats: stats.get(r.id) ?? NO_STATS,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      total: page.total,
      refNames: { ...page.refNames, ...refNames },
    }
  },
)

/**
 * Deals, one keyset page at a time (SPA-80). `/deals` itself still loads
 * the whole set (`listDealsTable`, and see the module header for why), so
 * this is not what the board reads: it is the same set — `listScope('deal')`
 * — in the same newest-first order, cut by the same pager, for the one
 * caller that must page it, the external API's `records.list`. No side
 * queries: a deal row is its core and its values.
 */
export const listDealsPageProgram = Effect.fn('listDealsPageProgram')(
  function* (conditions: Array<Condition>, options: ListPageOptions = {}) {
    const page = yield* pageOfKind(
      'deal',
      (q) => ilike(entity.canonicalName, likeArg(q)),
      conditions,
      options,
    )
    return {
      rows: page.rows.map((r) => ({
        id: r.id,
        name: r.name,
        values: r.values,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      total: page.total,
    }
  },
)
