import { z } from 'zod'

/**
 * The `suggestion(kind: 'task')` payload: an action item, from a recorder's
 * note or from Ask, not yet a task. Accepting writes one `task` row through
 * the task writer — the accepter creates it and is its assignee — linked to
 * `entity_id`. (D68)
 *
 * One decoder, two readers: `proposeProgram` holds a new row to it and the
 * accept path reads it back.
 */
export const taskPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    /** `YYYY-MM-DD`, or null: a dateless task is legal. */
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
      .nullable(),
    /** The record the task is about. */
    entity_id: z.string().uuid(),
  })
  .strict()

export type TaskPayload = {
  title: string
  due: string | null
  entity_id: string
}
