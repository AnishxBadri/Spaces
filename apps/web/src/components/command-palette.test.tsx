import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { Passage } from '#/lib/search/passages'
import type { SearchHit } from '#/lib/search/query'
import {
  HitLine,
  hitMeta,
  hrefFor,
  mergePassages,
  passageHref,
  passageMeta,
  splitHits,
} from './command-palette'

/**
 * The palette's record and passage rows. Asserted over the row's content and
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

  it('draws a record’s stored picture in place of its kind icon', () => {
    const picture = 'http://localhost:3000/api/blob/abc?exp=1&sig=x'
    const html = renderToStaticMarkup(
      <HitLine hit={{ ...companyHit, picture }} />,
    )
    expect(html).toContain(`src="${picture.replaceAll('&', '&amp;')}"`)
    expect(html).toContain('object-cover')
    expect(html).not.toContain('lucide-building')
  })
})

describe('the kind lane', () => {
  it('prints the kind, the stage word and the first filed space, not the plural slug', () => {
    expect(
      hitMeta({
        ...companyHit,
        objectSlug: 'companies',
        lane: {
          singular: 'Company',
          stage: 'Seed',
          space: 'Proptech › Property ops',
        },
      }),
    ).toBe('company · seed · Proptech › Property ops')
    expect(
      hitMeta({
        ...companyHit,
        kind: 'deal',
        objectSlug: 'deals',
        lane: { singular: 'Deal', stage: 'Diligence', space: null },
      }),
    ).toBe('deal · diligence')
    // No lane read: the kind alone, never the slug.
    expect(hitMeta({ ...companyHit, objectSlug: 'companies' })).toBe('company')
  })
})

describe('Records and Passages', () => {
  const hit = (
    id: string,
    kind: string,
    snippet: string | null,
  ): SearchHit => ({
    ...companyHit,
    id,
    kind,
    name: id,
    snippet,
  })

  it('sends a note or a file to Passages with its snippet, and keeps records and tasks in Records', () => {
    const task = taskHit(false, null)
    const { records, passages } = splitHits([
      hit('Vayu Orbital', 'company', null),
      hit('Vayu — first call', 'note', 'the «Vayu» thesis'),
      hit('Vayu deck.pdf', 'document', null),
      task,
    ])
    expect(records.map((h) => h.id)).toEqual(['Vayu Orbital', task.id])
    expect(passages.map((p) => [p.id, p.kind, p.snippet, p.page])).toEqual([
      ['Vayu — first call', 'note', 'the «Vayu» thesis', null],
      ['Vayu deck.pdf', 'document', '', null],
    ])
  })

  it('lists the lexical passages first, then the semantic lane’s new ones', () => {
    const { passages } = splitHits([hit('n1', 'note', 'a «word»')])
    const semantic = [
      { ...deckPassage, id: 'n1' },
      { ...deckPassage, id: 'd2' },
    ]
    expect(mergePassages(passages, semantic).map((p) => p.id)).toEqual([
      'n1',
      'd2',
    ])
  })
})

/**
 * A passage: the semantic lane's own row, never a Records row. Its path
 * lane names the file and page; it goes to the record the file is filed on.
 */
const deckPassage: Passage = {
  id: '5f0c1a52-3e0b-4a8e-9b61-000000000002',
  kind: 'document',
  name: 'Coldplate Series A.pdf',
  objectSlug: null,
  snippet: 'Our direct-to-chip liquid loop moves thermal load off the floor.',
  page: 5,
  parent: {
    id: '5f0c1a52-3e0b-4a8e-9b61-000000000003',
    kind: 'company',
    name: 'Coldplate Systems',
    objectSlug: null,
  },
}

describe('the palette passage row', () => {
  it('names the file and its page, and goes to the record the file is filed on', () => {
    expect(passageMeta(deckPassage)).toBe('Coldplate Series A.pdf · p.5')
    expect(passageMeta({ ...deckPassage, page: null })).toBe(
      'Coldplate Series A.pdf',
    )
    expect(passageHref(deckPassage)).toBe(
      '/companies/5f0c1a52-3e0b-4a8e-9b61-000000000003',
    )
    expect(passageHref({ ...deckPassage, parent: null })).toBeNull()
    expect(
      passageMeta({
        ...deckPassage,
        kind: 'note',
        name: 'IC call',
        page: null,
      }),
    ).toBe('note · IC call')
  })

  it("keeps cmdk's own filter off, so the server's order is the order shown", () => {
    const source = readFileSync(
      new URL('./command-palette.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('shouldFilter={false}')
  })
})
