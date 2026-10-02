import { Option, Schema } from 'effect'
import type { JobRunStatus } from '@spaces/db/schema/jobs'

/**
 * The `job_status` notification: what `runJob`'s ledger says on the channel
 * when it opens or closes a plugin job's `job_run` row, and what web's one
 * LISTEN client reads back. (D64)
 * - Status only, never state: a reader that missed one resyncs from
 *   `job_run`, so nothing here is the only copy of anything.
 * - `encodeJobStatus` keeps the payload under pg's 8000-byte NOTIFY limit.
 */

export const JOB_STATUS_CHANNEL = 'job_status'

export type JobStatusEvent = {
  readonly jobRunId: string
  readonly queue: string
  readonly integrationId: string | null
  readonly entityId: string | null
  readonly status: JobRunStatus
  /** ISO instant the attempt began; orders two attempts of one queue. */
  readonly startedAt: string
  readonly summary: string | null
  readonly error: string | null
}

export const JobStatusEventSchema = Schema.Struct({
  jobRunId: Schema.String,
  queue: Schema.String,
  integrationId: Schema.NullOr(Schema.String),
  entityId: Schema.NullOr(Schema.String),
  status: Schema.Literals(['running', 'succeeded', 'failed', 'skipped']),
  startedAt: Schema.String,
  summary: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(JobStatusEventSchema),
)

/** A notification's payload, or null for one that is not ours. */
export const decodeJobStatus = (payload: string): JobStatusEvent | null =>
  Option.getOrNull(decodePayload(payload))

/** pg refuses a NOTIFY payload of 8000 bytes or more. */
export const NOTIFY_LIMIT_BYTES = 8000
/** Each free-text field's share; JSON escaping can grow a character to 6 bytes. */
const TEXT_CHARS = 500

const utf8 = new TextEncoder()

const clip = (text: string | null): string | null =>
  text === null ? null : text.slice(0, TEXT_CHARS)

/** The payload, texts clipped; dropped altogether if it would still not fit. */
export const encodeJobStatus = (event: JobStatusEvent): string => {
  const clipped = JSON.stringify({
    ...event,
    summary: clip(event.summary),
    error: clip(event.error),
  })
  if (utf8.encode(clipped).length < NOTIFY_LIMIT_BYTES) return clipped
  return JSON.stringify({ ...event, summary: null, error: null })
}

/** The queues whose rows are announced: every plugin queue, no core one. */
export const announcesJobStatus = (queue: string): boolean =>
  queue.startsWith('plugin.')
