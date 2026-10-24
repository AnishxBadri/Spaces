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
 * **Is any row still holding this digest?** A `stored` document, a prior
 * revision, a staged import batch, a record's picture or the workspace logo.
 * - Content addressing means one file backs several rows, so the bytes go
 *   only when the last row goes.
 * - Both directions of blob GC (the delete path and the orphan sweep) ask
 *   this one query; never add a second copy of "referenced".
 * - Never move it into the server-fn modules: their plain exports ship to
 *   the browser, and the worker calls this without a request.
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
  // always-present, which the compiler never checked.
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
  // A staged import names its spreadsheet by digest and has no document row:
  // the same file filed as a document and then deleted must not
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
  // An email keeps its raw MIME by digest in `meta`.
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
 * That is the extraction cache (`extraction_cache`): answers keyed by
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
