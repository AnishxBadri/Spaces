import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
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
    const u = await requireUser()
    const { documentPreviewCard } = await import('../documents/preview-card')
    return documentPreviewCard(u, data.id)
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
