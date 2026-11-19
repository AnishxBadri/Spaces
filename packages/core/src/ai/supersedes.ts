import { DOCUMENT_KINDS } from '../documents'
import type { DocumentKind } from '../documents'
import { object, oneOf, readFirst, text } from './decode'

/**
 * The `suggestion(kind: 'supersedes')` payload: a document filed on a record
 * that looks like a newer version of one the record already holds.
 * - Decoded by `proposeWith` on insert, by the accept path before it writes
 *   the link, and by the Review card.
 * - The names are as filed when proposed; the ids are what accept writes.
 */

export const supersedesPayloadSchema = object(
  {
    newerId: text({ format: 'uuid' }),
    olderId: text({ format: 'uuid' }),
    newerName: text({ min: 1 }),
    olderName: text({ min: 1 }),
    documentKind: oneOf(DOCUMENT_KINDS),
  },
  {
    strict: true,
    rule: {
      holds: (p) => p.newerId !== p.olderId,
      words: 'a document is never a newer version of itself',
    },
  },
)

export type SupersedesPayload = {
  newerId: string
  olderId: string
  newerName: string
  olderName: string
  documentKind: DocumentKind
}

/** A stored payload read as a supersedes proposal, or null when it is not one. */
export function readSupersedesPayload(raw: unknown): SupersedesPayload | null {
  const parsed = readFirst(supersedesPayloadSchema, raw)
  return parsed.success ? parsed.data : null
}
