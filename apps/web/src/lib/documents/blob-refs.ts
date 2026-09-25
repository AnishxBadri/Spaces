import { count, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, extractionCache } from '@spaces/db/schema'
import { storage } from '#/lib/storage'

/**
 * **Is any document row still on this digest?** — the one question both
 * directions of blob GC ask, asked in one place (SPA-54).
 *
 * Content addressing means one file backs several rows: the deck emailed to
 * both partners, the same deck filed on a company and on a space. So "delete
 * the bytes" is never a consequence of deleting *a* row — it is a
 * consequence of the last row going. Until this slice the count lived inline
 * at the bottom of `deleteDocumentWithBlobGc`, which was fine while a delete
 * was the only thing that could strand bytes. The orphan sweep reclaims from
 * the other direction — a prepare whose finalize never came — and asks the
 * identical question, so a second copy of the query would be two places that
 * must stay in step about what "referenced" means. `blob-refs.test.ts`
 * asserts there is only one.
 *
 * It lives in `lib/documents/` and **not** in `lib/server/`: the server-fns
 * barrel re-exports `lib/server/*` wholesale to the browser and a plain
 * export there ships with it (CLAUDE.md → Traps, SPA-155), while the worker
 * and the delete path both have to call this without a request.
 */
export async function blobIsReferenced(sha: string): Promise<boolean> {
  // `.at(0)` rather than a destructure: drizzle types the element as
  // always-present, which is a claim about a result set rather than one the
  // compiler checked (CLAUDE.md gate 4).
  const row = (
    await db
      .select({ value: count() })
      .from(document)
      .where(eq(document.blobSha, sha))
  ).at(0)
  return (row?.value ?? 0) > 0
}

/**
 * **The last row went: drop the bytes and everything derived from them.**
 * Both directions of blob GC end here once `blobIsReferenced` says no — the
 * delete path (`deleteDocumentWithBlobGc`) and the orphan sweep — so what
 * "goes with the blob" is listed once.
 *
 * Today that is the extraction cache (SPA-74, `extraction_cache`): answers
 * keyed by the sha rather than by a document, so no entity delete reaches
 * them, and a deleted deck must leave no answers behind. The derived rows go
 * before the bytes: a store that throws leaves the bytes for the next run,
 * and a cache emptied early costs nothing but a call.
 *
 * Returns whether it reclaimed — false when a row still names the digest.
 */
export async function reclaimBlobIfOrphaned(sha: string): Promise<boolean> {
  if (await blobIsReferenced(sha)) return false
  await db.delete(extractionCache).where(eq(extractionCache.blobSha, sha))
  await storage().delete(sha)
  return true
}
