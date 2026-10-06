import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUMMARY_MAX, parseFeed } from './feed.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

describe('parseFeed on the RSS 2.0 fixture', () => {
  const feed = parseFeed(fixture('rss2.xml'))

  it('reads the channel title and every item, keyed by guid', () => {
    expect(feed?.format).toBe('rss')
    expect(feed?.title).toBe('Northwind Robotics — Newsroom')
    expect(feed?.items.map((i) => i.key)).toEqual([
      'northwind-news-0004',
      'northwind-news-0003',
      'https://northwind-robotics.example/news/grocer-pilot',
      'northwind-news-0001',
    ])
  })

  it('decodes entities and CDATA and reduces escaped HTML to text', () => {
    expect(feed?.items.at(0)).toEqual({
      key: 'northwind-news-0004',
      title: 'Northwind closes its Series B',
      url: 'https://northwind-robotics.example/news/series-b',
      publishedAt: '2026-10-05T09:00:00.000Z',
      summary: 'Northwind raised $40M led by Example Ventures & friends.',
    })
    expect(feed?.items.at(1)).toMatchObject({
      title: 'Hiring: 3 field engineers for the R&D lab',
      publishedAt: '2026-09-24T14:30:00.000Z',
      summary: 'We are growing the field team.',
    })
    expect(feed?.items.at(2)).toMatchObject({
      title: 'Pilot with a regional grocer — phase two',
      publishedAt: '2026-09-10T08:00:00.000Z',
    })
    expect(feed?.items.at(3)?.summary).toBeNull()
  })

  it("never reads the channel's atom:link as its link", () => {
    expect(feed?.items.map((i) => i.url)).not.toContain(
      'https://northwind-robotics.example/news/feed.xml',
    )
  })
})

describe('parseFeed on the Atom fixture', () => {
  const feed = parseFeed(fixture('atom.xml'))

  it('reads the feed title and every entry, keyed by id', () => {
    expect(feed?.format).toBe('atom')
    expect(feed?.title).toBe('Contoso Labs Engineering')
    expect(feed?.items.map((i) => i.key)).toEqual([
      'tag:contoso-labs.example,2026:blog/engine-v2',
      'tag:contoso-labs.example,2026:blog/berlin',
      'tag:contoso-labs.example,2026:blog/seed',
    ])
  })

  it('takes the alternate link, published over updated, and summary or content as text', () => {
    expect(feed?.items).toEqual([
      {
        key: 'tag:contoso-labs.example,2026:blog/engine-v2',
        title: 'Shipping v2 of the inference engine',
        url: 'https://contoso-labs.example/blog/engine-v2',
        publishedAt: '2026-10-02T12:00:00.000Z',
        summary: 'Twice the throughput on the same hardware.',
      },
      {
        key: 'tag:contoso-labs.example,2026:blog/berlin',
        title: 'Contoso Labs opens a Berlin office',
        url: 'https://contoso-labs.example/blog/berlin',
        publishedAt: '2026-09-18T07:15:00.000Z',
        summary: 'Our second office, opening in November.',
      },
      {
        key: 'tag:contoso-labs.example,2026:blog/seed',
        title: 'Notes from our seed round',
        url: 'https://contoso-labs.example/blog/seed',
        publishedAt: '2026-08-30T16:00:00.000Z',
        summary: 'What we learned raising £2M.',
      },
    ])
  })
})

describe('parseFeed at the edges', () => {
  const rss = (items: string) =>
    `<rss version="2.0"><channel><title>T</title>${items}</channel></rss>`

  it('keys an item with no guid by its link, and drops one with neither', () => {
    const feed = parseFeed(
      rss(
        '<item><title>a</title><link>https://x.example/a</link></item>' +
          '<item><title>no key</title></item>',
      ),
    )
    expect(feed?.items.map((i) => [i.key, i.title])).toEqual([
      ['https://x.example/a', 'a'],
    ])
  })

  it('leaves a date that does not parse as null', () => {
    const feed = parseFeed(
      rss('<item><guid>g</guid><pubDate>last Tuesday</pubDate></item>'),
    )
    expect(feed?.items.at(0)?.publishedAt).toBeNull()
  })

  it('cuts a long summary', () => {
    const feed = parseFeed(
      rss(
        `<item><guid>g</guid><description>${'word '.repeat(200)}</description></item>`,
      ),
    )
    const summary = feed?.items.at(0)?.summary ?? ''
    expect(summary.length).toBe(SUMMARY_MAX)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('is null for a document that is neither RSS nor Atom', () => {
    expect(parseFeed('<html><body>Not found</body></html>')).toBeNull()
    expect(parseFeed('{"items": []}')).toBeNull()
  })
})
