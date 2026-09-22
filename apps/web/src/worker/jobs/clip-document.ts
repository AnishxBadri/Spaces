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
import { guardedFetch } from '#/lib/documents/fetch-guard'
import { enqueue } from '#/lib/queue'
import { storage } from '#/lib/storage'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.clip — the fetching half of §3.1's URL clip (SPA-117).
 *
 * `clipUrlProgram` wrote the row and returned before any network call, so
 * everything that can go wrong with somebody else's web server goes wrong
 * here, on the worker, where a 30-second page is thirty seconds of a job and
 * not of a request. The row is already `pending`; this job's whole output is
 * that status becoming `done`, `unsupported` or `failed`, plus the text.
 *
 * **Every refusal is a row write and a `JobPermanent`, never a throw.**
 * `runJob`'s promise must not reject (hostability contract 2 — an uncaught
 * throw past the wrapper is a container death), and none of the four
 * refusals is worth another attempt:
 *
 *   - the guard refused the URL or a redirect → 'failed', the sentence
 *   - a network error or a timeout            → 'failed', the sentence
 *   - a content-type that is neither HTML
 *     nor PDF                                 → 'unsupported', the type
 *   - readability found no article            → 'unsupported'
 *
 * The network branch is the judgement call. A blob read is retried by
 * `extract-document` because the store may simply have been slow; a *guarded*
 * fetch has already spent its whole time budget by the time it fails, so a
 * retry would spend another full budget to reach the same server that just
 * refused, and the row would read 'pending' for minutes while it did. Re-ask
 * for it explicitly instead — the row keeps the URL, which is all a re-clip
 * needs. The one retryable failure is Postgres itself, which says nothing
 * about the page and may well take the write next time.
 *
 * **The PDF branch is docsurf-10b** (§3.1 entry point 5, "PDF snapshot"): a
 * URL whose response is a PDF is not a second kind of thing, it is a deck
 * that happened to arrive over HTTP, so it goes down the ordinary blob path
 * — hash the bytes, store them under the digest, point the row at them and
 * hand it to `document.extract`, which is the same pipeline an upload walks.
 *
 * **It is the second `storage().put(` in the app, and deliberately not
 * `intakeDocumentProgram`.** The server byte lane
 * (`lib/documents/intake.ts`) ends in `birthDocumentProgram`: it *births a
 * row*. Here the row already exists — `clipUrlProgram` wrote it, named it,
 * filed it and enqueued this job before a packet left the box — so reusing
 * intake would mean a second document for the same clip and an orphaned
 * first one. What is shared instead is the thing worth sharing: content
 * addressing. The digest is the key, so an identical deck already uploaded
 * is already stored and `exists` says so — one blob, two rows, which is the
 * only dedupe a pre-existing row can have. `intake.test.ts`'s one-caller
 * assertion names this file for exactly that reason.
 */

export const clipDocumentData = z.object({
  documentId: z.string().uuid(),
})

export type ClipDocumentData = z.infer<typeof clipDocumentData>

/**
 * 10MB and 20 seconds. An article is tens of kilobytes; the cap is against a
 * URL that streams forever, not against long prose. Both are constants and
 * not env vars for the reason `ORPHAN_BLOB_GRACE_MS` is: a deployment-wide
 * knob here is a way to switch the guard off in production by accident, and
 * `{DATABASE_URL, APP_URL}` is frozen (CONTEXT.md → Hostability).
 */
export const CLIP_MAX_BYTES = 10 * 1024 * 1024
export const CLIP_TIMEOUT_MS = 20_000

/**
 * Below this, readability found chrome and called it an article. 200 is not
 * arbitrary: it is the snippet width every surface renders
 * (`left(extracted_text, 200)`), so a "clip" with less text than the row's
 * own one-line preview has nothing in it worth calling an article — and
 * saying so as 'unsupported' is a truer answer than a `done` row whose whole
 * body is a navigation menu.
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
 * A PDF, by what the server said *or* by what it actually sent. The magic
 * bytes are not belt-and-braces: a deck behind a download endpoint is served
 * as `application/octet-stream` about as often as it is labelled honestly,
 * and a content-type table alone would record those as 'unsupported' with a
 * perfectly good PDF in hand. Read before the HTML branch, so bytes win over
 * a mislabel in either direction.
 */
function isPdf(type: string, bytes: Uint8Array): boolean {
  if (type === PDF_MIME) return true
  if (bytes.length < PDF_MAGIC.length) return false
  return PDF_MAGIC.every((byte, i) => bytes[i] === byte)
}

/**
 * The filename inside a URL — `…/decks/seed-deck.pdf` → `seed-deck.pdf` —
 * which is all `guessDocumentKind` needs and the only name this arrival has.
 * A URL ending in a slash, or one with no path at all, has no segment to
 * read and falls back to the whole address, which guesses `other`.
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
 * Readability over linkedom. linkedom rather than jsdom because this parses
 * hostile HTML on the worker: jsdom runs scripts and implements far more of
 * the platform than an article needs, and linkedom is a parser and a DOM and
 * nothing else.
 *
 * Exported so `clip-document.test.ts` can assert the extraction against a
 * fixture without a fetch, and so docsurf-10b's HTML branch has one place to
 * call rather than a second `new Readability(...)`.
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
 * Readability's `textContent` is the source's whitespace verbatim, so a page
 * whose HTML was pretty-printed comes back with a newline and eight spaces in
 * the middle of every sentence. That is not a cosmetic problem: it is what
 * the Files tab renders as its snippet and what an embedding pass will chunk.
 *
 * Paragraph breaks — a blank line — are the one piece of structure worth
 * keeping, so they survive; everything else collapses to a single space.
 */
function tidy(raw: string): string {
  return raw
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .join('\n\n')
}

/**
 * The bytes as text. `guardedFetch` answers octets because docsurf-10b wants
 * a PDF's; an HTML page is decoded here, and `fatal: false` because a page
 * mis-declaring its encoding should lose a character, not the whole clip.
 */
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * The PDF response, stored — hash, put (unless the digest is already there),
 * point the row at it, enqueue extraction.
 *
 * The bytes are already whole and already capped: `guardedFetch` counted
 * them off the stream against `CLIP_MAX_BYTES` and answered `ok: false` at
 * 10MB + 1, so a runaway response is a 'failed' row with the limit in the
 * sentence and **nothing stored** — the store is never reached. That is why
 * a `Buffer` is honest here where `intake.ts` needs a temp file: intake
 * takes a 250MB upload of unknown length, this takes ten megabytes at most.
 *
 * `extraction_status` back to 'pending' and `extraction_error` to null on
 * purpose: a re-clip of a row that failed last time must not leave the old
 * sentence sitting under a blob that is now perfectly extractable.
 *
 * The enqueue is last and outside any transaction, exactly as birth's is: a
 * queue that is down must not undo a good row, and with no worker the row
 * reads 'pending' and says so on every surface.
 */
const storePdf = Effect.fn('clipDocument.storePdf')(function* (
  documentId: string,
  fetched: { readonly url: string; readonly bytes: Uint8Array },
): Effect.fn.Return<void, ClipStoreUnavailable> {
  const bytes = fetched.bytes
  const sha = createHash('sha256').update(bytes).digest('hex')

  // Content addressing *is* the dedupe available to a row that already
  // exists: the same deck uploaded an hour ago is already these bytes under
  // this key, so the two rows share one file on disk. §3.4's row-level
  // dedupe is birth's, and birth is not on this path.
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
        // What we counted, never what the server declared — the same rule
        // intake applies to `declaredSize`.
        sizeBytes: bytes.byteLength,
        mime: PDF_MIME,
        // The row was born `article`, which is what a pasted link usually
        // is. This one turned out to be a file, so it is filed the way the
        // same file would have been had somebody dragged it in.
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
  // failed to be an article, and this is the whole of docsurf-10b.
  if (isPdf(type, fetched.bytes)) {
    return yield* storePdf(documentId, fetched)
  }
  if (!isHtml(type)) {
    return yield* new ClipRefused({
      status: 'unsupported',
      // The content-type verbatim, because the next question an operator asks
      // is "what was it then". PDF is handled above; everything still landing
      // here — a zip, a video, a JSON API — has no reader in the product.
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

  // One statement for text and tsv, as `extract-document` does and for the
  // same reason: they must never disagree, or search returns rows whose text
  // says otherwise. `filename` moves with the title because it is the display
  // name every surface renders — the row was named by its URL until now.
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

  // And the entity's own name, which is what ⌘K, the mention menu and every
  // timeline line read. It has said the URL since the row was born.
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
    // The status write is the point of this handler, but a Postgres that
    // cannot take it must not turn a refusal into a defect: the job still
    // ends permanently, and `job_run` carries the reason either way.
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
  // The document *is* an entity, so its id is the ledger's entity_id — the
  // same declaration `extractDocument` makes, and what puts a clip's attempts
  // on the row's own run history.
  refs: (data) => ({ entityId: data.documentId }),
  // One retry, and it is for Postgres and not for the page. Every refusal
  // above is a `JobPermanent` and never reaches this budget — see the module
  // note: a guarded fetch that failed has already spent its whole time
  // budget, so re-fetching buys nothing but a row that reads 'pending' for
  // another twenty seconds. What a retry *is* worth is a database that blinked
  // between the fetch and the write, which would otherwise throw away a page
  // we already have in hand.
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
