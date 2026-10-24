import { and, inArray, isNotNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { storage } from '@spaces/core/writes/storage'

/**
 * A record's picture as the page draws it: a short-lived URL on the blob
 * store, never the remote address it was fetched from.
 * - Server-only: the store signs the URL. Outside the server-fn barrel so
 *   the loaders' programs and tests can call it without a request.
 */

/** Long enough to outlast a page left open; the blob itself never changes. */
const PICTURE_URL_TTL_SECONDS = 12 * 60 * 60

export async function pictureUrl(sha: string | null): Promise<string | null> {
  return sha === null
    ? null
    : storage().getDownloadUrl(sha, PICTURE_URL_TTL_SECONDS)
}

/** The picture URL of each record that has one, by id. */
export async function pictureUrlsFor(
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: entity.id, sha: entity.pictureSha })
    .from(entity)
    .where(and(inArray(entity.id, [...ids]), isNotNull(entity.pictureSha)))
  const out = new Map<string, string>()
  for (const row of rows) {
    const url = await pictureUrl(row.sha)
    if (url !== null) out.set(row.id, url)
  }
  return out
}

/** Each row with its picture URL, or null. */
export async function withPictures<T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
): Promise<Array<T & { picture: string | null }>> {
  const urls = await pictureUrlsFor(rows.map((r) => r.id))
  return rows.map((r) => ({ ...r, picture: urls.get(r.id) ?? null }))
}
