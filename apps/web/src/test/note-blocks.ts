import type { PartialBlock } from '@blocknote/core'
import type { NoteBlock } from '@spaces/core/notes/markdown-blocks'

/**
 * The server renderer's blocks, as BlockNote's in-memory type spells them.
 * They differ only in a table's unset column widths: `null` in the JSON
 * column, `undefined` to `BlockNoteEditor.create`. Converted field by field
 * rather than by assertion.
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
