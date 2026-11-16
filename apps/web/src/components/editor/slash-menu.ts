import { filterSuggestionItems } from '@blocknote/core'
import { getDefaultReactSlashMenuItems } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'

/**
 * The editor BlockNote's default items are built from. A caller hands its
 * own editor through the same `as never` seam `BlockNoteView` takes: the
 * vendor's editor generics are not `exactOptionalPropertyTypes`-clean.
 */
type SlashMenuEditor = Parameters<typeof getDefaultReactSlashMenuItems>[0]

/**
 * The block types `/` offers, by BlockNote's item key: three headings, the
 * three lists, quote, table, code, image, file and divider. Turning a block
 * back into text is the formatting toolbar's block-type select, so
 * `paragraph` is not here; nor are video, audio, emoji, page break, the
 * toggle list and the toggle headings.
 */
export const SLASH_MENU_KEYS: ReadonlyArray<string> = [
  'heading',
  'heading_2',
  'heading_3',
  'bullet_list',
  'numbered_list',
  'check_list',
  'quote',
  'table',
  'code_block',
  'image',
  'file',
  'divider',
]

const KEEP = new Set(SLASH_MENU_KEYS)

/**
 * BlockNote's default slash items narrowed to `SLASH_MENU_KEYS`, in
 * BlockNote's own order so its groups stay together. The React item type
 * drops `key`, though every default item carries one; it is read at runtime.
 */
export function noteSlashItems(
  editor: SlashMenuEditor,
): Array<DefaultReactSuggestionItem> {
  return getDefaultReactSlashMenuItems(editor).filter(
    (item) =>
      'key' in item && typeof item.key === 'string' && KEEP.has(item.key),
  )
}

/** The `/` menu's `getItems`: the kept items, filtered by what was typed. */
export function noteSlashMenu(editor: SlashMenuEditor) {
  return async (query: string): Promise<Array<DefaultReactSuggestionItem>> =>
    filterSuggestionItems(noteSlashItems(editor), query)
}
