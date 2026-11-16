import { describe, expect, it } from 'vitest'
import type { FeedSource, Headline } from '#/lib/server-fns'
import {
  askDraft,
  byDay,
  dayBand,
  failingLine,
  filterSpaces,
  fixNotice,
  hasFeedUnder,
  headlinesOnlyLine,
  noFeedLine,
  paragraphsOf,
  removeBody,
  selectedOf,
  siteOf,
  spacesLine,
  storyStamp,
} from './feed-words'

const source = (over: Partial<FeedSource> = {}): FeedSource => ({
  id: 'f1',
  name: 'Orbit Notes',
  url: 'https://orbitnotes.substack.com/feed',
  siteUrl: 'https://orbitnotes.substack.com/',
  logoSha: null,
  logoUrl: null,
  state: 'failing',
  lastFetchedAt: '2026-11-16T09:00:00.000Z',
  lastSuccessAt: '2026-11-13T09:00:00.000Z',
  lastError: 'The site answered 404',
  spaces: [],
  headlineCount: 0,
  newestAt: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  ...over,
})

const TODAY = '2026-11-16'

describe('the failing feed', () => {
  it('reads since its last good fetch, else since it was added', () => {
    expect(failingLine(source(), TODAY)).toBe("Couldn't fetch since 13 Nov")
    expect(failingLine(source({ lastSuccessAt: null }), TODAY)).toBe(
      "Couldn't fetch since 1 Oct",
    )
  })

  it('says a 404 or a 410 likely moved the feed, and any other reason as it stands', () => {
    expect(fixNotice(source(), TODAY)).toBe(
      "Couldn't fetch since 13 Nov. The site answered 404, so the feed has likely moved.",
    )
    expect(
      fixNotice(source({ lastError: 'The site answered 410' }), TODAY),
    ).toContain('so the feed has likely moved.')
    expect(fixNotice(source({ lastError: 'Timed out' }), TODAY)).toBe(
      "Couldn't fetch since 13 Nov. Timed out.",
    )
    expect(fixNotice(source({ lastError: null }), TODAY)).toBe(
      "Couldn't fetch since 13 Nov.",
    )
  })
})

describe('the Spaces lane', () => {
  it('prints each space by its path, a space the list lacks by its own name', () => {
    const pathOf = new Map([['s1', 'Aerospace › Launch']])
    expect(
      spacesLine(
        [
          { id: 's1', name: 'Launch' },
          { id: 's2', name: 'Proptech' },
        ],
        pathOf,
      ),
    ).toBe('Aerospace › Launch, Proptech')
    expect(spacesLine([], pathOf)).toBe('')
  })
})

describe('Remove…', () => {
  it('says how many headlines go with the feed, and nothing when it holds none', () => {
    expect(removeBody(0)).toBeUndefined()
    expect(removeBody(1)).toBe('Its one headline goes with it.')
    expect(removeBody(1214)).toBe('Its 1,214 headlines go with it.')
  })
})

const headline = (over: Partial<Headline> = {}): Headline => ({
  id: 'h1',
  feedId: 'f1',
  feedName: 'SpaceNews',
  siteUrl: 'https://www.spacenews.com/',
  logoSha: null,
  logoUrl: null,
  title: 'Skyroot static-fires the Vikram-1 third stage',
  url: 'https://spacenews.com/skyroot',
  summary: null,
  publishedAt: '2026-11-16T10:12:00',
  imageSha: null,
  photoUrl: null,
  photoPending: false,
  ...over,
})

describe('Headlines', () => {
  it('bands stories by day: Today, Yesterday, then the weekday and day', () => {
    const groups = byDay(
      [
        headline({ id: 'a', publishedAt: '2026-11-16T10:12:00' }),
        headline({ id: 'b', publishedAt: '2026-11-16T07:30:00' }),
        headline({ id: 'c', publishedAt: '2026-11-15T18:20:00' }),
        headline({ id: 'd', publishedAt: '2026-11-13T15:05:00' }),
        headline({ id: 'e', publishedAt: '2025-12-31T15:05:00' }),
      ],
      TODAY,
    )
    expect(groups.map((g) => [g.label, g.headlines.map((h) => h.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Fri 13 Nov', ['d']],
      ['Wed 31 Dec 2025', ['e']],
    ])
    expect(dayBand('2026-11-16T00:01:00', TODAY)).toBe('Today')
  })

  it('stamps the reader with the day and the time', () => {
    expect(storyStamp('2026-11-16T10:12:00', TODAY)).toBe('16 Nov · 10:12')
  })

  it('splits the summary on blank lines and drops empty paragraphs', () => {
    expect(paragraphsOf('One.\n\nTwo\nlines.\n \n\nThree.  ')).toEqual([
      'One.',
      'Two\nlines.',
      'Three.',
    ])
    expect(paragraphsOf(null)).toEqual([])
    expect(paragraphsOf('  \n\n ')).toEqual([])
  })

  it('names the site a story continues on, the article’s host first', () => {
    expect(siteOf(headline())).toBe('spacenews.com')
    expect(siteOf(headline({ url: null }))).toBe('spacenews.com')
    expect(siteOf(headline({ url: 'not a url', siteUrl: null }))).toBeNull()
  })

  it('says what a headlines-only feed and an untagged space read as', () => {
    expect(headlinesOnlyLine('The Ken')).toBe(
      'The Ken sends headlines only. The story is on its site.',
    )
    expect(noFeedLine('Aerospace › Launch')).toBe(
      'No feed is tagged to Aerospace › Launch.',
    )
  })

  it('hands Ask the headline and its link', () => {
    expect(askDraft(headline())).toBe(
      'Skyroot static-fires the Vikram-1 third stage\nhttps://spacenews.com/skyroot\n\n',
    )
    expect(askDraft(headline({ url: null }))).toBe(
      'Skyroot static-fires the Vikram-1 third stage\n\n',
    )
  })

  it('selects the chosen story while it is listed, else the newest', () => {
    const list = [headline({ id: 'a' }), headline({ id: 'b' })]
    expect(selectedOf(list, 'b')?.id).toBe('b')
    expect(selectedOf(list, 'gone')?.id).toBe('a')
    expect(selectedOf(list, null)?.id).toBe('a')
    expect(selectedOf([], null)).toBeNull()
  })
})

describe('the space filter', () => {
  const tags = (...ids: Array<string>) => ({
    spaces: ids.map((id) => ({ id, name: id })),
  })
  const parentOf = new Map<string, string | null>([
    ['aero', null],
    ['launch', 'aero'],
    ['prop', null],
    ['fin', null],
  ])

  it('offers each tagged space once, by path', () => {
    const pathOf = new Map([
      ['launch', 'Aerospace › Launch'],
      ['prop', 'Proptech'],
    ])
    expect(
      filterSpaces([tags('prop', 'launch'), tags('launch')], pathOf),
    ).toEqual([
      { id: 'launch', path: 'Aerospace › Launch' },
      { id: 'prop', path: 'Proptech' },
    ])
  })

  it('counts a feed tagged under a space as that space’s', () => {
    const sources = [tags('launch'), tags('prop')]
    expect(hasFeedUnder('launch', sources, parentOf)).toBe(true)
    expect(hasFeedUnder('aero', sources, parentOf)).toBe(true)
    expect(hasFeedUnder('fin', sources, parentOf)).toBe(false)
  })
})
