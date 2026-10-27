import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  entity,
  interaction,
  interactionDocument,
  link,
  note,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { canRead } from '@spaces/core/read-policy'
import {
  canReadDocumentSql,
  noteWidenedSql,
} from '@spaces/core/writes/read/can-read-sql'

/**
 * What the file viewer's sidebar and the Remove confirm say about one
 * document beyond its Files-tab row: what leaves with it (chunks), what was
 * read (words, pages) and which notes mention it.
 * - A document the viewer cannot read answers null; private notes they
 *   cannot read are left out, not counted.
 * - Outside the server-fn modules so it never reaches the client barrel.
 */

export class DocumentDetailsFailed extends Schema.TaggedError<DocumentDetailsFailed>()(
  'DocumentDetailsFailed',
  { cause: Schema.Defect() },
) {}

export type DocumentDetails = {
  /** Chunks cut from its text — what leaves the server with it. */
  readonly chunks: number
  /** Words in the extracted text; null when nothing was read. */
  readonly words: number | null
  /** The highest page a chunk was cut from; null when no chunk knows its page. */
  readonly pages: number | null
  readonly sha: string | null
  readonly mentionedIn: ReadonlyArray<{
    readonly id: string
    readonly name: string
    /** When the mention was made, ISO. */
    readonly at: string
  }>
  /** The replace chain this file is on, newest first; itself alone when none. */
  readonly versions: ReadonlyArray<DocumentVersion>
  /** The email the file came on, when it came on one the viewer can open. */
  readonly email: { readonly id: string; readonly subject: string } | null
}

export type DocumentVersion = {
  readonly id: string
  readonly name: string
  /** ISO instant it was kept. */
  readonly at: string
  readonly uploader: string | null
  /** The file the viewer is reading. */
  readonly current: boolean
}

/** How far the chain walk goes before it stops: a guard, not a limit anyone meets. */
const CHAIN_STEPS = 50

/**
 * The files of one replace chain, newest first: a file is one past the
 * longest chain behind it, and a tie (two marked newer than one) goes to the
 * later upload.
 */
export function chainNewestFirst<T extends { id: string; at: string }>(
  files: ReadonlyArray<T>,
  edges: ReadonlyArray<{ newer: string; older: string }>,
): Array<T> {
  const olderOf = new Map<string, Array<string>>()
  for (const e of edges)
    olderOf.set(e.newer, [...(olderOf.get(e.newer) ?? []), e.older])
  const depth = new Map<string, number>()
  const measure = (id: string, seen: ReadonlySet<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const behind = (olderOf.get(id) ?? []).filter((o) => !seen.has(o))
    const n =
      1 + Math.max(0, ...behind.map((o) => measure(o, new Set([...seen, id]))))
    depth.set(id, n)
    return n
  }
  return [...files].sort(
    (a, b) =>
      measure(b.id, new Set()) - measure(a.id, new Set()) ||
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0),
  )
}

const query = <TRow>(run: () => Promise<TRow>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DocumentDetailsFailed({ cause }),
  })

/**
 * Every file on `documentId`'s replace chain, walked through `supersedes`
 * both ways, then read through `canReadDocumentSql`: a version the viewer
 * may not read is left out of the list.
 */
const versionsOf = Effect.fn('documentVersions')(function* (
  viewer: { readonly id: string },
  documentId: string,
) {
  const seen = new Set([documentId])
  const edges: Array<{ newer: string; older: string }> = []
  let frontier = [documentId]
  for (let step = 0; step < CHAIN_STEPS && frontier.length > 0; step++) {
    const ids = frontier
    const found = yield* query(() =>
      db
        .select({ newer: link.fromEntityId, older: link.toEntityId })
        .from(link)
        .innerJoin(document, eq(document.entityId, link.fromEntityId))
        .where(
          and(
            eq(link.relation, 'supersedes'),
            or(inArray(link.fromEntityId, ids), inArray(link.toEntityId, ids)),
          ),
        ),
    )
    const next: Array<string> = []
    for (const e of found) {
      if (!edges.some((x) => x.newer === e.newer && x.older === e.older))
        edges.push(e)
      for (const id of [e.newer, e.older])
        if (!seen.has(id)) {
          seen.add(id)
          next.push(id)
        }
    }
    frontier = next
  }
  const rows = yield* query(() =>
    db
      .select({
        id: document.entityId,
        filename: document.filename,
        name: entity.canonicalName,
        createdAt: document.createdAt,
        uploader: user.name,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .leftJoin(user, eq(user.id, document.uploadedBy))
      .where(
        and(
          inArray(document.entityId, [...seen]),
          isNull(entity.mergedIntoId),
          canReadDocumentSql(viewer.id),
        ),
      ),
  )
  const files = rows.map((r): DocumentVersion => ({
    id: r.id,
    name: r.filename ?? r.name,
    at: r.createdAt.toISOString(),
    uploader: r.uploader,
    current: r.id === documentId,
  }))
  return chainNewestFirst(files, edges)
})

export const documentDetailsProgram = Effect.fn('documentDetailsProgram')(
  function* (
    viewer: { readonly id: string },
    documentId: string,
  ): Effect.fn.Return<DocumentDetails | null, DocumentDetailsFailed> {
    const row = (yield* query(() =>
      db
        .select({
          sha: document.blobSha,
          words: sql<number | null>`case
            when btrim(coalesce(${document.extractedText}, '')) = '' then null
            else array_length(regexp_split_to_array(btrim(${document.extractedText}), '\\s+'), 1)
          end`,
        })
        .from(document)
        .where(
          and(eq(document.entityId, documentId), canReadDocumentSql(viewer.id)),
        ),
    )).at(0)
    // A document the viewer may not read has no details, as one that is gone.
    if (row === undefined) return null

    const cut = (yield* query(() =>
      db
        .select({ chunks: count(), pages: max(chunk.page) })
        .from(chunk)
        .where(eq(chunk.entityId, documentId)),
    )).at(0)

    const mentions = yield* query(() =>
      db
        .select({
          id: note.entityId,
          title: note.title,
          name: entity.canonicalName,
          visibility: note.visibility,
          authorId: note.authorId,
          widened: noteWidenedSql(viewer.id),
          at: link.createdAt,
        })
        .from(link)
        .innerJoin(note, eq(note.entityId, link.fromEntityId))
        .innerJoin(entity, eq(entity.id, link.fromEntityId))
        .where(
          and(
            eq(link.toEntityId, documentId),
            eq(link.relation, 'mentions'),
            isNull(entity.mergedIntoId),
          ),
        )
        .orderBy(desc(link.createdAt)),
    )

    const versions = yield* versionsOf(viewer, documentId)

    // The email it came on; the subject is a header, which every member reads.
    const email = (yield* query(() =>
      db
        .select({ id: interaction.id, subject: interaction.subject })
        .from(interactionDocument)
        .innerJoin(
          interaction,
          eq(interaction.id, interactionDocument.interactionId),
        )
        .where(
          and(
            eq(interactionDocument.documentId, documentId),
            eq(interactionDocument.role, 'attachment'),
            eq(interaction.kind, 'email'),
          ),
        )
        .orderBy(asc(interaction.occurredAt))
        .limit(1),
    )).at(0)

    return {
      versions,
      email:
        email === undefined
          ? null
          : { id: email.id, subject: email.subject ?? 'Untitled' },
      chunks: cut?.chunks ?? 0,
      words: row.words === null ? null : Number(row.words),
      pages: cut?.pages ?? null,
      sha: row.sha,
      mentionedIn: mentions
        .filter((m) => canRead(viewer, m))
        .map((m) => ({
          id: m.id,
          name: m.title || m.name,
          at: m.at.toISOString(),
        })),
    }
  },
)
