import { Cause, Effect, Exit } from 'effect'
import { Client } from 'pg'
import type { Notification } from 'pg'
import { messageOf } from './loader'

/**
 * The worker's `LISTEN plugin_changed` connection: a dedicated `pg.Client`,
 * never the pool, whose notifications ask for a plugin reload.
 *
 * - `pg_notify('plugin_changed', '<plugin id>')` is the contract; an empty
 *   payload means every plugin.
 * - A lost connection reconnects with capped exponential backoff, and every
 *   LISTEN, the first included, is followed by `onListening`: a notification
 *   missed while down must not leave the worker's view stale.
 */

export const PLUGIN_CHANGED = 'plugin_changed'

/** The listener's `application_name`, which names its backend in `pg_stat_activity`. */
export const LISTENER_APPLICATION_NAME = 'spaces-plugin-listener'

export type PluginListenerOptions = {
  readonly connectionString: string
  /** A plugin id, or null for an empty payload. */
  readonly onChange: (pluginId: string | null) => void
  /** Once LISTEN is in place, on every connect. */
  readonly onListening: () => void
  /** Defaults to 500ms doubling to 30s; a connection that reached LISTEN resets it. */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number }
  /** Defaults to the console. */
  readonly log?: (line: string) => void
}

const ignore = () => undefined

const connect = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const client = new Client({
        connectionString,
        application_name: LISTENER_APPLICATION_NAME,
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
const session = (options: PluginListenerOptions, onListening: () => void) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(options.connectionString)
      return yield* Effect.callback<never, Error>((resume) => {
        let lost = false
        const onError = (error: Error) => {
          if (lost) return
          lost = true
          resume(Effect.fail(error))
        }
        const onEnd = () => onError(new Error('the connection ended'))
        const onNotification = (message: Notification) => {
          if (message.channel !== PLUGIN_CHANGED) return
          const payload = message.payload?.trim() ?? ''
          options.onChange(payload === '' ? null : payload)
        }
        client.on('notification', onNotification)
        client.on('error', onError)
        client.on('end', onEnd)
        client.query(`LISTEN ${PLUGIN_CHANGED}`).then(onListening, onError)
        return Effect.sync(() => {
          client.off('notification', onNotification)
          client.off('error', onError)
          client.off('end', onEnd)
        })
      })
    }),
  )

/** Listens until interrupted, reconnecting for as long as it takes. */
export const listenPluginChanged = (
  options: PluginListenerOptions,
): Effect.Effect<never> => {
  const initialMs = options.backoff?.initialMs ?? 500
  const maxMs = options.backoff?.maxMs ?? 30_000
  const log = options.log ?? ((line: string) => console.log(line))
  return Effect.gen(function* () {
    let failures = 0
    const onListening = () => {
      failures = 0
      log(`[plugins] listening on ${PLUGIN_CHANGED}`)
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
        `[plugins] ${PLUGIN_CHANGED} listener lost (${reason}); reconnecting in ${String(delay)}ms`,
      )
      yield* Effect.sleep(delay)
    }
  })
}
