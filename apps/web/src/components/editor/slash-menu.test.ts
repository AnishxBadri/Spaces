import { BlockNoteEditor } from '@blocknote/core'
import { getDefaultReactSlashMenuItems } from '@blocknote/react'
import { describe, expect, it } from 'vitest'

import { SLASH_MENU_KEYS, noteSlashItems, noteSlashMenu } from './slash-menu'

/**
 * The `/` menu offers twelve block types, not BlockNote's twenty-odd. A real
 * headless editor builds BlockNote's own list, so a BlockNote upgrade that
 * renames a key shows up here as a missing item.
 */

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- @blocknote's editor generics are not exactOptionalPropertyTypes-clean (PartialBlock variance)
const editor = BlockNoteEditor.create() as never

const keyOf = (item: object): unknown => ('key' in item ? item.key : null)

describe('the slash menu', () => {
  it('keeps exactly the twelve block types, in BlockNote’s order', () => {
    const items = noteSlashItems(editor)
    expect(items.map(keyOf)).toEqual([
      'heading',
      'heading_2',
      'heading_3',
      'quote',
      'numbered_list',
      'bullet_list',
      'check_list',
      'code_block',
      'divider',
      'table',
      'image',
      'file',
    ])
    expect(new Set(items.map(keyOf))).toEqual(new Set(SLASH_MENU_KEYS))
    expect(items.map((i) => i.title)).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Quote',
      'Numbered List',
      'Bullet List',
      'Check List',
      'Code Block',
      'Divider',
      'Table',
      'Image',
      'File',
    ])
  })

  it('drops what the note page does not offer', () => {
    const all = getDefaultReactSlashMenuItems(editor).map(keyOf)
    const kept = new Set(noteSlashItems(editor).map(keyOf))
    for (const gone of [
      'paragraph',
      'video',
      'audio',
      'emoji',
      'toggle_list',
      'toggle_heading',
      'toggle_heading_2',
      'toggle_heading_3',
      'heading_4',
    ]) {
      expect(all, `${gone} is a BlockNote default`).toContain(gone)
      expect(kept.has(gone), gone).toBe(false)
    }
  })

  it('filters the kept items by what was typed', async () => {
    const getItems = noteSlashMenu(editor)
    expect((await getItems('head')).map(keyOf)).toEqual([
      'heading',
      'heading_2',
      'heading_3',
    ])
    expect((await getItems('video')).map(keyOf)).toEqual([])
  })
})
