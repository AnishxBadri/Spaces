import { Effect } from 'effect'
import { z } from 'zod'
import { BEAT_EVERY_MS } from '@spaces/db/heartbeat'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import { auth } from '#/lib/auth'
import { jobStatusSnapshotProgram, recordReadableProgram } from './job-status'
import type { JobStatusRow } from './job-status'
import { jobStatusListener } from '#/lib/server/job-status-listener'
import type { JobStatusListener } from '#/lib/server/job-status-listener'

/**
 * A record's plugin job status as server-sent events. (D64)
 * - `init` carries the latest `job_run` row per plugin queue, on open and on
 *   every resync; `status` carries one live notification. A client replaces
 *   its state on `init` and applies `status` on top.
 * - Live events heard before an `init` is written follow it, so a snapshot
 *   read just before a close cannot hide that close.
 * - While a row reads `running` the stream re-reads `job_run` every beat, so
 *   a run whose worker died settles without a notification; otherwise it
 *   sends a keepalive comment.
 */

export type JobStatusInit = { readonly rows: ReadonlyArray<JobStatusRow> }

export type JobStatusStreamDeps = {
  readonly listener: Pick<JobStatusListener, 'subscribe'>
  readonly snapshot: (entityId: string) => Promise<ReadonlyArray<JobStatusRow>>
  /** Defaults to the worker's beat interval. */
  readonly resyncMs?: number
}

/** How long a dropped `EventSource` waits before it reconnects. */
const RETRY_MS = 2000

const frame = (
  event: 'init' | 'status',
  data: JobStatusInit | JobStatusEvent,
) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** The event stream for one record; ends on `signal` or listener shutdown. */
export function jobStatusStream(
  entityId: string,
  deps: JobStatusStreamDeps,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let close: () => void = () => undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let synced = false
      let running = false
      let generation = 0
      let held: Array<JobStatusEvent> = []
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text))
      }
      const sync = async () => {
        const mine = ++generation
        synced = false
        try {
          const rows = await deps.snapshot(entityId)
          if (mine !== generation || closed) return
          running = rows.some((r) => r.status === 'running')
          send(frame('init', { rows }))
          synced = true
          for (const event of held) send(frame('status', event))
          held = []
        } catch (error) {
          // The client reconnects and resyncs; a stream with no `init` is no use.
          console.error('[job-status] could not read job_run', error)
          close()
        }
      }
      const unsubscribe = deps.listener.subscribe({
        entityId,
        onListening: () => void sync(),
        onEvent: (event) => {
          if (event.status === 'running') running = true
          if (synced) send(frame('status', event))
          else held.push(event)
        },
        onClose: () => close(),
      })
      const timer = setInterval(() => {
        if (running) void sync()
        else send(': keepalive\n\n')
      }, deps.resyncMs ?? BEAT_EVERY_MS)
      close = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        unsubscribe()
        signal.removeEventListener('abort', close)
        try {
          controller.close()
        } catch {
          // Already cancelled by the reader.
        }
      }
      signal.addEventListener('abort', close)
      send(`retry: ${String(RETRY_MS)}\n\n`)
      if (signal.aborted) close()
    },
    cancel() {
      close()
    },
  })
}

const entityIdSchema = z.uuid()

/**
 * `/api/job-status/$entityId`: the viewer's session, then the record as the
 * record page would load it for them, then the stream. Nothing is streamed
 * for a record the viewer could not open.
 */
export const jobStatusResponseProgram = Effect.fn('jobStatusResponseProgram')(
  function* (request: Request, entityId: string) {
    const session = yield* Effect.tryPromise(() =>
      auth.api.getSession({ headers: request.headers }),
    )
    if (!session) return new Response('Unauthorized', { status: 401 })
    if (!entityIdSchema.safeParse(entityId).success)
      return new Response('Forbidden', { status: 403 })
    const readable = yield* recordReadableProgram(session.user, entityId)
    if (!readable) return new Response('Forbidden', { status: 403 })
    const listener = yield* Effect.try(() => jobStatusListener())
    const stream = jobStatusStream(
      entityId,
      {
        listener,
        snapshot: (id) => Effect.runPromise(jobStatusSnapshotProgram(id)),
      },
      request.signal,
    )
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  },
  Effect.catch(() =>
    Effect.succeed(new Response('Unavailable', { status: 503 })),
  ),
)

/** The route's whole body. */
export const handleJobStatusRequest = (
  request: Request,
  entityId: string,
): Promise<Response> =>
  Effect.runPromise(jobStatusResponseProgram(request, entityId))
