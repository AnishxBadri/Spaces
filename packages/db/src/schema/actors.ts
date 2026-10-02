import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Who *attended* to a value — never merely who caused the flow.
 * - A sync-created value is `integration`; the merge executor's rewrites
 *   are `system`.
 * - `actor_id` is a real user FK, set iff type = 'user'; `actor_ref` a real
 *   integration FK, set iff type = 'integration'. Both are constraints. (D1)
 */
export const actorType = pgEnum('actor_type', ['user', 'integration', 'system'])
