import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { normalizeDomain, normalizeEmail } from '@spaces/sdk/identity'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entityAlias,
  interaction,
  interactionDocument,
  interactionEntity,
  note,
  pendingBlob,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import type { BodyVisibility } from '@spaces/core/writes/interactions/write'
import { putBlobProgram } from '@spaces/core/writes/documents/intake'
import { reclaimBlobIfOrphaned } from '#/lib/documents/blob-refs'
import { enqueueSummarizeEmail } from '#/lib/ai/summarize-email'
import type { EmailMeta } from '@spaces/db/schema'
import type { Address } from './forwarded'
import type { ArrivalMessage } from './message'
import { participantRecordsProgram } from './participant-records'
import {
  NO_ATTACHMENTS,
  fileAttachmentsProgram,
  rejoinAttachmentsProgram,
} from './attachment-filing'
import type { AttachmentOutcome } from './attachment-filing'

/**
 * One arrival → one interaction, its body note and its edges. The write half
 * of the poll, and the only place this lane touches the graph.
 * - The dedupe is `interaction_message_id_unique`: the insert is `on conflict
 *   (message_id) do nothing`. Nothing checks first — a pre-check would race a
 *   concurrent poll, and the index cannot.
 * - One transaction, the interaction first: a duplicate leaves no orphan body
 *   note, and a failed edge insert leaves no bodyless interaction that the
 *   next poll would skip as a duplicate.
 * - Participants become records first, through `resolveEntity`, which commits
 *   on its own and so sits before the transaction. Nothing here inserts into
 *   `entity` or `entity_alias` itself. The records the gate returned are
 *   edged too, so a company that lost its domain claim is still on the thread.
 * - The row, body and edges are `writeIntegrationInteraction`'s; this module
 *   owns who the participants are, thread inheritance and attachment filing.
 * - Edges go to people and companies only, never a deal: a deal's threads are
 *   derived from its company and contacts. A reply inherits every person and
 *   company already edged on its `thread_id`.
 * - The body is a note filed against nothing (not `tagged_in`, which would
 *   put every mail in every participant's Notes). A forwarded body is born
 *   shared — forwarding is the consent; a synced one follows `FileOptions`.
 * - Attachments file only for a written interaction, after the commit,
 *   because intake commits on its own. A duplicate only rejoins missing links.
 */

export class ArrivalWriteFailed extends Schema.TaggedError<ArrivalWriteFailed>()(
  'ArrivalWriteFailed',
  { cause: Schema.Defect() },
) {}

export type FileContext = {
  /** The mailbox's integration — `source_ref` on every row written. */
  integrationId: string
  /** The workspace user the body note is authored by. */
  authorId: string
}

/**
 * What differs between the two mail lanes. A forwarded body is born shared;
 * a synced one is the connection's to decide, and carries the mailbox's
 * labels so an exclude list can find it.
 * - The attachments are born with the body's visibility; a synced mailbox's
 *   are authored by its owner, so a private one is theirs alone.
 */
export type FileOptions = {
  visibility: BodyVisibility
  labels: ReadonlyArray<string> | null
  /** The mailbox's preview of the body (Gmail's `snippet`), when it sent one. */
  snippet?: string
  /** The synced mailbox's owner; null on the forwarded lane. */
  mailboxOwner: string | null
}

export const FORWARDED: FileOptions = {
  visibility: 'shared',
  labels: null,
  mailboxOwner: null,
}

/**
 * The headers an email row keeps in `interaction.meta`, with the
 * digest of its stored MIME — null when the bytes were too large to keep.
 */
export function emailMetaOf(
  message: ArrivalMessage,
  labels: ReadonlyArray<string> | null,
  mimeBlobSha: string | null,
  snippet?: string,
): EmailMeta {
  return {
    kind: 'email',
    from: message.from?.email ?? '',
    to: message.to.map((a) => a.email),
    cc: message.cc.map((a) => a.email),
    ...(message.bcc.length === 0
      ? {}
      : { bcc: message.bcc.map((a) => a.email) }),
    date: message.occurredAt.toISOString(),
    mime_blob_sha: mimeBlobSha,
    ...(labels === null ? {} : { labels: [...labels] }),
    ...(snippet === undefined ? {} : { snippet }),
  }
}

export type Filed =
  | {
      kind: 'written'
      interactionId: string
      noteId: string
      edges: number
      /** The records the attachments file on; empty is unfiled. */
      records: Array<string>
      attachments: AttachmentOutcome
    }
  | { kind: 'duplicate' }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The entities an address list resolves to — people by email, companies by domain. */
export async function matchParticipants(
  tx: Tx,
  participants: ReadonlyArray<Address>,
): Promise<Array<string>> {
  const emails = [
    ...new Set(
      participants
        .map((p) => normalizeEmail(p.email))
        .filter((e): e is string => e !== null),
    ),
  ]
  const domains = [
    ...new Set(
      participants
        .map((p) =>
          normalizeDomain(p.email.slice(p.email.lastIndexOf('@') + 1)),
        )
        .filter((d): d is string => d !== null),
    ),
  ]
  if (emails.length === 0 && domains.length === 0) return []

  const byKey = [
    ...(emails.length > 0
      ? [
          and(
            eq(entityAlias.kind, 'email'),
            inArray(entityAlias.valueNorm, emails),
          ),
        ]
      : []),
    ...(domains.length > 0
      ? [
          and(
            eq(entityAlias.kind, 'domain'),
            inArray(entityAlias.valueNorm, domains),
          ),
        ]
      : []),
  ]
  // A merged loser still owns its aliases until the executor moves them; the
  // edge goes to the winner it redirects to. Chains are flattened at merge
  // time, so one hop is the whole walk.
  const rows = await tx
    .selectDistinct({
      id: sql<string>`coalesce(${entity.mergedIntoId}, ${entity.id})`,
    })
    .from(entityAlias)
    .innerJoin(entity, eq(entity.id, entityAlias.entityId))
    .where(and(or(...byKey), inArray(entity.kind, ['person', 'company'])))
  return rows.map((r) => r.id)
}

/**
 * The body of the interaction a Message-ID already holds, made shared when
 * it was private, with a `note.visibility_changed` row naming the lane. Its
 * private attachments are shared with it, and keep no author: forwarding is
 * the consent, and the mailbox's toggle does not narrow them.
 */
async function widenBody(
  tx: Tx,
  messageId: string,
  integrationId: string,
): Promise<void> {
  const widened = await tx
    .update(note)
    .set({ visibility: 'shared', updatedAt: new Date() })
    .where(
      and(
        eq(note.visibility, 'private'),
        eq(
          note.entityId,
          sql`(select ${interaction.noteId} from ${interaction} where ${interaction.messageId} = ${messageId})`,
        ),
      ),
    )
    .returning({ id: note.entityId })
  await tx
    .update(document)
    .set({ visibility: 'shared', authorId: null })
    .where(
      and(
        eq(document.visibility, 'private'),
        inArray(
          document.entityId,
          tx
            .select({ id: interactionDocument.documentId })
            .from(interactionDocument)
            .innerJoin(
              interaction,
              eq(interaction.id, interactionDocument.interactionId),
            )
            .where(
              and(
                eq(interaction.messageId, messageId),
                eq(interactionDocument.role, 'attachment'),
              ),
            ),
        ),
      ),
    )
  for (const { id } of widened)
    await tx.insert(activity).values({
      actorId: null,
      verb: 'note.visibility_changed',
      subjectEntityId: id,
      meta: {
        from: 'private',
        to: 'shared',
        integrationId,
        reason: 'forwarded',
      },
    })
}

/** The live people and companies among an edge list: where attachments file. */
async function filingRecordsOf(
  tx: Tx,
  entityIds: ReadonlyArray<string>,
): Promise<Array<string>> {
  if (entityIds.length === 0) return []
  const rows = await tx
    .select({ id: entity.id })
    .from(entity)
    .where(
      and(
        inArray(entity.id, [...entityIds]),
        inArray(entity.kind, ['person', 'company']),
        isNull(entity.mergedIntoId),
      ),
    )
  return rows.map((r) => r.id)
}

/** People and companies already on this thread — what a reply inherits. */
async function threadEdges(tx: Tx, threadId: string): Promise<Array<string>> {
  const rows = await tx
    .selectDistinct({ id: interactionEntity.entityId })
    .from(interactionEntity)
    .innerJoin(interaction, eq(interaction.id, interactionEntity.interactionId))
    .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
    .where(
      and(
        eq(interaction.threadId, threadId),
        inArray(entity.kind, ['person', 'company']),
        isNull(entity.mergedIntoId),
      ),
    )
  return rows.map((r) => r.id)
}

type StoredMime = { sha: string; stored: boolean } | null

/**
 * The raw MIME as a content-addressed blob: the same bytes are one
 * blob by construction.
 * - Nothing is stored for a Message-ID already held: a second mailbox's copy
 *   carries its own Received and DKIM headers, so its digest differs and it
 *   would only ever be an orphan.
 * - Stored before the row so `meta` never names missing bytes; a new blob
 *   carries a `pending_blob` intent row that a written arrival clears.
 * - Too large to keep is null, not a refusal: the body note still lands.
 */
const storeMimeProgram = Effect.fn('storeMime')(function* (
  message: ArrivalMessage,
): Effect.fn.Return<StoredMime, ArrivalWriteFailed> {
  const held = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ id: interaction.id })
        .from(interaction)
        .where(eq(interaction.messageId, message.messageId))
        .limit(1),
    catch: (cause) => new ArrivalWriteFailed({ cause }),
  })
  if (held.length > 0) return null
  return yield* putBlobProgram({
    stream: Readable.from(message.mime),
    mime: 'message/rfc822',
    preparedBy: null,
  }).pipe(
    Effect.map((blob): StoredMime => ({ sha: blob.sha, stored: blob.stored })),
    Effect.catchTag('DocumentTooLarge', () => Effect.succeed(null)),
    Effect.mapError((e) => new ArrivalWriteFailed({ cause: e.cause })),
  )
})

/**
 * Bytes this arrival stored for a row a concurrent arrival wrote first: the
 * intent row goes, and the bytes too unless something names them.
 */
const dropRacedMimeProgram = Effect.fn('dropRacedMime')(function* (
  sha: string,
): Effect.fn.Return<void, ArrivalWriteFailed> {
  yield* Effect.tryPromise({
    try: async () => {
      await reclaimBlobIfOrphaned(sha)
      await db.delete(pendingBlob).where(eq(pendingBlob.sha, sha))
    },
    catch: (cause) => new ArrivalWriteFailed({ cause }),
  })
})

export const fileArrivalProgram = Effect.fn('fileArrival')(function* (
  message: ArrivalMessage,
  ctx: FileContext,
  options: FileOptions = FORWARDED,
): Effect.fn.Return<Filed, ArrivalWriteFailed> {
  // Participants → records, through the gate. Before the transaction, and
  // for a duplicate too: a re-read is all attaches.
  const records = yield* participantRecordsProgram(message, ctx).pipe(
    Effect.mapError((e) => new ArrivalWriteFailed({ cause: e.cause })),
  )
  const mime = yield* storeMimeProgram(message)
  const mimeBlobSha = mime?.sha ?? null
  const written = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx): Promise<Filed> => {
        const wrote = await writeIntegrationInteraction(tx, {
          integrationId: ctx.integrationId,
          kind: 'email',
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          occurredAt: message.occurredAt,
          meta: emailMetaOf(
            message,
            options.labels,
            mimeBlobSha,
            options.snippet,
          ),
          body: {
            title: message.subject ?? '',
            text: message.body,
            authorId: ctx.authorId,
            visibility: options.visibility,
          },
          // Matched and inherited after the row exists; the writer calls
          // this inside the same transaction.
          edges: async () => [
            ...records.entityIds,
            ...(await matchParticipants(tx, message.participants)),
            ...(await threadEdges(tx, message.threadId)),
          ],
        })
        if (wrote.kind === 'duplicate') {
          // Forwarding is the consent: a forward of a thread a mailbox
          // synced privately widens that body. A synced duplicate changes
          // nothing — two private copies of one thread is mailbox #2's.
          if (options.visibility === 'shared')
            await widenBody(tx, message.messageId, ctx.integrationId)
          return wrote
        }
        if (wrote.noteId === null)
          throw new Error('the mailbox writes a body for every interaction')
        // The row names the bytes now; the orphan sweep must not take them.
        if (mimeBlobSha !== null)
          await tx.delete(pendingBlob).where(eq(pendingBlob.sha, mimeBlobSha))
        const { interactionId, noteId, edges } = wrote

        return {
          kind: 'written',
          interactionId,
          noteId,
          edges: edges.length,
          records: await filingRecordsOf(tx, edges),
          attachments: NO_ATTACHMENTS,
        }
      }),
    catch: (cause) => new ArrivalWriteFailed({ cause }),
  })
  if (written.kind === 'duplicate') {
    if (mime?.stored === true) yield* dropRacedMimeProgram(mime.sha)
    yield* rejoinAttachmentsProgram(message.attachments, message.messageId)
    return written
  }

  const attachments = yield* fileAttachmentsProgram(message.attachments, {
    integrationId: ctx.integrationId,
    interactionId: written.interactionId,
    subject: message.subject,
    records: written.records,
    privacy: {
      visibility: options.visibility,
      authorId: options.mailboxOwner,
    },
  })
  // Its summary and categories, after the commit.
  yield* Effect.promise(() => enqueueSummarizeEmail(written.interactionId))
  return { ...written, attachments }
})
