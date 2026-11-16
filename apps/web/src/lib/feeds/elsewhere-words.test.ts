import { describe, expect, it } from 'vitest'
import {
  feedWatchLine,
  headlineFeedsLine,
  newHeadlinesLine,
} from './elsewhere-words'

describe('the words feeds print outside the Feeds page', () => {
  it('counts the day’s headlines', () => {
    expect(newHeadlinesLine(14)).toBe('14 new headlines')
    expect(newHeadlinesLine(1)).toBe('1 new headline')
  })

  it('names three feeds whole and past three, two and the rest', () => {
    expect(headlineFeedsLine(['SpaceNews'])).toBe('Feeds · SpaceNews')
    expect(headlineFeedsLine(['SpaceNews', 'Inc42'])).toBe(
      'Feeds · SpaceNews and Inc42',
    )
    expect(headlineFeedsLine(['SpaceNews', 'Inc42', 'TechCrunch'])).toBe(
      'Feeds · SpaceNews, Inc42 and TechCrunch',
    )
    expect(headlineFeedsLine(['SpaceNews', 'Inc42', 'A', 'B', 'C'])).toBe(
      'Feeds · SpaceNews, Inc42 and 3 more',
    )
  })

  it('times a feed by its newest headline, a dash before the first', () => {
    const now = new Date(2026, 10, 16, 12, 0).toISOString()
    expect(
      feedWatchLine(new Date(2026, 10, 16, 10, 12).toISOString(), now),
    ).toBe('feed · 10:12')
    expect(
      feedWatchLine(new Date(2026, 10, 15, 10, 12).toISOString(), now),
    ).toBe('feed · 15 Nov')
    expect(feedWatchLine(null, now)).toBe('feed · —')
  })
})
