import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { pendingBlob } from '@spaces/db/schema'
import { storage } from '../storage'

/**
 * **The first half of an upload** — hands out a URL, and decides whether
 * these bytes need watching.
 * - Upload is two calls around a direct-to-storage PUT, so a 200MB deck never
 *   streams through Node. A tab closed between PUT and finalize leaves bytes
 *   no `document` row names, so this writes the `pending_blob` row.
 * - Never in apps/web's server modules: the server-fns barrel ships their
 *   plain exports to the browser. `prepareDocumentUpload` is `requireUser()`
 *   plus this.
 */

export type PrepareBlobUploadInput = {
  /** sha256 hex of the file the client is about to send. */
  sha: string
  sizeBytes: number
  /** Who asked; null for a lane that prepares as an integration. */
  preparedBy: string | null
}

export type PrepareBlobUploadResult = {
  /** Null when the store already holds these bytes — nothing to send. */
  uploadUrl: string | null
  /** Sent verbatim with the PUT; the S3 driver signs a checksum into them. */
  uploadHeaders: Record<string, string>
  alreadyStored: boolean
}

export class PrepareBlobUploadFailed extends Schema.TaggedError<PrepareBlobUploadFailed>()(
  'PrepareBlobUploadFailed',
  { cause: Schema.Defect() },
) {}

/** The sentence the client is shown; a tagged error carries no `message`. */
export function prepareBlobUploadMessage(_failure: unknown): string {
  return 'Could not start this upload'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PrepareBlobUploadFailed({ cause }),
  })

export const prepareBlobUploadProgram = Effect.fn('prepareBlobUpload')(
  function* (
    input: PrepareBlobUploadInput,
  ): Effect.fn.Return<PrepareBlobUploadResult, PrepareBlobUploadFailed> {
    const store = storage()

    // Content-addressed: the same deck sent to both partners is one blob.
    // Already stored ⇒ skip the transfer entirely, and write **no** pending
    // row. These bytes are not in flight; they are bytes the
    // workspace already holds, either named by a document row or already
    // tracked by an earlier pending row with its own clock. A row written on
    // this branch would put a known deck's blob on the sweep's list every
    // time someone re-uploaded it, which is the one way this mechanism could
    // delete something that matters.
    if (yield* query(() => store.exists(input.sha)))
      return { uploadUrl: null, uploadHeaders: {}, alreadyStored: true }

    const { url, headers } = yield* query(() =>
      store.getUploadUrl(input.sha, 600),
    )

    // The intent row. Written before the URL is handed back, so there is no
    // ordering in which the client can PUT bytes this table has not heard of.
    //
    // `onConflictDoUpdate` rather than `doNothing` because the clock is the
    // whole point: a second prepare for the same digest is an upload starting
    // again, and it deserves a full grace period rather than inheriting the
    // remains of an abandoned attempt's.
    yield* query(() =>
      db
        .insert(pendingBlob)
        .values({
          sha: input.sha,
          sizeBytes: input.sizeBytes,
          preparedBy: input.preparedBy,
        })
        .onConflictDoUpdate({
          target: pendingBlob.sha,
          set: {
            sizeBytes: input.sizeBytes,
            preparedBy: input.preparedBy,
            preparedAt: new Date(),
          },
        }),
    )

    return { uploadUrl: url, uploadHeaders: headers, alreadyStored: false }
  },
)
