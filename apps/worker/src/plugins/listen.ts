import type { Effect } from 'effect'
import { listenChannel } from '../listen-channel'

/**
 * The worker's `LISTEN plugin_changed` connection, whose notifications ask
 * for a plugin reload (`listenChannel` does the connection's life).
 *
 * - `pg_notify('plugin_changed', '<plugin id>')` is the contract; an empty
 *   payload means every plugin.
 * - Every LISTEN, the first included, is followed by `onListening`: a
 *   notification missed while down must not leave the worker's view stale.
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

/** Listens until interrupted, reconnecting for as long as it takes. */
export const listenPluginChanged = (
  options: PluginListenerOptions,
): Effect.Effect<never> =>
  listenChannel({
    connectionString: options.connectionString,
    channel: PLUGIN_CHANGED,
    applicationName: LISTENER_APPLICATION_NAME,
    label: 'plugins',
    onPayload: (payload) => options.onChange(payload === '' ? null : payload),
    onListening: options.onListening,
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
