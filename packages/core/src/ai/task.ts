import { nullable, object, readFirst, text } from './decode'

/**
 * The `suggestion(kind: 'task')` payload: an action item, from a recorder's
 * note or from Ask, not yet a task. Accepting writes one `task` row through
 * the task writer — the accepter creates it and is its assignee — linked to
 * `entity_id`.
 *
 * One decoder, two readers: `proposeProgram` holds a new row to it and the
 * accept path reads it back.
 */
export const taskPayloadSchema = object(
  {
    title: text({ trim: true, min: 1, max: 500 }),
    /** `YYYY-MM-DD`, or null: a dateless task is legal. */
    due: nullable(
      text({
        format: {
          pattern: /^\d{4}-\d{2}-\d{2}$/,
          message: 'Expected YYYY-MM-DD',
        },
      }),
    ),
    /** The record the task is about. */
    entity_id: text({ format: 'uuid' }),
  },
  { strict: true },
)

export type TaskPayload = {
  title: string
  due: string | null
  entity_id: string
}

/** A stored payload read as a task, or null when it is not one. */
export function readTaskPayload(raw: unknown): TaskPayload | null {
  const parsed = readFirst(taskPayloadSchema, raw)
  return parsed.success ? parsed.data : null
}
