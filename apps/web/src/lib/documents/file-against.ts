/**
 * The global upload dialog's **file-against control, as a value** (SPA-108).
 *
 * §3.1 entry point 3 is the one entry point whose filing is a question rather
 * than a fact: the Files tab knows it means this record, a space's Sources
 * knows it means this space, but a deck that arrives before you know whose it
 * is has three answers — a record, a space, or nowhere. This module is those
 * three answers and the one translation into what `finalizeDocumentUpload`
 * validates, so the translation can be asserted against the real writer
 * (`file-against.test.ts` runs all three through `birthDocumentProgram`)
 * instead of only being read in a `.tsx` the node-environment suite cannot
 * render.
 *
 * It lives beside `upload.ts` because it is the same lane — client-side, no
 * `node:`, no drizzle, no Effect — and it takes `FileAgainst` from there
 * rather than re-declaring the shape, which is itself read off the server fn.
 * Three declarations of one union is how the empty array stops meaning
 * unfiled somewhere.
 */

import type { FileAgainst } from './upload'

/** The three states of the control, in the order it draws them. */
export type FilingMode = 'unfiled' | 'record' | 'space'

/** What the record search or the space picker handed back. */
export type PickedEntity = { entityId: string; name: string }

/**
 * Where one drop is filed. `unfiled` is a first-class answer and the default
 * — §3.2's inbox row is a document with no edge, not an orphan — so it is a
 * member of this union rather than a `null` every caller has to remember to
 * handle.
 */
export type UploadTarget =
  | { kind: 'unfiled' }
  | { kind: 'record'; entityId: string; name: string }
  | { kind: 'space'; entityId: string; name: string }

/**
 * The control's two pieces of state read as one target, or **null** when the
 * reader has named a mechanism and not yet named the thing: "record, but no
 * record picked" is not unfiled, and silently filing those bytes nowhere is
 * the one outcome the dialog must not produce. The dialog disarms its drop
 * zone on null rather than guessing.
 */
export function uploadTarget(
  mode: FilingMode,
  picked: PickedEntity | null,
): UploadTarget | null {
  if (mode === 'unfiled') return { kind: 'unfiled' }
  if (picked === null) return null
  return mode === 'record'
    ? { kind: 'record', entityId: picked.entityId, name: picked.name }
    : { kind: 'space', entityId: picked.entityId, name: picked.name }
}

/**
 * The target as `finalizeDocumentUpload`'s `fileAgainst` — one element for a
 * record (`link(tagged_in)`) or a space (`entity_space`), and the **empty
 * array** for unfiled, which is SPA-113's widening read literally: zero
 * targets is a document row with no link and no `entity_space`, whose
 * activity subject is the document itself.
 *
 * One target for every file in a multi-file drop: the reader answered the
 * question once, for the drop, not once per file.
 */
export function fileAgainstFor(target: UploadTarget): FileAgainst {
  switch (target.kind) {
    case 'record':
      return [{ kind: 'record', entityId: target.entityId }]
    case 'space':
      return [{ kind: 'space', entityId: target.entityId }]
    case 'unfiled':
      return []
  }
}

/** What the dialog's foot says one drop will do. */
export function filingNote(target: UploadTarget | null): string {
  if (target === null) return 'choose one first'
  return target.kind === 'unfiled'
    ? 'files unfiled — it lands in the inbox'
    : `files against ${target.name}`
}
