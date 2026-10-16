import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  pendingBlob,
  storageBinding,
} from '@spaces/db/schema'
import type {
  AuthExpired,
  NotFound,
  RateLimited,
  StorageSource,
} from '@spaces/sdk'
import { readableOf } from '../../documents/web-stream'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import { documentIntakeMessage, putBlobProgram } from '../documents/intake'
import type { DocumentIntakeFailed } from '../documents/intake'
import { BindingStoreFailed } from './bind'

/**
 * Retain per binding (docs/spec-storage-sources.md §7): the bytes of a
 * `remote` document fetched back through the connection it came through.
 * - The pointer is the row's own (`connection_id`, `external_id`): that pair
 *   is what the provider's id is unique within, whatever binding holds it.
 * - The drop after extraction is `dropBytesAfterExtraction`, beside
 *   `blobIsReferenced`, the shared-sha question it asks.
 * - Sensitivity lives on rows, not bytes, so nothing here reads or writes it.
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

/** Where a `remote` document's bytes can be read from. */
export type RemoteBytesTarget = {
  readonly _tag: 'target'
  readonly documentId: string
  readonly blobSha: string
  readonly bytesState: 'stored' | 'remote'
  readonly provider: string
  readonly product: string
  readonly connectionId: string
  readonly externalId: string
}

/** Why a document's bytes cannot be fetched from its provider right now. */
export type RemoteBytesRefusal =
  /** The row is gone, or names no bytes at all. */
  | { readonly _tag: 'no-file' }
  /** No connection and file id to fetch through. */
  | { readonly _tag: 'no-pointer' }
  /** The provider's copy was deleted (`external_status: gone`). */
  | {
      readonly _tag: 'deleted'
      readonly provider: string
      readonly product: string
    }
  /** The connection is in error or revoked. */
  | {
      readonly _tag: 'connection'
      readonly provider: string
      readonly product: string
      readonly reason: string | null
    }

/** A storage provider as a sentence names it: `Google Drive`, `Box`. */
export function storageLabel(provider: string): string {
  if (provider === 'google') return 'Google Drive'
  if (provider === 'box') return 'Box'
  return provider
}

/** The sentence a refusal reads as. */
export function remoteBytesRefusalMessage(refusal: RemoteBytesRefusal): string {
  switch (refusal._tag) {
    case 'no-file':
      return 'This document has no stored file'
    case 'no-pointer':
      return 'Only this file’s text is kept here, and no connection can fetch the file'
    case 'deleted':
      return `This file was deleted in ${storageLabel(refusal.provider)}; only its text is kept here`
    case 'connection':
      return `${storageLabel(refusal.provider)} cannot be reached: ${refusal.reason ?? 'the connection needs reconnecting'}`
  }
}

/** The document's pointer and its connection's health, read once. */
export const remoteBytesOf = Effect.fn('remoteBytesOf')(function* (
  documentId: string,
): Effect.fn.Return<
  RemoteBytesTarget | RemoteBytesRefusal,
  BindingStoreFailed
> {
  const row = (yield* query(() =>
    db
      .select({
        blobSha: document.blobSha,
        bytesState: document.bytesState,
        externalId: document.externalId,
        externalStatus: document.externalStatus,
        connectionId: document.connectionId,
        provider: accountConnection.provider,
        product: accountConnection.product,
        status: accountConnection.status,
        errorReason: accountConnection.errorReason,
      })
      .from(document)
      .leftJoin(
        accountConnection,
        eq(accountConnection.id, document.connectionId),
      )
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (row === undefined || row.blobSha === null) return { _tag: 'no-file' }
  if (
    row.connectionId === null ||
    row.externalId === null ||
    row.provider === null ||
    row.product === null
  )
    return { _tag: 'no-pointer' }
  const where = { provider: row.provider, product: row.product }
  if (row.externalStatus === 'gone') return { _tag: 'deleted', ...where }
  if (row.status !== 'active')
    return { _tag: 'connection', ...where, reason: row.errorReason }
  return {
    _tag: 'target',
    documentId,
    blobSha: row.blobSha,
    bytesState: row.bytesState,
    provider: row.provider,
    product: row.product,
    connectionId: row.connectionId,
    externalId: row.externalId,
  }
})

export type RestoreOutcome =
  /** The sha is on disk again; with `keep`, the row is `stored`. */
  | { readonly _tag: 'restored' }
  /**
   * The provider's bytes hash differently (revised there, or a native export,
   * which is never byte-stable). With `keep` the row advanced to them and
   * extraction was re-sent; without, nothing was cached.
   */
  | { readonly _tag: 'changed' }
  /** Too large to hold, or another refusal of the store's. */
  | { readonly _tag: 'skipped'; readonly reason: string }

export type RestoreFailure =
  | NotFound
  | RateLimited
  | AuthExpired
  | DocumentIntakeFailed
  | BindingStoreFailed

/**
 * The provider's bytes into the blob store under their own digest.
 * - `keep: false` is the viewer's cache: the bytes keep the `pending_blob`
 *   intent `putBlobProgram` wrote, so the orphan sweep takes them again.
 * - `keep: true` is the `text → full` backfill: the row becomes `stored` and
 *   the intent is spent. A changed file advances the row to the new bytes
 *   and re-extracts; the old sha's bytes were already discarded, so no
 *   revision is recorded for them.
 */
export const restoreBytesProgram = Effect.fn('restoreBytesProgram')(
  function* (input: {
    readonly target: RemoteBytesTarget
    readonly source: StorageSource
    readonly keep: boolean
  }): Effect.fn.Return<RestoreOutcome, RestoreFailure, Enqueue> {
    const { target } = input
    const file = yield* input.source.getFile(target.externalId)
    const blob = yield* putBlobProgram({
      stream: readableOf(file.stream),
      mime: file.mime,
      preparedBy: null,
    }).pipe(
      Effect.catchTag('DocumentTooLarge', (e) =>
        Effect.succeed({ skipped: documentIntakeMessage(e) }),
      ),
    )
    if ('skipped' in blob) return { _tag: 'skipped', reason: blob.skipped }
    if (!input.keep)
      return blob.sha === target.blobSha
        ? { _tag: 'restored' }
        : { _tag: 'changed' }

    // Compare-and-set on the sha this call read: a row a poll revised
    // meanwhile is left alone, and these bytes keep their intent for the sweep.
    const asRead = and(
      eq(document.entityId, target.documentId),
      eq(document.blobSha, target.blobSha),
      eq(document.bytesState, 'remote'),
    )
    const same = blob.sha === target.blobSha
    const moved = yield* query(() =>
      db.transaction(async (tx) => {
        const updated = await tx
          .update(document)
          .set(
            same
              ? { bytesState: 'stored' }
              : {
                  bytesState: 'stored',
                  blobSha: blob.sha,
                  mime: file.mime,
                  sizeBytes: blob.sizeBytes,
                  externalRevisionId: file.changeToken,
                  extractionStatus: 'pending',
                  extractionError: null,
                },
          )
          .where(asRead)
          .returning({ id: document.entityId })
        if (updated.length > 0)
          await tx.delete(pendingBlob).where(eq(pendingBlob.sha, blob.sha))
        return updated.length > 0
      }),
    )
    if (same) return { _tag: 'restored' }
    if (moved) {
      const queue = yield* Enqueue
      yield* queue.enqueue(QUEUES.extractDocument, {
        documentId: target.documentId,
      })
    }
    const changed: RestoreOutcome = { _tag: 'changed' }
    return changed
  },
)

/**
 * Change a binding's `retain`. Flipping to `full` sends one backfill per
 * `remote` document the binding filed; flipping to `text` drops nothing
 * already held — the next extraction of each file does.
 * - Null when the binding is gone.
 */
export const setBindingRetainProgram = Effect.fn('setBindingRetainProgram')(
  function* (input: {
    readonly bindingId: string
    readonly retain: 'full' | 'text'
  }): Effect.fn.Return<
    { readonly retain: 'full' | 'text'; readonly backfill: number } | null,
    BindingStoreFailed,
    Enqueue
  > {
    const updated = yield* query(() =>
      db
        .update(storageBinding)
        .set({ retain: input.retain })
        .where(eq(storageBinding.id, input.bindingId))
        .returning({ id: storageBinding.id }),
    )
    if (updated.length === 0) return null
    if (input.retain === 'text') return { retain: 'text', backfill: 0 }
    const remote = yield* query(() =>
      db
        .select({ id: document.entityId })
        .from(document)
        .where(
          and(
            eq(document.bindingId, input.bindingId),
            eq(document.bytesState, 'remote'),
          ),
        ),
    )
    const queue = yield* Enqueue
    for (const { id } of remote)
      yield* queue.enqueue(
        QUEUES.retainBackfill,
        { documentId: id },
        { singletonKey: id },
      )
    return { retain: 'full', backfill: remote.length }
  },
)
