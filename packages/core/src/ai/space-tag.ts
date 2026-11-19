import { Schema } from 'effect'
import { number, object, readFirst, text } from './decode'

/**
 * The `suggestion(kind: 'space_tag')` payload: one space a record
 * may belong in, as the classify lane read it off the live space tree.
 * Accepting writes `entity_space(source: 'ai', confidence)` for the record
 * and this space, by the accepter.
 *
 * `label` is the space's path as the tree named it when the suggestion was
 * made ("Energy / Storage / Grid batteries") — what the inbox card shows. It
 * is display only: the accept reads `spaceId`, and refuses a space that has
 * gone since.
 *
 * One decoder, three readers, as the identity and document-kind payloads:
 * `proposeProgram` holds a new row to it, the accept path reads it back
 * before tagging, and the inbox card draws it.
 */
export const spaceTagPayloadSchema = object(
  {
    spaceId: text({ format: 'uuid' }),
    label: text({ trim: true, min: 1, max: 1000 }),
    confidence: Schema.optional(number({ min: 0, max: 1 })),
  },
  { strict: true },
)

/**
 * Spelled out rather than the schema's type: an absent key is absent, so
 * the payload is JSON by type.
 */
export type SpaceTagPayload = {
  spaceId: string
  label: string
  confidence?: number
}

/** A stored payload read as a space tag, or null when it is not one. */
export function readSpaceTagPayload(raw: unknown): SpaceTagPayload | null {
  const parsed = readFirst(spaceTagPayloadSchema, raw)
  if (!parsed.success) return null
  const { spaceId, label, confidence } = parsed.data
  return confidence === undefined
    ? { spaceId, label }
    : { spaceId, label, confidence }
}
