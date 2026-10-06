import { and, eq, notLike } from 'drizzle-orm'
import { integration } from '@spaces/db/schema'

/**
 * An integration whose jobs may be sent: enabled, status `enabled`, and not
 * a first-party `core.*` channel. A degraded, operator-disabled or
 * breaker-tripped row is offered nowhere.
 */
export const runnable = and(
  eq(integration.enabled, true),
  eq(integration.status, 'enabled'),
  notLike(integration.capabilityId, 'core.%'),
)
