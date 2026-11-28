import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AskRef } from '#/lib/ask/types'
import { parseBrief } from '#/lib/meetings/brief'
import { BriefParts } from './brief-card'

vi.mock('#/lib/server-fns', () => ({ previewAskRef: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children: ReactNode
    className?: string
    'data-ref'?: string
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

/**
 * The brief's four parts: read from the model's labelled lines however it
 * dresses them, a lead kept, and each part drawn in its lane with every
 * claim cited `[n]` in the order first cited, a source with a page a link.
 */

const CALL = 'note:00000000-0000-4000-8000-0000000000c1'
const MIS = 'doc:00000000-0000-4000-8000-0000000000d1#0'
const MEET = 'interaction:00000000-0000-4000-8000-000000000001'

const REFS: ReadonlyArray<AskRef> = [
  { ref: MEET, label: 'Flent intro', href: null, entityId: null },
  {
    ref: CALL,
    label: 'Call notes',
    href: '/notes/00000000-0000-4000-8000-0000000000c1',
    entityId: '00000000-0000-4000-8000-0000000000c1',
  },
  { ref: MIS, label: 'Q3 MIS.pdf', href: null, entityId: null },
]

const BODY = [
  'A first meeting with the finance lead.',
  `**Who:** Priya Nair hosts; Rohan Gupta is new to us [${MEET}].`,
  `## Deal`,
  `In diligence, our pro rata $400k [${CALL}].`,
  `- Last time: the bridge closes on the 30th [${CALL}, note:00000000-0000-4000-8000-0000000000ff].`,
  `Since: the Q3 MIS was filed [${MIS}].`,
].join('\n')

describe('the brief', () => {
  it('reads the four labelled parts and the lead, whatever markdown dresses the labels', () => {
    expect(parseBrief(BODY)).toEqual({
      lead: 'A first meeting with the finance lead.',
      parts: [
        {
          label: 'Who',
          text: `Priya Nair hosts; Rohan Gupta is new to us [${MEET}].`,
        },
        { label: 'Deal', text: `In diligence, our pro rata $400k [${CALL}].` },
        {
          label: 'Last time',
          text: `the bridge closes on the 30th [${CALL}, note:00000000-0000-4000-8000-0000000000ff].`,
        },
        { label: 'Since', text: `the Q3 MIS was filed [${MIS}].` },
      ],
    })
    // Fewer parts, out of order, keep the card's order; none at all is lead.
    expect(parseBrief('Since: moved.\nWho: two.').parts).toEqual([
      { label: 'Who', text: 'two.' },
      { label: 'Since', text: 'moved.' },
    ])
    expect(parseBrief('Nothing in the records.')).toEqual({
      lead: 'Nothing in the records.',
      parts: [],
    })
  })

  it('draws each part in its lane with numbered citations, linked where the source has a page', async () => {
    const { Window } = await import('happy-dom')
    const host = new Window().document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      <BriefParts body={BODY} refs={REFS} />,
    )
    const parts = [...host.querySelectorAll('[data-brief-part]')]
    expect(parts.map((p) => p.getAttribute('data-brief-part'))).toEqual([
      'Who',
      'Deal',
      'Last time',
      'Since',
    ])
    expect(parts[0].querySelector('span')?.className).toContain('w-18')
    const cites = (i: number) =>
      [...parts[i].querySelectorAll('[data-ref]')].map((c) => ({
        n: c.textContent,
        ref: c.getAttribute('data-ref'),
        href: c.getAttribute('href'),
      }))
    // Numbered in the order first cited; a ref the brief does not hold is
    // never printed, and a source cited again keeps its number.
    expect(cites(0)).toEqual([{ n: '[1]', ref: MEET, href: null }])
    expect(cites(1)).toEqual([
      {
        n: '[2]',
        ref: CALL,
        href: '/notes/00000000-0000-4000-8000-0000000000c1',
      },
    ])
    expect(cites(2).map((c) => c.n)).toEqual(['[2]'])
    expect(cites(3)).toEqual([{ n: '[3]', ref: MIS, href: null }])
    expect(parts[1].textContent).toBe(
      'DealIn diligence, our pro rata $400k [2].',
    )
    expect(host.textContent).toContain('A first meeting with the finance lead.')
  })
})
