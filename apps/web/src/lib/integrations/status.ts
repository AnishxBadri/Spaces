import { Effect, Schema } from 'effect'
import { and, asc, eq, notLike } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'

/**
 * Plugins that need the operator, for Today's `PluginStatusSection`.
 * - Tripped: `enabled` with status `disabled` — the worker's breaker turned
 *   it off. An operator's off switch is `enabled = false` and is not listed.
 * - Never a first-party `core.*` row, which is a channel, not a plugin.
 */

export class PluginStatusFailed extends Schema.TaggedError<PluginStatusFailed>()(
  'PluginStatusFailed',
  { cause: Schema.Defect() },
) {}

/** One tripped plugin: its id and why it stopped. */
export type TrippedPlugin = {
  readonly integrationId: string
  readonly pluginId: string
  readonly lastError: string | null
}

export const trippedPluginsProgram = Effect.fn('trippedPluginsProgram')(
  function* (): Effect.fn.Return<Array<TrippedPlugin>, PluginStatusFailed> {
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            integrationId: integration.id,
            pluginId: integration.capabilityId,
            lastError: integration.lastError,
          })
          .from(integration)
          .where(
            and(
              eq(integration.enabled, true),
              eq(integration.status, 'disabled'),
              notLike(integration.capabilityId, 'core.%'),
            ),
          )
          .orderBy(asc(integration.capabilityId), asc(integration.createdAt)),
      catch: (cause) => new PluginStatusFailed({ cause }),
    })
  },
)
