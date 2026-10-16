import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entitySpace,
  link,
  storageBinding,
  storageTombstone,
} from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import type {
  AuthExpired,
  NotFound,
  RateLimited,
  StorageSource,
  WritableStorageSource,
} from '@spaces/sdk'
import { canonicalFileUrl } from '../connections/sources'
import { storage } from '../storage'
import { BindingStoreFailed } from './bind'
import { goneNot } from './gone'

/**
 * Write-through (docs/spec-storage-sources.md §6): an in-app upload on a
 * record whose folder binding is `push` or `both` lands in that folder too.
 * - Only a person's upload: `manual`, with bytes, no page address and no
 *   provider copy. Integration arrivals, clips and captures never export.
 * - Birth stamps the binding on the row and sends `storage.export`; the job
 *   uploads into the bound folder itself and records the pointer, with the
 *   upload's change token, so the next poll reads our own write as no change.
 * - An exported document re-filed off its binding's record onto another
 *   pushing binding of the same connection moves there; otherwise it stays.
 *   Its provider name follows `document.filename`.
 * - Nothing here deletes at the provider. A document deleted while its
 *   upload was in flight is tombstoned for the binding, so no poll files it.
 */

/** The directions that write an upload through. */
const WRITING = ['push', 'both'] as const

export const writesThrough = (direction: 'pull' | 'push' | 'both') =>
  direction !== 'pull'

/** A birth that is a person's upload, the only arrival that exports. */
export const isUploadArrival = (input: {
  readonly sourceClass: SourceClass
  readonly blobSha: string | null
  readonly url?: string | null
  readonly provenance: { readonly externalId?: string | null }
}): boolean =>
  input.sourceClass === 'manual' &&
  input.blobSha !== null &&
  (input.url ?? null) === null &&
  (input.provenance.externalId ?? null) === null

type Reader = Pick<typeof db, 'select'>

/** A folder binding an upload on its record may write through. */
const pushing = and(
  inArray(storageBinding.direction, [...WRITING]),
  eq(storageBinding.grain, 'folder'),
  isNotNull(storageBinding.folderId),
  eq(storageBinding.isMirrorRoot, false),
  ne(storageBinding.status, 'paused'),
)

/**
 * The binding an upload filed on these records writes through, or null: the
 * oldest pushing folder binding on any of them.
 */
export async function writeThroughBindingOf(
  reader: Reader,
  targetIds: ReadonlyArray<string>,
): Promise<string | null> {
  if (targetIds.length === 0) return null
  const row = (
    await reader
      .select({ id: storageBinding.id })
      .from(storageBinding)
      .where(
        and(inArray(storageBinding.targetEntityId, [...targetIds]), pushing),
      )
      .orderBy(asc(storageBinding.createdAt))
      .limit(1)
  ).at(0)
  return row?.id ?? null
}

/**
 * Whether a re-file of this document is the export job's business: an upload
 * that a pushing binding holds.
 */
export async function exportsOnRefile(documentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: document.entityId })
    .from(document)
    .innerJoin(storageBinding, eq(storageBinding.id, document.bindingId))
    .where(
      and(
        eq(document.entityId, documentId),
        eq(document.sourceClass, 'manual'),
        inArray(storageBinding.direction, [...WRITING]),
        goneNot,
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** A binding as the export reads it. */
export type ExportBinding = {
  readonly id: string
  readonly provider: string
  readonly connectionId: string | null
  readonly folderId: string
  readonly folderPath: string
  readonly direction: 'pull' | 'push' | 'both'
  readonly status: 'active' | 'error' | 'paused'
  readonly targetEntityId: string
}

/**
 * One document's export: the row, the binding it holds, and `home` — the
 * binding it belongs in now, which differs only after a re-file.
 */
export type ExportPlan = {
  readonly documentId: string
  readonly filename: string
  readonly mime: string | null
  readonly blobSha: string | null
  readonly sourceClass: SourceClass
  readonly externalId: string | null
  readonly externalStatus: 'linked' | 'gone' | null
  readonly binding: ExportBinding
  readonly home: ExportBinding
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

const bindingColumns = {
  id: storageBinding.id,
  provider: storageBinding.provider,
  connectionId: storageBinding.connectionId,
  folderId: storageBinding.folderId,
  folderPath: storageBinding.folderPath,
  direction: storageBinding.direction,
  status: storageBinding.status,
  targetEntityId: storageBinding.targetEntityId,
}

type BindingRow = Omit<ExportBinding, 'folderId'> & {
  readonly folderId: string | null
}

const asExportBinding = (row: BindingRow): ExportBinding | null =>
  row.folderId === null ? null : { ...row, folderId: row.folderId }

/** Every record and space the document is filed on. */
const filingsOf = async (documentId: string): Promise<Array<string>> => {
  const records = await db
    .select({ id: link.toEntityId })
    .from(link)
    .where(
      and(eq(link.fromEntityId, documentId), eq(link.relation, 'tagged_in')),
    )
  const spaces = await db
    .select({ id: entitySpace.spaceId })
    .from(entitySpace)
    .where(eq(entitySpace.entityId, documentId))
  return [...records, ...spaces].map((r) => r.id)
}

/**
 * Where an exported document belongs: its own binding while the document is
 * still filed on that binding's record; else the oldest pushing binding of
 * the same connection on a record it is filed on; else its own, unmoved.
 */
const homeOf = async (binding: ExportBinding, documentId: string) => {
  const filed = await filingsOf(documentId)
  if (filed.includes(binding.targetEntityId) || binding.connectionId === null)
    return binding
  if (filed.length === 0) return binding
  const rows = await db
    .select(bindingColumns)
    .from(storageBinding)
    .where(
      and(
        inArray(storageBinding.targetEntityId, filed),
        eq(storageBinding.connectionId, binding.connectionId),
        eq(storageBinding.provider, binding.provider),
        pushing,
      ),
    )
    .orderBy(asc(storageBinding.createdAt))
    .limit(1)
  const row = rows.at(0)
  return (row === undefined ? null : asExportBinding(row)) ?? binding
}

/** The document's export plan; null once the row or its binding is gone. */
export const exportPlanOf = Effect.fn('exportPlanOf')(function* (
  documentId: string,
): Effect.fn.Return<ExportPlan | null, BindingStoreFailed> {
  const row = (yield* query(() =>
    db
      .select({
        documentId: document.entityId,
        filename: document.filename,
        name: entity.canonicalName,
        mime: document.mime,
        blobSha: document.blobSha,
        sourceClass: document.sourceClass,
        externalId: document.externalId,
        externalStatus: document.externalStatus,
        binding: bindingColumns,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .innerJoin(storageBinding, eq(storageBinding.id, document.bindingId))
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (row === undefined) return null
  const binding = asExportBinding(row.binding)
  if (binding === null) return null
  const home =
    row.externalId === null
      ? binding
      : yield* query(() => homeOf(binding, documentId))
  const { name, ...rest } = row
  return { ...rest, filename: row.filename ?? name, binding, home }
})

/** The source with its write half, or null for a read-only provider. */
export const writableOf = (
  source: StorageSource,
): WritableStorageSource | null => {
  const { ensureFolder, putFile, move, rename } = source
  if (
    ensureFolder === undefined ||
    putFile === undefined ||
    move === undefined ||
    rename === undefined
  )
    return null
  return { ...source, ensureFolder, putFile, move, rename }
}

/** The blob the upload names is not in the store: nothing to send. */
export class ExportBytesGone extends Schema.TaggedError<ExportBytesGone>()(
  'ExportBytesGone',
  { sha: Schema.String },
) {}

export type ExportFailure =
  NotFound | RateLimited | AuthExpired | ExportBytesGone | BindingStoreFailed

export type ExportOutcome =
  /** Uploaded and the pointer recorded. */
  | { readonly _tag: 'exported'; readonly fileId: string }
  /** Moved to its new home's folder, and its name kept. */
  | { readonly _tag: 'moved' }
  /** Already where and as it should be: its name kept. */
  | { readonly _tag: 'kept' }
  /** Deleted here while uploading: tombstoned so no poll files it. */
  | { readonly _tag: 'deleted' }

const bytesOf = Effect.fn('exportDocument.bytesOf')(function* (sha: string) {
  const present = yield* query(() => storage().exists(sha))
  if (!present) return yield* new ExportBytesGone({ sha })
  const bytes = yield* query(() => storage().getBytes(sha))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
})

/** The pointer the upload made, recorded on the row unless it left meanwhile. */
const recordExport = (
  plan: ExportPlan,
  put: { fileId: string; revisionId: string; name: string; token: string },
) =>
  query(() =>
    db.transaction(async (tx): Promise<ExportOutcome> => {
      const { home } = plan
      const recorded = await tx
        .update(document)
        .set({
          bindingId: home.id,
          connectionId: home.connectionId,
          externalId: put.fileId,
          externalUrl: canonicalFileUrl(home.provider, put.fileId),
          externalStatus: 'linked',
          externalRevisionId: put.token,
          sourcePath: home.folderPath,
          filename: put.name,
        })
        .where(
          and(
            eq(document.entityId, plan.documentId),
            or(
              isNull(document.externalId),
              eq(document.externalId, put.fileId),
            ),
            goneNot,
          ),
        )
        .returning({ id: document.entityId })
      if (recorded.length === 0) {
        const held = await tx
          .select({ id: document.entityId })
          .from(document)
          .where(eq(document.entityId, plan.documentId))
        if (held.length > 0) return { _tag: 'kept' }
        await tx
          .insert(storageTombstone)
          .values({ bindingId: home.id, externalId: put.fileId })
          .onConflictDoNothing()
        return { _tag: 'deleted' }
      }
      // A taken name got a `(2)`: the record's name follows unless a person renamed it.
      if (put.name !== plan.filename)
        await tx
          .update(entity)
          .set({ canonicalName: put.name })
          .where(
            and(
              eq(entity.id, plan.documentId),
              eq(entity.canonicalName, plan.filename),
            ),
          )
      return { _tag: 'exported', fileId: put.fileId }
    }),
  )

/**
 * Bring the provider in line with the document: upload it into its binding's
 * folder when it has no pointer yet; else move it to its home's folder after
 * a re-file and give it the document's name. The caller decided it exports.
 */
export const exportDocumentProgram = Effect.fn('exportDocumentProgram')(
  function* (input: {
    readonly plan: ExportPlan
    readonly blobSha: string
    readonly source: WritableStorageSource
  }): Effect.fn.Return<ExportOutcome, ExportFailure> {
    const { plan, source } = input
    const { home } = plan

    if (plan.externalId === null) {
      // The bound folder itself: no kind subfolder is made. (§6, lazy folders)
      const folderId = yield* source.ensureFolder(home.folderId, '')
      const stream = yield* bytesOf(input.blobSha)
      const put = yield* source.putFile(folderId, plan.filename, {
        stream,
        mime: plan.mime ?? 'application/octet-stream',
        sha256: input.blobSha,
      })
      return yield* recordExport(plan, {
        ...put,
        token: put.changeToken ?? put.revisionId,
      })
    }

    const externalId = plan.externalId
    let moved = false
    if (home.id !== plan.binding.id) {
      yield* source.move(externalId, home.folderId)
      yield* query(() =>
        db
          .update(document)
          .set({ bindingId: home.id, sourcePath: home.folderPath })
          .where(
            and(
              eq(document.entityId, plan.documentId),
              eq(document.bindingId, plan.binding.id),
              goneNot,
            ),
          ),
      )
      moved = true
    }
    // A no-op at the provider when the name already matches.
    yield* source.rename(externalId, plan.filename)
    const outcome: ExportOutcome = moved ? { _tag: 'moved' } : { _tag: 'kept' }
    return outcome
  },
)

/** Uploads waiting on one provider: bound to push, not yet exported. */
export type WaitingExport = {
  readonly provider: string
  readonly count: number
}

/**
 * Uploads on a pushing binding that hold no pointer yet, by provider — the
 * export queue's backlog, read from the rows rather than from pg-boss.
 */
export const waitingExportsProgram = Effect.fn('waitingExportsProgram')(
  function* (): Effect.fn.Return<
    ReadonlyArray<WaitingExport>,
    BindingStoreFailed
  > {
    const rows = yield* query(() =>
      db
        .select({
          provider: storageBinding.provider,
          count: sql<number>`count(*)::int`,
        })
        .from(document)
        .innerJoin(storageBinding, eq(storageBinding.id, document.bindingId))
        .where(
          and(
            eq(document.sourceClass, 'manual'),
            isNull(document.externalId),
            isNotNull(document.blobSha),
            goneNot,
            inArray(storageBinding.direction, [...WRITING]),
          ),
        )
        .groupBy(storageBinding.provider)
        .orderBy(storageBinding.provider),
    )
    return rows
  },
)
