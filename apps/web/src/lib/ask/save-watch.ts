import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { askThread, askTurn, entity, space } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { discoverProgram } from '@spaces/core/writes/ports/discover'
import { liveSpaceOf } from '@spaces/core/writes/watches/run'
import type { FormValues } from '#/lib/integrations/settings-form'
import { createSpaceRow } from '#/lib/server/shared'
import {
  AlreadyWatching,
  WatchRefused,
  insertWatchRow,
  sameLensWatchProgram,
  watchEnginesProgram,
  watchSettingsProgram,
  watchWriteFailure,
} from '#/lib/spaces/watching'
import type { SpaceWatching, WatchingFailed } from '#/lib/spaces/watching'
import { FindRefused, liveFindProgram } from './find'
import { askQuery } from './query'
import type { AskQueryFailed } from './query'
import type { AskCall, AskFindRow, AskFindTable } from './types'

/**
 * Save as watch: a Find turn's question becomes a `space_watch`, and its
 * results are carried, not repeated. (D77)
 * - Needs a space: the table's, one picked, or one created from the question.
 * - The same space, engine and settings is `AlreadyWatching` and writes nothing.
 * - Rows the reader added or dismissed are left as they are; rows left
 *   untouched go through Discover's three checks, so each becomes a card
 *   under the space — or merges into its open one.
 * - The space, the watch and the thread's link commit together; the cards
 *   follow, each proposal idempotent per (space, domain).
 */

export type SaveWatchInput = {
  /** The answer turn holding the table. */
  turnId: string
  /** The call of that turn whose table is saved. */
  callIndex: number
  /** The space to watch, or the name of one to create. */
  space: { id: string } | { create: string }
  integrationId: string
  values: FormValues
  cadenceMinutes: number | null
}

export type SaveWatchResult =
  | {
      status: 'saved'
      watchId: string
      spaceId: string
      spaceName: string
      /** Untouched rows now waiting in Review under the space. */
      cards: number
    }
  | { status: 'exists'; watchId: string; spaceId: string; spaceName: string }

export class SaveWatchFailed extends Schema.TaggedError<SaveWatchFailed>()(
  'SaveWatchFailed',
  { cause: Schema.Defect() },
) {}

/** The sentence a failed save is shown as. */
export function saveWatchMessage(failure: unknown): string {
  if (failure instanceof FindRefused) return failure.message
  if (failure instanceof WatchRefused) return failure.message
  return 'Could not save the watch'
}

/** The longest name a space made from a question takes. */
const NAME_MAX = 120

/** The reader's answer turn, the table at `callIndex`, and its question. */
const ownTableProgram = Effect.fn('ask.saveWatch.table')(function* (
  userId: string,
  turnId: string,
  callIndex: number,
) {
  const turn = (yield* askQuery(() =>
    db
      .select({
        threadId: askTurn.threadId,
        calls: askTurn.calls,
        createdAt: askTurn.createdAt,
      })
      .from(askTurn)
      .innerJoin(askThread, eq(askThread.id, askTurn.threadId))
      .where(
        and(
          eq(askTurn.id, turnId),
          eq(askTurn.role, 'assistant'),
          eq(askThread.userId, userId),
        ),
      ),
  )).at(0)
  const table = turn?.calls.at(callIndex)?.find
  if (turn === undefined || table === undefined)
    return yield* new FindRefused({
      message: 'That table is no longer in this thread',
    })
  return { calls: turn.calls, table }
})

/** The live space a watch is saved on, with its criteria. */
const targetSpaceProgram = Effect.fn('ask.saveWatch.space')(function* (
  spaceId: string,
) {
  const row = (yield* askQuery(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        criteria: space.criteria,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          eq(space.entityId, spaceId),
          isNull(entity.mergedIntoId),
          liveSpaceOf(space.entityId),
        ),
      ),
  )).at(0)
  if (row === undefined)
    return yield* new WatchRefused({
      message: 'That space is gone or archived',
      errors: {},
    })
  return row
})

/**
 * The rows the reader left alone: read again, each still stands as it was
 * shown and is not filed. An added row now reads held or filed; a dismissed
 * one is hidden.
 */
export const untouchedRowsProgram = Effect.fn('ask.saveWatch.untouched')(
  function* (table: AskFindTable) {
    const shown = new Map(table.rows.map((r) => [r.domain, r.standing]))
    const live = yield* liveFindProgram(table)
    return live.rows.filter(
      (r: AskFindRow) =>
        r.standing !== 'filed' && shown.get(r.domain) === r.standing,
    )
  },
)

export const saveFindAsWatchProgram = Effect.fn('ask.saveFindAsWatch')(
  function* (
    userId: string,
    input: SaveWatchInput,
  ): Effect.fn.Return<
    SaveWatchResult,
    | FindRefused
    | AskQueryFailed
    | WatchRefused
    | WatchingFailed
    | SaveWatchFailed
  > {
    const { calls, table } = yield* ownTableProgram(
      userId,
      input.turnId,
      input.callIndex,
    )
    const target =
      'id' in input.space ? yield* targetSpaceProgram(input.space.id) : null
    const newName =
      'create' in input.space
        ? input.space.create.trim().slice(0, NAME_MAX).trim()
        : ''
    if (target === null && newName === '')
      return yield* new WatchRefused({
        message: 'A watch needs a space',
        errors: {},
      })
    const settings = yield* watchSettingsProgram({
      integrationId: input.integrationId,
      values: input.values,
      criteria: target?.criteria ?? null,
    })

    const exists = (
      watchId: string,
      on: { id: string; name: string },
    ): SaveWatchResult => ({
      status: 'exists',
      watchId,
      spaceId: on.id,
      spaceName: on.name,
    })
    // A space made here holds no watch yet; only a chosen one can.
    if (target !== null) {
      const held = yield* sameLensWatchProgram({
        spaceId: target.id,
        integrationId: input.integrationId,
        settings,
      })
      if (held !== null) return exists(held, target)
    }

    const saved = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            const spaceId =
              target?.id ?? (await createSpaceRow(newName, null, userId, tx))
            if (target === null)
              await tx.insert(activity).values({
                actorId: userId,
                verb: 'space.created',
                subjectEntityId: spaceId,
              })
            const spaceName = target?.name ?? newName
            const watch = await insertWatchRow(tx, userId, {
              spaceId,
              integrationId: input.integrationId,
              settings,
              cadenceMinutes: input.cadenceMinutes,
            })
            const linked: Array<AskCall> = calls.map((c, i) =>
              i === input.callIndex && c.find !== undefined
                ? {
                    ...c,
                    find: {
                      ...c.find,
                      savedWatch: { id: watch.id, spaceId, spaceName },
                    },
                  }
                : c,
            )
            await tx
              .update(askTurn)
              .set({ calls: linked })
              .where(eq(askTurn.id, input.turnId))
            return { watchId: watch.id, spaceId, spaceName }
          }),
        catch: watchWriteFailure,
      }),
    )
    if (saved._tag === 'Failure') {
      const failure = saved.failure
      if (!(failure instanceof AlreadyWatching)) return yield* failure
      // A racing save took the lens between the check and the insert.
      const held =
        target === null
          ? null
          : yield* sameLensWatchProgram({
              spaceId: target.id,
              integrationId: input.integrationId,
              settings,
            })
      if (held === null || target === null)
        return yield* new SaveWatchFailed({ cause: failure })
      return exists(held, target)
    }
    const { watchId, spaceId, spaceName } = saved.success

    let cards = 0
    for (const row of yield* untouchedRowsProgram(table)) {
      const found = yield* Effect.result(
        discoverProgram({
          claim: {
            spaceId,
            name: row.name,
            domain: row.domain,
            evidence: row.sources.map((s) =>
              s.title === undefined
                ? { url: s.url }
                : { url: s.url, title: s.title },
            ),
          },
          proposedBy: { type: 'user', id: userId },
          watchId,
        }),
      )
      // A row Discover refuses is left to the watch's first run.
      if (
        found._tag === 'Success' &&
        (found.success.outcome === 'proposed' ||
          found.success.outcome === 'merged')
      )
        cards++
    }
    return { status: 'saved', watchId, spaceId, spaceName, cards }
  },
)

/** A space the Save as watch window offers, with the criteria Look for blanks against. */
export type WatchSpace = {
  id: string
  name: string
  depth: number
  criteria: string | null
}

/** What the window needs: the engines, and the live spaces in tree order. */
export const saveWatchSetupProgram = Effect.fn('ask.saveWatchSetup')(
  function* (): Effect.fn.Return<
    Pick<SpaceWatching, 'engines' | 'installed'> & {
      spaces: Array<WatchSpace>
    },
    WatchingFailed | AskQueryFailed
  > {
    const offered = yield* watchEnginesProgram()
    const rows = yield* askQuery(() =>
      db
        .select({
          id: space.entityId,
          name: entity.canonicalName,
          path: space.path,
          criteria: space.criteria,
        })
        .from(space)
        .innerJoin(entity, eq(entity.id, space.entityId))
        .where(and(isNull(entity.mergedIntoId), liveSpaceOf(space.entityId)))
        .orderBy(asc(space.path)),
    )
    return {
      ...offered,
      spaces: rows.map((r) => ({
        id: r.id,
        name: r.name,
        depth: r.path.split('.').length - 1,
        criteria: r.criteria,
      })),
    }
  },
)
