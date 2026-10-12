import { z } from 'zod'
import { DOCUMENT_KINDS } from '../documents'
import type { DocumentKind } from '../documents'

/**
 * The `suggestion(kind: 'supersedes')` payload: a document filed on a record
 * that looks like a newer version of one the record already holds. (D59)
 * - Decoded by `proposeWith` on insert, by the accept path before it writes
 *   the link, and by the Review card.
 * - The names are as filed when proposed; the ids are what accept writes.
 */

export const supersedesPayloadSchema = z
  .object({
    newerId: z.string().uuid(),
    olderId: z.string().uuid(),
    newerName: z.string().min(1),
    olderName: z.string().min(1),
    documentKind: z.enum(DOCUMENT_KINDS),
  })
  .strict()
  .refine((p) => p.newerId !== p.olderId, {
    message: 'a document is never a newer version of itself',
  })

export type SupersedesPayload = {
  newerId: string
  olderId: string
  newerName: string
  olderName: string
  documentKind: DocumentKind
}

/** A stored payload read as a supersedes proposal, or null when it is not one. */
export function readSupersedesPayload(raw: unknown): SupersedesPayload | null {
  const parsed = supersedesPayloadSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
