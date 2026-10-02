import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, notLike } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'

/**
 * Plugins that are switched on and not running, for Today's and Review's
 * `PluginStatusSection` — the explanation for an action missing from a
 * record head. (D63)
 * - Tripped: `enabled` with status `disabled`, the worker's breaker. Degraded:
 *   `enabled` with status `degraded`, the loader could not run it.
 * - An operator's off switch is `enabled = false` and is not listed.
 * - Never a first-party `core.*` row, which is a channel, not a plugin.
 */

export class PluginStatusFailed extends Schema.TaggedError<PluginStatusFailed>()(
  'PluginStatusFailed',
  { cause: Schema.Defect() },
) {}

/** One stopped plugin: its id, how it stopped, and why. */
export type StoppedPlugin = {
  readonly integrationId: string
  readonly pluginId: string
  readonly state: 'tripped' | 'degraded'
  readonly lastError: string | null
}

export const stoppedPluginsProgram = Effect.fn('stoppedPluginsProgram')(
  function* (): Effect.fn.Return<Array<StoppedPlugin>, PluginStatusFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            integrationId: integration.id,
            pluginId: integration.capabilityId,
            status: integration.status,
            lastError: integration.lastError,
          })
          .from(integration)
          .where(
            and(
              eq(integration.enabled, true),
              inArray(integration.status, ['disabled', 'degraded']),
              notLike(integration.capabilityId, 'core.%'),
            ),
          )
          .orderBy(asc(integration.capabilityId), asc(integration.createdAt)),
      catch: (cause) => new PluginStatusFailed({ cause }),
    })
    return rows.map(({ status, ...row }): StoppedPlugin => ({
      ...row,
      state: status === 'degraded' ? 'degraded' : 'tripped',
    }))
  },
)
