import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Segmented } from './segmented.tsx'

/**
 * The bounded switch: one 28px bone-deep box, the chosen segment on paper
 * in ink, the rest graphite, counts inside and none at 0, and the reticle
 * round the whole box.
 */

const win = new Window()

function render(value: 'all' | 'email' | 'calls' = 'all') {
  const doc = win.document
  doc.body.innerHTML = renderToStaticMarkup(
    <Segmented
      label="Kind"
      value={value}
      options={[
        { id: 'all', label: 'All' },
        { id: 'email', label: 'Email', count: 17 },
        { id: 'calls', label: 'Calls', count: 0 },
      ]}
      onChange={() => {}}
    />,
  )
  return doc
}

const classes = (el: { className: string } | null | undefined) =>
  (el?.className ?? '').split(/\s+/)

function segment(doc: ReturnType<typeof render>, name: string) {
  const found = Array.from(doc.querySelectorAll('[role="radio"]'))
    .filter((s) => s.textContent.startsWith(name))
    .at(0)
  if (!found) throw new Error(`no segment ${name}`)
  return found
}

describe('the box', () => {
  it('is one 28px radiogroup on bone-deep, a rule round it, 2px in', () => {
    const group = render().querySelector('[role="radiogroup"]')
    expect(group?.getAttribute('aria-label')).toBe('Kind')
    expect(classes(group)).toEqual(
      expect.arrayContaining([
        'h-7',
        'p-0.5',
        'gap-0.5',
        'bg-bone-deep',
        'border',
        'border-rule',
        'rounded-md',
        // The reticle frames the box, not one segment.
        'focus-ring-within',
      ]),
    )
  })
})

describe('a segment', () => {
  it('labels in sans at the label step', () => {
    for (const s of Array.from(render().querySelectorAll('[role="radio"]'))) {
      expect(classes(s)).toEqual(
        expect.arrayContaining(['text-label', 'px-2.5', 'gap-1.5']),
      )
      expect(classes(s)).not.toContain('mono')
    }
  })

  it('raises the chosen one on paper with a rule, in ink', () => {
    const doc = render('email')
    const email = segment(doc, 'Email')
    expect(email.getAttribute('aria-checked')).toBe('true')
    expect(classes(email)).toEqual(
      expect.arrayContaining(['bg-paper', 'border-rule', 'text-foreground']),
    )
    const all = segment(doc, 'All')
    expect(all.getAttribute('aria-checked')).toBe('false')
    expect(classes(all)).toEqual(
      expect.arrayContaining([
        'text-graphite',
        'hover:bg-bone-deep',
        'hover:text-foreground',
      ]),
    )
  })

  it('carries its count in mono, and none at 0 or when not given', () => {
    const doc = render()
    expect(segment(doc, 'Email').textContent).toBe('Email17')
    expect(
      classes(segment(doc, 'Email').querySelector('[data-segment-count]')),
    ).toEqual(expect.arrayContaining(['mono', 'text-micro']))
    expect(segment(doc, 'Calls').textContent).toBe('Calls')
    expect(segment(doc, 'All').querySelector('[data-segment-count]')).toBeNull()
  })

  it('names a mark-only segment for screen readers', () => {
    const doc = win.document
    doc.body.innerHTML = renderToStaticMarkup(
      <Segmented
        label="Icon"
        value="star"
        options={[
          { id: 'star', label: <svg />, name: 'star', tip: 'star' },
          { id: 'flag', label: <svg />, name: 'flag', tip: 'flag' },
        ]}
        onChange={() => {}}
      />,
    )
    const radios = Array.from(doc.querySelectorAll('[role="radio"]'))
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'star',
      'flag',
    ])
  })
})
