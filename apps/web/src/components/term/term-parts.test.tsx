import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Highlighted } from '#/components/command-palette'
import {
  CoMentioned,
  TERM_EMPTY,
  TermMentions,
  mentionHref,
} from './term-parts'
import type { MentionRow } from './term-parts'

/**
 * The term page's parts, rendered the way the app ships them
 * (`renderToStaticMarkup`, `environment: 'node'`). Rows that carry a `Link`
 * want a router, so the cases here are the ones that draw none — which are
 * also the ones that matter: what is absent, what the empty state says, and
 * a snippet drawn exactly as Cmd-K draws it.
 */

const unfiledDeck: MentionRow = {
  id: '5f0c1a52-3e0b-4a8e-9b61-000000000001',
  kind: 'document',
  subKind: 'deck',
  name: 'Series A deck.pdf',
  at: '2026-09-20T12:00:00.000Z',
  snippet: 'tanks bring «power» «usage» «effectiveness» below 1.05',
  parent: null,
}

describe('the term page', () => {
  it('draws no co-mentioned rail at all when there are none', () => {
    expect(renderToStaticMarkup(<CoMentioned rows={[]} />)).toBe('')
  })

  it('says one line when nothing mentions the term, and holds the primary it is given', () => {
    const bare = renderToStaticMarkup(<TermMentions rows={[]} total={0} />)
    expect(TERM_EMPTY).toBe('Nothing mentions this term yet.')
    expect(bare).toContain(TERM_EMPTY)
    expect(bare.match(/<p/g)).toHaveLength(1)
    expect(bare).not.toMatch(/<button|<a |<form|<input/)
    const offered = renderToStaticMarkup(
      <TermMentions
        rows={[]}
        total={0}
        action={<button type="button">Write a note</button>}
      />,
    )
    expect(offered).toContain('Write a note')
  })

  it('draws a snippet with the palette’s own renderer — «» as text, never markup', () => {
    const html = renderToStaticMarkup(
      <TermMentions rows={[unfiledDeck]} total={1} />,
    )
    const palette = renderToStaticMarkup(
      <Highlighted text={unfiledDeck.snippet ?? ''} />,
    )
    expect(html).toContain(palette)
    expect(html).toContain(
      '<span class="font-medium text-foreground">effectiveness</span>',
    )
    expect(html).not.toContain('«')
    expect(html).not.toMatch(/<b>/)
    // An unfiled document has nowhere to land, and says so by not linking.
    expect(mentionHref(unfiledDeck)).toBeNull()
    expect(html).toContain('deck')
  })

  it('sends a note to its page and a filed document to its record', () => {
    expect(mentionHref({ ...unfiledDeck, kind: 'note', subKind: 'memo' })).toBe(
      `/notes/${unfiledDeck.id}`,
    )
    expect(
      mentionHref({
        ...unfiledDeck,
        parent: {
          id: 'c0ffee00-0000-4000-8000-000000000000',
          kind: 'company',
          name: 'Coolant Labs',
          objectSlug: null,
        },
      }),
    ).toBe('/companies/c0ffee00-0000-4000-8000-000000000000')
  })
})
