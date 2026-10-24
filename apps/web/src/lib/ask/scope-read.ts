import { Effect } from 'effect'
import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, objectDef, space, view } from '@spaces/db/schema'
import { askQuery } from './query'
import { NO_SCOPE, droppedLine } from './scope'
import type { TurnScope } from './scope'
import type { AskScopeChip } from './types'

/**
 * A turn's chips read into its narrowing, each chip on its own: one that
 * does not resolve is dropped with a line naming it, and the rest still
 * narrow.
 * - A space chip must name a space that still exists.
 * - A view chip must name a view over an object that the asker may read.
 */

export type ResolvedScope = {
  narrowing: TurnScope
  /** The chips the turn is asked in: every chip that resolved. */
  kept: ReadonlyArray<AskScopeChip>
  /** Chips that did not, each with the line the thread prints. */
  dropped: ReadonlyArray<{ chip: AskScopeChip; line: string }>
}

const spaceRow = (id: string) =>
  askQuery(() =>
    db
      .select({ id: space.entityId })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(and(eq(space.entityId, id), isNull(entity.mergedIntoId))),
  ).pipe(Effect.map((rows) => rows.at(0) ?? null))

const viewRow = (id: string, userId: string) =>
  askQuery(() =>
    db
      .select({
        name: view.name,
        filter: view.filter,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
      })
      .from(view)
      .innerJoin(objectDef, eq(objectDef.id, view.objectId))
      .where(
        and(
          eq(view.id, id),
          or(eq(view.visibility, 'shared'), eq(view.createdBy, userId)),
        ),
      ),
  ).pipe(Effect.map((rows) => rows.at(0) ?? null))

export const resolveScopeProgram = Effect.fn('ask.resolveScope')(function* (
  userId: string,
  scope: ReadonlyArray<AskScopeChip>,
): Effect.fn.Return<ResolvedScope> {
  let narrowing: TurnScope = NO_SCOPE
  const kept: Array<AskScopeChip> = []
  const dropped: Array<{ chip: AskScopeChip; line: string }> = []
  for (const chip of scope) {
    if (chip.id === null || (chip.kind !== 'space' && chip.kind !== 'view')) {
      kept.push(chip)
      continue
    }
    const read =
      chip.kind === 'space'
        ? yield* Effect.result(spaceRow(chip.id))
        : yield* Effect.result(viewRow(chip.id, userId))
    if (read._tag === 'Failure') {
      dropped.push({ chip, line: droppedLine(chip, 'unread') })
      continue
    }
    const row = read.success
    if (row === null) {
      dropped.push({ chip, line: droppedLine(chip, 'gone') })
      continue
    }
    kept.push(chip)
    if ('filter' in row) {
      if (narrowing.view === null)
        narrowing = {
          ...narrowing,
          view: {
            name: row.name,
            object: {
              slug: row.slug,
              singular: row.singular,
              plural: row.plural,
            },
            conditions: row.filter,
          },
        }
    } else if (narrowing.space === null)
      narrowing = { ...narrowing, space: { id: row.id, name: chip.name } }
  }
  return { narrowing, kept, dropped }
})
