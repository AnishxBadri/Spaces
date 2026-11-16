import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SUMMARY_MAX,
  feedAddressOf,
  feedLinksOf,
  iconLinksOf,
  parseFeed,
} from './feed'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const rss = (items: string, channel = '') =>
  `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title><link>https://site.example/</link>${channel}${items}</channel></rss>`

const atom = (entries: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><link rel="self" href="https://site.example/atom.xml"/><link rel="alternate" href="https://site.example/blog"/>${entries}</feed>`

describe('parseFeed on the RSS 2.0 fixture', () => {
  const feed = parseFeed(fixture('rss2.xml'))

  it('reads the channel title, the site link and every item, keyed by guid', () => {
    expect(feed?.format).toBe('rss')
    expect(feed?.title).toBe('Northwind Robotics — Newsroom')
    expect(feed?.siteUrl).toBe('https://northwind-robotics.example/news')
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
      imageUrl: null,
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
    expect(feed?.siteUrl).not.toBe(
      'https://northwind-robotics.example/news/feed.xml',
    )
  })
})

describe('parseFeed on the Atom fixture', () => {
  const feed = parseFeed(fixture('atom.xml'))

  it('reads the feed title, its alternate link and every entry, keyed by id', () => {
    expect(feed?.format).toBe('atom')
    expect(feed?.title).toBe('Contoso Labs Engineering')
    expect(feed?.siteUrl).toBe('https://contoso-labs.example/blog')
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
        imageUrl: null,
      },
      {
        key: 'tag:contoso-labs.example,2026:blog/berlin',
        title: 'Contoso Labs opens a Berlin office',
        url: 'https://contoso-labs.example/blog/berlin',
        publishedAt: '2026-09-18T07:15:00.000Z',
        summary: 'Our second office, opening in November.',
        imageUrl: null,
      },
      {
        key: 'tag:contoso-labs.example,2026:blog/seed',
        title: 'Notes from our seed round',
        url: 'https://contoso-labs.example/blog/seed',
        publishedAt: '2026-08-30T16:00:00.000Z',
        summary: 'What we learned raising £2M.',
        imageUrl: null,
      },
    ])
  })
})

describe('an item’s image, one form at a time', () => {
  const imageOf = (doc: string) => parseFeed(doc)?.items.at(0)?.imageUrl

  it.each([
    [
      'RSS enclosure of an image type',
      rss(
        '<item><guid>g</guid><enclosure url="https://cdn.example/a.jpg" length="1" type="image/jpeg"/></item>',
      ),
      'https://cdn.example/a.jpg',
    ],
    [
      'RSS enclosure of audio is not a photo',
      rss(
        '<item><guid>g</guid><enclosure url="https://cdn.example/a.mp3" type="audio/mpeg"/></item>',
      ),
      null,
    ],
    [
      'media:content with medium="image"',
      rss(
        '<item><guid>g</guid><media:content url="https://cdn.example/b" medium="image"/></item>',
      ),
      'https://cdn.example/b',
    ],
    [
      'media:content of a video type is passed over for the thumbnail',
      rss(
        '<item><guid>g</guid><media:content url="https://cdn.example/v.mp4" type="video/mp4"><media:thumbnail url="https://cdn.example/v.png"/></media:content></item>',
      ),
      'https://cdn.example/v.png',
    ],
    [
      'media:thumbnail',
      rss(
        '<item><guid>g</guid><media:thumbnail url="https://cdn.example/t.png" width="120"/></item>',
      ),
      'https://cdn.example/t.png',
    ],
    [
      'the first <img> in escaped content, made absolute against the link',
      rss(
        '<item><guid>g</guid><link>https://site.example/post/1</link><description>&lt;p&gt;&lt;img src="/img/hero.webp" alt=""&gt;Text&lt;/p&gt;&lt;img src="https://cdn.example/second.png"&gt;</description></item>',
      ),
      'https://site.example/img/hero.webp',
    ],
    [
      'the first <img> in CDATA content:encoded',
      rss(
        '<item><guid>g</guid><content:encoded><![CDATA[<figure><img class="x" src="https://cdn.example/c.png"></figure><p>Body</p>]]></content:encoded></item>',
      ),
      'https://cdn.example/c.png',
    ],
    [
      'an enclosure wins over an inline <img>',
      rss(
        '<item><guid>g</guid><description><![CDATA[<img src="https://cdn.example/inline.png">]]></description><enclosure url="https://cdn.example/enc.png" type="image/png"/></item>',
      ),
      'https://cdn.example/enc.png',
    ],
    [
      'a data: pixel is never a photo',
      rss(
        '<item><guid>g</guid><description><![CDATA[<img src="data:image/gif;base64,R0lGOD">]]></description></item>',
      ),
      null,
    ],
    [
      'Atom link rel="enclosure" of an image type',
      atom(
        '<entry><id>e</id><link rel="enclosure" type="image/png" href="https://cdn.example/e.png"/></entry>',
      ),
      'https://cdn.example/e.png',
    ],
    [
      'the first <img> in Atom xhtml content',
      atom(
        '<entry><id>e</id><link href="https://site.example/blog/e"/><content type="xhtml"><div><p><img src="pic.jpg"/>Hi</p></div></content></entry>',
      ),
      'https://site.example/blog/pic.jpg',
    ],
  ])('%s', (_name, doc, expected) => {
    expect(imageOf(doc)).toBe(expected)
  })
})

describe('parseFeed at the edges', () => {
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

  it.each([
    [
      'paragraphs survive as blank-line breaks, inline tags vanish',
      '<description><![CDATA[<p>First <b>bold</b> line.</p><p>Second<br/>line.</p>]]></description>',
      'First bold line.\n\nSecond\nline.',
    ],
    [
      'escaped HTML is decoded once, then its entities',
      '<description>&lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;&lt;p&gt;Again&lt;/p&gt;</description>',
      'Tom & Jerry\n\nAgain',
    ],
    [
      'scripts and styles say nothing',
      '<description><![CDATA[<style>p{color:red}</style><p>Kept</p><script>alert(1)</script>]]></description>',
      'Kept',
    ],
    [
      'the fuller of description and content:encoded is the body',
      '<description>Teaser.</description><content:encoded><![CDATA[<p>Teaser.</p><p>The whole story.</p>]]></content:encoded>',
      'Teaser.\n\nThe whole story.',
    ],
  ])('summary: %s', (_name, fields, expected) => {
    const feed = parseFeed(rss(`<item><guid>g</guid>${fields}</item>`))
    expect(feed?.items.at(0)?.summary).toBe(expected)
  })

  it('cuts a long summary at a word, under the cap', () => {
    const feed = parseFeed(
      rss(
        `<item><guid>g</guid><description>${'word '.repeat(600)}</description></item>`,
      ),
    )
    const summary = feed?.items.at(0)?.summary ?? ''
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX)
    expect(summary.length).toBeGreaterThan(SUMMARY_MAX - 10)
    expect(summary.endsWith('word…')).toBe(true)
  })

  it('is null for a document that is neither RSS nor Atom', () => {
    expect(parseFeed('<html><body>Not found</body></html>')).toBeNull()
    expect(parseFeed('{"items": []}')).toBeNull()
  })
})

describe('feedLinksOf', () => {
  it('reads RSS and Atom alternates in order, absolute against the page', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/s.css">
      <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/">
      <link rel="alternate" hreflang="fr" href="/fr/">
      <link type="application/atom+xml" rel="alternate" href="https://other.example/atom">
      <link rel="alternate" type="application/json" href="/feed.json">
    </head></html>`
    expect(feedLinksOf(html, 'https://spacenews.com/')).toEqual([
      'https://spacenews.com/feed/',
      'https://other.example/atom',
    ])
  })

  it('is empty for a page with no feed', () => {
    expect(
      feedLinksOf('<html><head></head></html>', 'https://x.example/'),
    ).toEqual([])
  })
})

describe('the feed’s own image', () => {
  it('is the RSS channel’s <image><url>, absolute against the site', () => {
    const feed = parseFeed(
      rss(
        '<item><guid>a</guid><title>A</title><enclosure url="https://cdn.example/a.jpg" type="image/jpeg"/></item>',
        '<image><url>/logo.png</url><title>T</title><link>https://site.example/</link></image>',
      ),
    )
    expect(feed?.imageUrl).toBe('https://site.example/logo.png')
  })

  it('is the itunes:image when the channel has no <image>', () => {
    const feed = parseFeed(
      rss('', '<itunes:image href="https://cdn.example/show.jpg"/>'),
    )
    expect(feed?.imageUrl).toBe('https://cdn.example/show.jpg')
  })

  it('is never an item’s photo', () => {
    const feed = parseFeed(
      rss(
        '<item><guid>a</guid><image><url>https://cdn.example/item.png</url></image></item>',
      ),
    )
    expect(feed?.imageUrl).toBeNull()
  })

  it('is Atom’s <logo>, else its <icon>', () => {
    expect(
      parseFeed(
        atom(
          '<icon>/favicon.png</icon><logo>https://site.example/logo.png</logo>',
        ),
      )?.imageUrl,
    ).toBe('https://site.example/logo.png')
    expect(parseFeed(atom('<icon>/favicon.png</icon>'))?.imageUrl).toBe(
      'https://site.example/favicon.png',
    )
  })

  it('is null when the feed names none', () => {
    expect(parseFeed(fixture('rss2.xml'))?.imageUrl).toBeNull()
    expect(parseFeed(fixture('atom.xml'))?.imageUrl).toBeNull()
  })
})

describe('iconLinksOf', () => {
  it('lists icons, then apple-touch-icons, then /favicon.ico, each once', () => {
    const html = `<html><head>
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="stylesheet" href="/s.css">
      <link rel="shortcut icon" href="/favicon.ico">
      <link rel="icon" type="image/png" sizes="32x32" href="https://cdn.example/32.png">
    </head></html>`
    expect(iconLinksOf(html, 'https://spacenews.com/news/')).toEqual([
      'https://spacenews.com/favicon.ico',
      'https://cdn.example/32.png',
      'https://spacenews.com/touch.png',
    ])
  })

  it('is /favicon.ico at the origin for a page that names no icon', () => {
    expect(
      iconLinksOf('<html><head></head></html>', 'https://x.example/a/b'),
    ).toEqual(['https://x.example/favicon.ico'])
  })
})

describe('feedAddressOf', () => {
  it.each([
    ['spacenews.com', 'https://spacenews.com/'],
    ['  https://site.example/feed.xml ', 'https://site.example/feed.xml'],
    ['http://site.example', 'http://site.example/'],
    ['ftp://site.example', null],
    ['not a url', null],
    ['', null],
  ])('%s', (typed, expected) => {
    expect(feedAddressOf(typed)).toBe(expected)
  })
})
