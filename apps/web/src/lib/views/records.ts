import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, entitySpace, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'
import type { Condition } from '@spaces/core/views/filter'

/**
 * The registry-generated list page's rows, filtered in Postgres (SPA-40).
 *
 * This is the read `listObjectRecords` wraps. It lives outside
 * `lib/server/` on purpose: `lib/server-fns.ts` is a client-imported barrel
 * and re-exports `server/objects.ts`, so a plain export from there ships to
 * the browser — only `createServerFn().handler()` bodies are stripped
 * (CLAUDE.md, traps). A test that wants the query without a request calls
 * this program directly.
 *
 * The live registry read is what makes an archived attribute *ignorable*
 * rather than exclusionary: it never reaches the resolver, so its condition
 * is dropped and the list widens.
 */

export class RecordQueryFailed extends Schema.TaggedError<RecordQueryFailed>()(
  'RecordQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecordQueryFailed({ cause }),
  })

export const listRecordsProgram = Effect.fn('listRecordsProgram')(function* (
  objectId: string,
  conditions: Array<Condition>,
) {
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
  const filter = compileConditions(conditions, entityValuesResolver(registry))

  const rows = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        createdAt: entity.createdAt,
      })
      .from(entity)
      .where(
        and(
          eq(entity.objectId, objectId),
          eq(entity.kind, 'custom'),
          isNull(entity.mergedIntoId),
          filter,
        ),
      )
      .orderBy(desc(entity.createdAt)),
  )
  const ids = rows.map((r) => r.id)
  const tags =
    ids.length > 0
      ? yield* query(() =>
          db
            .select({
              entityId: entitySpace.entityId,
              spaceId: entitySpace.spaceId,
              spaceName: entity.canonicalName,
            })
            .from(entitySpace)
            .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
            .where(inArray(entitySpace.entityId, ids)),
        )
      : []
  const spacesBy = new Map<string, Array<{ id: string; name: string }>>()
  for (const t of tags)
    spacesBy.set(t.entityId, [
      ...(spacesBy.get(t.entityId) ?? []),
      { id: t.spaceId, name: t.spaceName },
    ])
  // Names for record-reference values, so cells can render them.
  const refs =
    ids.length > 0
      ? yield* query(() =>
          db
            .select({ toId: link.toEntityId, name: entity.canonicalName })
            .from(link)
            .innerJoin(entity, eq(entity.id, link.toEntityId))
            .where(
              and(
                eq(link.relation, 'references'),
                inArray(link.fromEntityId, ids),
              ),
            ),
        )
      : []
  const users = yield* query(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  )
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      values: r.values,
      spaces: spacesBy.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
    })),
    refNames: {
      ...Object.fromEntries(refs.map((r) => [r.toId, { name: r.name }])),
      ...Object.fromEntries(users.map((u) => [u.id, { name: u.name }])),
    },
  }
})
