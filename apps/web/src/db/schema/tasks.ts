import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { user } from './auth'
import { entity } from './entities'

/**
 * Tasks (CONTEXT.md 15b, 2026-08-07): the resurrection machinery for
 * Parked deals plus diligence chores. A plain table, deliberately not an
 * entity kind — tasks need no backlinks, search, or mentions payload.
 * due_date is nullable: a dateless task is legal, forced deadlines create
 * fake urgency.
 */
export const task = pgTable(
  'task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    content: text('content').notNull(),
    dueDate: date('due_date'),
    assigneeId: text('assignee_id')
      .notNull()
      .references(() => user.id),
    doneAt: timestamp('done_at', { withTimezone: true }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('task_assignee_open_idx')
      .on(t.assigneeId, t.dueDate)
      .where(sql`${t.doneAt} is null`),
  ],
)

/** Linked records — the task shows on each entity's rail. */
export const taskEntity = pgTable(
  'task_entity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
  },
  (t) => [
    uniqueIndex('task_entity_unique').on(t.taskId, t.entityId),
    index('task_entity_entity_idx').on(t.entityId),
  ],
)
