import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { joinImportList } from '@spaces/sdk/import-grid'
import { db } from '@spaces/db'
import {
  document,
  entity,
  link,
  note,
  objectDef,
  user,
} from '@spaces/db/schema'
import {
  CSV_BOM,
  MANIFEST_HEADER,
  blobEntry,
  csvLine,
  exportColumns,
  exportRow,
  noteMarkdown,
  notePath,
} from '../../export/workspace'
import { importObjectOf } from '../import/registry'
import type { ImportObject } from '../import/registry'
import { storage } from '../storage'
import { putMeasuredFileProgram } from '../documents/intake'
import { ZipSink } from './zip-sink'
import type { ExportCounts, ExportStored } from '../../export/workspace'
import type { Json } from '@spaces/db/json'

/**
 * The workspace as one zip, so a user can leave: one CSV per object in the
 * columns the import reads, every shared note as markdown, and the shared
 * documents as `documents/manifest.csv` plus their bytes under
 * `documents/blobs/`.
 *
 * - **What it leaves out.** A note or a document is exported only when it is
 *   `shared`, which `canRead` opens to every member. A private note, a synced
 *   email's body (a note private to its mailbox owner) and a private
 *   attachment stay out, even the requesting admin's own and even one a
 *   grant or the owner's override opened to them, because any admin may
 *   download the zip.
 * - **Never held whole.** The zip streams to a temp file as it is built
 *   (`ZipSink`), hashed on the way; the file then streams to the store under
 *   its digest. Rows are read a page at a time.
 * - **Kept a day.** The zip goes to the store through `putMeasuredFileProgram`,
 *   which writes its `pending_blob` row before its bytes; no row ever names
 *   them, so the nightly orphan sweep deletes them once the row is a day old.
 */

export class WorkspaceExportFailed extends Schema.TaggedError<WorkspaceExportFailed>()(
  'WorkspaceExportFailed',
  { cause: Schema.Defect() },
) {}

export type WorkspaceExport = ExportStored & ExportCounts

/** Rows read per query; a page of records, notes or documents. */
const PAGE = 500

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceExportFailed({ cause }),
  })

/** `id → canonical name` for every id, in one query. */
const namesOf = async (ids: ReadonlyArray<string>) => {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map<string, string>()
  const rows = await db
    .select({ id: entity.id, name: entity.canonicalName })
    .from(entity)
    .where(inArray(entity.id, unique))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** The records each note or document is filed on, by name, in filing order. */
const filedOnOf = async (ids: ReadonlyArray<string>) => {
  const out = new Map<string, Array<string>>()
  if (ids.length === 0) return out
  const rows = await db
    .select({ from: link.fromEntityId, name: entity.canonicalName })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(inArray(link.fromEntityId, [...ids]), eq(link.relation, 'tagged_in')),
    )
    .orderBy(asc(link.createdAt))
  for (const r of rows) out.set(r.from, [...(out.get(r.from) ?? []), r.name])
  return out
}

/** Every id a page's reference cells name, so one query fetches their names. */
const referencedIds = (
  rows: ReadonlyArray<{ values: { [slug: string]: Json } }>,
  slugs: ReadonlyArray<string>,
): Array<string> =>
  rows.flatMap((r) =>
    slugs.flatMap((slug) => {
      const v = r.values[slug]
      const list = Array.isArray(v) ? v : [v]
      return list.filter((x): x is string => typeof x === 'string')
    }),
  )

/** One object's records, a page at a time, into its CSV. */
async function writeObject(
  zip: ZipSink,
  object: ImportObject,
  memberEmails: ReadonlyMap<string, string>,
): Promise<number> {
  const columns = exportColumns(object.registry)
  const refSlugs = columns.flatMap((c) =>
    c.source.kind === 'attribute' &&
    c.source.attribute.type === 'record_reference'
      ? [c.source.attribute.slug]
      : [],
  )
  const csv = zip.text(`${object.slug}.csv`)
  await csv.write(CSV_BOM + csvLine(columns.map((c) => c.header)))
  let after: string | null = null
  let count = 0
  for (;;) {
    const page = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
      })
      .from(entity)
      .where(
        and(
          eq(entity.objectId, object.id),
          // A merged record lives on in its survivor's row.
          isNull(entity.mergedIntoId),
          after === null ? undefined : gt(entity.id, after),
        ),
      )
      .orderBy(asc(entity.id))
      .limit(PAGE)
    if (page.length === 0) break
    const recordNames = await namesOf(referencedIds(page, refSlugs))
    await csv.write(
      page
        .map((r) =>
          csvLine(exportRow(columns, r, { recordNames, memberEmails })),
        )
        .join(''),
    )
    count += page.length
    after = page.at(-1)?.id ?? null
    if (page.length < PAGE) break
  }
  await csv.end()
  return count
}

/** Every shared note, one markdown file each. */
async function writeNotes(
  zip: ZipSink,
  authors: ReadonlyMap<string, { name: string; email: string }>,
): Promise<number> {
  let after: string | null = null
  let count = 0
  for (;;) {
    const page = await db
      .select({
        id: note.entityId,
        title: note.title,
        kind: note.kind,
        authorId: note.authorId,
        body: note.bodyMd,
        createdAt: entity.createdAt,
        updatedAt: note.updatedAt,
      })
      .from(note)
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(
          eq(note.visibility, 'shared'),
          after === null ? undefined : gt(note.entityId, after),
        ),
      )
      .orderBy(asc(note.entityId))
      .limit(PAGE)
    if (page.length === 0) break
    const filed = await filedOnOf(page.map((n) => n.id))
    for (const n of page) {
      const author = authors.get(n.authorId)
      const exported = {
        id: n.id,
        title: n.title,
        kind: n.kind,
        author:
          author === undefined ? null : `${author.name} <${author.email}>`,
        filedOn: filed.get(n.id) ?? [],
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        body: n.body,
      }
      await zip.file(notePath(exported), noteMarkdown(exported))
    }
    count += page.length
    after = page.at(-1)?.id ?? null
    if (page.length < PAGE) break
  }
  return count
}

/**
 * Every shared document's manifest row, then each distinct held blob once.
 * A `remote` document's bytes are its provider's, not ours: it is listed
 * with its digest and has no blob in the tree.
 */
async function writeDocuments(zip: ZipSink): Promise<number> {
  const manifest = zip.text('documents/manifest.csv')
  await manifest.write(CSV_BOM + csvLine(MANIFEST_HEADER))
  const held = new Set<string>()
  let after: string | null = null
  let count = 0
  for (;;) {
    const page = await db
      .select({
        id: document.entityId,
        filename: document.filename,
        name: entity.canonicalName,
        sizeBytes: document.sizeBytes,
        sha: document.blobSha,
        bytesState: document.bytesState,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(document.visibility, 'shared'),
          after === null ? undefined : gt(document.entityId, after),
        ),
      )
      .orderBy(asc(document.entityId))
      .limit(PAGE)
    if (page.length === 0) break
    const filed = await filedOnOf(page.map((d) => d.id))
    await manifest.write(
      page
        .map((d) =>
          csvLine([
            d.filename ?? d.name,
            d.sizeBytes === null ? '' : String(d.sizeBytes),
            d.sha ?? '',
            joinImportList(filed.get(d.id) ?? []),
          ]),
        )
        .join(''),
    )
    for (const d of page)
      if (d.sha !== null && d.bytesState === 'stored') held.add(d.sha)
    count += page.length
    after = page.at(-1)?.id ?? null
    if (page.length < PAGE) break
  }
  await manifest.end()
  // After the manifest, never inside it: an entry is ended before the next.
  for (const sha of held) {
    if (!(await storage().exists(sha))) continue
    await zip.stream(blobEntry(sha), await storage().getStream(sha))
  }
  return count
}

/** The zip, built into `path`. */
const buildZip = Effect.fn('buildZip')(function* (
  path: string,
): Effect.fn.Return<ExportStored & ExportCounts, WorkspaceExportFailed> {
  const zip = new ZipSink(path)
  const members = yield* io(() =>
    db.select({ id: user.id, name: user.name, email: user.email }).from(user),
  )
  const memberEmails = new Map(members.map((m) => [m.id, m.email]))
  const authors = new Map(members.map((m) => [m.id, m]))

  const objects = yield* io(() =>
    db
      .select({ id: objectDef.id })
      .from(objectDef)
      .orderBy(asc(objectDef.createdAt)),
  )
  let records = 0
  for (const { id } of objects) {
    const object = yield* importObjectOf(id).pipe(
      Effect.mapError((e) => new WorkspaceExportFailed({ cause: e.cause })),
    )
    if (object === null) continue
    records += yield* io(() => writeObject(zip, object, memberEmails))
  }
  const notes = yield* io(() => writeNotes(zip, authors))
  const documents = yield* io(() => writeDocuments(zip))
  const stored = yield* io(() => zip.finish())
  return { ...stored, objects: objects.length, records, notes, documents }
})

/**
 * Builds the zip and stores it. `requestedBy` is the admin who asked: the
 * `pending_blob` row names them, as an upload's names its uploader.
 */
export const exportWorkspaceProgram = Effect.fn('exportWorkspaceProgram')(
  function* (input: {
    requestedBy: string
  }): Effect.fn.Return<WorkspaceExport, WorkspaceExportFailed> {
    return yield* Effect.acquireUseRelease(
      io(() => mkdtemp(join(tmpdir(), 'spaces-export-'))),
      (dir) =>
        Effect.gen(function* () {
          const path = join(dir, 'workspace.zip')
          const built = yield* buildZip(path)
          yield* putMeasuredFileProgram({
            path,
            sha: built.sha,
            sizeBytes: built.sizeBytes,
            mime: 'application/zip',
            preparedBy: input.requestedBy,
          }).pipe(
            Effect.mapError(
              (e) => new WorkspaceExportFailed({ cause: e.cause }),
            ),
          )
          return built
        }),
      (dir) =>
        Effect.promise(() =>
          rm(dir, { recursive: true, force: true }).catch(() => undefined),
        ),
    )
  },
)
