/**
 * The "via <tool> · <author>" mark a note filed from a recorder carries. Client-safe; `notesViaProgram` reads it.
 */
export type NoteVia = { tool: string; author: string }

/** The mark as it reads: "via Granola · Anish". */
export const viaLabel = (via: NoteVia): string =>
  `via ${via.tool} · ${via.author}`
