import { Effect, Schema } from 'effect'
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { canRead } from '@spaces/core/read-policy'
import { emailListing } from '@spaces/core/interactions/email-listing'
import {
  canReadDocumentSql,
  noteWidenedSql,
} from '@spaces/core/writes/read/can-read-sql'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  emailDraft,
  entity,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
  note,
} from '@spaces/db/schema'
import { decodeCursor, encodeCursor, likeArg } from '#/lib/views/paging'
import type { ThreadFilter } from '#/lib/email/threads'
import type { ThreadPerson } from '#/lib/timeline/threads'
import { sentBy, viewerSelf } from '#/lib/timeline/record'

/**
 * The Email page's Threads: every email thread the workspace holds, newest
 * first, a page at a time. Subject, people and date always show (the
 * headers are never private); the summary and the files pass `canRead`.
 * - A thread is its messages sharing a `thread_id`; a message with none is
 *   its own thread. The row is drawn from the newest message.
 * - `mine`: a message came through one of the reader's mailboxes or is a
 *   body they own. `shared`: a body someone else owns that the reader may
 *   read — a grant, the owner's record override, or a mailbox shared whole.
 * - `q` matches a subject in the thread or the name of a record on it, never
 *   a body, so a search cannot tell anyone what a private body says.
 * - `total` counts the threads under the filter and the search, never the
 *   cursor; the cursor is opaque, and an unreadable one is page one.
 */

export class EmailThreadsFailed extends Schema.TaggedError<EmailThreadsFailed>()(
  'EmailThreadsFailed',
  { cause: Schema.Defect() },
) {}

/** A record a thread is filed on, other than a person. */
export type ThreadRecord = { id: string; name: string; kind: string }

export type EmailThreadRow = {
  /** The newest message: the one the pane opens on. */
  id: string
  subject: string
  /** ISO instant of the newest message. */
  at: string
  messages: number
  /** The people on any message, oldest first; the reader is marked `self`. */
  attendees: Array<ThreadPerson>
  /** The newest message came from the reader. */
  sent: boolean
  records: Array<ThreadRecord>
  /** The files on its messages the reader may read. */
  attachments: number
  attachmentNames: Array<string>
  /** The newest message's summary or snippet; null when its body is not the reader's. */
  summary: string | null
  /** The newest message's body is someone else's and closed to the reader. */
  privateBody: boolean
  /** The reader holds a draft replying to one of its messages. */
  draft: boolean
}

export type EmailThreadPage = {
  threads: Array<EmailThreadRow>
  total: number
  nextCursor: string | null
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new EmailThreadsFailed({ cause }),
  })

/** Rows per page when the caller names none, and the most it may ask for. */
const PAGE_SIZE = 50
const PAGE_MAX = 100

const PG_TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}(?::\d{2})?$/

/** The thread a message belongs to; prefixed so a thread id never meets a row id. */
const threadKey: SQL<string> = sql<string>`coalesce('t:' || ${interaction.threadId}, 'r:' || ${interaction.id}::text)`

const cursorOf = (raw: string | undefined) => {
  const c = raw === undefined ? null : decodeCursor(raw)
  if (c === null || c.k === null || !PG_TIMESTAMPTZ.test(c.k)) return null
  return { key: c.id, at: c.k }
}

/** Whether a thread passes the filter: true when any of its messages does. */
function filterSql(viewerId: string, filter: ThreadFilter): SQL | undefined {
  if (filter === 'mine')
    return sql`coalesce(bool_or(${note.authorId} = ${viewerId} or ${accountConnection.userId} = ${viewerId}), false)`
  if (filter === 'shared')
    return sql`coalesce(bool_or(${note.authorId} <> ${viewerId} and (${note.visibility} <> 'private' or ${noteWidenedSql(viewerId)})), false)`
  return undefined
}

/** A subject in the thread, or a record on one of its messages, holds `q`. */
function searchSql(q: string): SQL {
  const pattern = likeArg(q)
  return sql`coalesce(bool_or(${interaction.subject} ilike ${pattern} or exists (
    select 1 from interaction_entity sie
    join entity se on se.id = sie.entity_id
    where sie.interaction_id = ${interaction.id}
      and se.canonical_name ilike ${pattern}
  )), false)`
}

export const listEmailThreadsProgram = Effect.fn('listEmailThreadsProgram')(
  function* (
    viewer: { id: string },
    input: {
      readonly filter?: ThreadFilter | undefined
      readonly q?: string | undefined
      readonly cursor?: string | undefined
      readonly limit?: number | undefined
    },
  ): Effect.fn.Return<EmailThreadPage, EmailThreadsFailed> {
    const limit = Math.max(1, Math.min(input.limit ?? PAGE_SIZE, PAGE_MAX))
    const q = input.q?.trim() ?? ''
    const having = [
      filterSql(viewer.id, input.filter ?? 'all'),
      q === '' ? undefined : searchSql(q),
    ].filter((h) => h !== undefined)

    const grouped = db
      .select({
        key: threadKey.as('key'),
        newest: sql<Date>`max(${interaction.occurredAt})`.as('newest'),
        sortKey: sql<string>`max(${interaction.occurredAt})::text`.as(
          'sort_key',
        ),
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .leftJoin(integration, eq(integration.id, interaction.sourceRef))
      .leftJoin(
        accountConnection,
        eq(accountConnection.id, integration.connectionId),
      )
      .where(eq(interaction.kind, 'email'))
      .groupBy(threadKey)
      .having(having.length === 0 ? undefined : and(...having))
      .as('threads')

    const after = cursorOf(input.cursor)
    const page = yield* query(() =>
      db
        .select({ key: grouped.key, sortKey: grouped.sortKey })
        .from(grouped)
        .where(
          after === null
            ? undefined
            : sql`(${grouped.newest}, ${grouped.key}) < (${after.at}::timestamptz, ${after.key})`,
        )
        .orderBy(desc(grouped.newest), desc(grouped.key))
        .limit(limit + 1),
    )
    const total =
      (yield* query(() => db.select({ n: count() }).from(grouped))).at(0)?.n ??
      0
    const shown = page.slice(0, limit)
    const last = shown.at(-1)
    const nextCursor =
      page.length > limit && last !== undefined
        ? encodeCursor({ id: last.key, k: last.sortKey })
        : null
    const keys = shown.map((t) => t.key)
    if (keys.length === 0) return { threads: [], total, nextCursor }

    const threads = yield* threadRows(viewer, keys)
    return { threads, total, nextCursor }
  },
)

/** The rows for these threads, in the order given. */
const threadRows = Effect.fn('emailThreadRows')(function* (
  viewer: { id: string },
  keys: ReadonlyArray<string>,
) {
  const messages = yield* query(() =>
    db
      .select({
        id: interaction.id,
        key: threadKey,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
        meta: interaction.meta,
        visibility: note.visibility,
        authorId: note.authorId,
        widened: noteWidenedSql(viewer.id),
      })
      .from(interaction)
      .leftJoin(note, eq(note.entityId, interaction.noteId))
      .where(and(eq(interaction.kind, 'email'), inArray(threadKey, [...keys])))
      .orderBy(asc(interaction.occurredAt), asc(interaction.id)),
  )
  const ids = messages.map((m) => m.id)
  const keyOf = new Map(messages.map((m) => [m.id, m.key]))
  const order = new Map(ids.map((id, i) => [id, i]))

  const edges = yield* query(() =>
    db
      .select({
        interactionId: interactionEntity.interactionId,
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(interactionEntity)
      .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
      .where(
        and(
          inArray(interactionEntity.interactionId, ids),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.canonicalName)),
  )
  const files = yield* query(() =>
    db
      .select({
        interactionId: interactionDocument.interactionId,
        name: entity.canonicalName,
      })
      .from(interactionDocument)
      .innerJoin(
        document,
        eq(document.entityId, interactionDocument.documentId),
      )
      .innerJoin(entity, eq(entity.id, interactionDocument.documentId))
      .where(
        and(
          inArray(interactionDocument.interactionId, ids),
          eq(interactionDocument.role, 'attachment'),
          canReadDocumentSql(viewer.id),
        ),
      )
      .orderBy(asc(entity.canonicalName)),
  )
  const drafts = yield* query(() =>
    db
      .selectDistinct({ inReplyToId: emailDraft.inReplyToId })
      .from(emailDraft)
      .where(
        and(
          eq(emailDraft.userId, viewer.id),
          inArray(emailDraft.inReplyToId, ids),
        ),
      ),
  )
  const own = yield* viewerSelf(viewer.id).pipe(
    Effect.mapError((cause) => new EmailThreadsFailed({ cause })),
  )

  const byKey = new Map<string, Array<(typeof messages)[number]>>()
  for (const m of messages) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m])
  const keyedOf = (interactionId: string | null) =>
    interactionId === null ? undefined : keyOf.get(interactionId)
  const drafted = new Set(drafts.flatMap((d) => keyedOf(d.inReplyToId) ?? []))
  // An edge's message order, so a thread's people read oldest first.
  const firstEdges = [...edges].sort(
    (a, b) =>
      (order.get(a.interactionId) ?? 0) - (order.get(b.interactionId) ?? 0),
  )

  return keys.flatMap((key): Array<EmailThreadRow> => {
    const thread = byKey.get(key) ?? []
    const newest = thread.at(-1)
    if (newest === undefined) return []
    const inThread = new Set(thread.map((m) => m.id))
    const people = new Map<string, ThreadPerson>()
    const records = new Map<string, ThreadRecord>()
    for (const e of firstEdges) {
      if (!inThread.has(e.interactionId)) continue
      if (e.kind === 'person')
        people.set(e.id, { name: e.name, self: own.people.has(e.id) })
      else records.set(e.id, { id: e.id, name: e.name, kind: e.kind })
    }
    const attached = files.filter((f) => inThread.has(f.interactionId))
    const readable = canRead(viewer, {
      visibility: newest.visibility,
      authorId: newest.authorId,
      widened: newest.widened,
    })
    const listing = emailListing(newest.meta, readable)
    return [
      {
        id: newest.id,
        subject: newest.subject ?? '',
        at: newest.occurredAt.toISOString(),
        messages: thread.length,
        attendees: [...people.values()],
        sent: sentBy(newest.meta, own.addresses),
        records: [...records.values()],
        attachments: attached.length,
        attachmentNames: [...new Set(attached.map((f) => f.name))],
        summary: listing.summary ?? listing.snippet,
        privateBody: !readable,
        draft: drafted.has(key),
      },
    ]
  })
})
