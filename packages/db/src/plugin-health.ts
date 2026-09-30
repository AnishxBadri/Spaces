import { and, eq, notLike } from 'drizzle-orm'
import { db } from './index.ts'
import { integration } from './schema/integrations.ts'

/**
 * The degraded plugins, as `/api/health` lists them (sdk-11; spec §10 "boot
 * reconciliation"). Read from `integration` rows the worker's loader wrote,
 * never from `/data`, so the web process answers it in a split-role
 * deployment too.
 *
 * A degraded plugin is not an unhealthy box: the route reports the list and
 * keeps its status and HTTP code on the database alone. Like the heartbeat
 * reads beside it, this returns a value on every path — an unreachable
 * database is the route's `db` field to report, not a throw here.
 *
 * `core.*` rows are first-party channels (the mailbox's `core.mailbox`), not
 * plugins; the loader never touches them and this never lists them.
 */
export interface DegradedPlugin {
  readonly id: string
  readonly version: string
  readonly reason: string
}

export async function readDegradedPlugins(): Promise<Array<DegradedPlugin>> {
  try {
    const rows = await db
      .select({
        id: integration.capabilityId,
        version: integration.version,
        reason: integration.lastError,
      })
      .from(integration)
      .where(
        and(
          eq(integration.enabled, true),
          eq(integration.status, 'degraded'),
          notLike(integration.capabilityId, 'core.%'),
        ),
      )
      .orderBy(integration.capabilityId)
    return rows.map((r) => ({ ...r, reason: r.reason ?? 'degraded' }))
  } catch {
    return []
  }
}
