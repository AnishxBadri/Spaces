import { Effect, Schema } from 'effect'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, space } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { raiseSensitivity, stampedSensitive } from '../ai/stamp-sensitivity'
import type { StampScope } from '../ai/stamp-sensitivity'

/**
 * Space writes: archive, restore and move (D73), and criteria (D72). Rename is
 * `renameRecordProgram` on the space entity.
 * - The ltree path is the only derived structure; every reader computes from
 *   it, so a move rewrites paths and nothing else but the sensitivity cache.
 * - Filings (`entity_space`) are never touched here.
 */

export class SpaceNotFound extends Schema.TaggedError<SpaceNotFound>()(
  'SpaceNotFound',
  { id: Schema.String, message: Schema.String },
) {}

/** Refused: a seeded root still holds unarchived children. */
export class SeededRootHasChildren extends Schema.TaggedError<SeededRootHasChildren>()(
  'SeededRootHasChildren',
  { id: Schema.String, children: Schema.Number, message: Schema.String },
) {}

/** Refused: the target is the space itself or one of its descendants. */
export class MoveUnderSelf extends Schema.TaggedError<MoveUnderSelf>()(
  'MoveUnderSelf',
  { id: Schema.String, targetId: Schema.String, message: Schema.String },
) {}

/** Refused: a sibling under the target already holds the slug. */
export class SpaceSlugCollision extends Schema.TaggedError<SpaceSlugCollision>()(
  'SpaceSlugCollision',
  {
    slug: Schema.String,
    siblingId: Schema.String,
    siblingName: Schema.String,
    message: Schema.String,
  },
) {}

export class SpaceWriteFailed extends Schema.TaggedError<SpaceWriteFailed>()(
  'SpaceWriteFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SpaceWriteFailed({ cause }),
  })

const readSpace = (id: string) =>
  query(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        path: space.path,
        slug: space.slug,
        parentId: space.parentId,
        isSeeded: space.isSeeded,
        archivedAt: space.archivedAt,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(space.entityId, id))
      .then((rows) => rows.at(0)),
  )

/** One space's archive instant, compared in SQL so no precision is lost. */
const archivedAtOf = (id: string) =>
  sql`(select a.archived_at from space a where a.entity_id = ${id}::uuid)`

const notFound = (id: string) =>
  new SpaceNotFound({ id, message: 'Space not found' })

export type ArchiveResult = { archivedAt: string; spaces: number }

/**
 * Archive a space and every live descendant in one statement, stamping one
 * instant on all of them. A descendant archived earlier keeps its own.
 * - Refused on a seeded root while it holds unarchived children.
 * - Archiving an archived space answers its existing instant, writes nothing.
 */
export const archiveSpaceProgram = Effect.fn('archiveSpaceProgram')(function* (
  actorId: string,
  id: string,
): Effect.fn.Return<
  ArchiveResult,
  SpaceNotFound | SeededRootHasChildren | SpaceWriteFailed
> {
  const head = yield* readSpace(id)
  if (!head) return yield* notFound(id)
  if (head.archivedAt) {
    return { archivedAt: head.archivedAt.toISOString(), spaces: 0 }
  }
  if (head.isSeeded && head.parentId === null) {
    const children = yield* query(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(space)
        .where(and(eq(space.parentId, id), isNull(space.archivedAt)))
        .then((rows) => rows.at(0)?.n ?? 0),
    )
    if (children > 0) {
      return yield* new SeededRootHasChildren({
        id,
        children,
        message: `${head.name} is a seeded root with ${children} live subspace${children === 1 ? '' : 's'}; archive those first`,
      })
    }
  }
  const archived = yield* query(() =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(space)
        .set({ archivedAt: sql`date_trunc('milliseconds', now())` })
        .where(
          and(
            sql`${space.path} <@ ${head.path}::ltree`,
            isNull(space.archivedAt),
          ),
        )
        .returning({ archivedAt: space.archivedAt })
      await tx.insert(activity).values({
        actorId,
        verb: 'space.archived',
        subjectEntityId: id,
        meta: { spaces: rows.length },
      })
      return rows
    }),
  )
  const at = archived.at(0)?.archivedAt
  if (!at) return yield* notFound(id)
  return { archivedAt: at.toISOString(), spaces: archived.length }
})

/**
 * Restore a space and the descendants archived with it: exactly the rows in
 * its subtree carrying its instant. A descendant archived on its own, earlier,
 * stays archived.
 */
export const restoreSpaceProgram = Effect.fn('restoreSpaceProgram')(function* (
  actorId: string,
  id: string,
): Effect.fn.Return<{ spaces: number }, SpaceNotFound | SpaceWriteFailed> {
  const head = yield* readSpace(id)
  if (!head) return yield* notFound(id)
  if (!head.archivedAt) return { spaces: 0 }
  const restored = yield* query(() =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(space)
        .set({ archivedAt: null })
        .where(
          and(
            sql`${space.path} <@ ${head.path}::ltree`,
            eq(space.archivedAt, archivedAtOf(id)),
          ),
        )
        .returning({ id: space.entityId })
      await tx.insert(activity).values({
        actorId,
        verb: 'space.restored',
        subjectEntityId: id,
        meta: { spaces: rows.length },
      })
      return rows.length
    }),
  )
  return { spaces: restored }
})

/** What one archive holds: the spaces stamped with its instant, their filings. */
export const archiveCountsProgram = Effect.fn('archiveCountsProgram')(
  function* (id: string, path: string) {
    return yield* query(() =>
      db
        .select({
          spaces: sql<number>`count(distinct ${space.entityId})::int`,
          filings: sql<number>`count(${entitySpace.entityId})::int`,
        })
        .from(space)
        .leftJoin(entitySpace, eq(entitySpace.spaceId, space.entityId))
        .where(
          and(
            sql`${space.path} <@ ${path}::ltree`,
            eq(space.archivedAt, archivedAtOf(id)),
          ),
        )
        .then((rows) => rows.at(0) ?? { spaces: 0, filings: 0 }),
    )
  },
)

export type MoveSpaceInput = {
  id: string
  /** The new parent; null moves the space to the root. */
  parentId: string | null
}

export type MoveResult = {
  moved: boolean
  from: string
  to: string
  /** Entities whose chunks a lowering must restamp, after the commit. */
  restamp: Array<string>
}

/** True when the space or one of its ancestors is flagged sensitive. */
const chainSensitive = (path: string) =>
  query(() =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(sql`${space.path} @> ${path}::ltree`, eq(entity.sensitive, true)),
      )
      .then((rows) => (rows.at(0)?.n ?? 0) > 0),
  )

/**
 * Move a space under a new parent, or to the root: one UPDATE rewrites the
 * subtree's paths and the space's `parent_id`, one activity row names both
 * paths. (D73)
 * - Refused under itself or a descendant, and on a slug a sibling under the
 *   target already holds — never a silent rename.
 * - Sensitivity: the raise runs in the transaction; a move out from under a
 *   sensitive ancestor hands back the entities to restamp.
 * - An archived space may move and stays archived.
 */
export const moveSpaceProgram = Effect.fn('moveSpaceProgram')(function* (
  actorId: string,
  input: MoveSpaceInput,
): Effect.fn.Return<
  MoveResult,
  SpaceNotFound | MoveUnderSelf | SpaceSlugCollision | SpaceWriteFailed
> {
  const head = yield* readSpace(input.id)
  if (!head) return yield* notFound(input.id)
  const target = input.parentId ? yield* readSpace(input.parentId) : null
  if (input.parentId && !target) return yield* notFound(input.parentId)

  if (
    target &&
    (target.path === head.path || target.path.startsWith(`${head.path}.`))
  ) {
    return yield* new MoveUnderSelf({
      id: head.id,
      targetId: target.id,
      message: `${head.name} cannot move under ${target.id === head.id ? 'itself' : `its own subspace ${target.name}`}`,
    })
  }
  if ((target?.id ?? null) === head.parentId) {
    return { moved: false, from: head.path, to: head.path, restamp: [] }
  }

  const sibling = yield* query(() =>
    db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          target ? eq(space.parentId, target.id) : isNull(space.parentId),
          eq(space.slug, head.slug),
        ),
      )
      .then((rows) => rows.at(0)),
  )
  if (sibling) {
    return yield* new SpaceSlugCollision({
      slug: head.slug,
      siblingId: sibling.id,
      siblingName: sibling.name,
      message: `${target ? target.name : 'The root'} already holds ${sibling.name}`,
    })
  }

  const parentPath = head.path.split('.').slice(0, -1).join('.')
  const wasSensitive = parentPath ? yield* chainSensitive(parentPath) : false
  const to = target ? `${target.path}.${head.slug}` : head.slug
  // The subtree below the moved space keeps its tail; only the prefix changes.
  const keep = sql`subpath(${space.path}, nlevel(${head.path}::ltree) - 1)`
  const restamp = yield* query(() =>
    db.transaction(async (tx) => {
      await tx
        .update(space)
        .set({
          path: target ? sql`${target.path}::ltree || ${keep}` : keep,
          parentId: sql`case when ${space.entityId} = ${head.id}::uuid then ${target?.id ?? null}::uuid else ${space.parentId} end`,
        })
        .where(sql`${space.path} <@ ${head.path}::ltree`)
      await tx.insert(activity).values({
        actorId,
        verb: 'space.moved',
        subjectEntityId: head.id,
        objectEntityId: target?.id ?? null,
        meta: { from: head.path, to },
      })
      const scope: StampScope = { kind: 'moved', spaceId: head.id }
      await raiseSensitivity(tx, scope)
      return wasSensitive ? stampedSensitive(tx, scope) : []
    }),
  )
  return { moved: true, from: head.path, to, restamp }
})

/**
 * Set or clear what belongs in a space (D72). One `space.criteria_changed`
 * line per save that changes it.
 * - Blank clears to null; nothing else is ever stored in its place.
 * - An unchanged value writes nothing and answers `changed: false`.
 */
export const setSpaceCriteriaProgram = Effect.fn('setSpaceCriteriaProgram')(
  function* (
    actorId: string,
    input: { id: string; criteria: string },
  ): Effect.fn.Return<
    { criteria: string | null; changed: boolean },
    SpaceNotFound | SpaceWriteFailed
  > {
    const trimmed = input.criteria.trim()
    const next = trimmed === '' ? null : trimmed
    const saved = yield* query(() =>
      db.transaction(async (tx) => {
        const held = (
          await tx
            .select({ criteria: space.criteria })
            .from(space)
            .where(eq(space.entityId, input.id))
            .for('update')
        ).at(0)
        if (!held) return null
        if (held.criteria === next) return { criteria: next, changed: false }
        await tx
          .update(space)
          .set({ criteria: next })
          .where(eq(space.entityId, input.id))
        await tx.insert(activity).values({
          actorId,
          verb: 'space.criteria_changed',
          subjectEntityId: input.id,
          meta: { from: held.criteria, to: next },
        })
        return { criteria: next, changed: true }
      }),
    )
    if (saved === null) return yield* notFound(input.id)
    return saved
  },
)

/**
 * What a refused space write tells the person. A refusal carries its own
 * sentence; anything else is a plain failure.
 */
export function spaceWriteMessage(failure: unknown): string {
  if (
    failure instanceof SpaceNotFound ||
    failure instanceof SeededRootHasChildren ||
    failure instanceof MoveUnderSelf ||
    failure instanceof SpaceSlugCollision
  ) {
    return failure.message
  }
  return 'Could not change the space'
}
