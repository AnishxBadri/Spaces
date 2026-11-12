import { Effect } from 'effect'
import { and, inArray, isNotNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { storage } from '@spaces/core/writes/storage'
import { recordsQuery } from './query'

/**
 * A record's picture as the page draws it: a short-lived URL on the blob
 * store, never the remote address it was fetched from.
 * - Server-only: the store signs the URL. Outside the server-fn barrel so
 *   the loaders' programs and tests can call it without a request.
 */

/** Long enough to outlast a page left open; the blob itself never changes. */
const PICTURE_URL_TTL_SECONDS = 12 * 60 * 60

// A storage failure reaches the caller as the storage threw it.
export const pictureUrlProgram = Effect.fn('pictureUrl')(function* (
  sha: string | null,
) {
  if (sha === null) return null
  return yield* Effect.promise(() =>
    storage().getDownloadUrl(sha, PICTURE_URL_TTL_SECONDS),
  )
})

/** {@link pictureUrlProgram}, for a caller that is not a program. */
export const pictureUrl = (sha: string | null): Promise<string | null> =>
  Effect.runPromise(pictureUrlProgram(sha))

/** The picture URL of each record that has one, by id. */
export const pictureUrlsForProgram = Effect.fn('pictureUrlsFor')(function* (
  ids: ReadonlyArray<string>,
) {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const rows = yield* recordsQuery(() =>
    db
      .select({ id: entity.id, sha: entity.pictureSha })
      .from(entity)
      .where(and(inArray(entity.id, [...ids]), isNotNull(entity.pictureSha))),
  )
  for (const row of rows) {
    const url = yield* pictureUrlProgram(row.sha)
    if (url !== null) out.set(row.id, url)
  }
  return out
})

/** {@link pictureUrlsForProgram}, for a caller that is not a program. */
export const pictureUrlsFor = (
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> => Effect.runPromise(pictureUrlsForProgram(ids))

/** Each row with its picture URL, or null. */
export const withPicturesProgram = <T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
) =>
  pictureUrlsForProgram(rows.map((r) => r.id)).pipe(
    Effect.map((urls) =>
      rows.map((r): T & { picture: string | null } => ({
        ...r,
        picture: urls.get(r.id) ?? null,
      })),
    ),
  )

/** {@link withPicturesProgram}, for a caller that is not a program. */
export const withPictures = <T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
): Promise<Array<T & { picture: string | null }>> =>
  Effect.runPromise(withPicturesProgram(rows))
