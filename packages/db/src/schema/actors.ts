import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Who *attended* to a value — never merely who caused the flow (spec §4,
 * grilled 2026-09). A sync-created value is `integration`, traceable to
 * whoever connected it through the integration's own config; the merge
 * executor's rewrites are `system`. Attio's typed-actor idea without its
 * polymorphic (type, id) pair: `actor_id` stays a real user FK, set iff
 * type = 'user', and `actor_ref` is a real integration FK, set iff
 * type = 'integration' (SPA-70 — the integration table exists now, so the
 * second half of the invariant is a constraint rather than a comment).
 */
export const actorType = pgEnum('actor_type', ['user', 'integration', 'system'])
