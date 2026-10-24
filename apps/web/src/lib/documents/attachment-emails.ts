import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { canRead } from '@spaces/core/read-policy'
import { noteWidenedSql } from '@spaces/core/writes/read/can-read-sql'
import { db } from '@spaces/db'
import { interaction, interactionDocument, note } from '@spaces/db/schema'

/** The email a file came attached to, as the Files row names it. */
export type AttachmentEmail = { interactionId: string; subject: string | null }

/** The earliest email the viewer may read, per document. */
export type AttachmentEmails = Map<string, AttachmentEmail>

export class AttachmentEmailsFailed extends Schema.TaggedError<AttachmentEmailsFailed>()(
  'AttachmentEmailsFailed',
  { cause: Schema.Defect() },
) {}

/**
 * The email each attached document is named by on the Files tab: the
 * earliest one the viewer can read through its body gate. Whether the
 * document is listed at all is `canReadDocumentSql`'s question.
 */
export const attachmentEmailsProgram = Effect.fn('attachmentEmails')(function* (
  viewer: { id: string },
  documentIds: ReadonlyArray<string>,
): Effect.fn.Return<AttachmentEmails, AttachmentEmailsFailed> {
  const out: AttachmentEmails = new Map()
  if (documentIds.length === 0) return out
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          documentId: interactionDocument.documentId,
          interactionId: interaction.id,
          subject: interaction.subject,
          visibility: note.visibility,
          authorId: note.authorId,
          widened: noteWidenedSql(viewer.id),
        })
        .from(interactionDocument)
        .innerJoin(
          interaction,
          eq(interaction.id, interactionDocument.interactionId),
        )
        .leftJoin(note, eq(note.entityId, interaction.noteId))
        .where(
          and(
            inArray(interactionDocument.documentId, [...documentIds]),
            eq(interactionDocument.role, 'attachment'),
          ),
        )
        .orderBy(asc(interaction.occurredAt)),
    catch: (cause) => new AttachmentEmailsFailed({ cause }),
  })

  for (const r of rows)
    if (!out.has(r.documentId) && canRead(viewer, r))
      out.set(r.documentId, {
        interactionId: r.interactionId,
        subject: r.subject,
      })
  return out
})
