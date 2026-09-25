import { z } from 'zod'

/**
 * The `suggestion(kind: 'space_tag')` payload (SPA-103): one space a record
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
export const spaceTagPayloadSchema = z
  .object({
    spaceId: z.string().uuid(),
    label: z.string().trim().min(1).max(1000),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()

/**
 * Spelled out rather than `z.infer`: an absent key is absent, so the payload
 * is JSON by type.
 */
export type SpaceTagPayload = {
  spaceId: string
  label: string
  confidence?: number
}

/** A stored payload read as a space tag, or null when it is not one. */
export function readSpaceTagPayload(raw: unknown): SpaceTagPayload | null {
  const parsed = spaceTagPayloadSchema.safeParse(raw)
  if (!parsed.success) return null
  const { spaceId, label, confidence } = parsed.data
  return confidence === undefined
    ? { spaceId, label }
    : { spaceId, label, confidence }
}
