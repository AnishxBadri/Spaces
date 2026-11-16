import { describe, expect, it } from 'vitest'
import type { FeedSource } from '#/lib/server-fns'
import {
  failingLine,
  fixNotice,
  logoOf,
  removeBody,
  spacesLine,
} from './feed-words'

const source = (over: Partial<FeedSource> = {}): FeedSource => ({
  id: 'f1',
  name: 'Orbit Notes',
  url: 'https://orbitnotes.substack.com/feed',
  siteUrl: 'https://orbitnotes.substack.com/',
  logoSha: null,
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

describe('the logo', () => {
  it('is the stored logo once the source carries one, else none', () => {
    expect(logoOf(source())).toBeNull()
    const stored = { ...source(), logoUrl: '/api/blobs/abc' }
    expect(logoOf(stored)).toBe('/api/blobs/abc')
  })
})
