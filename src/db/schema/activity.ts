import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { entity } from './entities'
import { user } from './auth'

/**
 * One denormalized activity stream written by every producer: stage change,
 * note added, document filed, evidence attached, tag applied, merge.
 * Timeline reads dominate writes — never UNION five tables at query time.
 * verb is an open set (text, not enum) so new producers don't need a
 * migration.
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: text('actor_id').references(() => user.id),
    verb: text('verb').notNull(),
    subjectEntityId: uuid('subject_entity_id')
      .notNull()
      .references(() => entity.id),
    objectEntityId: uuid('object_entity_id').references(() => entity.id),
    meta: jsonb('meta').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('activity_subject_idx').on(t.subjectEntityId, t.at),
    index('activity_at_idx').on(t.at),
  ],
)
