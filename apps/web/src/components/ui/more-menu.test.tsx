import { Component, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { icon } from '#/components/icons'
import { ProviderMark } from '#/components/provider-mark'
import { MENU_RULE, MoreMenu, menuLayout } from './more-menu'
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
            {
              label: 'Rename',
              icon: <icon.edit />,
              disabled: true,
              onSelect: noop,
            },
            MENU_RULE,
            {
              label: 'Archive',
              icon: <icon.edit />,
              disabled: true,
              onSelect: noop,
            },
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
        items={[
          { label: 'Save as template…', icon: <icon.edit />, onSelect: run },
        ]}
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

  it('keeps a rare lone verb in the ··· with forceMenu', async () => {
    const run = vi.fn()
    mount(
      <MoreMenu
        variant="head"
        label="Deals"
        forceMenu
        items={[
          { label: 'Import…', icon: <icon.edit />, onSelect: run, opens: true },
        ]}
      />,
    )
    const trigger = document.querySelector('[aria-label="More for Deals"]')
    expect(trigger?.querySelector('[data-more-glyph]')).not.toBeNull()
    expect([...document.querySelectorAll('button')]).toHaveLength(1)
    await open('Deals')
    expect(rows()).toEqual(['Import…'])
  })

  it('renders a row’s one item at 24px, revealed with its row', () => {
    const out = html(
      <MoreMenu
        variant="row"
        label="Acme Data Room"
        items={[{ label: 'Unlink', icon: <icon.edit />, onSelect: noop }]}
      />,
    )
    expect(out).toMatch(/data-variant="outline" data-size="xs"/)
    expect(out).toMatch(/class="[^"]*\brow-reveal\b/)
    expect(out).toContain('>Unlink</button>')
  })

  it('draws the head trigger boxed at 32px and the row trigger bare at 24px', () => {
    const items: Array<MoreMenuEntry> = [
      { label: 'Open', icon: <icon.edit />, onSelect: noop },
      { label: 'Download', icon: <icon.edit />, onSelect: noop },
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
          { label: 'Ask about this', icon: <icon.edit />, onSelect: noop },
          {
            label: 'Remove…',
            icon: <icon.edit />,
            destructive: true,
            onSelect: noop,
          },
          MENU_RULE,
          MENU_RULE,
          { label: 'Rename', icon: <icon.edit />, onSelect: noop },
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
          { label: 'Ask about this', icon: <icon.edit />, onSelect: noop },
          {
            label: 'Copy link',
            icon: <icon.edit />,
            copy: () => 'http://localhost/companies/x',
          },
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

/** Catches what the menu below it throws while it draws. */
class Caught extends Component<
  { children: ReactNode; onError: (e: Error) => void },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(e: Error) {
    this.props.onError(e)
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

describe('the lead lane (E12)', () => {
  it('leads every item with its mark in a 16px lane, a check item with its box', async () => {
    mount(
      <MoreMenu
        variant="head"
        label="Flent"
        items={[
          { label: 'Open', icon: <icon.open />, onSelect: noop },
          {
            label: 'Open in Gmail',
            icon: <ProviderMark brand="gmail" />,
            href: 'https://mail.google.com',
          },
          { label: 'Pinned', checked: true, onCheckedChange: noop },
          {
            label: 'Delete…',
            icon: <icon.delete />,
            destructive: true,
            onSelect: noop,
          },
        ]}
      />,
    )
    await open('Flent')
    const items = [
      ...document.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ),
    ]
    expect(items).toHaveLength(4)
    for (const item of items) {
      const lead = item.firstElementChild
      expect(lead?.hasAttribute('data-menu-lead'), item.textContent).toBe(true)
      expect(lead?.getAttribute('aria-hidden')).toBe('true')
      expect(lead?.className).toMatch(/\bsize-4\b/)
      expect(lead?.className).toMatch(/\bshrink-0\b/)
      expect(lead?.childElementCount).toBe(1)
    }
    // The mark is outside the item's name: the label alone names it.
    expect(items.map((el) => el.textContent)).toEqual([
      'Open',
      'Open in Gmail',
      'Pinned',
      'Delete…',
    ])
    expect(
      items[1]?.querySelector('[data-provider-mark="gmail"]'),
    ).not.toBeNull()
    expect(items[3]?.querySelector('[data-icon="trash-can"]')).not.toBeNull()
  })

  it('refuses an item whose mark draws nothing', async () => {
    const errors: Array<Error> = []
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount(
      <Caught onError={(e) => errors.push(e)}>
        <MoreMenu
          variant="head"
          label="Flent"
          items={[
            { label: 'Open', icon: <icon.open />, onSelect: noop },
            { label: 'Download', icon: <></>, onSelect: noop },
          ]}
        />
      </Caught>,
    )
    await open('Flent')
    quiet.mockRestore()
    expect(errors.map((e) => e.message)).toEqual([
      'A menu item leads with its 16px mark (E12).',
    ])
  })
})

describe('menuLayout with groups', () => {
  const item = (label: string) => ({
    label,
    icon: <icon.edit />,
    onSelect: noop,
  })

  it('keeps a group over its items, after a rule', () => {
    const laid = menuLayout([
      item('Copy link'),
      MENU_RULE,
      { group: 'Exa' },
      item('Find similar'),
    ])
    expect(
      laid.map((e) =>
        typeof e === 'string' ? e : 'group' in e ? `[${e.group}]` : e.label,
      ),
    ).toEqual(['Copy link', MENU_RULE, '[Exa]', 'Find similar'])
  })

  it('drops a group that heads nothing, and the rule before it', () => {
    const laid = menuLayout([
      item('Copy link'),
      MENU_RULE,
      { group: 'Exa' },
      MENU_RULE,
      { group: 'Apollo' },
    ])
    expect(laid).toEqual(
      [item('Copy link')].map((e) =>
        expect.objectContaining({ label: e.label }),
      ),
    )
  })
})
