import type { PartialBlock } from '@blocknote/core'
import type { NoteBlock } from '#/lib/notes/markdown-blocks'

/**
 * The server renderer's blocks, as BlockNote's in-memory type spells them
 * (SPA-91). The two differ in one place: a table's unset column widths. The
 * column is JSON, so `markdown-blocks.ts` writes them as `null` — which is
 * exactly what BlockNote's own `(number | undefined)[]` becomes on the way to
 * the database — while `BlockNoteEditor.create` types them `undefined`. The
 * note editor crosses that seam once, on load (`note-editor.tsx`); a test
 * that opens the renderer's blocks in a headless editor crosses it here,
 * field by field rather than by assertion.
 */
export function editorBlocks(
  blocks: ReadonlyArray<NoteBlock>,
): Array<PartialBlock> {
  return blocks.map((b): PartialBlock => {
    const children = editorBlocks(b.children)
    if (b.type !== 'table') return { ...b, children }
    return {
      ...b,
      content: {
        ...b.content,
        columnWidths: b.content.columnWidths.map(() => undefined),
      },
      children,
    }
  })
}
