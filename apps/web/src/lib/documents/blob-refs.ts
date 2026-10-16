import { and, count, eq, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  document,
  documentRevision,
  entity,
  extractionCache,
  importBatch,
  interaction,
  workspace,
} from '@spaces/db/schema'
import { storage } from '@spaces/core/writes/storage'

/**
 * **Is any row still holding this digest?** A `stored` document, a
 * document's prior revision, a staged import batch,
 * a record's picture (`entity.picture_sha`) or the workspace logo
 * (`workspace.settings.logo`) — the one question both
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
export async function blobIsReferenced(
  sha: string,
  exceptDocumentId?: string,
): Promise<boolean> {
  // Only a `stored` row holds its bytes: a `remote` one (retain: text) keeps
  // the sha for its derived layers and fetches the file from its provider.
  // `exceptDocumentId` is the retain drop asking about every row but its own.
  const held = and(
    eq(document.blobSha, sha),
    eq(document.bytesState, 'stored'),
    exceptDocumentId === undefined
      ? undefined
      : ne(document.entityId, exceptDocumentId),
  )
  // `.at(0)` rather than a destructure: drizzle types the element as
  // always-present, which is a claim about a result set rather than one the
  // compiler checked (CLAUDE.md gate 4).
  const row = (
    await db.select({ value: count() }).from(document).where(held)
  ).at(0)
  if ((row?.value ?? 0) > 0) return true
  // A followed document's prior bytes: deleting the document that shares
  // the digest must not take another document's history with it.
  const revision = (
    await db
      .select({ value: count() })
      .from(documentRevision)
      .where(eq(documentRevision.blobSha, sha))
  ).at(0)
  if ((revision?.value ?? 0) > 0) return true
  // A staged import names its spreadsheet by digest and has no document row
  // (SPA-164): the same file filed as a document and then deleted must not
  // take the batch's bytes with it.
  const staged = (
    await db
      .select({ value: count() })
      .from(importBatch)
      .where(eq(importBatch.blobSha, sha))
  ).at(0)
  if ((staged?.value ?? 0) > 0) return true
  // A record's picture names its bytes by digest and has no document row:
  // the logo filed as a document and then deleted must not take the picture.
  const picture = (
    await db
      .select({ value: count() })
      .from(entity)
      .where(eq(entity.pictureSha, sha))
  ).at(0)
  if ((picture?.value ?? 0) > 0) return true
  // The workspace logo names its bytes by digest in the settings jsonb.
  const logo = (
    await db
      .select({ value: count() })
      .from(workspace)
      .where(sql`${workspace.settings} ->> 'logo' = ${sha}`)
  ).at(0)
  if ((logo?.value ?? 0) > 0) return true
  // An email keeps its raw MIME by digest in `meta` (D67).
  const mime = (
    await db
      .select({ value: count() })
      .from(interaction)
      .where(sql`${interaction.meta} ->> 'mime_blob_sha' = ${sha}`)
  ).at(0)
  return (mime?.value ?? 0) > 0
}

/**
 * **The last row went: drop the bytes and everything derived from them.**
 * Both directions of blob GC end here once `blobIsReferenced` says no — the
 * delete path (`deleteDocumentWithBlobGc`) and the orphan sweep — so what
 * "goes with the blob" is listed once.
 *
 * Today that is the extraction cache (`extraction_cache`): answers keyed by
 * the sha rather than by a document, so no entity delete reaches them, and a
 * deleted deck must leave no answers behind — unless a `remote` document
 * still names the sha (`reclaimDerivedIfUnnamed`). The derived rows go
 * before the bytes: a store that throws leaves the bytes for the next run,
 * and a cache emptied early costs nothing but a call.
 *
 * Returns whether it reclaimed — false when a row still names the digest.
 */
export async function reclaimBlobIfOrphaned(sha: string): Promise<boolean> {
  if (await blobIsReferenced(sha)) return false
  await reclaimDerivedIfUnnamed(sha)
  // Already remote: the bytes were dropped after extraction, so no delete
  // is attempted. A viewer's cached fetch, or a drop that crashed half way,
  // is still on disk and goes here.
  if (await storage().exists(sha)) await storage().delete(sha)
  return true
}

/**
 * The derived rows keyed by a digest, once no document of any state names
 * it. A `remote` document holds no bytes but its derived layers are its only
 * copy, so they outlive the blob until the last row naming the sha goes.
 */
async function reclaimDerivedIfUnnamed(sha: string): Promise<void> {
  const named = (
    await db
      .select({ value: count() })
      .from(document)
      .where(eq(document.blobSha, sha))
  ).at(0)
  if ((named?.value ?? 0) > 0) return
  await db.delete(extractionCache).where(eq(extractionCache.blobSha, sha))
}
