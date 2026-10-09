import { Readable } from 'node:stream'
import { Effect } from 'effect'
import { JobRetryable } from '@spaces/sdk'
import type { JobError } from '@spaces/sdk'
import { PICTURE_MAX_BYTES, judgePicture } from '../../enrichment/picture'
import type { PictureAnswer, PictureRefusal } from '../../enrichment/picture'
import { WebsiteReader } from '../../enrichment/website'
import { putBlobProgram } from '../documents/intake'

/**
 * A picture answer fetched once and stored as a blob (D76): through the URL
 * guard under `PICTURE_MAX_BYTES`, raster images only.
 * - A new blob carries its `pending_blob` row until `applyRun` sets the
 *   picture; one that never lands is the orphan sweep's.
 * - A refusal stores nothing and says why, for the run's line.
 */

export type PictureFetched =
  | (PictureAnswer & { readonly outcome: 'stored'; readonly sha: string })
  | (PictureAnswer & {
      readonly outcome: 'refused'
      readonly why: PictureRefusal
      readonly reason: string
    })

export const fetchPicture = Effect.fn('fetchPicture')(function* (
  answer: PictureAnswer,
): Effect.fn.Return<PictureFetched, JobError, WebsiteReader> {
  const refused = (why: PictureRefusal, reason: string): PictureFetched => ({
    ...answer,
    outcome: 'refused',
    why,
    reason,
  })
  const fetched = yield* (yield* WebsiteReader).fetch(answer.url, {
    maxBytes: PICTURE_MAX_BYTES,
  })
  if (!fetched.ok)
    return refused(
      fetched.tooLarge === true ? 'too large' : 'unreachable',
      fetched.reason,
    )
  const judged = judgePicture(fetched.contentType, fetched.bytes)
  if (!judged.ok)
    return refused(
      judged.why,
      `${fetched.url} answered ${fetched.contentType ?? 'no type'}`,
    )
  const { sha } = yield* putBlobProgram({
    stream: Readable.from(Buffer.from(fetched.bytes)),
    mime: judged.type,
    preparedBy: null,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new JobRetryable({
          reason: `picture: could not store ${answer.url} (${cause._tag})`,
        }),
    ),
  )
  const stored: PictureFetched = { ...answer, outcome: 'stored', sha }
  return stored
})
