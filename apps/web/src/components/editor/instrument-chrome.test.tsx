import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { instrumentChrome } from './instrument-chrome'

/**
 * The editor's block and table menus are BlockNote's items drawn in the
 * app's menu: each takes its mark by BlockNote's English label, and a label
 * the map does not know (one a later BlockNote adds) gets the empty lane,
 * never a wrong mark and never a throw.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/notes/n1' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'Node',
    'NodeFilter',
    'Element',
    'SVGElement',
    'HTMLElement',
    'HTMLButtonElement',
    'Text',
    'DocumentFragment',
    'ShadowRoot',
    'Event',
    'CustomEvent',
    'UIEvent',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} = instrumentChrome.DropdownMenu

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

/** Draws the items in an open menu, the way BlockNote's handle menu does. */
function openMenu(children: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Block</DropdownMenuTrigger>
        <DropdownMenuContent>{children}</DropdownMenuContent>
      </DropdownMenu>,
    ),
  )
}

/** The menu item whose label is `text`, and the glyph in its lead lane. */
function item(text: string) {
  const el = [...document.querySelectorAll('[role="menuitem"]')].find(
    (i) => i.textContent === text,
  )
  if (el === undefined) throw new Error(`no ${text}`)
  const lead = el.firstElementChild
  if (lead === null || !lead.hasAttribute('data-menu-lead'))
    throw new Error(`${text} has no lead lane`)
  return {
    el,
    lead,
    glyph: lead.querySelector('svg')?.getAttribute('data-icon'),
  }
}

describe('the editor’s menus', () => {
  it('marks a label BlockNote draws by its English text', () => {
    openMenu(
      <>
        <DropdownMenuItem>Delete</DropdownMenuItem>
        <DropdownMenuItem>Add row above</DropdownMenuItem>
        <DropdownMenuItem>Merge cells</DropdownMenuItem>
      </>,
    )
    expect(item('Delete').glyph).toBe('trash-can')
    expect(item('Delete').el.getAttribute('data-variant')).toBe('destructive')
    expect(item('Add row above').glyph).toBe('add')
    expect(item('Add row above').el.getAttribute('data-variant')).toBe(
      'default',
    )
    expect(item('Merge cells').glyph).toBe('arrows--horizontal')
  })

  it('gives a label it does not know the empty lane, not a wrong mark', () => {
    openMenu(<DropdownMenuItem>Duplicate block</DropdownMenuItem>)
    const { lead } = item('Duplicate block')
    expect(lead.childElementCount).toBe(0)
    expect(lead.className).toMatch(/\bsize-4\b/)
  })

  it('moves the icon BlockNote hands over (a colour swatch) into the lane', () => {
    openMenu(
      <DropdownMenuItem>
        <span data-swatch="red" />
        Red
      </DropdownMenuItem>,
    )
    const { lead } = item('Red')
    expect(lead.querySelector('[data-swatch="red"]')).not.toBeNull()
  })

  it('marks a sub-menu trigger by the label of the item BlockNote wraps', () => {
    openMenu(
      <>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <DropdownMenuItem>Colors</DropdownMenuItem>
          </DropdownMenuSubTrigger>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <DropdownMenuItem>Text direction</DropdownMenuItem>
          </DropdownMenuSubTrigger>
        </DropdownMenuSub>
      </>,
    )
    expect(item('Colors').glyph).toBe('color-palette')
    expect(item('Text direction').lead.childElementCount).toBe(0)
  })
})
