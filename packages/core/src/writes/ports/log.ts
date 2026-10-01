import { Effect, Layer } from 'effect'
import { Log } from '@spaces/sdk'
import type { LogFields } from '@spaces/sdk'
import { noScrub } from './binding'
import type { Scrub } from './binding'

/**
 * LogLive (sdk-6a): every line prefixed `[plugin:<id>]`, its fields as JSON,
 * and the whole line passed through the binding's scrub — a secret a plugin
 * logs, in the message or in a field, is written in the vault's `redact()`
 * form. The sink is the process's console by default; a test captures it.
 */
export type LogLevel = 'info' | 'warn' | 'error'
export type LogSink = (level: LogLevel, line: string) => void

export const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const formatLine = (
  pluginId: string,
  message: string,
  fields?: LogFields,
): string =>
  fields === undefined || Object.keys(fields).length === 0
    ? `[plugin:${pluginId}] ${message}`
    : `[plugin:${pluginId}] ${message} ${JSON.stringify(fields)}`

export const LogLive = (
  pluginId: string,
  options: { readonly scrub?: Scrub; readonly sink?: LogSink } = {},
): Layer.Layer<Log> => {
  const scrub = options.scrub ?? noScrub
  const sink = options.sink ?? consoleSink
  const write =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): Effect.Effect<void> =>
      Effect.sync(() => {
        sink(level, scrub(formatLine(pluginId, message, fields)))
      })
  return Layer.succeed(
    Log,
    Log.of({ info: write('info'), warn: write('warn'), error: write('error') }),
  )
}
