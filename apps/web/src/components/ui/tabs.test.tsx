import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Tabs } from './tabs.tsx'
import type { TabItem } from './tabs.tsx'
import { declared } from '#/test/tailwind-css'

/**
 * The tab head's states this file owns: an empty tab drawn at disabled grey
 * with its 0 (D74 — the head stays the record's index), the head pinned
 * under the folded bar, and a switch that never fades the open tab's fill.
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
      size="head"
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

describe('an empty tab', () => {
  it('stays in the head, graphite at 0, still a tab to open', () => {
    const doc = render('notes')
    const files = tab(doc, 'Files')
    expect(files.textContent).toBe('Files0')
    expect(files.hasAttribute('data-empty')).toBe(true)
    expect(classes(files)).toContain('text-graphite')
    expect(classes(files)).not.toContain('text-foreground')
    expect(files.hasAttribute('disabled')).toBe(false)
    expect(classes(files.querySelector('[data-tab-count]'))).toContain(
      'text-graphite',
    )
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
    // Its zero stays graphite: nothing to count.
    expect(classes(files.querySelector('[data-tab-count]'))).toContain(
      'text-graphite',
    )
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
  // The open tab is an ink fill under a paper pane; fading that fill is what
  // left both tabs half-inked for a frame. Only the text colour may move.
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
