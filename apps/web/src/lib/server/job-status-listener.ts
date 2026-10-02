import { Cause, Effect, Exit, Fiber } from 'effect'
import { Client } from 'pg'
import {
  JOB_STATUS_CHANNEL,
  decodeJobStatus,
} from '@spaces/core/queue/job-status'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import { requireEnv } from './env'

/**
 * Web's one LISTEN client on `job_status`, fanning each notification out to
 * the record pages' status streams by entity. (D64)
 * - The first long-lived pg client in the web process: a dedicated
 *   `pg.Client`, never the pool, created on the first subscriber and
 *   released on shutdown. Rejected: a client per subscriber. (D64)
 * - It stays connected after the last subscriber leaves: one idle connection
 *   is cheaper than a reconnect on every navigation.
 * - A lost connection reconnects with capped backoff, and every LISTEN tells
 *   each subscriber to resync from `job_run`: what fired while down is gone.
 */

/** Its `application_name`, which names the backend in `pg_stat_activity`. */
export const LISTENER_APPLICATION_NAME = 'spaces-web-job-status'

/** The few calls the listener makes on its connection; a `pg.Client` in production. */
export type ListenConnection = {
  readonly connect: () => Promise<void>
  readonly query: (text: string) => Promise<unknown>
  readonly end: () => Promise<void>
  readonly onNotification: (
    handler: (channel: string, payload: string | undefined) => void,
  ) => void
  /** An error or the connection ending: either way it is gone. */
  readonly onLost: (handler: (error: Error) => void) => void
}

export type JobStatusSubscriber = {
  readonly entityId: string
  /** LISTEN is in place, on every (re)connect: read `job_run` now. */
  readonly onListening: () => void
  readonly onEvent: (event: JobStatusEvent) => void
  /** The listener shut down: end the stream. */
  readonly onClose: () => void
}

export type JobStatusListener = {
  /** Returns the unsubscribe. */
  readonly subscribe: (subscriber: JobStatusSubscriber) => () => void
  readonly shutdown: () => Promise<void>
}

export type JobStatusListenerOptions = {
  readonly connect: () => ListenConnection
  /** Defaults to 500ms doubling to 30s; a connection that reached LISTEN resets it. */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number }
  /** Defaults to the console. */
  readonly log?: (line: string) => void
}

const ignore = () => undefined

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A `pg.Client` as a `ListenConnection`. */
export const pgListenConnection = (
  connectionString: string,
): ListenConnection => {
  const client = new Client({
    connectionString,
    application_name: LISTENER_APPLICATION_NAME,
    keepAlive: true,
  })
  // Never without a handler: an unhandled 'error' event kills the process.
  client.on('error', ignore)
  return {
    connect: async () => {
      await client.connect()
    },
    query: (text) => client.query(text),
    end: () => client.end(),
    onNotification: (handler) =>
      client.on('notification', (message) =>
        handler(message.channel, message.payload),
      ),
    onLost: (handler) => {
      client.on('error', handler)
      client.on('end', () => handler(new Error('the connection ended')))
    },
  }
}

const open = (options: JobStatusListenerOptions) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const connection = options.connect()
      try {
        await connection.connect()
      } catch (error) {
        await connection.end().catch(ignore)
        throw error
      }
      return connection
    }),
    (connection) => Effect.promise(() => connection.end().catch(ignore)),
  )

/** One connection's life: LISTEN, deliver, and fail when the connection is lost. */
const session = (
  options: JobStatusListenerOptions,
  onListening: () => void,
  deliver: (event: JobStatusEvent) => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* open(options)
      return yield* Effect.callback<never, Error>((resume) => {
        let live = true
        const lost = (error: Error) => {
          if (!live) return
          live = false
          resume(Effect.fail(error))
        }
        connection.onNotification((channel, payload) => {
          if (!live || channel !== JOB_STATUS_CHANNEL) return
          const event = decodeJobStatus(payload ?? '')
          if (event !== null) deliver(event)
        })
        connection.onLost(lost)
        connection.query(`LISTEN ${JOB_STATUS_CHANNEL}`).then(() => {
          if (live) onListening()
        }, lost)
        return Effect.sync(() => {
          live = false
        })
      })
    }),
  )

/** A subscriber's callback must not take the others, or the listener, down. */
const safely = (run: () => void) => {
  try {
    run()
  } catch (error) {
    console.error(`[job-status] a subscriber threw — ${messageOf(error)}`)
  }
}

/** A listener that connects on its first subscriber. */
export const makeJobStatusListener = (
  options: JobStatusListenerOptions,
): JobStatusListener => {
  const initialMs = options.backoff?.initialMs ?? 500
  const maxMs = options.backoff?.maxMs ?? 30_000
  const log = options.log ?? ((line: string) => console.log(line))
  const subscribers = new Set<JobStatusSubscriber>()
  let listening = false
  let stopped = false
  let fiber: Fiber.Fiber<never> | null = null

  const onListening = () => {
    listening = true
    for (const s of [...subscribers]) safely(s.onListening)
  }
  const deliver = (event: JobStatusEvent) => {
    for (const s of [...subscribers])
      if (s.entityId === event.entityId) safely(() => s.onEvent(event))
  }

  const loop = Effect.gen(function* () {
    let failures = 0
    for (;;) {
      const exit = yield* Effect.exit(
        session(
          options,
          () => {
            failures = 0
            onListening()
          },
          deliver,
        ),
      )
      listening = false
      const reason = Exit.isFailure(exit)
        ? messageOf(Cause.squash(exit.cause))
        : 'closed'
      failures += 1
      const delay = Math.min(maxMs, initialMs * 2 ** Math.min(failures - 1, 20))
      log(
        `[job-status] ${JOB_STATUS_CHANNEL} listener lost (${reason}); reconnecting in ${String(delay)}ms`,
      )
      yield* Effect.sleep(delay)
    }
  })

  return {
    subscribe: (subscriber) => {
      if (stopped) {
        queueMicrotask(() => safely(subscriber.onClose))
        return ignore
      }
      subscribers.add(subscriber)
      if (fiber === null) fiber = Effect.runFork(loop)
      else if (listening)
        queueMicrotask(() => {
          if (subscribers.has(subscriber)) safely(subscriber.onListening)
        })
      return () => {
        subscribers.delete(subscriber)
      }
    },
    shutdown: async () => {
      stopped = true
      listening = false
      const running = fiber
      fiber = null
      if (running !== null) await Effect.runPromise(Fiber.interrupt(running))
      const closing = [...subscribers]
      subscribers.clear()
      for (const s of closing) safely(s.onClose)
    },
  }
}

let shared: JobStatusListener | null = null

/**
 * The process's listener, made on first use and shut down on SIGTERM or
 * SIGINT, so open status streams end and nitro's graceful close is not held.
 * A signal nobody else handles is raised again once released.
 */
export const jobStatusListener = (): JobStatusListener => {
  if (shared !== null) return shared
  const connectionString = requireEnv('DATABASE_URL')
  const listener = makeJobStatusListener({
    connect: () => pgListenConnection(connectionString),
  })
  shared = listener
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void listener.shutdown()
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    })
  }
  return listener
}
