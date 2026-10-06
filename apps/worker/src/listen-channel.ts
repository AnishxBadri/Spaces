import { Cause, Effect, Exit } from 'effect'
import { Client } from 'pg'
import type { Notification } from 'pg'

/**
 * One `LISTEN <channel>` connection that outlives a lost connection: a
 * dedicated `pg.Client`, never the pool.
 * - A lost connection reconnects with capped exponential backoff, and every
 *   LISTEN, the first included, is followed by `onListening`: a notification
 *   missed while down is gone, so the caller resyncs.
 * - `label` prefixes the log lines: `[label] listening on <channel>`.
 */

export type ChannelListenerOptions = {
  readonly connectionString: string
  readonly channel: string
  /** Names the backend in `pg_stat_activity`. */
  readonly applicationName: string
  readonly label: string
  /** The payload, trimmed; empty when none was sent. */
  readonly onPayload: (payload: string) => void
  /** Once LISTEN is in place, on every connect. */
  readonly onListening: () => void
  /** Defaults to 500ms doubling to 30s; a connection that reached LISTEN resets it. */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number }
  /** Defaults to the console. */
  readonly log?: (line: string) => void
}

const ignore = () => undefined

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const connect = (options: ChannelListenerOptions) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const client = new Client({
        connectionString: options.connectionString,
        application_name: options.applicationName,
        keepAlive: true,
      })
      // Never without a handler: an unhandled 'error' event kills the process.
      client.on('error', ignore)
      try {
        await client.connect()
      } catch (error) {
        await client.end().catch(ignore)
        throw error
      }
      return client
    }),
    (client) => Effect.promise(() => client.end().catch(ignore)),
  )

/** One connection's life: LISTEN, deliver, and fail when the connection is lost. */
const session = (options: ChannelListenerOptions, onListening: () => void) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(options)
      return yield* Effect.callback<never, Error>((resume) => {
        let lost = false
        const onError = (error: Error) => {
          if (lost) return
          lost = true
          resume(Effect.fail(error))
        }
        const onEnd = () => onError(new Error('the connection ended'))
        const onNotification = (message: Notification) => {
          if (message.channel !== options.channel) return
          options.onPayload(message.payload?.trim() ?? '')
        }
        client.on('notification', onNotification)
        client.on('error', onError)
        client.on('end', onEnd)
        client.query(`LISTEN ${options.channel}`).then(onListening, onError)
        return Effect.sync(() => {
          client.off('notification', onNotification)
          client.off('error', onError)
          client.off('end', onEnd)
        })
      })
    }),
  )

/** Listens until interrupted, reconnecting for as long as it takes. */
export const listenChannel = (
  options: ChannelListenerOptions,
): Effect.Effect<never> => {
  const initialMs = options.backoff?.initialMs ?? 500
  const maxMs = options.backoff?.maxMs ?? 30_000
  const log = options.log ?? ((line: string) => console.log(line))
  return Effect.gen(function* () {
    let failures = 0
    const onListening = () => {
      failures = 0
      log(`[${options.label}] listening on ${options.channel}`)
      options.onListening()
    }
    for (;;) {
      const exit = yield* Effect.exit(session(options, onListening))
      const reason = Exit.isFailure(exit)
        ? messageOf(Cause.squash(exit.cause))
        : 'closed'
      failures += 1
      const delay = Math.min(maxMs, initialMs * 2 ** Math.min(failures - 1, 20))
      log(
        `[${options.label}] ${options.channel} listener lost (${reason}); reconnecting in ${String(delay)}ms`,
      )
      yield* Effect.sleep(delay)
    }
  })
}
