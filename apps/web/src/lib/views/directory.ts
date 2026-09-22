import { Effect, Schema } from 'effect'
import { and, eq, exists, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  company,
  entity,
  entityAlias,
  entitySpace,
  interaction,
  interactionEntity,
  link,
  person,
} from '@spaces/db/schema'
import { objectIdForKind } from '../attributes/objects'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'
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
 * domains, a person's emails and employer, and when either was last touched
 * by an interaction. Those were whole-table side queries: three `select`s
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

/**
 * The text box narrows on the name **or** on the identity alias the surface
 * shows in its second column — a domain on /companies, an email on /people.
 * The box used to be a client filter over every loaded row and matched both,
 * so moving it to SQL without the alias half would have quietly deleted
 * "find the company whose domain I remember". Correlated `exists`, not a
 * join: a company with three domains must still be one row.
 */
const aliasMatch = (kind: 'domain' | 'email', q: string): SQL =>
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

const nameOrAlias = (kind: 'domain' | 'email', q: string) =>
  or(ilike(entity.canonicalName, likeArg(q)), aliasMatch(kind, q))

/** Identity aliases of one kind, for the page's rows only. */
async function aliasesFor(
  kind: 'domain' | 'email',
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
  const by = new Map<string, Array<string>>()
  for (const r of rows)
    by.set(r.entityId, [...(by.get(r.entityId) ?? []), r.value])
  return by
}

/**
 * Last interaction per record, for the page's rows only. It was a `group by`
 * over every interaction edge in the database (`lastTouchedMap`, SPA-96
 * removed it); scoping it to the page turns a whole-table aggregate into an
 * index range.
 */
async function lastTouchedFor(
  ids: Array<string>,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      entityId: interactionEntity.entityId,
      last: sql<string>`max(${interaction.occurredAt})`,
    })
    .from(interactionEntity)
    .innerJoin(interaction, eq(interaction.id, interactionEntity.interactionId))
    .where(inArray(interactionEntity.entityId, ids))
    .groupBy(interactionEntity.entityId)
  return new Map(rows.map((r) => [r.entityId, new Date(r.last).toISOString()]))
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
 * `extra` is the surface's own `where` — the subtype join guard and the kind
 * — and `search` is how its text box narrows. Everything else is the pager.
 */
const pageOfKind = Effect.fn('pageOfKind')(function* (
  kind: 'company' | 'person',
  extra: SQL | undefined,
  search: (q: string) => SQL | undefined,
  conditions: Array<Condition>,
  options: ListPageOptions,
) {
  const objectId = yield* objectIdForKind(kind)
  // Live attributes only: an archived slug resolves to null and its
  // condition is dropped, the way `matchesConditions` skips an unknown one.
  const registry = yield* query(() =>
    db
      .select({ slug: attribute.slug, type: attribute.type })
      .from(attribute)
      .where(
        and(eq(attribute.objectId, objectId), eq(attribute.archived, false)),
      ),
  )
  const resolve = entityValuesResolver(registry)
  const plan = planSort(options.sort, resolve)
  const limit = clampLimit(options.limit)
  const q = (options.q ?? '').trim()

  // Everything the reader asked for, cursor excluded: the page is a window
  // onto this set, and `total` is how big it is. The text box narrows, so it
  // narrows the count too — "12 of 20,000" when twelve is the whole truth is
  // two lies in one line.
  const matching = and(
    extra,
    isNull(entity.mergedIntoId),
    compileConditions(conditions, resolve),
    q ? search(q) : undefined,
  )
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
  return {
    rows,
    nextCursor,
    total: counted.at(0)?.total ?? 0,
    ids: rows.map((r) => r.id),
  }
})

/** The `/companies` table: entity core + values + domains + spaces. */
export const listCompaniesPageProgram = Effect.fn('listCompaniesPageProgram')(
  function* (conditions: Array<Condition>, options: ListPageOptions = {}) {
    const page = yield* pageOfKind(
      'company',
      // The subtype row is the guard the old `innerJoin company` was; as an
      // `exists` it cannot multiply a row, and the pager owns the `from`.
      and(
        eq(entity.kind, 'company'),
        exists(
          db
            .select({ one: sql`1` })
            .from(company)
            .where(eq(company.entityId, entity.id)),
        ),
      ),
      (q) => nameOrAlias('domain', q),
      conditions,
      options,
    )
    const [domains, spaces, touched] = yield* query(() =>
      Promise.all([
        aliasesFor('domain', page.ids),
        spacesFor(page.ids),
        lastTouchedFor(page.ids),
      ]),
    )
    return {
      rows: page.rows.map((r) => ({
        id: r.id,
        name: r.name,
        values: r.values,
        domains: domains.get(r.id) ?? [],
        spaces: spaces.get(r.id) ?? [],
        lastTouched: touched.get(r.id) ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      total: page.total,
    }
  },
)

/** Employer per person, for the page's rows only. */
async function employersFor(
  ids: Array<string>,
): Promise<Map<string, { id: string; name: string }>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      personId: link.fromEntityId,
      companyId: entity.id,
      companyName: entity.canonicalName,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(
        eq(link.relation, 'contact_at'),
        isNull(entity.mergedIntoId),
        inArray(link.fromEntityId, ids),
      ),
    )
  return new Map(
    rows.map((r) => [r.personId, { id: r.companyId, name: r.companyName }]),
  )
}

/** The `/people` table: entity core + values + emails + employer. */
export const listPeoplePageProgram = Effect.fn('listPeoplePageProgram')(
  function* (conditions: Array<Condition>, options: ListPageOptions = {}) {
    const page = yield* pageOfKind(
      'person',
      // `/people` filtered on the subtype row alone, never on `entity.kind`;
      // that is preserved rather than tightened here.
      exists(
        db
          .select({ one: sql`1` })
          .from(person)
          .where(eq(person.entityId, entity.id)),
      ),
      (q) => nameOrAlias('email', q),
      conditions,
      options,
    )
    const [emails, employers, touched] = yield* query(() =>
      Promise.all([
        aliasesFor('email', page.ids),
        employersFor(page.ids),
        lastTouchedFor(page.ids),
      ]),
    )
    return {
      rows: page.rows.map((r) => ({
        id: r.id,
        name: r.name,
        values: r.values,
        emails: emails.get(r.id) ?? [],
        company: employers.get(r.id) ?? null,
        lastTouched: touched.get(r.id) ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      total: page.total,
    }
  },
)
