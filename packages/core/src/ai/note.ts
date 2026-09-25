import { z } from 'zod'

/**
 * The `suggestion(kind: 'note')` payload (SPA-66, spec-ai-substrate.md §11
 * "Summarize"): a note a model drafted, not yet a note. Accepting it is what
 * writes the `note` row — with the accepter as author — filed against the
 * record the suggestion sits on and `derived_from` the source it was drafted
 * from.
 *
 * The body is **markdown**, its citations already written into the text as
 * words ("(DD pack.pdf, p.4)"), so it reads on the inbox card as it will
 * read in the note. The accept path renders it into BlockNote blocks and
 * serializes `body_md` back from those blocks
 * (`apps/web/src/lib/notes/markdown-blocks.ts`).
 *
 * One decoder, three readers — the identity payload's shape
 * (`./identity.ts`): `proposeProgram` holds a new row to it, the accept path
 * reads it back, and the inbox card draws it.
 */
export const notePayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    markdown: z.string().trim().min(1).max(200_000),
    /**
     * What the note was drafted from: a document, or the record itself.
     * Accepting links the note `derived_from` it.
     */
    sourceId: z.string().uuid(),
  })
  .strict()

export type NotePayload = {
  title: string
  markdown: string
  sourceId: string
}

/** A stored payload read as a note, or null when it is not one. */
export function readNotePayload(raw: unknown): NotePayload | null {
  const parsed = notePayloadSchema.safeParse(raw)
  return parsed.success
    ? {
        title: parsed.data.title,
        markdown: parsed.data.markdown,
        sourceId: parsed.data.sourceId,
      }
    : null
}
