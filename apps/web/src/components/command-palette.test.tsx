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
 * DOM. `renderToStaticMarkup` is the server render the app ships through.
 * `go(href)` is the row's whole `onSelect`,
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

const TODAY = '2026-10-10'

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

  it('draws a checkbox icon and the due day in the mono lane', () => {
    const html = renderToStaticMarkup(
      <HitLine hit={taskHit(false, '2026-10-01')} today={TODAY} />,
    )
    expect(html).toContain('lucide-square-check')
    expect(html).toMatch(/class="[^"]*mono[^"]*">1 Oct</)
    expect(html).not.toContain('line-through')
    // The inline snippet column is gone: the name and the lane only.
    expect(html).not.toContain('runway»')
    expect(html).not.toContain('>how much <')
  })

  it('prints no lane for a dateless task', () => {
    const html = renderToStaticMarkup(
      <HitLine hit={taskHit(false, null)} today={TODAY} />,
    )
    expect(html).not.toContain('data-lane')
  })

  it('strikes a done task through', () => {
    const html = renderToStaticMarkup(
      <HitLine hit={taskHit(true, '2026-09-01')} today={TODAY} />,
    )
    expect(html).toMatch(
      /class="[^"]*line-through[^"]*">Ask the founders how much runway is left</,
    )
  })

  it('draws an entity row with its kind glyph', () => {
    const html = renderToStaticMarkup(
      <HitLine hit={companyHit} today={TODAY} />,
    )
    expect(html).toContain('lucide-building')
    expect(html).not.toContain('lucide-square-check')
  })

  it('draws a record’s stored picture in place of its kind icon', () => {
    const picture = 'http://localhost:3000/api/blob/abc?exp=1&sig=x'
    const html = renderToStaticMarkup(
      <HitLine hit={{ ...companyHit, picture }} today={TODAY} />,
    )
    expect(html).toContain(`src="${picture.replaceAll('&', '&amp;')}"`)
    expect(html).toContain('object-cover')
    expect(html).not.toContain('lucide-building')
  })
})

describe('the record lane', () => {
  const lane = {
    singular: 'Company',
    stage: 'Seed',
    space: 'Proptech › Property ops',
    day: null,
  }
  it('prints a company’s first space path and a deal’s stage, and nothing else', () => {
    expect(hitMeta({ ...companyHit, lane }, TODAY)).toBe(
      'Proptech › Property ops',
    )
    expect(
      hitMeta(
        {
          ...companyHit,
          kind: 'deal',
          lane: { ...lane, singular: 'Deal', stage: 'Diligence', space: null },
        },
        TODAY,
      ),
    ).toBe('Diligence')
    expect(hitMeta({ ...companyHit, kind: 'person', lane }, TODAY)).toBeNull()
    // No lane read, no lane.
    expect(hitMeta(companyHit, TODAY)).toBeNull()
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
    // A note's day rides on its kind lane.
    const note = splitHits([
      {
        ...hit('n', 'note', null),
        lane: { singular: null, stage: null, space: null, day: '2026-10-04' },
      },
    ]).passages.at(0)
    expect(note?.day).toBe('2026-10-04')
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
  day: null,
}

describe('the palette passage row', () => {
  it('names the file and its page, a note by title and day, and goes to the record the file is filed on', () => {
    expect(passageMeta(deckPassage, TODAY)).toBe('Coldplate Series A.pdf · p.5')
    expect(passageMeta({ ...deckPassage, page: null }, TODAY)).toBe(
      'Coldplate Series A.pdf',
    )
    expect(passageHref(deckPassage)).toBe(
      '/companies/5f0c1a52-3e0b-4a8e-9b61-000000000003',
    )
    expect(passageHref({ ...deckPassage, parent: null })).toBeNull()
    const note = {
      ...deckPassage,
      kind: 'note',
      name: 'IC call',
      page: null,
      day: '2026-10-04T09:30:00.000Z',
    }
    expect(passageMeta(note, TODAY)).toBe('IC call · 4 Oct')
    expect(passageMeta({ ...note, day: '2025-03-01' }, TODAY)).toBe(
      'IC call · 1 Mar 2025',
    )
    expect(passageMeta({ ...note, day: null }, TODAY)).toBe('IC call')
  })

  it("keeps cmdk's own filter off, so the server's order is the order shown", () => {
    const source = readFileSync(
      new URL('./command-palette.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('shouldFilter={false}')
  })
})
