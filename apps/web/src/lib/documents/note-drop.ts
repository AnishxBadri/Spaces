/**
 * §3.1 **entry point 4** — a file dropped on a note's body (SPA-140).
 *
 * The gesture itself is DOM (a `dragover`/`drop` pair on the editor's
 * container, a ProseMirror coordinate, a chip inserted where the pointer let
 * go), and the suite runs on `environment: 'node'`, so this file is the half
 * of it that is a **value**: where the drop files, what the reader is told,
 * and whether the position captured at drop time still means anything after
 * the upload resolved. `note-drop.test.ts` runs those against the real
 * writer; the tsx around them (`components/editor/note-editor.tsx`,
 * `routes/_app/notes_.$noteId.tsx`) holds nothing this file could have held.
 *
 * It sits beside `upload.ts` and `file-against.ts` because it is the same
 * lane — client-side, no `node:`, no drizzle, no Effect — and it takes
 * `FileAgainst` from `upload.ts` rather than re-declaring the shape, which is
 * itself read off the server fn. Three declarations of one union is how the
 * empty array stops meaning unfiled somewhere.
 */

import type { FileAgainst } from './upload'

/**
 * What the drop affordance says. Deliberately a sentence and not an icon: the
 * editor already has a selection wash and a drop cursor of its own, and the
 * only thing that distinguishes *this* wash from those is that it is
 * captioned.
 */
export const NOTE_DROP_LABEL = 'Drop to file into this note'

/**
 * What a note filed nowhere is told, verbatim. A note's filing is
 * `entity_space` and nothing else (CONTEXT.md → _The note model_), so a note
 * in no space has no filing to inherit — the document lands unfiled, which is
 * a first-class state (§3.2) rather than a failure, and the reader is told
 * plainly instead of the UI guessing a space for it.
 */
export const UNFILED_NOTE_MESSAGE =
  'Filed nowhere yet — this note is in no space'

/** The shelf filter that message links to (SPA-124). */
export const UNFILED_SHELF_LABEL = 'Show unfiled'

/**
 * Where a document dropped on this note is filed: **every space the note is
 * filed in, in one array**.
 *
 * This is the reason document birth takes an array of targets rather than one
 * (SPA-113). One call with N targets is one document row carrying N
 * `entity_space` edges — §3.4's "filed in N places without copying". N calls
 * with one target each would be N document rows, which is the copy the spec
 * exists to refuse.
 *
 * A note's filing is `entity_space` only, so every element is `space`: a note
 * filed against a *record* carries `link(tagged_in)`, which is the note's own
 * edge and not a filing the document inherits — `createNote` writes
 * `entity_space` for a space `about` and `link(mentions)` for a record one.
 * Zero spaces is the empty array, which is unfiled and says so.
 *
 * Deduped by entity id: the same space cannot be filed into twice, and the
 * writer would refuse the second edge rather than shrug.
 */
export function fileAgainstForNote(
  spaces: ReadonlyArray<{ id: string }>,
): FileAgainst {
  const seen = new Set<string>()
  const out: Array<{ kind: 'space'; entityId: string }> = []
  for (const space of spaces) {
    if (seen.has(space.id)) continue
    seen.add(space.id)
    out.push({ kind: 'space', entityId: space.id })
  }
  return out
}

/**
 * What the success toast says a drop did — the names, because "filed in 2
 * spaces" makes the reader open another page to learn which two.
 */
export function noteDropFiledIn(
  spaces: ReadonlyArray<{ id: string; name: string }>,
): string {
  const names: Array<string> = []
  const seen = new Set<string>()
  for (const space of spaces) {
    if (seen.has(space.id)) continue
    seen.add(space.id)
    names.push(space.name)
  }
  return names.length === 0
    ? UNFILED_NOTE_MESSAGE
    : `Filed in ${names.join(', ')}`
}

/**
 * The drop coordinate, re-validated against the document as it is **now**.
 *
 * The position is resolved from the pointer at drop time, before any `await`
 * — the drop handler both uploads and inserts, and reading the coordinate
 * after the upload would read a pointer that is no longer anywhere
 * (CLAUDE.md → Browser verification: beware stale closures when clicking and
 * submitting in one tick). But a hash and a PUT take seconds, and the writer
 * may have typed, undone or deleted in them, so the captured number can
 * outlive the position it named.
 *
 * `null` in, or a number outside `0…docSize`, means "no usable position" and
 * the caller inserts at the cursor instead. The chip still lands — a
 * successful upload always leaves a mention — it just lands where the caret
 * is rather than somewhere the document no longer has.
 */
export function noteDropInsertPos(
  pos: number | null,
  docSize: number,
): number | null {
  if (pos === null) return null
  if (!Number.isInteger(pos)) return null
  if (pos < 0 || pos > docSize) return null
  return pos
}

/**
 * Whether a drag is carrying files. A drag *inside* the editor — a block by
 * its handle, a selection — carries no `Files` type, and must be left alone:
 * intercepting it would break BlockNote's own reordering. Only a file drag is
 * taken over, which is also what makes `preventDefault` safe to call
 * unconditionally once this is true.
 */
export function isFileDrag(types: ReadonlyArray<string>): boolean {
  return types.includes('Files')
}

/**
 * Why a drop produced no chip. An upload that fails leaves the note exactly
 * as it was — no placeholder to clean up, because none was ever inserted —
 * so this string is the only trace, and it has to name the file and the
 * reason.
 */
export function noteDropFailure(filename: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : 'Upload failed'
  return `${filename}: ${reason}`
}
