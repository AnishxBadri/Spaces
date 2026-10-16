import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import {
  remoteBytesOf,
  remoteBytesRefusalMessage,
  storageLabel,
} from '@spaces/core/writes/bindings/retain'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { storage } from '@spaces/core/writes/storage'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'

/**
 * A document's bytes for the viewer and Download: a signed URL when the sha
 * is on disk, otherwise — a `remote` row under `retain: text` — a fetch
 * through its connection on the worker (`storage.fetch-bytes`), which the
 * caller polls. A connection in error answers `unavailable` with the
 * provider's reason instead of a fetch that would fail.
 */

export type DocumentBytes =
  | { readonly state: 'ready'; readonly url: string }
  /** The worker is fetching from `from` (`Google Drive`); ask again. */
  | { readonly state: 'fetching'; readonly from: string }
  | { readonly state: 'unavailable'; readonly reason: string }

export class DocumentBytesFailed extends Schema.TaggedError<DocumentBytesFailed>()(
  'DocumentBytesFailed',
  { cause: Schema.Defect() },
) {}

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DocumentBytesFailed({ cause }),
  })

const NO_FILE = 'This document has no stored file'

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
const reasonOf = (output: object | null): string | null => {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

const latestOf = (jobs: ReadonlyArray<QueuedJob> | null) =>
  [...(jobs ?? [])]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)

/**
 * - `poll: false` is an open: a fetch is sent unless one is under way.
 * - `poll: true` is the viewer asking again: a fetch that failed since is
 *   its answer, so a refused file is said once rather than re-sent forever.
 */
export const documentBytesProgram = Effect.fn('documentBytesProgram')(
  function* (
    viewerId: string,
    documentId: string,
    opts: { readonly poll: boolean },
  ): Effect.fn.Return<DocumentBytes, DocumentBytesFailed> {
    const row = (yield* io(() =>
      db
        .select({
          blobSha: document.blobSha,
          bytesState: document.bytesState,
          filename: document.filename,
        })
        .from(document)
        .where(
          and(eq(document.entityId, documentId), canReadDocumentSql(viewerId)),
        ),
    )).at(0)
    const sha = row?.blobSha ?? null
    if (row === undefined || sha === null)
      return { state: 'unavailable', reason: NO_FILE }
    const ready = () =>
      io(() =>
        storage().getDownloadUrl(
          sha,
          300,
          row.filename === null ? {} : { filename: row.filename },
        ),
      ).pipe(Effect.map((url): DocumentBytes => ({ state: 'ready', url })))
    // A remote row's sha may be on disk too: a viewer's earlier fetch, or a
    // sibling row that keeps the same bytes.
    if (row.bytesState === 'stored' || (yield* io(() => storage().exists(sha))))
      return yield* ready()

    const target = yield* remoteBytesOf(documentId).pipe(
      Effect.mapError((e) => new DocumentBytesFailed({ cause: e })),
    )
    if (target._tag !== 'target')
      return { state: 'unavailable', reason: remoteBytesRefusalMessage(target) }
    const from = storageLabel(target.provider)
    const latest = latestOf(
      yield* io(() => jobsByKey(QUEUES.fetchRemoteBytes, documentId)),
    )
    if (
      latest !== undefined &&
      (latest.state === 'created' ||
        latest.state === 'retry' ||
        latest.state === 'active')
    )
      return { state: 'fetching', from }
    if (
      opts.poll &&
      latest !== undefined &&
      (latest.state === 'failed' || latest.state === 'cancelled')
    )
      return {
        state: 'unavailable',
        reason:
          reasonOf(latest.output) ?? `The file could not be read from ${from}`,
      }
    const sent = yield* io(() =>
      enqueue(
        QUEUES.fetchRemoteBytes,
        { documentId },
        { singletonKey: documentId },
      ),
    )
    if (sent === null && latest === undefined)
      return {
        state: 'unavailable',
        reason: `The file could not be requested from ${from}`,
      }
    return { state: 'fetching', from }
  },
)
