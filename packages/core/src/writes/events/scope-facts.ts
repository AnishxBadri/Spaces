import { Effect } from 'effect'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, link, space } from '@spaces/db/schema'
import type { DomainEvent } from '@spaces/sdk'
import type {
  AutoEnrichScope,
  ScopeFacts,
} from '@spaces/core/plugins/auto-enrich'

/**
 * What the auto-enrich scopes ask about an event's record, read only as far
 * as the scopes ask. The dispatcher's event jobs and the host's enrichment
 * run read it the same way.
 */

const read = <T>(run: () => Promise<T>) => Effect.tryPromise(run)

/** Whether the record is a party of a live deal: its `company` or one of its `people`. */
const isDealParty = (entityId: string) =>
  read(async () => {
    const hit = await db
      .select({ id: link.id })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, entityId),
          eq(link.relation, 'references'),
          inArray(link.attrSlug, ['company', 'people']),
          eq(entity.kind, 'deal'),
          isNull(entity.mergedIntoId),
        ),
      )
      .limit(1)
    return hit.length > 0
  })

/** Space paths by id. */
const spacePaths = (ids: ReadonlyArray<string>) =>
  read(async () =>
    ids.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await db
              .select({ id: space.entityId, path: space.path })
              .from(space)
              .where(inArray(space.entityId, [...ids]))
          ).map((r) => [r.id, r.path]),
        ),
  )

/** The paths of every space the record is filed in. */
const filedPathsOf = (entityId: string) =>
  read(async () =>
    (
      await db
        .select({ path: space.path })
        .from(entitySpace)
        .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
        .where(eq(entitySpace.entityId, entityId))
    ).map((r) => r.path),
  )

/** The facts `scopes` ask about the event's record. */
export const scopeFacts = Effect.fn('scopeFacts')(function* (
  event: DomainEvent,
  scopes: ReadonlyArray<AutoEnrichScope>,
) {
  const chosen = [...new Set(scopes.flatMap((s) => s.spaces))]
  const wantsSpace = scopes.some((s) => s.scopes.includes('space'))
  const wantsDeal = scopes.some((s) => s.scopes.includes('deal'))
  const chosenPaths: ReadonlyMap<string, string> = wantsSpace
    ? yield* spacePaths(chosen)
    : new Map()
  switch (event.name) {
    case 'deal.linked': {
      const facts: ScopeFacts = { dealParty: true, filedPaths: [], chosenPaths }
      return facts
    }
    case 'interaction.logged': {
      // The meeting scope asks nothing about the record.
      const facts: ScopeFacts = {
        dealParty: false,
        filedPaths: [],
        chosenPaths,
      }
      return facts
    }
    case 'filed': {
      const own = wantsSpace
        ? (yield* spacePaths([event.spaceId])).get(event.spaceId)
        : undefined
      const facts: ScopeFacts = {
        dealParty: false,
        filedPaths: own === undefined ? [] : [own],
        chosenPaths,
      }
      return facts
    }
    case 'entity.created':
    case 'identity.added': {
      const facts: ScopeFacts = {
        dealParty: wantsDeal ? yield* isDealParty(event.entityId) : false,
        filedPaths: wantsSpace ? yield* filedPathsOf(event.entityId) : [],
        chosenPaths,
      }
      return facts
    }
  }
})
