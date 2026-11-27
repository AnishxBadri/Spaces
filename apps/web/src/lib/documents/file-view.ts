import { Effect } from 'effect'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, interaction, link } from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { parseAddresses } from '#/lib/arrival/forwarded'
import { documentDetailsProgram } from './details'
import { documentsQuery } from './query'
import { describeDocumentRowsProgram, documentRowProgram } from './record-files'

/**
 * Where a file came from, as its head's facts line says it. A person is
 * named only when it is not the reader: `by` and `from` are null for the
 * reader's own upload or email.
 */
export type FileOrigin =
  | {
      readonly via: 'email'
      readonly from: string | null
      /** When the email was sent, ISO. */
      readonly at: string
    }
  | { readonly via: 'lane'; readonly lane: string; readonly at: string }
  | {
      readonly via: 'upload' | 'clip'
      readonly by: string | null
      readonly at: string
    }

/**
 * One file as its window and its page read it, by id, from wherever it was
 * opened: the Files-tab row, the head's facts and the files it may be the
 * newer version of (same kind, filed under one of its records). Null when
 * it is gone, merged away or private to someone else.
 * - No record stands behind it, so the row never offers Follow here.
 */
export const fileViewProgram = Effect.fn('fileView')(function* (
  viewer: { readonly id: string; readonly email: string },
  documentId: string,
) {
  const row = yield* documentRowProgram(viewer.id, documentId)
  if (row === null) return null
  const doc = (yield* describeDocumentRowsProgram(viewer.id, [row], false)).at(
    0,
  )
  if (doc === undefined) return null
  const details = yield* documentDetailsProgram(viewer, documentId)

  // Only an email the reader may read names its sender: `doc.email` is the
  // earliest one that passes the body gate, so an unreadable one says nothing.
  const readable = doc.email
  const email =
    readable === null
      ? undefined
      : (yield* documentsQuery(() =>
          db
            .select({ meta: interaction.meta, at: interaction.occurredAt })
            .from(interaction)
            .where(eq(interaction.id, readable.interactionId))
            .limit(1),
        )).at(0)

  const records = doc.filedIn.flatMap((e) =>
    e.kind === 'record' ? [e.id] : [],
  )
  const older =
    records.length === 0
      ? []
      : yield* documentsQuery(() =>
          db
            .selectDistinct({
              id: document.entityId,
              filename: document.filename,
              mime: document.mime,
              externalUrl: document.externalUrl,
              createdAt: document.createdAt,
            })
            .from(link)
            .innerJoin(document, eq(document.entityId, link.fromEntityId))
            .innerJoin(entity, eq(entity.id, document.entityId))
            .where(
              and(
                eq(link.relation, 'tagged_in'),
                inArray(link.toEntityId, records),
                eq(document.kind, doc.kind),
                ne(document.entityId, documentId),
                isNull(entity.mergedIntoId),
                canReadDocumentSql(viewer.id),
              ),
            )
            .orderBy(desc(document.createdAt)),
        )

  return {
    doc,
    version: versionOf(details?.versions ?? []),
    /** The highest page its text was read from; null when none knows. */
    pages: details?.pages ?? null,
    origin: originOf(
      viewer,
      doc,
      email === undefined
        ? undefined
        : {
            from: email.meta?.kind === 'email' ? email.meta.from : '',
            at: email.at,
          },
    ),
    older: older.map((o) => ({
      ...o,
      filename: o.filename ?? 'Untitled file',
      createdAt: o.createdAt.toISOString(),
    })),
  }
})

/**
 * Where it stands on its replace chain (`v3 of 3`, oldest first), or null
 * for a file that stands alone.
 */
function versionOf(
  chain: ReadonlyArray<{ readonly current: boolean }>,
): { at: number; of: number } | null {
  const newest = chain.findIndex((v) => v.current)
  if (chain.length < 2 || newest < 0) return null
  return { at: chain.length - newest, of: chain.length }
}

function originOf(
  viewer: { readonly id: string; readonly email: string },
  doc: {
    readonly uploadedBy: string | null
    readonly uploadedByName: string | null
    readonly sourceCapability: string | null
    readonly blobSha: string | null
    readonly url: string | null
    readonly createdAt: string
  },
  /** The email it came on: its `From` header and when it was sent. */
  email: { readonly from: string; readonly at: Date } | undefined,
): FileOrigin {
  if (email !== undefined) {
    const sender = parseAddresses(email.from).at(0)
    const mine =
      sender === undefined || sender.email === viewer.email.toLowerCase()
    return {
      via: 'email',
      from: mine ? null : (sender.name ?? sender.email),
      at: email.at.toISOString(),
    }
  }
  if (doc.sourceCapability !== null)
    return { via: 'lane', lane: doc.sourceCapability, at: doc.createdAt }
  return {
    via: doc.blobSha === null && doc.url !== null ? 'clip' : 'upload',
    by: doc.uploadedBy === viewer.id ? null : doc.uploadedByName,
    at: doc.createdAt,
  }
}
