import { Effect, Schema } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'
import {
  DocumentBirthRejected,
  birthDocumentProgram,
} from '@spaces/core/writes/documents/birth'
import { webEnqueue } from '#/lib/enqueue-live'
import { enqueue } from '#/lib/queue'
import { urlRefusal } from './fetch-guard'
import type {
  DocumentActor,
  DocumentBirthFailure,
} from '@spaces/core/writes/documents/birth'
import type { DocumentFilingTarget } from '#/lib/server/shared'

/**
 * **The URL clip**: the one arrival with no bytes. A saved article is a
 * `document` row (there is no `source` table); `document.url`, set only here,
 * is what marks it a clip.
 * - Row first, fetch later: validate, birth the row `pending`, enqueue
 *   `document.clip`. With the worker down the row simply stays pending.
 * - `source_class` is `manual` (`url` is not a member); `source_ref` and
 *   `external_url` stay null, since the clip has no provider copy.
 * - Outside the server-fn modules, whose plain exports ship to the browser.
 */

export type ClipUrlInput = {
  /** What the reader pasted. Validated here, never trusted. */
  url: string
  /** Zero, one or N places — birth's array, unchanged. */
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
 * the instant it appears, and its address is all that is known yet. The clip
 * job overwrites it with the article's title once readability has one.
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
    // The clip is why `blobSha` is nullable: no bytes are kept, and
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
    // See the module note: `url` is not a `source_class`.
    sourceClass: 'manual',
    sourceRef: null,
    // `external_url` stays null — a clip has no provider copy.
    provenance: {},
    fileAgainst: input.fileAgainst,
    actor: input.actor,
  }).pipe(Effect.provide(webEnqueue))

  // Outside any transaction and after the row, exactly as birth enqueues
  // extraction: a queue that is down must not undo a perfectly good row. With
  // no worker running the row stays `pending` and says so on every surface.
  //
  // Unconditional, and `deduped` is not consulted: dedupe compares
  // *bytes*, and `existingFiling` answers null for a blobless birth by
  // construction, so a clip is always a fresh row. Reading `deduped` here
  // would be a branch no input can take.
  yield* query(() => enqueue(QUEUES.clipDocument, { documentId: born.id }))

  return born
})
