import { Effect, Schema } from 'effect'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  askThread,
  askTurn,
  entity,
  link,
  note,
  suggestion,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { Json } from '@spaces/core/json'
import { canRead } from '@spaces/core/read-policy'
import { noteSource } from '@spaces/core/writes/ai/chunk-sources'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { noteBodyFromMarkdown } from '@spaces/core/notes/markdown-blocks'
import { answerBlocks, answerMarkdown } from './answer'
import { AskCardRefused, cardViewsProgram } from './card-store'
import { liveCallsProgram } from './find'
import { AskQueryFailed, askQuery } from './query'
import type {
  AskCall,
  AskCardView,
  AskRef,
  AskThreadRow,
  AskThreadView,
  AskTurnView,
} from './types'

/**
 * Ask's thread store, read and kept: private to its author, every query
 * keyed on the reader. (D70)
 * - Another user's thread is not found, never refused by name.
 * - An answer citing a source the reader can no longer read is hidden: its
 *   text and refs never leave the server, and the turn says so.
 */

export class AskThreadNotFound extends Schema.TaggedError<AskThreadNotFound>()(
  'AskThreadNotFound',
  { message: Schema.String },
) {}

export { AskQueryFailed, askQuery }

const notFound = () => new AskThreadNotFound({ message: 'No such thread' })

/** The sentence a failure is shown as. */
export function askMessage(failure: unknown): string {
  if (failure instanceof AskThreadNotFound) return failure.message
  if (failure instanceof AskCardRefused) return failure.message
  return 'Could not read Ask'
}

/** The thread, if the reader wrote it. */
export const ownThreadProgram = Effect.fn('ask.ownThread')(function* (
  userId: string,
  threadId: string,
): Effect.fn.Return<
  typeof askThread.$inferSelect,
  AskThreadNotFound | AskQueryFailed
> {
  const row = (yield* askQuery(() =>
    db
      .select()
      .from(askThread)
      .where(and(eq(askThread.id, threadId), eq(askThread.userId, userId))),
  )).at(0)
  if (!row) return yield* notFound()
  return row
})

/**
 * The refs of `refs` the reader cannot read now: the entity is gone, or it
 * is a note made private by someone else.
 */
export const unreadableRefsProgram = Effect.fn('ask.unreadableRefs')(function* (
  userId: string,
  refs: ReadonlyArray<AskRef>,
): Effect.fn.Return<Set<string>, AskQueryFailed> {
  const ids = [
    ...new Set(refs.flatMap((r) => (r.entityId === null ? [] : [r.entityId]))),
  ]
  if (ids.length === 0) return new Set()
  const rows = yield* askQuery(() =>
    db
      .select({
        id: entity.id,
        visibility: note.visibility,
        authorId: note.authorId,
      })
      .from(entity)
      .leftJoin(note, eq(note.entityId, entity.id))
      .where(inArray(entity.id, ids)),
  )
  const readable = new Set(
    rows.filter((r) => canRead({ id: userId }, r)).map((r) => r.id),
  )
  return new Set(
    refs
      .filter((r) => r.entityId !== null && !readable.has(r.entityId))
      .map((r) => r.ref),
  )
})

type TurnRow = typeof askTurn.$inferSelect

/** A stored turn as the reader may see it. */
export function turnView(
  row: TurnRow,
  hidden: boolean,
  cards: ReadonlyArray<AskCardView> = [],
  calls: ReadonlyArray<AskCall> = row.calls,
): AskTurnView {
  return {
    id: row.id,
    role: row.role,
    body: hidden ? '' : row.bodyMd,
    refs: hidden ? [] : row.refs,
    calls,
    cards: hidden ? [] : cards,
    scope: row.scope,
    state: row.state,
    route: row.route,
    savedAt: row.savedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    hidden,
  }
}

/**
 * Turns as views, each answer checked against what the reader can read.
 * `finds: 'stored'` keeps find tables as asked — for a reader of the text
 * alone, such as the next question's history.
 */
export const turnViewsProgram = Effect.fn('ask.turnViews')(function* (
  userId: string,
  rows: ReadonlyArray<TurnRow>,
  finds: 'live' | 'stored' = 'live',
): Effect.fn.Return<Array<AskTurnView>, AskQueryFailed> {
  const evidenceOf = (r: TurnRow) =>
    r.calls.flatMap((c) => (c.card === undefined ? [] : c.card.evidence))
  const lost = yield* unreadableRefsProgram(
    userId,
    rows.flatMap((r) => [...r.refs, ...evidenceOf(r)]),
  )
  const cards = yield* cardViewsProgram(
    rows.flatMap((r) =>
      r.calls.flatMap((c) => (c.card === undefined ? [] : [c.card])),
    ),
  )
  // A find table reads each row's standing as it is now. (D77)
  const live = new Map<string, ReadonlyArray<AskCall>>()
  for (const r of finds === 'live' ? rows : [])
    if (r.calls.some((c) => c.find !== undefined))
      live.set(r.id, yield* liveCallsProgram(r.calls))
  return rows.map((r) =>
    turnView(
      r,
      r.role === 'assistant' &&
        [...r.refs, ...evidenceOf(r)].some((ref) => lost.has(ref.ref)),
      r.calls.flatMap((c) => {
        const view =
          c.card === undefined ? undefined : cards.get(c.card.suggestionId)
        return view === undefined ? [] : [view]
      }),
      live.get(r.id) ?? r.calls,
    ),
  )
})

export const threadTurnsProgram = Effect.fn('ask.threadTurns')(function* (
  threadId: string,
): Effect.fn.Return<Array<TurnRow>, AskQueryFailed> {
  return yield* askQuery(() =>
    db
      .select()
      .from(askTurn)
      .where(eq(askTurn.threadId, threadId))
      .orderBy(asc(askTurn.createdAt), asc(askTurn.role)),
  )
})

export const getThreadProgram = Effect.fn('ask.getThread')(function* (
  userId: string,
  threadId: string,
): Effect.fn.Return<AskThreadView, AskThreadNotFound | AskQueryFailed> {
  const thread = yield* ownThreadProgram(userId, threadId)
  const rows = yield* threadTurnsProgram(threadId)
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt.toISOString(),
    turns: yield* turnViewsProgram(userId, rows),
  }
})

/** The reader's threads, newest first, each with its scope and outcome. */
export const listThreadsProgram = Effect.fn('ask.listThreads')(function* (
  userId: string,
): Effect.fn.Return<Array<AskThreadRow>, AskQueryFailed> {
  const threads = yield* askQuery(() =>
    db
      .select()
      .from(askThread)
      .where(eq(askThread.userId, userId))
      .orderBy(desc(askThread.createdAt))
      .limit(200),
  )
  if (threads.length === 0) return []
  const ids = threads.map((t) => t.id)
  const turns = yield* askQuery(() =>
    db
      .select({
        threadId: askTurn.threadId,
        role: askTurn.role,
        scope: askTurn.scope,
        savedAt: askTurn.savedAt,
        aiRunId: askTurn.aiRunId,
      })
      .from(askTurn)
      .where(inArray(askTurn.threadId, ids))
      .orderBy(asc(askTurn.createdAt)),
  )
  const runs = turns.flatMap((t) => (t.aiRunId === null ? [] : [t.aiRunId]))
  const accepted =
    runs.length === 0
      ? []
      : yield* askQuery(() =>
          db
            .select({ runId: suggestion.runId, n: count() })
            .from(suggestion)
            .where(
              and(
                inArray(suggestion.runId, runs),
                eq(suggestion.status, 'accepted'),
              ),
            )
            .groupBy(suggestion.runId),
        )
  const appliedByRun = new Map(accepted.map((a) => [a.runId, a.n]))
  return threads.map((t) => {
    const own = turns.filter((x) => x.threadId === t.id)
    return {
      id: t.id,
      title: t.title,
      createdAt: t.createdAt.toISOString(),
      scope: own.find((x) => x.role === 'user')?.scope ?? [],
      questions: own.filter((x) => x.role === 'user').length,
      applied: own.reduce(
        (n, x) =>
          n + (x.aiRunId === null ? 0 : (appliedByRun.get(x.aiRunId) ?? 0)),
        0,
      ),
      saved: own.filter((x) => x.savedAt !== null).length,
    }
  })
})

export const renameThreadProgram = Effect.fn('ask.renameThread')(function* (
  userId: string,
  threadId: string,
  title: string,
): Effect.fn.Return<void, AskThreadNotFound | AskQueryFailed> {
  yield* ownThreadProgram(userId, threadId)
  yield* askQuery(() =>
    db
      .update(askThread)
      .set({ title: title.trim().slice(0, 200) })
      .where(eq(askThread.id, threadId)),
  )
})

/** What deleting a thread takes with it, for the confirm's note. */
export const threadCountsProgram = Effect.fn('ask.threadCounts')(function* (
  userId: string,
  threadId: string,
): Effect.fn.Return<
  { questions: number; saved: number },
  AskThreadNotFound | AskQueryFailed
> {
  yield* ownThreadProgram(userId, threadId)
  const rows = yield* askQuery(() =>
    db
      .select({
        questions:
          sql<number>`count(*) filter (where ${askTurn.role} = 'user')`.mapWith(
            Number,
          ),
        saved:
          sql<number>`count(*) filter (where ${askTurn.savedAt} is not null)`.mapWith(
            Number,
          ),
      })
      .from(askTurn)
      .where(eq(askTurn.threadId, threadId)),
  )
  return rows.at(0) ?? { questions: 0, saved: 0 }
})

/** Deletes the thread and its turns; notes saved from it stay. */
export const deleteThreadProgram = Effect.fn('ask.deleteThread')(function* (
  userId: string,
  threadId: string,
): Effect.fn.Return<void, AskThreadNotFound | AskQueryFailed> {
  yield* ownThreadProgram(userId, threadId)
  yield* askQuery(() => db.delete(askThread).where(eq(askThread.id, threadId)))
})

const RECORD_KINDS = new Set(['company', 'person', 'deal', 'custom', 'space'])

/**
 * "Save as note": the answer as the reader saw it, one shared note by the
 * reader, filed `tagged_in` on the records it cited.
 * - Citations are kept twice: as words in the text, and as mentions in a
 *   closing Sources line, which `body_md` carries as `[[Label|entity:id]]`.
 */
export const saveAnswerNoteProgram = Effect.fn('ask.saveAnswerNote')(function* (
  userId: string,
  turnId: string,
): Effect.fn.Return<{ noteId: string }, AskThreadNotFound | AskQueryFailed> {
  const row = (yield* askQuery(() =>
    db
      .select({ turn: askTurn, title: askThread.title })
      .from(askTurn)
      .innerJoin(askThread, eq(askThread.id, askTurn.threadId))
      .where(
        and(
          eq(askTurn.id, turnId),
          eq(askThread.userId, userId),
          eq(askTurn.role, 'assistant'),
        ),
      ),
  )).at(0)
  if (!row) return yield* notFound()
  const lost = yield* unreadableRefsProgram(userId, row.turn.refs)
  if (row.turn.refs.some((r) => lost.has(r.ref)))
    return yield* new AskThreadNotFound({
      message: 'This answer cited something you can no longer see',
    })
  const markdown = answerMarkdown(answerBlocks(row.turn.bodyMd, row.turn.refs))
  if (markdown.trim() === '')
    return yield* new AskThreadNotFound({ message: 'Nothing to save yet' })

  const cited = [
    ...new Set(
      row.turn.refs.flatMap((r) => (r.entityId === null ? [] : [r.entityId])),
    ),
  ]
  const kinds =
    cited.length === 0
      ? []
      : yield* askQuery(() =>
          db
            .select({
              id: entity.id,
              kind: entity.kind,
              name: entity.canonicalName,
            })
            .from(entity)
            .where(inArray(entity.id, cited)),
        )
  const records = kinds.filter((k) => RECORD_KINDS.has(k.kind))
  const labelOf = new Map(
    row.turn.refs.flatMap((r) =>
      r.entityId === null ? [] : [[r.entityId, r.label] as const],
    ),
  )
  const mentions = kinds.map((k) => ({
    id: k.id,
    kind: k.kind,
    label: k.name || (labelOf.get(k.id) ?? ''),
  }))

  const title = `Ask: ${row.title}`.slice(0, 300)
  const body = noteBodyFromMarkdown(markdown)
  const sources: Array<Json> =
    mentions.length === 0
      ? []
      : [
          {
            type: 'paragraph',
            props: {
              backgroundColor: 'default',
              textColor: 'default',
              textAlignment: 'left',
            },
            content: [
              { type: 'text', text: 'Sources: ', styles: {} },
              ...mentions.flatMap((m, i): Array<Json> => [
                ...(i === 0
                  ? []
                  : [{ type: 'text', text: ' ', styles: {} } satisfies Json]),
                {
                  type: 'mention',
                  props: {
                    entityId: m.id,
                    label: m.label,
                    kind: m.kind,
                    objectSlug: '',
                  },
                },
              ]),
            ],
            children: [],
          },
        ]
  const bodyMd =
    mentions.length === 0
      ? body.bodyMd
      : `${body.bodyMd.trimEnd()}\n\nMentions: ${mentions
          .map((m) => `[[${m.label}|entity:${m.id}]]`)
          .join(' ')}\n`

  const noteId = yield* askQuery(() =>
    db.transaction(async (tx) => {
      const ent = (
        await tx
          .insert(entity)
          .values({ kind: 'note', canonicalName: title, createdBy: userId })
          .returning({ id: entity.id })
      ).at(0)
      if (!ent) throw new Error('note entity insert returned no row')
      await tx.insert(note).values({
        entityId: ent.id,
        authorId: userId,
        title,
        kind: 'note',
        visibility: 'shared',
        bodyJson: [...body.bodyJson, ...sources],
        bodyMd,
      })
      if (records.length > 0)
        await tx.insert(link).values(
          records.map((r) => ({
            fromEntityId: ent.id,
            toEntityId: r.id,
            relation: 'tagged_in' as const,
            source: 'manual' as const,
            createdBy: userId,
          })),
        )
      const subject = records.at(0)
      await tx.insert(activity).values({
        actorId: userId,
        verb: 'note.created',
        subjectEntityId: subject?.id ?? ent.id,
        objectEntityId: ent.id,
      })
      await tx
        .update(askTurn)
        .set({ savedAt: new Date() })
        .where(eq(askTurn.id, turnId))
      return ent.id
    }),
  )
  yield* Effect.promise(() => enqueueSourceEmbed(noteSource(noteId)))
  return { noteId }
})
