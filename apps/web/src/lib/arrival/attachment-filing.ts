import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interactionDocument } from '@spaces/db/schema'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '@spaces/core/writes/documents/intake'
import type { DocumentPrivacy } from '@spaces/core/writes/documents/birth'
import { webEnqueue } from '#/lib/enqueue-live'
import type { MailAttachment, SortedAttachments } from './attachments'

/**
 * Every mail attachment, forwarded or synced, is a document joined to its
 * email on `interaction_document` as `attachment` (D67, D68).
 * - **One byte path.** Each part goes through `intakeDocumentProgram`, the
 *   one writer of `document`; nothing here inserts a document row.
 * - **Filed on every participant record** the interaction edged, people and
 *   companies alike. None is an unfiled document.
 * - **Dedupe is the sha.** Birth answers the row already holding these bytes
 *   at one of the records, so the same deck forwarded and synced is one
 *   document joined to both emails.
 * - **Provenance is the mailbox's**: `source_class = 'integration'`, the
 *   lane's integration as `source_ref` and actor, the subject as
 *   `source_path`. `kind` stays `other`; the classify lane proposes one.
 * - **Private with the email's body** (D67): born with `privacy`, which a
 *   synced mailbox sets to its owner.
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
}

export type AttachmentOutcome = {
  /** Filed onto its records — a fresh row, or the one §3.4 answered. */
  filed: number
  /** Written with no edge at all. */
  unfiled: number
  /** Filed or unfiled, but the join to its email failed; a re-delivery retries. */
  unjoined: number
  /** Inline and signature images, never handed to the pipeline. */
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
    const born = yield* intakeDocumentProgram({
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
    }).pipe(
      // Birth's extraction enqueue, through the web sender.
      Effect.provide(webEnqueue),
      Effect.map((doc) => ({ ok: true as const, id: doc.id })),
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

/**
 * A re-delivered Message-ID's missing joins, written now: each part's sha
 * finds the document its first filing made — born by the email's lane, or
 * deduped onto one filed on the email's records — and joins it if it is not.
 * Nothing is filed: a part never stored stays unstored. Answers how many.
 */
export const rejoinAttachmentsProgram = Effect.fn('rejoinAttachments')(
  function* (
    attachments: SortedAttachments,
    messageId: string,
  ): Effect.fn.Return<number> {
    if (attachments.file.length === 0) return 0
    const shas = [
      ...new Set(
        attachments.file.map((p) =>
          createHash('sha256').update(p.content).digest('hex'),
        ),
      ),
    ]
    return yield* Effect.tryPromise({
      try: () =>
        db.execute(sql`
          insert into interaction_document (interaction_id, document_id, role)
          select distinct on (d.blob_sha) i.id, d.entity_id, 'attachment'
          from interaction i
          join document d on d.blob_sha in (${sql.join(
            shas.map((sha) => sql`${sha}`),
            sql`, `,
          )})
          where i.message_id = ${messageId}
            and not exists (
              select 1 from interaction_document j
              join document jd on jd.entity_id = j.document_id
              where j.interaction_id = i.id and j.role = 'attachment'
                and jd.blob_sha = d.blob_sha
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
          order by d.blob_sha, d.created_at
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
