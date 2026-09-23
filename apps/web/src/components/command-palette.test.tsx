import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SearchHit } from '#/lib/search/query'
import { HitLine, hitMeta, hrefFor } from './command-palette'

/**
 * The palette's task branch (SPA-55). Asserted over the row's content and
 * its destination rather than the dialog: `CommandPalette` wants a router
 * and a Radix portal, and the suite runs on `environment: 'node'` with no
 * DOM. `renderToStaticMarkup` is the server render the app ships through
 * (`routes/_app/inbox.test.tsx`). `go(href)` is the row's whole `onSelect`,
 * so `hrefFor` is where a selected hit lands.
 */

const taskHit = (done: boolean, dueDate: string | null): SearchHit => ({
  rowKind: 'task',
  id: '5f0c1a52-3e0b-4a8e-9b61-000000000001',
  kind: 'task',
  name: 'Ask the founders how much runway is left',
  objectSlug: null,
  snippet: 'how much «runway» is left',
  matchedIn: 'task',
  parent: null,
  task: { dueDate, done },
})

const companyHit: SearchHit = {
  rowKind: 'entity',
  id: '5f0c1a52-3e0b-4a8e-9b61-000000000001',
  kind: 'company',
  name: 'Runway',
  objectSlug: null,
  snippet: null,
  matchedIn: 'name',
  parent: null,
  task: null,
}

describe('the palette task row', () => {
  it('routes a task hit to /tasks, and an entity with the same id to its record', () => {
    expect(hrefFor(taskHit(false, null))).toBe('/tasks')
    expect(hrefFor(companyHit)).toBe(`/companies/${companyHit.id}`)
  })

  it('draws a checkbox icon and the due date in the mono lane', () => {
    const html = renderToStaticMarkup(
      <HitLine hit={taskHit(false, '2026-10-01')} />,
    )
    expect(html).toContain('lucide-square-check')
    expect(html).toMatch(/class="[^"]*mono[^"]*">2026-10-01</)
    expect(html).not.toContain('line-through')
    // The snippet is text with the match set in a span — never markup.
    expect(html).toContain(
      '<span class="font-medium text-foreground">runway</span>',
    )
  })

  it('says a dateless task has no date', () => {
    const html = renderToStaticMarkup(<HitLine hit={taskHit(false, null)} />)
    expect(html).toMatch(/class="[^"]*mono[^"]*">no date</)
  })

  it('strikes a done task through', () => {
    const html = renderToStaticMarkup(
      <HitLine hit={taskHit(true, '2026-09-01')} />,
    )
    expect(html).toMatch(
      /class="[^"]*line-through[^"]*">Ask the founders how much runway is left</,
    )
  })

  it('leaves an entity row as it was', () => {
    const html = renderToStaticMarkup(<HitLine hit={companyHit} />)
    expect(html).toContain('lucide-building')
    expect(html).not.toContain('lucide-square-check')
    expect(html).toMatch(/class="[^"]*mono[^"]*">company</)
  })
})

/**
 * A row the second wave found by meaning alone (SPA-129): `matchedIn:
 * 'semantic'`, a plain 160-character cut of the nearest chunk, and a meta
 * lane that says why it is here.
 */
const meaningSnippet =
  'Our direct-to-chip liquid loop moves thermal load off the server floor. Cold plates sit on each accelerator and the warm water leaves the building through a'

const deckByMeaning: SearchHit = {
  rowKind: 'entity',
  id: '5f0c1a52-3e0b-4a8e-9b61-000000000002',
  kind: 'document',
  name: 'Coldplate Series A.pdf',
  objectSlug: null,
  snippet: meaningSnippet,
  matchedIn: 'semantic',
  parent: {
    id: '5f0c1a52-3e0b-4a8e-9b61-000000000003',
    kind: 'company',
    name: 'Coldplate Systems',
    objectSlug: null,
  },
  task: null,
}

describe('the palette row for a hit found by meaning', () => {
  it('reads · meaning in the mono lane, beside the record it is filed on', () => {
    expect(hitMeta(deckByMeaning)).toBe('in Coldplate Systems · meaning')
    expect(
      hitMeta({
        ...companyHit,
        kind: 'note',
        matchedIn: 'semantic',
      }),
    ).toBe('note · meaning')
    // The lexical lanes read as they did.
    expect(hitMeta({ ...companyHit, kind: 'note', matchedIn: 'note' })).toBe(
      'note · text',
    )
    expect(hitMeta({ ...deckByMeaning, matchedIn: 'document' })).toBe(
      'in Coldplate Systems',
    )
  })

  it('renders the plain snippet as text: one span, nothing set as a match', () => {
    const html = renderToStaticMarkup(<HitLine hit={deckByMeaning} />)
    expect(html).toMatch(
      /class="[^"]*mono[^"]*">in Coldplate Systems · meaning</,
    )
    expect(html).toContain(`<span>${meaningSnippet}</span>`)
    expect(html).not.toContain('font-medium text-foreground')
  })

  it("keeps cmdk's own filter off, so the second wave's rows are shown as ranked", () => {
    const source = readFileSync(
      new URL('./command-palette.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('shouldFilter={false}')
  })
})
