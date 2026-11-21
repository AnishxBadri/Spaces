import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Effect } from 'effect'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  document,
  interactionDocument,
  link,
  pendingBlob,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
  putBlobProgram,
} from '@spaces/core/writes/documents/intake'
import {
  addEdges,
  birthDocumentProgram,
} from '@spaces/core/writes/documents/birth'
import type { DocumentPrivacy } from '@spaces/core/writes/documents/birth'
import { proposeNewerVersionProgram } from '@spaces/core/writes/documents/newer-version'
import { webEnqueue } from '#/lib/enqueue-live'
import { attachmentExternalId } from './attachment-pointer'
import type { MailAttachment, SortedAttachments } from './attachments'

/**
 * Every mail attachment, forwarded or synced, is a document joined to its
 * email on `interaction_document` as `attachment`.
 * - **One writer.** Each part is born through `birthDocumentProgram`, via
 *   intake when its bytes are stored; nothing here inserts a document row.
 * - **Filed on every participant record** the interaction edged, people and
 *   companies alike. None is an unfiled document.
 * - **Dedupe is the sha.** A part lands on the row already holding or
 *   standing for these bytes at one of the records, so the same deck
 *   forwarded and synced is one document joined to both emails.
 * - **Provenance is the mailbox's**: `source_class = 'integration'`, the
 *   lane's integration as `source_ref` and actor, the subject as
 *   `source_path`. `kind` stays `other`; the classify lane proposes one.
 * - **Private with the email's body**: born with `privacy`, which a
 *   synced mailbox sets to its owner.
 * - **A synced mailbox keeps text, not files.** Its part is born with
 *   an empty `blob_sha`, its connection, and `<message id>/<sha>` as
 *   `external_id`; extraction fetches it back through the connection and
 *   stores nothing. The automatic filing on the records does not keep it.
 * - **A forwarded part is stored, as forwarding asks.** A synced row of the
 *   same bytes on the same records is given them, so the two lanes still
 *   meet on one document.
 * - **A refusal is per part, never the message's**: too large or a store
 *   that is down is recorded on the poll's summary line and the rest lands.
 *   A failed join is `unjoined`, not refused: the document exists, and the
 *   Message-ID's re-delivery rejoins it (`rejoinAttachmentsProgram`).
 */

export type AttachmentFilingContext = {
  /** The lane's integration — `source_ref` and actor on every row. */
  integrationId: string
  /** The email the attachments join. */
  interactionId: string
  /** The message subject, stored verbatim as `document.source_path`. */
  subject: string | null
  /** The people and companies the email edged; empty is unfiled. */
  records: ReadonlyArray<string>
  /** Who may read each part: the body's visibility and the mailbox owner. */
  privacy: DocumentPrivacy
  /**
   * The synced mailbox the files stay in: its connection and its own id for
   * the message. Null on the forwarded lane, which stores them.
   */
  mailbox: {
    readonly connectionId: string
    readonly providerMessageId: string
  } | null
}

export type AttachmentOutcome = {
  /** Filed onto its records — a fresh row, or the one birth deduped onto. */
  filed: number
  /** Written with no edge at all. */
  unfiled: number
  /** Filed or unfiled, but the join to its email failed; a re-delivery retries. */
  unjoined: number
  /** Inline and signature images and invites, never handed to the pipeline. */
  skipped: number
  /** Refused, with the sentence the summary line carries. */
  refused: Array<{ filename: string; reason: string }>
}

export const NO_ATTACHMENTS: AttachmentOutcome = {
  filed: 0,
  unfiled: 0,
  unjoined: 0,
  skipped: 0,
  refused: [],
}

/**
 * The decoded part, handed over in slices so the intake meter counts it the
 * way it counts any provider's stream — and stops reading at the limit.
 * `subarray` is a view: no copy of the bytes mailparser already holds.
 */
const CHUNK_BYTES = 64 * 1024

function streamOf(content: MailAttachment['content']): Readable {
  return Readable.from(
    (function* () {
      for (let at = 0; at < content.length; at += CHUNK_BYTES)
        yield content.subarray(at, at + CHUNK_BYTES)
    })(),
  )
}

const digestOf = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex')

/** The email's half of a filed part: the join row, idempotent. */
const joinAttachment = (interactionId: string, documentId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .insert(interactionDocument)
        .values({ interactionId, documentId, role: 'attachment' })
        .onConflictDoNothing(),
    catch: (cause) => cause,
  }).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  )

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

/** Any mailbox pointer to a part of these bytes. */
const pointerLike = (sha: string) => `%/${sha}`

/** Whether a document holding these bytes is filed on one of the records. */
const storedTwinOn = (sha: string, records: ReadonlyArray<string>) =>
  records.length === 0
    ? Effect.succeed(false)
    : query(() =>
        db
          .select({ id: document.entityId })
          .from(document)
          .innerJoin(link, eq(link.fromEntityId, document.entityId))
          .where(
            and(
              eq(document.blobSha, sha),
              inArray(link.toEntityId, [...records]),
              eq(link.relation, 'tagged_in'),
            ),
          )
          .limit(1),
      ).pipe(Effect.map((rows) => rows.length > 0))

/**
 * A synced row with no bytes that stands for the same part: this
 * connection's own row for it, or one of these bytes filed on one of the
 * records. Oldest first, as birth's dedupe answers.
 */
const remoteTwinOf = (
  sha: string,
  records: ReadonlyArray<string>,
  own: { connectionId: string; externalId: string } | null,
) => {
  const mine =
    own === null
      ? sql`false`
      : sql`(${document.connectionId} = ${own.connectionId} and ${document.externalId} = ${own.externalId})`
  const onRecords =
    records.length === 0
      ? sql`false`
      : sql`(${document.externalId} like ${pointerLike(sha)} and exists (select 1 from ${link} where ${link.fromEntityId} = ${document.entityId} and ${link.relation} = 'tagged_in' and ${inArray(link.toEntityId, [...records])}))`
  return query(() =>
    db
      .select({ id: document.entityId })
      .from(document)
      .where(and(isNull(document.blobSha), sql`(${mine} or ${onRecords})`))
      .orderBy(document.createdAt)
      .limit(1),
  ).pipe(Effect.map((rows) => rows.at(0)?.id ?? null))
}

/**
 * The part filed onto a synced row that already stands for it: the missing
 * edges, and shared when it arrives shared, as birth's dedupe does.
 */
const fileOntoTwin = (documentId: string, ctx: AttachmentFilingContext) =>
  query(() =>
    db.transaction(async (tx) => {
      await addEdges(
        tx,
        documentId,
        ctx.records.map((entityId) => ({ kind: 'record' as const, entityId })),
        null,
      )
      if (ctx.privacy.visibility === 'shared')
        await tx
          .update(document)
          .set({
            visibility: 'shared',
            authorId: sql`case when ${document.authorId} is not distinct from ${ctx.privacy.authorId} then ${document.authorId} end`,
          })
          .where(eq(document.entityId, documentId))
    }),
  ).pipe(Effect.as(documentId))

/**
 * Forwarded bytes for a synced row that has none: the row keeps them now,
 * so intake's dedupe lands the forward on it instead of beside it.
 */
const keepOnRemoteTwin = Effect.fn('keepOnRemoteTwin')(function* (
  part: MailAttachment,
  sha: string,
  records: ReadonlyArray<string>,
) {
  const twin = yield* remoteTwinOf(sha, records, null)
  if (twin === null) return
  const blob = yield* putBlobProgram({
    stream: streamOf(part.content),
    mime: part.mime,
    preparedBy: null,
  })
  yield* query(() =>
    db.transaction(async (tx) => {
      const kept = await tx
        .update(document)
        .set({ blobSha: blob.sha })
        .where(and(eq(document.entityId, twin), isNull(document.blobSha)))
        .returning({ id: document.entityId })
      if (kept.length > 0)
        await tx.delete(pendingBlob).where(eq(pendingBlob.sha, blob.sha))
    }),
  )
})

/**
 * One synced part as a document with no bytes: onto the row that already
 * stands for it, else born with its pointer, its text read through the
 * connection.
 */
const fileFromMailbox = Effect.fn('fileFromMailbox')(function* (
  part: MailAttachment,
  sha: string,
  mailbox: NonNullable<AttachmentFilingContext['mailbox']>,
  ctx: AttachmentFilingContext,
) {
  const externalId = attachmentExternalId(mailbox.providerMessageId, sha)
  const twin = yield* remoteTwinOf(sha, ctx.records, {
    connectionId: mailbox.connectionId,
    externalId,
  })
  if (twin !== null) return yield* fileOntoTwin(twin, ctx)
  const born = yield* birthDocumentProgram({
    blobSha: null,
    filename: part.filename,
    mime: part.mime,
    sizeBytes: part.content.length,
    kind: 'other',
    sourceClass: 'integration',
    sourceRef: ctx.integrationId,
    provenance: {
      sourcePath: ctx.subject,
      connectionId: mailbox.connectionId,
      externalId,
      externalStatus: 'linked',
    },
    fileAgainst: ctx.records.map((entityId) => ({
      kind: 'record' as const,
      entityId,
    })),
    actor: { integrationId: ctx.integrationId },
    privacy: ctx.privacy,
  })
  // Birth sends no extraction for a row without bytes; this one has a
  // pointer, and extraction fetches through it.
  const queue = yield* Enqueue
  yield* queue.enqueue(QUEUES.extractDocument, { documentId: born.id })
  if (ctx.records.length > 0) yield* proposeNewerVersionProgram(born.id)
  return born.id
})

const intakeOf = (part: MailAttachment, ctx: AttachmentFilingContext) =>
  intakeDocumentProgram({
    stream: streamOf(part.content),
    filename: part.filename,
    mime: part.mime,
    // Not declared: the meter is this lane's one guard, the same one every
    // server-side arrival passes through, and it refuses mid-stream.
    declaredSize: null,
    kind: 'other',
    sourceClass: 'integration',
    sourceRef: ctx.integrationId,
    provenance: { sourcePath: ctx.subject },
    fileAgainst: ctx.records.map((entityId) => ({
      kind: 'record' as const,
      entityId,
    })),
    actor: { integrationId: ctx.integrationId },
    privacy: ctx.privacy,
  }).pipe(Effect.map((doc) => doc.id))

/** One part, by its lane: the id of the document it filed as. */
const filePart = Effect.fn('filePart')(function* (
  part: MailAttachment,
  ctx: AttachmentFilingContext,
) {
  const sha = digestOf(part.content)
  const mailbox = ctx.mailbox
  if (mailbox === null) {
    yield* keepOnRemoteTwin(part, sha, ctx.records)
    return yield* intakeOf(part, ctx)
  }
  // Bytes a record already holds: intake stores nothing new and dedupes.
  if (yield* storedTwinOn(sha, ctx.records)) return yield* intakeOf(part, ctx)
  return yield* fileFromMailbox(part, sha, mailbox, ctx)
})

export const fileAttachmentsProgram = Effect.fn('fileAttachments')(function* (
  attachments: SortedAttachments,
  ctx: AttachmentFilingContext,
): Effect.fn.Return<AttachmentOutcome> {
  const outcome: AttachmentOutcome = {
    filed: 0,
    unfiled: 0,
    unjoined: 0,
    skipped: attachments.skipped.length,
    refused: [],
  }
  for (const part of attachments.file) {
    const born = yield* filePart(part, ctx).pipe(
      // Birth's extraction enqueue, through the web sender.
      Effect.provide(webEnqueue),
      Effect.map((id) => ({ ok: true as const, id })),
      Effect.catch((failure) =>
        Effect.succeed({
          ok: false as const,
          reason: documentIntakeMessage(failure),
        }),
      ),
    )
    if (!born.ok) {
      outcome.refused.push({ filename: part.filename, reason: born.reason })
      continue
    }
    if (ctx.records.length === 0) outcome.unfiled++
    else outcome.filed++
    // The document exists either way; a re-delivery rejoins it.
    if (!(yield* joinAttachment(ctx.interactionId, born.id))) outcome.unjoined++
  }
  return outcome
})

/** A row's bytes by digest: its blob, else the digest its mailbox pointer names. */
const contentSha = (alias: 'd' | 'jd') =>
  sql.raw(
    `coalesce(${alias}.blob_sha, substring(${alias}.external_id from '/([a-f0-9]{64})$'))`,
  )

/**
 * A re-delivered Message-ID's missing joins, written now: each part's sha
 * finds the document its first filing made — born by the email's lane, or
 * deduped onto one filed on the email's records — and joins it if it is not.
 * A synced row with no bytes is found by the digest its pointer names.
 * Nothing is filed: a part never stored stays unstored. Answers how many.
 */
export const rejoinAttachmentsProgram = Effect.fn('rejoinAttachments')(
  function* (
    attachments: SortedAttachments,
    messageId: string,
  ): Effect.fn.Return<number> {
    if (attachments.file.length === 0) return 0
    const shas = [...new Set(attachments.file.map((p) => digestOf(p.content)))]
    return yield* Effect.tryPromise({
      try: () =>
        db.execute(sql`
          insert into interaction_document (interaction_id, document_id, role)
          select distinct on (${contentSha('d')}) i.id, d.entity_id, 'attachment'
          from interaction i
          join document d on ${contentSha('d')} in (${sql.join(
            shas.map((sha) => sql`${sha}`),
            sql`, `,
          )})
          where i.message_id = ${messageId}
            and not exists (
              select 1 from interaction_document j
              join document jd on jd.entity_id = j.document_id
              where j.interaction_id = i.id and j.role = 'attachment'
                and ${contentSha('jd')} = ${contentSha('d')}
            )
            and (
              d.source_ref = i.source_ref
              or exists (
                select 1 from link l
                join interaction_entity ie on ie.entity_id = l.to_entity_id
                where l.from_entity_id = d.entity_id
                  and l.relation = 'tagged_in'
                  and ie.interaction_id = i.id
              )
            )
          order by ${contentSha('d')}, d.created_at
          on conflict do nothing
          returning document_id
        `),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((result) => result.rows.length),
      Effect.orElseSucceed(() => 0),
    )
  },
)
