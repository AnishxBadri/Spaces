import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { requireUser } from './shared'

/**
 * One document's card, by entity id — everything `DocumentPreview` needs to
 * open, and nothing else.
 *
 * It lives beside `documents.ts` rather than in it because the Files tab's
 * `listRecordDocuments` starts from a *record* and joins through
 * `link(tagged_in)`. A mention chip has only the document's own id: the note
 * mentioning a deck is not the record the deck is filed against, and often
 * there is no such record at all.
 *
 * Deliberately not the text or the blob: the preview fetches those itself,
 * lazily, through `getDocumentText` / `getDocumentDownloadUrl`.
 */
export const getDocumentPreview = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    // `.at(0)` rather than destructuring: the row genuinely may not exist —
    // a mention whose document was deleted is an ordinary state — and a
    // destructured element types as always-present.
    const row = (
      await db
        .select({
          id: document.entityId,
          filename: document.filename,
          mime: document.mime,
          sizeBytes: document.sizeBytes,
          kind: document.kind,
          extractionStatus: document.extractionStatus,
          extractionError: document.extractionError,
          // The two columns that decide whether there is a file to fetch at
          // all (docsurf-10b). A clipped article has no blob and an address
          // instead, and the dialog renders the extracted text with the
          // address linked rather than asking storage for bytes it never
          // stored — which is what `getDocumentDownloadUrl` throws about.
          blobSha: document.blobSha,
          url: document.url,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(document)
        .innerJoin(entity, eq(entity.id, document.entityId))
        .where(eq(document.entityId, data.id))
    ).at(0)
    if (!row || row.mergedIntoId) return null
    return {
      id: row.id,
      // Same coercion the Files tab makes: `filename` is nullable for
      // url-origin documents, and the dialog's title is not optional.
      filename: row.filename ?? 'Untitled file',
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
      extractionStatus: row.extractionStatus,
      extractionError: row.extractionError,
      blobSha: row.blobSha,
      url: row.url,
    }
  })

/**
 * The viewer sidebar's facts and the Remove confirm's ledger for one
 * document: chunk count, words and pages read, the notes that mention it.
 * The query is `documentDetailsProgram`, reached by a dynamic import so
 * drizzle and Effect stay out of the client bundle.
 */
export const getDocumentDetails = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { documentDetailsProgram } = await import('../documents/details')
    const { effectFn } = await import('./effect')
    return effectFn(documentDetailsProgram)(u, data.id)
  })
