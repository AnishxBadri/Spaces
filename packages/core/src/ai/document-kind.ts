import { z } from 'zod'
import { DOCUMENT_KINDS } from '../documents'
import type { DocumentKind } from '../documents'

/**
 * The `suggestion(kind: 'document_kind')` payload (SPA-62,
 * spec-ai-substrate.md §11's first row): the kind the classify lane read a
 * document as. `other` is never proposed — it is the kind the document
 * already has, and "unknown" is not an answer worth a row in the inbox.
 *
 * One decoder, three readers, as the identity payload: `proposeProgram`
 * holds a new row to it, the accept path reads it back before writing
 * `document.kind`, and the inbox card draws it.
 */

/** A document kind a classification may propose: every kind but `other`. */
export type ProposedDocumentKind = Exclude<DocumentKind, 'other'>

const isProposable = (k: DocumentKind): k is ProposedDocumentKind =>
  k !== 'other'

export const documentKindPayloadSchema = z
  .object({
    kind: z
      .enum(DOCUMENT_KINDS)
      .refine(isProposable, { message: 'other is never proposed' }),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()

/**
 * Spelled out rather than `z.infer`, as `IdentityPayload` is: an absent key
 * is absent, so the payload is JSON by type.
 */
export type DocumentKindPayload = {
  kind: ProposedDocumentKind
  confidence?: number
}

/** A stored payload read as a document kind, or null when it is not one. */
export function readDocumentKindPayload(
  raw: unknown,
): DocumentKindPayload | null {
  const parsed = documentKindPayloadSchema.safeParse(raw)
  if (!parsed.success) return null
  const kind = parsed.data.kind
  if (!isProposable(kind)) return null
  return parsed.data.confidence === undefined
    ? { kind }
    : { kind, confidence: parsed.data.confidence }
}
