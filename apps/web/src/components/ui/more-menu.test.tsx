import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MENU_RULE, MoreMenu } from './more-menu'
import type { MoreMenuEntry } from './more-menu'

/**
 * The one `···`: nothing with no enabled item, the item itself as an outline
 * button when there is one, and a menu otherwise, destructive items last
 * under one rule. The menu opens in a happy-dom `Window` on this file's
 * globals.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/flent' })
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

const noop = () => {}
const html = (node: ReactNode) => renderToStaticMarkup(node)

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
}

async function open(label: string) {
  const trigger = document.querySelector(`[aria-label="More for ${label}"]`)
  if (trigger === null) throw new Error('no ··· trigger')
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await flush()
}

/** The open menu's rows, a rule as `—`. */
function rows(): Array<string> {
  const menu = document.querySelector('[role="menu"]')
  if (menu === null) throw new Error('no menu')
  return [...menu.children].map((el) =>
    el.getAttribute('role') === 'separator' ? '—' : el.textContent.trim(),
  )
}

describe('MoreMenu', () => {
  it('renders nothing when no item is enabled', () => {
    expect(html(<MoreMenu variant="head" label="Flent" items={[]} />)).toBe('')
    expect(
      html(
        <MoreMenu
          variant="row"
          label="Flent"
          items={[
            { label: 'Rename', disabled: true, onSelect: noop },
            MENU_RULE,
            { label: 'Archive', disabled: true, onSelect: noop },
          ]}
        />,
      ),
    ).toBe('')
  })

  it('renders one item as that item, an outline button, and no ···', () => {
    const run = vi.fn()
    mount(
      <MoreMenu
        variant="head"
        label="Flent"
        items={[{ label: 'Save as template…', onSelect: run }]}
      />,
    )
    expect(document.querySelector('[aria-label="More for Flent"]')).toBeNull()
    const button = document.querySelector('button')
    expect(button?.textContent).toBe('Save as template…')
    expect(button?.dataset.variant).toBe('outline')
    expect(button?.dataset.size).toBe('default')
    act(() => button?.click())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('renders a row’s one item at 24px, revealed with its row', () => {
    const out = html(
      <MoreMenu
        variant="row"
        label="Acme Data Room"
        items={[{ label: 'Unlink', onSelect: noop }]}
      />,
    )
    expect(out).toMatch(/data-variant="outline" data-size="xs"/)
    expect(out).toMatch(/class="[^"]*\brow-reveal\b/)
    expect(out).toContain('>Unlink</button>')
  })

  it('draws the head trigger boxed at 32px and the row trigger bare at 24px', () => {
    const items: Array<MoreMenuEntry> = [
      { label: 'Open', onSelect: noop },
      { label: 'Download', onSelect: noop },
    ]
    const head = html(<MoreMenu variant="head" label="Flent" items={items} />)
    expect(head).toMatch(/aria-label="More for Flent"/)
    expect(head).toMatch(/data-variant="outline" data-size="icon"/)
    expect(head).not.toContain('row-reveal')
    const row = html(<MoreMenu variant="row" label="deck.pdf" items={items} />)
    expect(row).toMatch(/data-variant="ghost" data-size="icon-xs"/)
    expect(row).toMatch(/class="[^"]*\brow-reveal\b/)
    expect(row).toContain('hover:bg-bone-deep')
  })

  it('puts a destructive item last, below one rule, wherever it was given', async () => {
    mount(
      <MoreMenu
        variant="head"
        label="Flent"
        items={[
          MENU_RULE,
          { label: 'Ask about this', onSelect: noop },
          { label: 'Remove…', destructive: true, onSelect: noop },
          MENU_RULE,
          MENU_RULE,
          { label: 'Rename', onSelect: noop },
          MENU_RULE,
        ]}
      />,
    )
    await open('Flent')
    expect(rows()).toEqual(['Ask about this', '—', 'Rename', '—', 'Remove…'])
    const last = document.querySelector('[role="menu"]')?.lastElementChild
    expect(last?.getAttribute('data-variant')).toBe('destructive')
  })

  it('swaps Copy link to Copied and keeps the menu open', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    mount(
      <MoreMenu
        variant="head"
        label="Flent"
        items={[
          { label: 'Ask about this', onSelect: noop },
          { label: 'Copy link', copy: () => 'http://localhost/companies/x' },
        ]}
      />,
    )
    await open('Flent')
    const copy = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === 'Copy link',
    )
    act(() => {
      copy?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(writeText).toHaveBeenCalledWith('http://localhost/companies/x')
    expect(rows()).toEqual(['Ask about this', 'Copied'])
  })
})
