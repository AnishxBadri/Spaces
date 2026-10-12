import { Effect, Schema } from 'effect'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, note, suggestion } from '@spaces/db/schema'
import { canRead } from '../../read-policy'
import type { Tx } from '../attributes/values'

/**
 * The one `supersedes` writer: `link(supersedes)` newer → older. (D59)
 * - Nothing is deleted; both rows and their chunks stay. The ranker demotes
 *   the older one.
 * - Never written automatically — only a verb the user chose calls this.
 * - Idempotent: the same pair twice is a no-op on `link_edge_unique`.
 */

export type SupersedesEdge = {
  newerId: string
  olderId: string
  actorId: string
}

const REFUSAL_REASONS = [
  'self',
  'not_found',
  'kind_mismatch',
  'not_versionable',
  'reverse',
] as const

export type SupersedesRefusal = (typeof REFUSAL_REASONS)[number]

export class SupersedesRefused extends Schema.TaggedError<SupersedesRefused>()(
  'SupersedesRefused',
  { reason: Schema.Literals(REFUSAL_REASONS) },
) {}

export class SupersedesFailed extends Schema.TaggedError<SupersedesFailed>()(
  'SupersedesFailed',
  { cause: Schema.Defect() },
) {}

const REFUSALS: Record<SupersedesRefusal, string> = {
  self: 'A file cannot be a newer version of itself',
  not_found: 'That item is no longer here',
  kind_mismatch: 'Only a document can replace a document, and a note a note',
  not_versionable: 'Only documents and notes have versions',
  reverse: 'That one is already the newer version of this',
}

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function supersedesMessage(failure: unknown): string {
  if (failure instanceof SupersedesRefused) return REFUSALS[failure.reason]
  return 'Could not mark the newer version'
}

/** Writes the one row, inside the caller's transaction. True when it was new. */
export async function insertSupersedes(
  tx: Tx,
  edge: SupersedesEdge,
): Promise<boolean> {
  const rows = await tx
    .insert(link)
    .values({
      fromEntityId: edge.newerId,
      toEntityId: edge.olderId,
      relation: 'supersedes',
      source: 'manual',
      createdBy: edge.actorId,
    })
    .onConflictDoNothing()
    .returning({ id: link.id })
  return rows.length > 0
}

/**
 * "Newer version of…": checks the pair, then writes one `link` row and
 * nothing else, inside the caller's transaction. Throws `SupersedesRefused`.
 * - Both live, both documents or both notes, a note readable by the actor.
 * - Refuses the reverse of an existing edge, so a chain never loops.
 * - Closes every open `supersedes` suggestion for the pair as accepted by
 *   the actor, so Review never offers a link already made. `except` is the
 *   row an accept is closing itself.
 */
export async function markNewerVersionInTx(
  tx: Tx,
  edge: SupersedesEdge,
  except: string | null = null,
): Promise<{ written: boolean }> {
  if (edge.newerId === edge.olderId)
    throw new SupersedesRefused({ reason: 'self' })

  const rows = await tx
    .select({
      id: entity.id,
      kind: entity.kind,
      mergedIntoId: entity.mergedIntoId,
      visibility: note.visibility,
      authorId: note.authorId,
    })
    .from(entity)
    .leftJoin(note, eq(note.entityId, entity.id))
    .where(inArray(entity.id, [edge.newerId, edge.olderId]))
  const newer = rows.find((r) => r.id === edge.newerId)
  const older = rows.find((r) => r.id === edge.olderId)
  const user = { id: edge.actorId }
  if (
    !newer ||
    !older ||
    newer.mergedIntoId !== null ||
    older.mergedIntoId !== null ||
    !canRead(user, newer) ||
    !canRead(user, older)
  )
    throw new SupersedesRefused({ reason: 'not_found' })
  if (newer.kind !== older.kind)
    throw new SupersedesRefused({ reason: 'kind_mismatch' })
  if (newer.kind !== 'document' && newer.kind !== 'note')
    throw new SupersedesRefused({ reason: 'not_versionable' })

  const reverse = await tx
    .select({ id: link.id })
    .from(link)
    .where(
      and(
        eq(link.fromEntityId, edge.olderId),
        eq(link.toEntityId, edge.newerId),
        eq(link.relation, 'supersedes'),
      ),
    )
  if (reverse.length > 0) throw new SupersedesRefused({ reason: 'reverse' })

  const written = await insertSupersedes(tx, edge)
  await tx
    .update(suggestion)
    .set({ status: 'accepted', decidedBy: edge.actorId, decidedAt: new Date() })
    .where(
      and(
        eq(suggestion.kind, 'supersedes'),
        eq(suggestion.status, 'open'),
        sql`${suggestion.payload} ->> 'newerId' = ${edge.newerId}`,
        sql`${suggestion.payload} ->> 'olderId' = ${edge.olderId}`,
        except === null ? undefined : ne(suggestion.id, except),
      ),
    )
  return { written }
}

/** `markNewerVersionInTx` in its own transaction: the manual verb's program. */
export const markNewerVersionProgram = Effect.fn('markNewerVersionProgram')(
  function* (
    edge: SupersedesEdge,
  ): Effect.fn.Return<
    { written: boolean },
    SupersedesRefused | SupersedesFailed
  > {
    return yield* Effect.tryPromise({
      try: () => db.transaction((tx) => markNewerVersionInTx(tx, edge)),
      catch: (cause) =>
        cause instanceof SupersedesRefused
          ? cause
          : new SupersedesFailed({ cause }),
    })
  },
)
