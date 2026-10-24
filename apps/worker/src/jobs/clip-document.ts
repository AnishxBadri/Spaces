import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { parseHTML } from 'linkedom'
import { z } from 'zod'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { guessDocumentKind } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { guardedFetch } from '#web/lib/documents/fetch-guard'
import { enqueue } from '#web/lib/queue'
import { storage } from '@spaces/core/writes/storage'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.clip: fetches a clipped URL whose row `clipUrlProgram` already
 * wrote as `pending`, and ends it `done`, `unsupported` or `failed`.
 *
 * - Every refusal is a row write and a `JobPermanent`, never a throw: `runJob`'s
 *   promise must not reject, since an uncaught throw past it kills the container.
 *   Guard refusal or network error/timeout → 'failed'; a type neither HTML nor
 *   PDF, or no readable article → 'unsupported'.
 * - A failed guarded fetch is not retried: it has already spent its whole time
 *   budget, and the row keeps the URL for a re-clip. Only Postgres is retryable.
 * - A PDF response goes down the ordinary blob path (hash, store, point the
 *   row, enqueue `document.extract`), like an upload.
 * - This is the second `storage().put(`, deliberately not intake
 *   (`writes/documents/intake.ts`): intake births a row, and this row already
 *   exists. Content addressing still dedupes the blob: one blob, two rows.
 */

export const clipDocumentData = z.object({
  documentId: z.string().uuid(),
})

export type ClipDocumentData = z.infer<typeof clipDocumentData>

/**
 * 10MB and 20 seconds: the cap is against a URL that streams forever, not long
 * prose. Constants, not env vars: a deployment-wide knob could switch the
 * guard off in production by accident, and the env surface is frozen at
 * `{DATABASE_URL, APP_URL}`.
 */
export const CLIP_MAX_BYTES = 10 * 1024 * 1024
export const CLIP_TIMEOUT_MS = 20_000

/**
 * Below this, readability found chrome and called it an article. 200 is the
 * snippet width every surface renders (`left(extracted_text, 200)`), so less
 * text than the row's own preview is reported 'unsupported'.
 */
export const CLIP_MIN_ARTICLE_CHARS = 200

/** The clip cannot be read, now or ever. Terminal, and explainable. */
export class ClipRefused extends Schema.TaggedError<ClipRefused>()(
  'ClipRefused',
  {
    status: Schema.Literals(['unsupported', 'failed']),
    reason: Schema.String,
  },
) {}

/** The read failed — Postgres, not the page. */
export class ClipStoreUnavailable extends Schema.TaggedError<ClipStoreUnavailable>()(
  'ClipStoreUnavailable',
  { operation: Schema.String, message: Schema.String },
) {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const store = <T>(operation: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (err) =>
      new ClipStoreUnavailable({ operation, message: messageOf(err) }),
  })

/** Everything before the first `;`, lower-cased: `text/html; charset=utf-8`. */
function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

function isHtml(type: string): boolean {
  return type === 'text/html' || type === 'application/xhtml+xml'
}

/** The one mime a clipped PDF is stored under, whatever the server said. */
const PDF_MIME = 'application/pdf'

/** `%PDF-`, the five bytes every PDF opens with (ISO 32000-1 §7.5.2). */
const PDF_MAGIC = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])

/**
 * A PDF, by what the server said or by the magic bytes: download endpoints
 * often serve decks as `application/octet-stream`. Checked before the HTML
 * branch, so bytes win over a mislabel in either direction.
 */
function isPdf(type: string, bytes: Uint8Array): boolean {
  if (type === PDF_MIME) return true
  if (bytes.length < PDF_MAGIC.length) return false
  return PDF_MAGIC.every((byte, i) => bytes[i] === byte)
}

/**
 * The filename inside a URL (`…/decks/seed-deck.pdf` → `seed-deck.pdf`), for
 * `guessDocumentKind`. With no path segment it falls back to the whole
 * address, which guesses `other`.
 */
function lastPathSegment(raw: string): string {
  try {
    const last = new URL(raw).pathname
      .split('/')
      .filter((segment) => segment !== '')
      .at(-1)
    return last === undefined ? raw : decodeURIComponent(last)
  } catch {
    return raw
  }
}

/**
 * Readability over linkedom. Not jsdom: this parses hostile HTML, and jsdom
 * runs scripts; linkedom is only a parser and a DOM.
 * Exported so tests can assert extraction against a fixture without a fetch.
 */
export function readArticle(
  html: string,
): { title: string | null; text: string } | null {
  const { document: dom } = parseHTML(html)
  const article = new Readability(dom).parse()
  if (article === null) return null
  const text = tidy(article.textContent ?? '')
  if (text.length < CLIP_MIN_ARTICLE_CHARS) return null
  const title = article.title?.trim()
  return { title: title === undefined || title === '' ? null : title, text }
}

/**
 * Collapses Readability's verbatim source whitespace, which is what the
 * snippet renders and embedding chunks. Paragraph breaks (a blank line)
 * survive; all other whitespace becomes one space.
 */
function tidy(raw: string): string {
  return raw
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .join('\n\n')
}

/**
 * The bytes as text (`guardedFetch` answers octets so a PDF survives).
 * `fatal: false`: a page mis-declaring its encoding should lose a character,
 * not the whole clip.
 */
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * Stores the PDF response: hash, put unless the digest exists, point the row
 * at it, enqueue extraction.
 * - A `Buffer` is fine: `guardedFetch` already capped the bytes at
 *   `CLIP_MAX_BYTES`, and an oversize response stores nothing.
 * - Resets `extraction_status`/`extraction_error` so a re-clip does not keep
 *   the old failure under a now-extractable blob.
 * - The enqueue is last and outside any transaction: a down queue must not
 *   undo a good row.
 */
const storePdf = Effect.fn('clipDocument.storePdf')(function* (
  documentId: string,
  fetched: { readonly url: string; readonly bytes: Uint8Array },
): Effect.fn.Return<void, ClipStoreUnavailable> {
  const bytes = fetched.bytes
  const sha = createHash('sha256').update(bytes).digest('hex')

  // Content addressing is the only dedupe for a row that already exists: an
  // identical upload shares this blob. Row-level dedupe is birth's.
  const stored = yield* store('blobExists', () => storage().exists(sha))
  if (!stored) {
    yield* store('blobPut', () =>
      storage().put(sha, Buffer.from(bytes), { mime: PDF_MIME }),
    )
  }

  yield* store('markStored', async () => {
    await db
      .update(document)
      .set({
        blobSha: sha,
        // What we counted, never what the server declared.
        sizeBytes: bytes.byteLength,
        mime: PDF_MIME,
        // Born `article`; it turned out to be a file, so file it as an
        // upload of the same file would be.
        kind: guessDocumentKind(lastPathSegment(fetched.url)),
        extractionStatus: 'pending',
        extractionError: null,
      })
      .where(eq(document.entityId, documentId))
  })

  yield* store('enqueueExtract', () =>
    enqueue(QUEUES.extractDocument, { documentId }),
  )

  console.log(
    `[worker] stored ${String(bytes.byteLength)} PDF bytes from ${fetched.url} as ${sha}`,
  )
})

const program = Effect.fn('clipDocument')(function* (data: ClipDocumentData) {
  const { documentId } = data
  const row = yield* store(
    'read',
    async () =>
      (
        await db
          .select({ url: document.url })
          .from(document)
          .where(eq(document.entityId, documentId))
      ).at(0) ?? null,
  )

  if (row === null) {
    console.warn(`[worker] document ${documentId} vanished before the clip`)
    return
  }
  if (row.url === null) {
    return yield* new ClipRefused({
      status: 'unsupported',
      reason: 'No URL on this document to fetch',
    })
  }
  const url = row.url

  // Deliberately `Effect.promise`: `guardedFetch` answers with a result and
  // never rejects, so a throw out of it is a bug and belongs on the wrapper's
  // defect path rather than becoming operator-facing text.
  const fetched = yield* Effect.promise(() =>
    guardedFetch(url, {
      maxBytes: CLIP_MAX_BYTES,
      timeoutMs: CLIP_TIMEOUT_MS,
    }),
  )

  if (!fetched.ok) {
    // Both kinds are 'failed': neither says anything about the *document*
    // being unreadable, which is what 'unsupported' means on this column.
    return yield* new ClipRefused({ status: 'failed', reason: fetched.reason })
  }

  const type = mediaType(fetched.contentType)
  // Before the HTML branch: a PDF is a document with bytes, not a page that
  // failed to be an article.
  if (isPdf(type, fetched.bytes)) {
    return yield* storePdf(documentId, fetched)
  }
  if (!isHtml(type)) {
    return yield* new ClipRefused({
      status: 'unsupported',
      // The content-type verbatim: the operator's next question is "what
      // was it then".
      reason: `Not an HTML page — the server answered ${type === '' ? 'no content-type' : type}`,
    })
  }

  const article = readArticle(decode(fetched.bytes))
  if (article === null) {
    return yield* new ClipRefused({
      status: 'unsupported',
      reason: 'No readable article text on this page',
    })
  }

  // One statement for text and tsv: they must never disagree, or search
  // returns rows whose text says otherwise. `filename` is the display name,
  // so it takes the title in place of the URL.
  yield* store('markExtracted', async () => {
    await db
      .update(document)
      .set({
        extractedText: article.text,
        // 'english' matches the tsvector config the search indexes use;
        // changing it here alone makes writes and queries disagree.
        tsv: sql`to_tsvector('english', ${article.text})`,
        extractionStatus: 'done',
        extractionError: null,
        extractedAt: new Date(),
        ...(article.title === null ? {} : { filename: article.title }),
      })
      .where(eq(document.entityId, documentId))
  })

  // The entity's name too, which ⌘K, mentions and the timeline read.
  if (article.title !== null) {
    const title = article.title
    yield* store('renameEntity', async () => {
      await db
        .update(entity)
        .set({ canonicalName: title })
        .where(eq(entity.id, documentId))
    })
  }

  console.log(
    `[worker] clipped ${String(article.text.length)} chars from ${fetched.url}`,
  )
})

/**
 * Records the terminal status on the row, then fails the job permanently.
 * The row write is what the reader sees on the Files tab; the `JobPermanent`
 * is what stops pg-boss retrying something that will never succeed.
 */
const onClipRefused = Effect.fn('clipDocument.onClipRefused')(function* (
  documentId: string,
  err: ClipRefused,
) {
  yield* store('markFailed', async () => {
    await db
      .update(document)
      .set({
        extractionStatus: err.status,
        extractionError: err.reason.slice(0, 500),
        extractedAt: new Date(),
      })
      .where(eq(document.entityId, documentId))
  }).pipe(
    // A Postgres that cannot take the status write must not turn a refusal
    // into a defect: the job still ends permanently, and `job_run` carries
    // the reason either way.
    Effect.catchTag('ClipStoreUnavailable', (unavailable) =>
      Effect.sync(() => {
        console.error(
          `[worker] could not record the clip refusal for ${documentId} during ${unavailable.operation}: ${unavailable.message}`,
        )
      }),
    ),
  )
  console.warn(`[worker] ${err.status} ${documentId}: ${err.reason}`)
  return yield* new JobPermanent({ reason: err.reason })
})

export const clipDocument: JobDef<ClipDocumentData> = {
  name: QUEUES.clipDocument,
  schema: clipDocumentData,
  // The document is an entity, so a clip's attempts land on its run history.
  refs: (data) => ({ entityId: data.documentId }),
  // One retry, for Postgres and not the page: every refusal is a
  // `JobPermanent`. It saves a fetched page from a database that blinked
  // before the write.
  retry: { limit: 1, delaySeconds: 30, backoff: false },
  run: (data) =>
    program(data).pipe(
      Effect.catchTag('ClipRefused', (err) =>
        onClipRefused(data.documentId, err),
      ),
      Effect.catchTag(
        'ClipStoreUnavailable',
        (err) =>
          new JobRetryable({
            reason: `document store unavailable during ${err.operation}: ${err.message}`,
          }),
      ),
    ),
}
