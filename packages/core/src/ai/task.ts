import { Schema } from 'effect'
import { nullable, object, readFirst, text } from './decode'

/**
 * The `suggestion(kind: 'task')` payload: an action item, from a recorder's
 * note or from Ask, not yet a task. Accepting writes one `task` row through
 * the task writer — the accepter creates it, and it is assigned to
 * `assignee_id`, else the accepter — linked to `entity_id`.
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
    /**
     * Whose task it becomes: a write-up's author, or the member whose
     * recorder filed it. Older rows carry none and go to the accepter.
     */
    assignee_id: Schema.optional(text({ min: 1, max: 200 })),
  },
  { strict: true },
)

/** Spelled out: an absent assignee is absent, never an `undefined` value. */
export type TaskPayload = {
  title: string
  due: string | null
  entity_id: string
  assignee_id?: string
}

/** The decoded fields as the payload type, dropping an undefined assignee. */
export function taskPayloadOf(decoded: {
  title: string
  due: string | null
  entity_id: string
  assignee_id?: string | undefined
}): TaskPayload {
  const { assignee_id, ...rest } = decoded
  return assignee_id === undefined ? rest : { ...rest, assignee_id }
}

/** A stored payload read as a task, or null when it is not one. */
export function readTaskPayload(raw: unknown): TaskPayload | null {
  const parsed = readFirst(taskPayloadSchema, raw)
  return parsed.success ? taskPayloadOf(parsed.data) : null
}
