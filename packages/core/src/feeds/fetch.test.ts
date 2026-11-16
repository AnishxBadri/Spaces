import { describe, expect, it } from 'vitest'
import { FEED_REASONS, fetchFailureOf, itemRowsOf } from './fetch'
import type { FeedItem } from './feed'

describe('fetchFailureOf', () => {
  it.each([
    [
      { kind: 'network', reason: 'x', status: 404 },
      'The site answered 404',
      false,
    ],
    [
      { kind: 'network', reason: 'x', status: 410 },
      'The site answered 410',
      false,
    ],
    [
      { kind: 'network', reason: 'x', status: 429 },
      'The site answered 429',
      true,
    ],
    [
      { kind: 'network', reason: 'x', status: 503 },
      'The site answered 503',
      true,
    ],
    [
      { kind: 'network', reason: 'x', timedOut: true },
      FEED_REASONS.timedOut,
      true,
    ],
    [{ kind: 'network', reason: 'ECONNRESET' }, FEED_REASONS.unreachable, true],
    [
      { kind: 'refused', reason: 'x', tooLarge: true },
      FEED_REASONS.tooLarge,
      false,
    ],
    [
      { kind: 'refused', reason: '10.0.0.1 is a private address' },
      '10.0.0.1 is a private address',
      false,
    ],
  ] as const)('%o', (failed, reason, retryable) => {
    expect(fetchFailureOf(failed)).toMatchObject({ reason, retryable })
  })
})

describe('itemRowsOf', () => {
  const now = new Date('2026-11-16T12:00:00.000Z')
  const item = (over: Partial<FeedItem>): FeedItem => ({
    key: 'k',
    title: 'Title',
    url: null,
    publishedAt: '2026-11-15T00:00:00.000Z',
    summary: null,
    imageUrl: null,
    ...over,
  })

  it('dates an undated item, and one from the future, at first seen', () => {
    const rows = itemRowsOf(
      [
        item({ key: 'a', publishedAt: null }),
        item({ key: 'b', publishedAt: '2027-01-01T00:00:00.000Z' }),
      ],
      now,
    )
    expect(rows.map((r) => r.publishedAt.toISOString())).toEqual([
      now.toISOString(),
      now.toISOString(),
    ])
  })

  it('never stores an item already past ninety days, nor a repeated key', () => {
    const rows = itemRowsOf(
      [
        item({ key: 'old', publishedAt: '2026-08-01T00:00:00.000Z' }),
        item({ key: 'new' }),
        item({ key: 'new', title: 'Again' }),
      ],
      now,
    )
    expect(rows.map((r) => [r.key, r.title])).toEqual([['new', 'Title']])
  })

  it('titles an untitled item from its summary, then its link, then its key', () => {
    const rows = itemRowsOf(
      [
        item({ key: 'a', title: null, summary: 'First line.\n\nMore.' }),
        item({ key: 'b', title: '', url: 'https://x.example/b' }),
        item({ key: 'c', title: null }),
      ],
      now,
    )
    expect(rows.map((r) => r.title)).toEqual([
      'First line.',
      'https://x.example/b',
      'c',
    ])
  })
})
