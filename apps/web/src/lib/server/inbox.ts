import { createServerFn } from '@tanstack/react-start'
import { Cause, Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { duplicateCandidate } from '@spaces/db/schema'
import { mergeEntities } from '@spaces/core/writes/entities/merge'
import { requireUser } from './shared'
import { input } from './input'
import { serverQuery } from './query'
import type { ServerQueryFailed } from './query'

/**
 * The review inbox: one queue over typed rows (`duplicate_candidate` pairs
 * and `suggestion` cards). `/dedupe` is a permanent redirect to `/inbox`.
 * A new lane joins by adding a member to `InboxRow` and a renderer to the
 * page's `RENDERERS` map — never a second page.
 *
 * Every handler runs an Effect program; nothing Effect-shaped escapes this
 * file. The inbox's own programs are imported inside these so their
 * database code never reaches the client bundle.
 */

export type {
  AskCardsRow,
  CapturedPage,
  ColumnRunRow,
  ColumnRunSummary,
  DiscoveryRow,
  DiscoverySpace,
  DuplicateCandidateRow,
  InboxFilterLabels,
  InboxKind,
  InboxLane,
  InboxRow,
  InboxScopeRecord,
  SuggestionCitation,
  SuggestionField,
  SuggestionItem,
  SuggestionRecord,
  SuggestionRow,
} from '../inbox/queue'
/** One side of a pair: the record plus everything the card compares. */
export type { InboxSide } from '../inbox/context'
export type { SuggestionKind } from '@spaces/core/writes/suggestions/propose'
export type { RecordDuplicate } from '../records/notices'

const uuid = Schema.String.check(Schema.isUUID())

/** The pair is no longer open, or the winner is not one of it. */
class PairRefused extends Schema.TaggedError<PairRefused>()('PairRefused', {
  message: Schema.String,
}) {}

/** A dismiss that did not land, with the reason the card shows. */
class DismissFailed extends Schema.TaggedError<DismissFailed>()(
  'DismissFailed',
  { message: Schema.String },
) {}

const listInboxProgram = Effect.fn('listInboxProgram')(function* (
  viewer: string,
  record: string | null,
  source: string | null,
  space: string | null,
) {
  const queue = yield* Effect.promise(() => import('../inbox/queue'))
  const [rows, scope, filter] = yield* Effect.all(
    [
      queue.listInboxProgram({ record, source, space, viewer }),
      record === null
        ? Effect.succeed(null)
        : queue.inboxScopeRecordProgram(record),
      source === null && space === null
        ? Effect.succeed(null)
        : queue.inboxFilterLabelsProgram(source, space),
    ],
    { concurrency: 'unbounded' },
  )
  return { rows, scope, filter }
})

/**
 * The queue, optionally scoped to one record (the record rail's "Waiting"
 * chips land here with `?record=`) or to Today's source and space. `scope`
 * and `filter` name them for the header's dismissible chips, read beside the
 * rows rather than from them — an emptied queue still names its scope.
 */
export const listInbox = createServerFn()
  .validator(
    input(
      Schema.Struct({
        record: Schema.NullOr(uuid),
        source: Schema.optional(
          Schema.NullOr(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
          ),
        ),
        space: Schema.optional(Schema.NullOr(uuid)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    return Effect.runPromise(
      listInboxProgram(
        user.id,
        data.record,
        data.source ?? null,
        data.space ?? null,
      ),
    )
  })

/** The open duplicate pairs a record is in, for its notices band. */
export const listRecordDuplicates = createServerFn()
  .validator(input(Schema.Struct({ entityId: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    const { recordDuplicatesProgram } = await import('../inbox/queue')
    const { effectFn } = await import('./effect')
    return effectFn(recordDuplicatesProgram)(data.entityId)
  })

const mergeDuplicateProgram = Effect.fn('mergeDuplicateProgram')(function* (
  candidateId: string,
  winnerId: string,
  mergedBy: string,
): Effect.fn.Return<{ ok: boolean }, PairRefused | ServerQueryFailed> {
  const cand = (yield* serverQuery(() =>
    db
      .select()
      .from(duplicateCandidate)
      .where(eq(duplicateCandidate.id, candidateId)),
  )).at(0)
  if (!cand || cand.status !== 'open')
    return yield* new PairRefused({ message: 'Candidate not open' })
  if (winnerId !== cand.entityA && winnerId !== cand.entityB)
    return yield* new PairRefused({ message: 'Winner must be one of the pair' })
  const loserId = winnerId === cand.entityA ? cand.entityB : cand.entityA
  // The merge's own refusals reach the caller as it throws them.
  yield* Effect.promise(() =>
    mergeEntities({ winnerId, loserId, mergedBy, candidateId }),
  )
  return { ok: true }
})

export const mergeDuplicate = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ candidateId: uuid, winnerId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(
      mergeDuplicateProgram(data.candidateId, data.winnerId, u.id),
    )
  })

const dismissProgram = Effect.fn('dismissProgram')(function* (
  candidateId: string,
  actorId: string,
) {
  const { dismissDuplicateProgram } = yield* Effect.promise(
    () => import('../inbox/held-commit'),
  )
  // A pair merged or dismissed meanwhile is left as it stands. Whatever
  // stopped it reaches the card as its message alone.
  yield* dismissDuplicateProgram(candidateId, actorId).pipe(
    Effect.catchCause((cause) => {
      const err = Cause.squash(cause)
      return Effect.fail(
        new DismissFailed({
          message:
            err instanceof Error ? err.message : 'Could not dismiss the pair',
        }),
      )
    }),
  )
  return { ok: true }
})

export const dismissDuplicate = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ candidateId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(dismissProgram(data.candidateId, u.id))
  })
