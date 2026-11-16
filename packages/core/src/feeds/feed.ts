import { DateTime, Option } from 'effect'

/**
 * RSS 2.0 and Atom, read with string matching rather than an XML parser.
 * - Enough for the two formats' fields: exact element names (so RSS's
 *   `<atom:link>` is never read as `<link>`), CDATA, the XML entities.
 * - An item's key is its `guid` (RSS) or `id` (Atom), else its link; an
 *   item with neither is dropped, since it cannot be deduped.
 * - The summary is the feed's own text in plain paragraphs: the reader's
 *   only body, because the article page is never fetched.
 * - Pure: no ports, no clock.
 */

export type FeedItem = {
  readonly key: string
  readonly title: string | null
  readonly url: string | null
  /** ISO-8601, or null when the feed gave no date that parses. */
  readonly publishedAt: string | null
  /** Plain paragraphs split by a blank line, at most `SUMMARY_MAX` characters. */
  readonly summary: string | null
  /** An absolute http(s) URL of the item's photo, when it names one. */
  readonly imageUrl: string | null
}

export type Feed = {
  readonly format: 'rss' | 'atom'
  readonly title: string | null
  /** The site the feed belongs to (RSS channel link, Atom alternate link). */
  readonly siteUrl: string | null
  /**
   * The feed's own picture, absolute http(s): RSS `<image><url>` or
   * `itunes:image`, Atom `<logo>` or `<icon>`. What a source's logo is
   * fetched from first.
   */
  readonly imageUrl: string | null
  /** In document order: newest first, by convention. */
  readonly items: ReadonlyArray<FeedItem>
}

/** Enough for the reader to show a story's opening, short of the article. */
export const SUMMARY_MAX = 1500

const ENTITIES: { readonly [name: string]: string } = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(ref.slice(2), 16))
    if (ref.startsWith('#'))
      return String.fromCodePoint(Number.parseInt(ref.slice(1), 10))
    return ENTITIES[ref.toLowerCase()] ?? whole
  })

const BLOCK =
  /<\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote|section|article|figure|figcaption|pre|hr)\b[^>]*>/gi

/** Tags whose content is never text a reader should see. */
const NOISE = /<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g

/**
 * An element's inner content as HTML: CDATA kept as is, escaped markup
 * outside it decoded once, raw child tags (Atom xhtml) kept.
 */
const htmlOf = (inner: string): string => {
  let out = ''
  let last = 0
  for (const match of inner.matchAll(CDATA)) {
    out += decode(inner.slice(last, match.index))
    out += match.at(1) ?? ''
    last = match.index + match[0].length
  }
  return out + decode(inner.slice(last))
}

/** One line of words: a title, a name. */
const plain = (inner: string): string =>
  decode(
    htmlOf(inner)
      .replace(NOISE, ' ')
      .replace(BLOCK, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()

/** Paragraphs a block tag or a blank line separates; inline tags vanish. */
const paragraphs = (inner: string): string =>
  decode(
    htmlOf(inner)
      .replace(NOISE, ' ')
      .replace(BLOCK, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line !== '')
        .join('\n'),
    )
    .filter((p) => p !== '')
    .join('\n\n')

/** Cut at a word boundary under the cap, ending in an ellipsis. */
const capped = (text: string): string => {
  if (text.length <= SUMMARY_MAX) return text
  const room = text.slice(0, SUMMARY_MAX - 1)
  const space = room.search(/\s\S*$/)
  const cut = space > SUMMARY_MAX / 2 ? room.slice(0, space) : room
  return `${cut.trimEnd()}…`
}

type Element = { readonly attrs: string; readonly inner: string }

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every `<name …>…</name>` and `<name …/>` in `xml`, in order. */
const elements = (xml: string, name: string): ReadonlyArray<Element> => {
  const n = escapeName(name)
  const pattern = new RegExp(
    `<${n}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${n}\\s*>)`,
    'g',
  )
  return [...xml.matchAll(pattern)].map((m) => ({
    attrs: m.at(1) ?? '',
    inner: m.at(2) ?? '',
  }))
}

const first = (xml: string, ...names: ReadonlyArray<string>): string | null => {
  for (const name of names) {
    const found = elements(xml, name).at(0)
    if (found === undefined) continue
    const text = plain(found.inner)
    if (text !== '') return text
  }
  return null
}

/** The longest non-empty body among `names`: a teaser loses to full text. */
const body = (xml: string, ...names: ReadonlyArray<string>): string | null => {
  let best: string | null = null
  for (const name of names) {
    const found = elements(xml, name).at(0)
    if (found === undefined) continue
    const text = paragraphs(found.inner)
    if (text !== '' && (best === null || text.length > best.length)) best = text
  }
  return best === null ? null : capped(best)
}

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(
    `(?:^|\\s)${escapeName(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  ).exec(attrs)
  const value = m?.at(1) ?? m?.at(2)
  return value === undefined ? null : decode(value)
}

const isoOf = (raw: string | null): string | null =>
  raw === null
    ? null
    : Option.getOrNull(Option.map(DateTime.make(raw), DateTime.formatIso))

/** `raw` made absolute against `base`, or null unless it is http(s). */
const absolute = (raw: string | null, base: string | null): string | null => {
  if (raw === null || raw.trim() === '') return null
  try {
    const url = base === null ? new URL(raw.trim()) : new URL(raw.trim(), base)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

const IMAGE_PATH = /\.(?:jpe?g|png|gif|webp|avif)(?:$|[?#])/i

/** A media element is an image by its `type`, its `medium`, or its path. */
const isImage = (attrs: string, url: string): boolean => {
  const type = attr(attrs, 'type')
  if (type !== null) return type.toLowerCase().startsWith('image/')
  const medium = attr(attrs, 'medium')
  if (medium !== null) return medium.toLowerCase() === 'image'
  return IMAGE_PATH.test(url)
}

/** The first media element of `name` that names an image by `urlAttr`. */
const mediaImage = (
  xml: string,
  name: string,
  urlAttr: string,
  base: string | null,
  check: boolean,
): string | null => {
  for (const e of elements(xml, name)) {
    const raw = attr(e.attrs, urlAttr)
    const url = absolute(raw, base)
    if (url !== null && (!check || isImage(e.attrs, url))) return url
  }
  return null
}

/** The first `<img src>` in any of the item's bodies. */
const inlineImage = (
  xml: string,
  base: string | null,
  ...names: ReadonlyArray<string>
): string | null => {
  for (const name of names) {
    for (const e of elements(xml, name)) {
      for (const img of htmlOf(e.inner).matchAll(/<img\b([^>]*)>/gi)) {
        // `absolute` admits http(s) only, so a `data:` pixel is passed over.
        const url = absolute(attr(img.at(1) ?? '', 'src'), base)
        if (url !== null) return url
      }
    }
  }
  return null
}

/**
 * The item's photo, in the order a publisher means it: an image enclosure,
 * `media:content`, `media:thumbnail`, then the first `<img>` in the text.
 */
const imageOf = (
  xml: string,
  base: string | null,
  enclosure: (xml: string) => string | null,
  ...bodies: ReadonlyArray<string>
): string | null =>
  enclosure(xml) ??
  mediaImage(xml, 'media:content', 'url', base, true) ??
  mediaImage(xml, 'media:thumbnail', 'url', base, false) ??
  inlineImage(xml, base, ...bodies)

const item = (fields: Omit<FeedItem, 'key'>, key: string | null) =>
  key === null ? [] : [{ key, ...fields }]

const rssItem = (xml: string, site: string | null): ReadonlyArray<FeedItem> => {
  const url = absolute(first(xml, 'link'), site)
  const base = url ?? site
  return item(
    {
      title: first(xml, 'title'),
      url,
      publishedAt: isoOf(first(xml, 'pubDate', 'dc:date', 'published')),
      summary: body(xml, 'description', 'content:encoded'),
      imageUrl: imageOf(
        xml,
        base,
        (x) => mediaImage(x, 'enclosure', 'url', base, true),
        'content:encoded',
        'description',
      ),
    },
    first(xml, 'guid') ?? url,
  )
}

/** The `alternate` link, or the first link with no `rel`. */
const atomLink = (xml: string, base: string | null): string | null => {
  for (const link of elements(xml, 'link')) {
    const rel = attr(link.attrs, 'rel')
    const href = absolute(attr(link.attrs, 'href'), base)
    if (href !== null && (rel === null || rel === 'alternate')) return href
  }
  return null
}

/** An Atom `<link rel="enclosure">` of an image type. */
const atomEnclosure = (xml: string, base: string | null): string | null => {
  for (const link of elements(xml, 'link')) {
    if (attr(link.attrs, 'rel') !== 'enclosure') continue
    const href = absolute(attr(link.attrs, 'href'), base)
    if (href !== null && isImage(link.attrs, href)) return href
  }
  return null
}

const atomEntry = (
  xml: string,
  site: string | null,
): ReadonlyArray<FeedItem> => {
  const url = atomLink(xml, site)
  const base = url ?? site
  return item(
    {
      title: first(xml, 'title'),
      url,
      publishedAt: isoOf(first(xml, 'published', 'updated')),
      summary: body(xml, 'summary', 'content'),
      imageUrl: imageOf(
        xml,
        base,
        (x) => atomEnclosure(x, base),
        'content',
        'summary',
      ),
    },
    first(xml, 'id') ?? url,
  )
}

/** The part of the document before its first item: the feed's own fields. */
const head = (xml: string, tag: string): string => {
  const at = xml.search(new RegExp(`<${tag}[\\s>]`))
  return at < 0 ? xml : xml.slice(0, at)
}

/** The channel's `<image><url>`, else its `itunes:image href`. */
const rssImage = (top: string, site: string | null): string | null => {
  for (const image of elements(top, 'image')) {
    const url = absolute(first(image.inner, 'url'), site)
    if (url !== null) return url
  }
  return mediaImage(top, 'itunes:image', 'href', site, false)
}

/** Atom's `<logo>`, else its `<icon>`. */
const atomImage = (top: string, site: string | null): string | null =>
  absolute(first(top, 'logo'), site) ?? absolute(first(top, 'icon'), site)

/** The feed, or null when `xml` is neither RSS nor Atom. */
export const parseFeed = (xml: string): Feed | null => {
  const doc = xml.replace(/<!--[\s\S]*?-->/g, '')
  if (/<(rss|rdf:RDF)[\s>]/.test(doc)) {
    const top = head(doc, 'item')
    const site = absolute(first(top, 'link'), null)
    return {
      format: 'rss',
      title: first(top, 'title'),
      siteUrl: site,
      imageUrl: rssImage(top, site),
      items: elements(doc, 'item').flatMap((e) => rssItem(e.inner, site)),
    }
  }
  if (/<feed[\s>]/.test(doc)) {
    const top = head(doc, 'entry')
    const site = atomLink(top, null)
    return {
      format: 'atom',
      title: first(top, 'title'),
      siteUrl: site,
      imageUrl: atomImage(top, site),
      items: elements(doc, 'entry').flatMap((e) => atomEntry(e.inner, site)),
    }
  }
  return null
}

const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
])

/**
 * The feeds an HTML page advertises with `<link rel="alternate">`, RSS or
 * Atom, made absolute against `pageUrl`, in document order.
 */
export const feedLinksOf = (
  html: string,
  pageUrl: string,
): ReadonlyArray<string> =>
  [...html.matchAll(/<link\b([^>]*)>/gi)].flatMap((m) => {
    const attrs = m.at(1) ?? ''
    const rel = (attr(attrs, 'rel') ?? '').toLowerCase().split(/\s+/)
    const type = (attr(attrs, 'type') ?? '').toLowerCase().trim()
    if (!rel.includes('alternate') || !FEED_TYPES.has(type)) return []
    const href = absolute(attr(attrs, 'href'), pageUrl)
    return href === null ? [] : [href]
  })

/**
 * Where a site's icon may be, best first: every `<link rel="icon">` (and
 * `shortcut icon`), then `apple-touch-icon`, in document order, then
 * `/favicon.ico` at the page's origin, which a site serves without saying.
 * Made absolute against `pageUrl`, each once.
 */
export const iconLinksOf = (
  html: string,
  pageUrl: string,
): ReadonlyArray<string> => {
  const icons: Array<string> = []
  const touch: Array<string> = []
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m.at(1) ?? ''
    const rel = (attr(attrs, 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = absolute(attr(attrs, 'href'), pageUrl)
    if (href === null) continue
    if (rel.includes('icon')) icons.push(href)
    else if (
      rel.includes('apple-touch-icon') ||
      rel.includes('apple-touch-icon-precomposed')
    )
      touch.push(href)
  }
  const fallback = absolute('/favicon.ico', pageUrl)
  return [
    ...new Set([...icons, ...touch, ...(fallback === null ? [] : [fallback])]),
  ]
}

/**
 * What a person typed, as a URL to fetch: `spacenews.com` is
 * `https://spacenews.com/`. Null when it cannot be a web address.
 */
export const feedAddressOf = (typed: string): string | null => {
  const raw = typed.trim()
  if (raw === '' || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw.replace(/^\/+/, '')}`
  return absolute(withScheme, null)
}
