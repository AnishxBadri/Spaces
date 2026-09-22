import { Readability } from '@mozilla/readability'
import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { parseHTML } from 'linkedom'
import { z } from 'zod'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { guardedFetch } from '#/lib/documents/fetch-guard'
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
 *   - a non-HTML content-type                 → 'unsupported', the type
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
 * docsurf-10b is the one exception that will be added here: a PDF
 * content-type becomes a real blob through intake rather than an
 * 'unsupported' row, using the same `guardedFetch` bytes.
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
  if (!isHtml(type)) {
    return yield* new ClipRefused({
      status: 'unsupported',
      // The content-type verbatim, because the next question an operator asks
      // is "what was it then" — and docsurf-10b reads this branch to decide
      // which types become a blob through intake instead.
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
