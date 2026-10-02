import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  like,
  notLike,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration, jobRun } from '@spaces/db/schema'
import { CAP_REFUSAL_PREFIX } from '@spaces/core/plugins/credit'

/**
 * Plugins that are switched on and not running, or refusing work at their
 * credit cap, for Today's and Review's `PluginStatusSection` — the
 * explanation for an action missing from a record head, or one that did
 * nothing. (D53, D63)
 * - Tripped: `enabled` with status `disabled`, the worker's breaker. Degraded:
 *   `enabled` with status `degraded`, the loader could not run it.
 * - Capped: a running plugin with cap refusals since UTC midnight, when its
 *   spend resets. A cache skip is also `skipped` and is never listed.
 * - An operator's off switch is `enabled = false` and is not listed.
 * - Never a first-party `core.*` row, which is a channel, not a plugin.
 */

export class PluginStatusFailed extends Schema.TaggedError<PluginStatusFailed>()(
  'PluginStatusFailed',
  { cause: Schema.Defect() },
) {}

/** One plugin that needs looking at: its id, its state, and why. */
export type StoppedPlugin =
  | {
      readonly integrationId: string
      readonly pluginId: string
      readonly state: 'tripped' | 'degraded'
      readonly lastError: string | null
    }
  | {
      readonly integrationId: string
      readonly pluginId: string
      readonly state: 'capped'
      /** The latest refusal, naming the cap: `daily credit cap (2) reached`. */
      readonly reason: string
      /** Jobs refused since UTC midnight. */
      readonly refused: number
    }

const utcMidnight = sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`

export const stoppedPluginsProgram = Effect.fn('stoppedPluginsProgram')(
  function* (): Effect.fn.Return<Array<StoppedPlugin>, PluginStatusFailed> {
    const stopped = yield* Effect.tryPromise({
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
    const capped = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            integrationId: integration.id,
            pluginId: integration.capabilityId,
            reason: sql<string>`(array_agg(${jobRun.summary} order by ${jobRun.finishedAt} desc))[1]`,
            refused: count(),
          })
          .from(jobRun)
          .innerJoin(integration, eq(integration.id, jobRun.integrationId))
          .where(
            and(
              eq(jobRun.status, 'skipped'),
              like(jobRun.summary, `${CAP_REFUSAL_PREFIX}%`),
              gte(jobRun.finishedAt, utcMidnight),
              eq(integration.enabled, true),
              eq(integration.status, 'enabled'),
              notLike(integration.capabilityId, 'core.%'),
            ),
          )
          .groupBy(integration.id)
          .orderBy(asc(integration.capabilityId), asc(integration.createdAt)),
      catch: (cause) => new PluginStatusFailed({ cause }),
    })
    return [
      ...stopped.map(({ status, ...row }): StoppedPlugin => ({
        ...row,
        state: status === 'degraded' ? 'degraded' : 'tripped',
      })),
      ...capped.map((row): StoppedPlugin => ({ ...row, state: 'capped' })),
    ]
  },
)
