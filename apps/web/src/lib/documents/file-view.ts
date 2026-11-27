import { Effect } from 'effect'
import { and, desc, eq, inArray, isNull, max, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  entity,
  interaction,
  link,
  objectDef,
} from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { parseAddresses } from '#/lib/arrival/forwarded'
import { documentDetailsProgram } from './details'
import { spaceTreeProgram } from './file-under'
import type { FileUnderOption } from './file-under'
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
  | {
      readonly via: 'lane'
      readonly lane: string
      /** The provider's own folder path, verbatim. */
      readonly path: string | null
      readonly at: string
    }
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

  const origin = originOf(
    viewer,
    doc,
    email === undefined
      ? undefined
      : {
          from: email.meta?.kind === 'email' ? email.meta.from : '',
          at: email.at,
        },
  )
  const versions = yield* railVersionsProgram(
    viewer,
    doc,
    origin,
    details?.versions ?? [],
  )

  return {
    doc,
    version: versionOf(details?.versions ?? []),
    /** The highest page its text was read from; null when none knows. */
    pages: details?.pages ?? null,
    origin,
    /** Every place it is filed, as the rail's `Filed under` draws them. */
    filings: yield* railFilingsProgram(doc.filedIn),
    /** Its replace chain, newest first: the rail's `Versions`. */
    versions,
    source: sourceOf(doc, details?.email ?? null),
    /** The notes that mention it, the reader's private ones only to them. */
    mentionedIn: details?.mentionedIn ?? [],
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
  doc: OriginFields,
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
    return {
      via: 'lane',
      lane: doc.sourceCapability,
      path: doc.sourcePath,
      at: doc.createdAt,
    }
  return {
    via: doc.blobSha === null && doc.url !== null ? 'clip' : 'upload',
    by: doc.uploadedBy === viewer.id ? null : doc.uploadedByName,
    at: doc.createdAt,
  }
}

/** What `originOf` reads off a file's row. */
type OriginFields = {
  readonly uploadedBy: string | null
  readonly uploadedByName: string | null
  readonly sourceCapability: string | null
  readonly sourcePath: string | null
  readonly blobSha: string | null
  readonly url: string | null
  readonly createdAt: string
}

/** One version on the rail's timeline. */
export type RailVersion = {
  readonly id: string
  readonly name: string
  /** ISO instant it was kept. */
  readonly at: string
  /** The file open in the viewer. */
  readonly current: boolean
  /** Its highest read page; null when none knows. */
  readonly pages: number | null
  /** Who brought it and how: `Priya Raman, by email`. */
  readonly origin: FileOrigin
}

/**
 * The replace chain as the rail's timeline draws it, newest first, or empty
 * for a file that stands alone. Each version is read as the file itself is
 * (`documentRowProgram`, through the read gate), so an email the reader may
 * not open names no sender here either.
 */
const railVersionsProgram = Effect.fn('fileView.versions')(function* (
  viewer: { readonly id: string; readonly email: string },
  doc: { readonly id: string },
  origin: FileOrigin,
  chain: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly at: string
    readonly current: boolean
  }>,
) {
  if (chain.length < 2) return []
  const others = chain.filter((v) => v.id !== doc.id).map((v) => v.id)
  const rows = (yield* Effect.forEach(
    others,
    (id) => documentRowProgram(viewer.id, id),
    { concurrency: 4 },
  )).flatMap((r) => (r === null ? [] : [r]))
  const described = yield* describeDocumentRowsProgram(viewer.id, rows, false)
  const mailIds = described.flatMap((d) =>
    d.email === null ? [] : [d.email.interactionId],
  )
  const mails =
    mailIds.length === 0
      ? []
      : yield* documentsQuery(() =>
          db
            .select({
              id: interaction.id,
              meta: interaction.meta,
              at: interaction.occurredAt,
            })
            .from(interaction)
            .where(inArray(interaction.id, mailIds)),
        )
  const mailById = new Map(mails.map((m) => [m.id, m]))
  const pageRows = yield* documentsQuery(() =>
    db
      .select({ id: chunk.entityId, pages: max(chunk.page) })
      .from(chunk)
      .where(
        inArray(
          chunk.entityId,
          chain.map((v) => v.id),
        ),
      )
      .groupBy(chunk.entityId),
  )
  const pages = new Map(pageRows.map((p) => [p.id, p.pages]))
  const origins = new Map<string, FileOrigin>([[doc.id, origin]])
  for (const d of described) {
    const mail =
      d.email === null ? undefined : mailById.get(d.email.interactionId)
    origins.set(
      d.id,
      originOf(
        viewer,
        d,
        mail === undefined
          ? undefined
          : {
              from: mail.meta?.kind === 'email' ? mail.meta.from : '',
              at: mail.at,
            },
      ),
    )
  }
  return chain.flatMap((v): Array<RailVersion> => {
    const of = origins.get(v.id)
    return of === undefined
      ? []
      : [
          {
            id: v.id,
            name: v.name,
            at: v.at,
            current: v.id === doc.id,
            pages: pages.get(v.id) ?? null,
            origin: of,
          },
        ]
  })
})

/**
 * The filings as the rail's rows draw them: a custom record with its
 * object's words and glyph, a space with its ancestors' names.
 */
const railFilingsProgram = Effect.fn('fileView.filings')(function* (
  edges: ReadonlyArray<
    | {
        readonly kind: 'record'
        readonly id: string
        readonly name: string
        readonly entityKind: string
      }
    | { readonly kind: 'space'; readonly id: string; readonly name: string }
  >,
) {
  const customIds = edges.flatMap((e) =>
    e.kind === 'record' && e.entityKind === 'custom' ? [e.id] : [],
  )
  const objects =
    customIds.length === 0
      ? []
      : yield* documentsQuery(() =>
          db
            .select({
              id: entity.id,
              singular: objectDef.singular,
              plural: objectDef.plural,
              icon: objectDef.icon,
              slug: objectDef.slug,
            })
            .from(entity)
            .innerJoin(objectDef, eq(objectDef.id, entity.objectId))
            .where(inArray(entity.id, customIds)),
        )
  const objectOf = new Map(objects.map(({ id, ...o }) => [id, o]))
  const tree = edges.some((e) => e.kind === 'space')
    ? yield* spaceTreeProgram()
    : new Map<string, { parents: ReadonlyArray<string> }>()
  return edges.map((e): FileUnderOption =>
    e.kind === 'space'
      ? {
          target: { kind: 'space', entityId: e.id },
          name: e.name,
          kind: 'space',
          object: null,
          parents: tree.get(e.id)?.parents ?? [],
        }
      : {
          target: { kind: 'record', entityId: e.id },
          name: e.name,
          kind: e.entityKind,
          object: objectOf.get(e.id) ?? null,
          parents: [],
        },
  )
})

/** Where a file came from, as the rail's Source row opens it. */
export type FileSource =
  | {
      readonly via: 'email'
      /** The attaching message, which the Email page opens. */
      readonly id: string
      readonly subject: string
    }
  | {
      readonly via: 'lane'
      readonly lane: string
      /** The provider's folder path, verbatim; null when it sent none. */
      readonly path: string | null
      /** The provider's own page for the file. */
      readonly href: string | null
    }
  | { readonly via: 'link'; readonly url: string }
  | { readonly via: 'upload' }

/**
 * The Source row's one answer. The email's subject is a header every member
 * reads, so it shows even when the body is someone else's.
 */
function sourceOf(
  doc: {
    readonly sourceCapability: string | null
    readonly sourcePath: string | null
    readonly externalUrl: string | null
    readonly blobSha: string | null
    readonly url: string | null
  },
  email: { readonly id: string; readonly subject: string } | null,
): FileSource {
  if (email !== null)
    return { via: 'email', id: email.id, subject: email.subject }
  if (doc.sourceCapability !== null)
    return {
      via: 'lane',
      lane: doc.sourceCapability,
      path: doc.sourcePath,
      href: doc.externalUrl,
    }
  if (doc.url !== null) return { via: 'link', url: doc.url }
  return { via: 'upload' }
}
