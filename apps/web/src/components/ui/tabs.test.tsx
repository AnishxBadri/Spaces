import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Tabs } from './tabs.tsx'
import type { TabItem } from './tabs.tsx'
import { declared } from '#/test/tailwind-css'

/**
 * The tab head's states this file owns: the one 44px bar, an empty tab in
 * graphite with no count, a counted tab in ink, the open tab on paper, the
 * head pinned under the folded bar, and a switch that never fades the open
 * tab's fill.
 */

type Id = 'notes' | 'files' | 'history'
const items: Array<TabItem<Id>> = [
  { id: 'notes', label: 'Notes', count: 3 },
  { id: 'files', label: 'Files', count: 0 },
  { id: 'history', label: 'History', count: 0 },
]

const win = new Window()
type Doc = typeof win.document

function render(value: Id, pinned = false): Doc {
  const doc = win.document
  doc.body.innerHTML = renderToStaticMarkup(
    <Tabs
      label="Record"
      pinned={pinned}
      items={items}
      value={value}
      onValueChange={() => {}}
    >
      <p>Body</p>
    </Tabs>,
  )
  return doc
}

function tab(doc: Doc, name: string) {
  const found = Array.from(doc.querySelectorAll('[role="tab"]'))
    .filter((t) => t.textContent.startsWith(name))
    .at(0)
  if (!found) throw new Error(`no tab ${name}`)
  return found
}

const classes = (el: { className: string } | null) =>
  (el?.className ?? '').split(/\s+/)

describe('the bar', () => {
  it('is one 44px bone bar, inset 12px, the tabs sitting on its foot', () => {
    const list = render('notes').querySelector('[role="tablist"]')
    expect(classes(list)).toEqual(
      expect.arrayContaining(['h-11', 'px-3', 'pt-1', 'bg-bone', 'items-end']),
    )
  })

  it('labels every tab in sentence-case sans, never the caps tier', () => {
    const doc = render('notes')
    for (const t of Array.from(doc.querySelectorAll('[role="tab"]'))) {
      expect(classes(t)).toContain('text-ui')
      expect(classes(t)).not.toContain('label-caps')
      expect(classes(t)).not.toContain('uppercase')
    }
  })
})

describe('a counted tab', () => {
  it('prints its count in mono ink beside the label', () => {
    const notes = tab(render('history'), 'Notes')
    expect(notes.textContent).toBe('Notes3')
    const count = notes.querySelector('[data-tab-count]')
    expect(count?.textContent).toBe('3')
    expect(classes(count)).toEqual(
      expect.arrayContaining(['mono', 'text-micro', 'text-foreground']),
    )
  })
})

describe('the open tab', () => {
  it('is paper with the ink edge, a pixel taller and a pixel low', () => {
    const notes = tab(render('notes'), 'Notes')
    expect(notes.getAttribute('aria-selected')).toBe('true')
    expect(classes(notes)).toEqual(
      expect.arrayContaining(['tab-open', 'h-10', 'top-px']),
    )
    for (const t of Array.from(
      render('notes').querySelectorAll('[role="tab"][aria-selected="false"]'),
    )) {
      expect(classes(t)).toContain('h-9.75')
    }
  })
})

describe('an empty tab', () => {
  it('stays in the head with no count, graphite, still a tab to open', () => {
    const doc = render('notes')
    const files = tab(doc, 'Files')
    expect(files.textContent).toBe('Files')
    expect(files.querySelector('[data-tab-count]')).toBeNull()
    expect(files.hasAttribute('data-empty')).toBe(true)
    expect(classes(files)).toContain('text-graphite')
    expect(classes(files)).toContain('hover:text-foreground')
    expect(classes(files)).not.toContain('text-foreground')
    expect(files.hasAttribute('disabled')).toBe(false)
  })

  it('prints no count when the caller gives none either', () => {
    const doc = win.document
    doc.body.innerHTML = renderToStaticMarkup(
      <Tabs
        label="Views"
        items={[
          { id: 'a', label: 'All' },
          { id: 'b', label: 'Mine' },
        ]}
        value="a"
        onValueChange={() => {}}
      />,
    )
    expect(doc.querySelectorAll('[data-tab-count]')).toHaveLength(0)
    expect(tab(doc, 'Mine').textContent).toBe('Mine')
  })

  it('never dims its text with opacity — graphite is the second colour', () => {
    const doc = render('notes')
    for (const t of Array.from(doc.querySelectorAll('[role="tab"]'))) {
      expect(
        classes(t).filter(
          (c) => /(^|:)opacity-/.test(c) && !c.startsWith('disabled:'),
        ),
      ).toEqual([])
    }
  })

  it('reads at full ink once it is the open tab', () => {
    const files = tab(render('files'), 'Files')
    expect(files.getAttribute('aria-selected')).toBe('true')
    expect(classes(files)).toContain('text-foreground')
    // Still nothing to count.
    expect(files.querySelector('[data-tab-count]')).toBeNull()
  })

  it('is only the tab whose count is 0; a closed tab with content is ink', () => {
    const doc = render('history')
    const notes = tab(doc, 'Notes')
    expect(notes.getAttribute('aria-selected')).toBe('false')
    expect(notes.hasAttribute('data-empty')).toBe(false)
    expect(classes(notes)).toContain('text-foreground')
    expect(classes(notes)).not.toContain('text-graphite')
    expect(classes(notes.querySelector('[data-tab-count]'))).toContain(
      'text-foreground',
    )
    expect(doc.querySelectorAll('[data-empty]')).toHaveLength(2)
  })
})

describe('a pinned head', () => {
  it('sticks directly under the 40px folded bar, above the body', () => {
    const list = render('notes', true).querySelector('[role="tablist"]')
    expect(classes(list)).toEqual(
      expect.arrayContaining(['sticky', 'md:top-10', 'top-22', 'z-sticky']),
    )
    // Opaque, so rows scrolling under it never show through.
    expect(classes(list)).toContain('bg-bone')
  })

  it('scrolls with the page when not pinned', () => {
    const list = render('notes').querySelector('[role="tablist"]')
    expect(classes(list)).not.toContain('sticky')
  })
})

describe('a tab switch', () => {
  // The open tab is an ink fill under a paper pane; fading that fill leaves
  // both tabs half-inked for a frame. Only the text colour may move.
  it('transitions colour only, on the open tab and the closed ones', async () => {
    const doc = render('notes')
    for (const t of Array.from(doc.querySelectorAll('[role="tab"]'))) {
      expect(await declared(t.className, 'transition-property')).toEqual([
        'color',
      ])
      expect(await declared(t.className, 'transition')).toEqual([])
    }
  })

  it('switches the fill at once: the open tab still draws one', async () => {
    const open = tab(render('notes'), 'Notes')
    // The ink edge; the paper pane is its `::before`.
    expect(await declared(open.className, 'background')).toContain(
      'var(--hairline)',
    )
    // Within the compositor budget: nothing over 250ms.
    expect(await declared(open.className, 'transition-duration')).toContain(
      '150ms',
    )
  })
})
