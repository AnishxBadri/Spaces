import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

const uuid = Schema.String.check(Schema.isUUID())

/**
 * One document's card, by entity id — everything `DocumentPreview` needs to
 * open, and nothing else.
 *
 * Separate from `listRecordDocuments`, which starts from a *record* and joins
 * through `link(tagged_in)`: a mention chip has only the document's own id,
 * and often there is no record the deck is filed against.
 *
 * Deliberately not the text or the blob: the preview fetches those itself,
 * lazily, through `getDocumentText` / `getDocumentDownloadUrl`.
 */
export const getDocumentPreview = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { documentPreviewCard } = await import('../documents/preview-card')
    return documentPreviewCard(u, data.id)
  })

/**
 * One file as its window (`?modal=file&id=`) and its page (`/files/<id>`)
 * read it, by id, or null when the reader may not have it. The query is
 * `fileViewProgram`, reached by a dynamic import so drizzle and Effect stay
 * out of the client bundle.
 */
export const getFileView = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { fileViewProgram } = await import('../documents/file-view')
    const { effectFn } = await import('./effect')
    return effectFn(fileViewProgram)(u, data.id)
  })

/**
 * The viewer sidebar's facts and the Remove confirm's ledger for one
 * document: chunk count, words and pages read, the notes that mention it.
 * The query is `documentDetailsProgram`, reached by a dynamic import so
 * drizzle and Effect stay out of the client bundle.
 */
export const getDocumentDetails = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { documentDetailsProgram } = await import('../documents/details')
    const { effectFn } = await import('./effect')
    return effectFn(documentDetailsProgram)(u, data.id)
  })

/**
 * The viewer's find: hits for `query` in one file's stored text, grouped by
 * page, or null when the reader may not have the file. The query is
 * `findInDocumentProgram`, reached by a dynamic import so drizzle and Effect
 * stay out of the client bundle.
 */
export const findInDocument = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        query: Schema.String.check(Schema.isMaxLength(200)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { findInDocumentProgram } = await import('../documents/find')
    const { effectFn } = await import('./effect')
    return effectFn(findInDocumentProgram)(u, data.id, data.query)
  })

/**
 * The viewer's bytes: a signed URL, a fetch under way from the document's
 * provider (a `remote` row under `retain: text`), or why neither. The viewer
 * opens with `poll: false` and asks again with `poll: true`.
 */
export const getDocumentBytes = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid, poll: Schema.Boolean })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { documentBytesProgram } = await import('../documents/remote-bytes')
    const { effectFn } = await import('./effect')
    return effectFn(documentBytesProgram)(u.id, data.id, { poll: data.poll })
  })
