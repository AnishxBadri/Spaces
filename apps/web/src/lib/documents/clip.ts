import { Effect, Schema } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import { DocumentBirthRejected, birthDocumentProgram } from './birth'
import { urlRefusal } from './fetch-guard'
import type { DocumentActor, DocumentBirthFailure } from './birth'
import type { DocumentFilingTarget } from '#/lib/server/shared'

/**
 * **The URL clip** — `docs/spec-storage-sources.md` §3.1 entry point 5, and
 * the one arrival with no bytes (SPA-117).
 *
 * CONTEXT.md → "Sources are documents" is the whole design: there is no
 * `source` table. A saved article is a `document` row whose readability text
 * lands in the same `extracted_text` / `tsv` / chunk pipeline a deck's does,
 * so ⌘K covers decks and articles with one query rather than a union of two
 * shapes. What tells the two apart is `document.url`, which is set here and
 * nowhere else in the product.
 *
 * **Row first, fetch later.** This program returns before a single packet
 * leaves the box: it validates the URL against the guard table, births the
 * row `pending`, and enqueues `document.clip`. The reader gets a row named by
 * the URL immediately, which flips to the article's title seconds later when
 * the worker lands — and with the worker down the row simply stays pending,
 * which is the acceptance criterion about no new required env read literally.
 * Fetching inline would also mean a server function that holds a request open
 * for however long somebody else's server feels like taking.
 *
 * **`source_class` is `manual`, not `url`.** The body of this issue predates
 * SPA-137: `url` was a value of the old `document_origin` enum, and D1
 * collapsed that enum into the eight-value `source_class`, where `url` is not
 * a member. A person pasting a link into a surface we ship is the plainest
 * `manual` write there is (§11 delta 2 — origin collapses into
 * `source_class` + `source_ref`), the biconditional check would refuse a
 * `source_ref` anyway, and `document.url` is what marks the row a clip.
 * `source_ref` is therefore null and `external_url` stays null too: that
 * column is docsurf-11's "Open in source" for a *provider's* copy, and the
 * clip's own address already has a column of its own.
 *
 * It lives in `lib/documents/` and not `lib/server/` for the reason
 * `birth.ts` does — the server-fns barrel ships `lib/server/*` to the
 * browser, and `clip.test.ts` drives this without a request.
 */

export type ClipUrlInput = {
  /** What the reader pasted. Validated here, never trusted. */
  url: string
  /** Zero, one or N places — birth's array, unchanged (SPA-113). */
  fileAgainst: Array<DocumentFilingTarget>
  actor: DocumentActor
}

/** The URL will not be fetched — carries the guard's sentence, not a code. */
export class ClipUrlRejected extends Schema.TaggedError<ClipUrlRejected>()(
  'ClipUrlRejected',
  { reason: Schema.String },
) {}

export class ClipUrlFailed extends Schema.TaggedError<ClipUrlFailed>()(
  'ClipUrlFailed',
  { cause: Schema.Defect() },
) {}

export type ClipUrlFailure =
  ClipUrlRejected | ClipUrlFailed | DocumentBirthFailure

/**
 * The sentence the client is shown. `Effect.runPromise` rejects with the
 * tagged error itself and a `Schema.TaggedError` carries no `message`, so a
 * refusal allowed through as-is arrives empty — `ledgerVoidMessage` set this
 * rule and `documentBirthMessage` repeats it. Both refusal shapes are worth
 * reading aloud: the guard's names the address, birth's names the target.
 */
export function clipUrlMessage(failure: unknown): string {
  if (failure instanceof ClipUrlRejected) return failure.reason
  if (failure instanceof DocumentBirthRejected) return failure.reason
  return 'Could not save this link'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ClipUrlFailed({ cause }),
  })

/**
 * Save a link as a document, and hand the fetching to the worker.
 *
 * The canonical name is **the URL**, deliberately: a row has to be readable
 * the instant it appears, and the only fact known about the page at this
 * point is its address. `clip-document.ts` overwrites it with the article's
 * title once readability has one.
 */
export const clipUrlProgram = Effect.fn('clipUrlProgram')(function* (
  input: ClipUrlInput,
): Effect.fn.Return<{ id: string; deduped: boolean }, ClipUrlFailure> {
  // The same table the worker re-checks on every redirect hop. Checked here
  // too, and first, so an intranet URL is refused to the reader's face in the
  // dialog rather than becoming a row that reads 'failed' a second later.
  const refusal = urlRefusal(input.url)
  if (refusal !== null) return yield* new ClipUrlRejected({ reason: refusal })

  const born = yield* birthDocumentProgram({
    // The clip is why `blobSha` is nullable (§3.1): no bytes are kept, and
    // birth skips the extract enqueue on a null sha, so `document.extract`
    // never sees a row it would only mark 'unsupported'.
    blobSha: null,
    filename: input.url,
    url: input.url,
    mime: null,
    sizeBytes: null,
    // An article is a kind the product already has, and the reader who
    // pasted a link meant one. Nothing later re-guesses it.
    kind: 'article',
    // See the module note: `url` is not a `source_class`. D1/SPA-137.
    sourceClass: 'manual',
    sourceRef: null,
    // `external_url` stays null — a clip has no provider copy.
    provenance: {},
    fileAgainst: input.fileAgainst,
    actor: input.actor,
  })

  // Outside any transaction and after the row, exactly as birth enqueues
  // extraction: a queue that is down must not undo a perfectly good row. With
  // no worker running the row stays `pending` and says so on every surface.
  //
  // Unconditional, and `deduped` is not consulted: §3.4's rule compares
  // *bytes*, and `existingFiling` answers null for a blobless birth by
  // construction, so a clip is always a fresh row. Reading `deduped` here
  // would be a branch no input can take.
  yield* query(() => enqueue(QUEUES.clipDocument, { documentId: born.id }))

  return born
})
