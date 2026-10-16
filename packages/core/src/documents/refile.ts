import { z } from 'zod'

/**
 * The `suggestion(kind: 'refile_document')` payload: a document a storage
 * source brought whose folder now resolves to another record (§5.6, §8).
 * - Decoded by `proposeWith` on insert, by the accept path before it moves
 *   the edge, and by the Review card.
 * - The ids are what accept writes; the names are as filed when proposed.
 * - `sourcePath` is the provider folder the file now sits in.
 */

export const refileDocumentPayloadSchema = z
  .object({
    documentId: z.string().uuid(),
    fromEntityId: z.string().uuid(),
    toEntityId: z.string().uuid(),
    sourcePath: z.string(),
    documentName: z.string().min(1),
    fromName: z.string().min(1),
    toName: z.string().min(1),
  })
  .strict()
  .refine((p) => p.fromEntityId !== p.toEntityId, {
    message: 'a re-file names two different records',
  })

export type RefileDocumentPayload = {
  documentId: string
  fromEntityId: string
  toEntityId: string
  sourcePath: string
  documentName: string
  fromName: string
  toName: string
}

/** A stored payload read as a re-file proposal, or null when it is not one. */
export function readRefileDocumentPayload(
  raw: unknown,
): RefileDocumentPayload | null {
  const parsed = refileDocumentPayloadSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
