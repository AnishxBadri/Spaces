import { Effect, Schema } from 'effect'
import { asc, eq, inArray, lt } from 'drizzle-orm'
import { db } from '@spaces/db'
import { feed, feedItem, pendingBlob } from '@spaces/db/schema'
import { itemRowsOf, retentionCutoff } from '@spaces/core/feeds/fetch'
import { reclaimBlobIfOrphanedProgram } from '#/lib/documents/blob-refs'
import { fetchFeedProgram } from './fetch'
import type { FeedFetchFailed } from './fetch'

/**
 * The poller's writes: one feed fetched and its new headlines kept, and the
 * daily delete past retention. The worker's jobs are these programs plus a
 * mapping of their failures; outside `lib/server/` so the worker and tests
 * call them without a request.
 */

/** The feed tables could not be read or written; worth a retry. */
export class FeedStoreFailed extends Schema.TaggedError<FeedStoreFailed>()(
  'FeedStoreFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const store = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new FeedStoreFailed({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

/** Every feed the half-hourly poll fetches. */
export const feedIdsProgram = Effect.fn('feeds.feedIds')(function* () {
  const rows = yield* store(() =>
    db.select({ id: feed.id }).from(feed).orderBy(asc(feed.createdAt)),
  )
  return rows.map((r) => r.id)
})

export type FeedPolled =
  | { readonly _tag: 'Gone' }
  | { readonly _tag: 'NotModified' }
  | {
      readonly _tag: 'Fetched'
      readonly seen: number
      readonly added: number
      /** The new headlines that name a photo: what `feed.images` fetches. */
      readonly withImages: ReadonlyArray<string>
    }

/**
 * One fetch of one feed, its outcome written to the row.
 * - The stored validators go out; a 304 is a success that adds nothing.
 * - New keys insert, existing ones are skipped by the `(feed, key)` index.
 * - Photos are not fetched here: the new headlines that name one are
 *   handed back for their own queue, so a headline never waits on one.
 * - A failure writes the status and the sentence and fails, leaving every
 *   stored headline alone; the next good fetch clears it.
 * - A feed removed while its fetch was queued is `Gone`, not a failure.
 */
export const pollFeedProgram = Effect.fn('feeds.pollFeed')(function* (
  feedId: string,
  now: Date = new Date(),
): Effect.fn.Return<FeedPolled, FeedFetchFailed | FeedStoreFailed> {
  const row = (yield* store(() =>
    db
      .select({
        url: feed.url,
        etag: feed.etag,
        lastModified: feed.lastModified,
      })
      .from(feed)
      .where(eq(feed.id, feedId)),
  )).at(0)
  if (row === undefined) return { _tag: 'Gone' }

  const fetched = yield* fetchFeedProgram(row.url, {
    etag: row.etag,
    lastModified: row.lastModified,
  }).pipe(
    Effect.tapError((failed) =>
      store(() =>
        db
          .update(feed)
          .set({
            lastFetchedAt: now,
            lastStatus: 'failed',
            lastError: failed.message,
          })
          .where(eq(feed.id, feedId)),
      ),
    ),
  )

  const succeeded = {
    lastFetchedAt: now,
    lastSuccessAt: now,
    lastStatus: 'ok' as const,
    lastError: null,
  }
  if (fetched._tag === 'NotModified') {
    yield* store(() =>
      db.update(feed).set(succeeded).where(eq(feed.id, feedId)),
    )
    return { _tag: 'NotModified' }
  }

  const rows = itemRowsOf(fetched.feed.items, now)
  const added = yield* store(() =>
    db.transaction(async (tx) => {
      const inserted =
        rows.length === 0
          ? []
          : await tx
              .insert(feedItem)
              .values(rows.map((r) => ({ ...r, feedId, firstSeenAt: now })))
              .onConflictDoNothing({
                target: [feedItem.feedId, feedItem.key],
              })
              .returning({ id: feedItem.id, imageUrl: feedItem.imageUrl })
      await tx
        .update(feed)
        .set({
          ...succeeded,
          // A site that stopped sending a validator gets none sent back.
          etag: fetched.validators.etag,
          lastModified: fetched.validators.lastModified,
        })
        .where(eq(feed.id, feedId))
      return inserted
    }),
  )
  return {
    _tag: 'Fetched',
    seen: rows.length,
    added: added.length,
    withImages: added.filter((r) => r.imageUrl !== null).map((r) => r.id),
  }
})

/**
 * Each digest's bytes dropped once no row of any kind names it: a photo a
 * deleted headline shared with a kept one stays, and so does a favicon two
 * feeds share.
 */
export const reclaimFeedBlobsProgram = Effect.fn('feeds.reclaimBlobs')(
  function* (
    shas: ReadonlyArray<string | null>,
  ): Effect.fn.Return<number, FeedStoreFailed> {
    let reclaimed = 0
    for (const sha of new Set(shas)) {
      if (sha === null) continue
      const gone = yield* reclaimBlobIfOrphanedProgram(sha).pipe(
        Effect.mapError(
          (cause) => new FeedStoreFailed({ cause, message: cause.message }),
        ),
      )
      if (gone) reclaimed += 1
    }
    return reclaimed
  },
)

/**
 * Rows deleted and the blobs they named reclaimed, crash-safe: `remove`
 * runs in a transaction that also writes a `pending_blob` intent for each
 * digest it let go, so a process that dies before the reclaim leaves them
 * to the orphan sweep. The intents this wrote are spent once the reclaim
 * has asked.
 */
export const deleteAndReclaimProgram = Effect.fn('feeds.deleteAndReclaim')(
  function* <T>(
    remove: (tx: Tx) => Promise<ReadonlyArray<T>>,
    shasOf: (row: T) => ReadonlyArray<string | null>,
  ): Effect.fn.Return<
    { readonly deleted: number; readonly reclaimed: number },
    FeedStoreFailed
  > {
    const { deleted, intents } = yield* store(() =>
      db.transaction(async (tx) => {
        const rows = await remove(tx)
        const shas = [
          ...new Set(
            rows.flatMap(shasOf).filter((s): s is string => s !== null),
          ),
        ]
        const written =
          shas.length === 0
            ? []
            : await tx
                .insert(pendingBlob)
                .values(shas.map((sha) => ({ sha })))
                .onConflictDoNothing({ target: pendingBlob.sha })
                .returning({ sha: pendingBlob.sha })
        return { deleted: rows, intents: written.map((w) => w.sha) }
      }),
    )
    const reclaimed = yield* reclaimFeedBlobsProgram(deleted.flatMap(shasOf))
    if (intents.length > 0)
      yield* store(() =>
        db.delete(pendingBlob).where(inArray(pendingBlob.sha, intents)),
      )
    return { deleted: deleted.length, reclaimed }
  },
)

/**
 * The daily delete: every headline published before the retention cutoff,
 * and its photo unless another row holds the same blob.
 */
export const pruneFeedItemsProgram = Effect.fn('feeds.pruneItems')(function* (
  now: Date = new Date(),
) {
  return yield* deleteAndReclaimProgram(
    (tx) =>
      tx
        .delete(feedItem)
        .where(lt(feedItem.publishedAt, retentionCutoff(now)))
        .returning({ imageSha: feedItem.imageSha }),
    (r) => [r.imageSha],
  )
})
